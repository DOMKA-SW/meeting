require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const OpenAI = require('openai');
const jwt = require('jsonwebtoken');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();

// ─── CORS: permitir Authorization header ─────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => { console.log(`${new Date().toISOString()} ${req.method} ${req.path}`); next(); });

// ─── Config ──────────────────────────────────────────────────────────────────
const SECTION_SIZE    = 12;     // chunks por sección (~18 min con chunks de 90s)
const WORDS_PER_CHUNK = 2500;   // fallback para texto manual largo
const SPEAKER_BATCH   = 60;     // líneas por batch de speaker improvement

const dbDir          = path.join(__dirname, '..', 'storage', 'db');
const storagePath    = path.join(__dirname, '..', 'storage', 'audio');
const attachmentPath = path.join(__dirname, '..', 'storage', 'attachments');
const dbPath         = path.join(dbDir, 'meetings.db');
fs.mkdirSync(dbDir,          { recursive: true });
fs.mkdirSync(storagePath,    { recursive: true });
fs.mkdirSync(attachmentPath, { recursive: true });

// ─── Auth ────────────────────────────────────────────────────────────────────
const JWT_SECRET   = process.env.JWT_SECRET   || 'meeting-secret-change-in-production';
const APP_PASSWORD = process.env.APP_PASSWORD || 'actas2025';

const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Autenticación requerida' });
  }
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: 'Token inválido o expirado. Inicia sesión de nuevo.' });
  }
};

// ─── Base de datos ────────────────────────────────────────────────────────────
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY, user_id TEXT, status TEXT,
    started_at TEXT, ended_at TEXT, cliente TEXT,
    proyecto TEXT, responsable TEXT, participantes TEXT
  )`);
  ['cliente','proyecto','responsable','participantes'].forEach(col =>
    db.run(`ALTER TABLE meetings ADD COLUMN ${col} TEXT`, () => {}));

  db.run(`CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT,
    chunk_number INTEGER, file_path TEXT, processed INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transcriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT,
    chunk_number INTEGER, speaker TEXT, text TEXT, timestamp TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS section_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT,
    section_num INTEGER, from_chunk INTEGER, to_chunk INTEGER,
    summary_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(meeting_id, section_num)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS actas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT UNIQUE,
    acta_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tareas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, tarea_id TEXT,
    tipo TEXT, descripcion TEXT, responsable TEXT,
    estado TEXT DEFAULT 'pendiente', fecha_compromiso TEXT
  )`);

  // ── NUEVAS TABLAS ──────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS meeting_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    content TEXT NOT NULL,
    author TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS meeting_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    mime_type TEXT DEFAULT '',
    transcription TEXT,
    transcription_status TEXT DEFAULT 'pending',
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ─── Groq / LLM ──────────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) console.warn('⚠️  GROQ_API_KEY no definida');
else console.log('Groq key:', GROQ_API_KEY.slice(0,10) + '...');

const groq = new OpenAI({ apiKey: GROQ_API_KEY || 'dummy', baseURL: 'https://api.groq.com/openai/v1' });
const upload = multer({ storage: multer.memoryStorage() });

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

const addBusinessDays = (startDate, days) => {
  const date = new Date(startDate);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() !== 0 && date.getDay() !== 6) added++;
  }
  return date.toISOString().split('T')[0];
};

const callLLM = async (prompt, model = 'llama-3.3-70b-versatile', retries = 3) => {
  for (let i = 0; i <= retries; i++) {
    try {
      const completion = await groq.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.15,
        response_format: { type: 'json_object' }
      });
      return completion.choices?.[0]?.message?.content || null;
    } catch (e) {
      if (e.status === 429 && i < retries) {
        const wait = (i + 1) * 8000;
        console.warn(`Rate limit, esperando ${wait/1000}s...`);
        await sleep(wait);
      } else {
        console.error('LLM error:', e.message);
        throw e;
      }
    }
  }
  return null;
};

const parseJSON = (raw) => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) {
    const m = raw.match(/\{[\s\S]*\}/);
    try { return m ? JSON.parse(m[0]) : null; } catch (_) { return null; }
  }
};

// ─── Speaker Improvement ──────────────────────────────────────────────────────
const improveSpeakersInSection = async (transcriptions, participantes = [], speakerRegistry = {}) => {
  if (!GROQ_API_KEY || transcriptions.length === 0) return transcriptions;

  const result = [...transcriptions];
  const knownNames = Object.values(speakerRegistry).filter(v => v && !v.startsWith('Speaker'));
  const participantesHint = participantes.length > 0
    ? `PARTICIPANTES CONFIRMADOS EN ESTA REUNIÓN: ${participantes.join(', ')}.
Usa estos nombres EXACTAMENTE cuando identifiques quién habla.
Si el contenido sugiere que habla uno de ellos, asígnalo con su nombre real.`
    : knownNames.length > 0
      ? `Speakers ya identificados en secciones anteriores: ${knownNames.join(', ')}.`
      : 'No hay información previa de participantes.';

  for (let start = 0; start < transcriptions.length; start += SPEAKER_BATCH) {
    const batch = transcriptions.slice(start, start + SPEAKER_BATCH);
    const lines = batch.map((t, i) => `[${start + i}]: ${t.text}`).join('\n');

    const prompt = `Eres un experto en diarización de reuniones corporativas en español.

${participantesHint}

INSTRUCCIONES DE DIARIZACIÓN:
1. Analiza el CONTENIDO semántico para detectar cambios de hablante:
   - Preguntas → respuestas (siempre son speakers diferentes)
   - "Como decía X...", "Yo creo que...", "Desde mi perspectiva..." → cambio de voz
   - Cambios de rol: quien reporta vs quien decide
   - Cambio de tema iniciado por alguien nuevo
2. Mantén CONSISTENCIA: el mismo speaker debe tener el mismo nombre en toda la sesión
3. Si tienes nombres de participantes, úsalos cuando el contexto lo indique claramente
4. Si no puedes inferir el nombre, usa Speaker1, Speaker2... (numeración global consistente)
5. NUNCA inventes nombres que no estén en la lista de participantes

Responde SOLO JSON: {"lines": [{"index": N, "speaker": "Nombre"}]}

Transcripción a analizar:
${lines}`;

    try {
      const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
      const parsed = parseJSON(raw);
      const linesOut = Array.isArray(parsed?.lines) ? parsed.lines : [];
      for (const line of linesOut) {
        if (line.index >= 0 && line.index < result.length && line.speaker) {
          result[line.index] = { ...result[line.index], speaker: line.speaker };
          const origSpeaker = transcriptions[line.index]?.speaker;
          if (origSpeaker && !speakerRegistry[origSpeaker]) {
            speakerRegistry[origSpeaker] = line.speaker;
          }
        }
      }
    } catch (e) {
      console.warn(`Speaker batch ${start} falló:`, e.message);
    }
  }
  return result;
};

// ─── Resumen de Sección ───────────────────────────────────────────────────────
const generateSectionSummary = async (meetingId, sectionNum, fromChunk, toChunk) => {
  return new Promise((resolve) => {
    db.all(
      `SELECT t.id, t.speaker, t.text, t.chunk_number
       FROM transcriptions t
       WHERE t.meeting_id = ? AND t.chunk_number >= ? AND t.chunk_number <= ?
       ORDER BY t.chunk_number, t.id`,
      [meetingId, fromChunk, toChunk],
      async (err, transcriptions) => {
        if (err || transcriptions.length === 0) return resolve(null);

        db.get('SELECT participantes FROM meetings WHERE id = ?', [meetingId], async (_, meeting) => {
          let participantes = [];
          try { participantes = JSON.parse(meeting?.participantes || '[]'); } catch(_) {}

          const improved = await improveSpeakersInSection(transcriptions, participantes);

          for (let i = 0; i < improved.length; i++) {
            if (improved[i].speaker !== transcriptions[i].speaker) {
              db.run('UPDATE transcriptions SET speaker = ? WHERE id = ?',
                [improved[i].speaker, transcriptions[i].id]);
            }
          }

          const transcript = improved.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
          const minStart = Math.round(fromChunk * 1.5);
          const minEnd   = Math.round((toChunk + 1) * 1.5);

          const prompt = `Eres un asistente experto en análisis de reuniones corporativas en español.
Analiza la SECCIÓN ${sectionNum} (aproximadamente minutos ${minStart}–${minEnd}) de esta reunión.

CRITERIOS DE EXTRACCIÓN:

Para "temas": temas REALES debatidos, no genéricos. Ej: "Revisión del módulo de pagos" no "Revisión"
Para "decisiones": solo acuerdos TOMADOS, no discusiones. Ej: "Se aprobó lanzar en Q2" no "Se habló del lanzamiento"
Para "tareas": SOLO compromisos EXPLÍCITOS con verbo de acción + objeto concreto:
  ✅ VÁLIDO: "Juan enviará el contrato al cliente el viernes"
  ✅ VÁLIDO: "María preparará el prototipo para la próxima sesión"
  ❌ INVÁLIDO: "Revisar", "Mejorar la situación", "Hacer seguimiento", "Continuar"
Para "puntos_criticos": alertas, bloqueos, riesgos o temas que requieren atención especial
Para "resumen": narrativa de 3-4 frases que capture la esencia de esta sección

Responde SOLO JSON válido:
{
  "temas": ["tema específico 1"],
  "decisiones": ["decisión concreta tomada"],
  "tareas": [{"tarea": "acción concreta y específica", "quien": "nombre o vacío", "cuando": "fecha mencionada o vacío"}],
  "puntos_criticos": ["alerta o bloqueo importante si existe"],
  "resumen": "narrativa fluida de 3-4 frases de esta sección"
}

Transcripción:
${transcript}

Responde SOLO JSON válido.`;

          try {
            const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
            const summary = parseJSON(raw);
            if (summary) {
              db.run(
                `INSERT OR REPLACE INTO section_summaries
                 (meeting_id, section_num, from_chunk, to_chunk, summary_json)
                 VALUES (?, ?, ?, ?, ?)`,
                [meetingId, sectionNum, fromChunk, toChunk, JSON.stringify(summary)],
                () => {
                  console.log(`[${meetingId}] Sección ${sectionNum} resumida (chunks ${fromChunk}-${toChunk})`);
                  resolve(summary);
                }
              );
            } else resolve(null);
          } catch (e) {
            console.error(`Error resumen sección ${sectionNum}:`, e.message);
            resolve(null);
          }
        });
      }
    );
  });
};

const checkAndTriggerSectionSummary = (meetingId) => {
  db.get(
    `SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ? AND processed = 1`,
    [meetingId],
    (err, row) => {
      const processed = row?.cnt || 0;
      if (processed > 0 && processed % SECTION_SIZE === 0) {
        const sectionNum = Math.floor(processed / SECTION_SIZE);
        const fromChunk  = (sectionNum - 1) * SECTION_SIZE;
        const toChunk    = sectionNum * SECTION_SIZE - 1;
        db.get(
          `SELECT id FROM section_summaries WHERE meeting_id = ? AND section_num = ?`,
          [meetingId, sectionNum],
          (_, existing) => {
            if (!existing) {
              console.log(`[${meetingId}] Disparando resumen sección ${sectionNum}`);
              generateSectionSummary(meetingId, sectionNum, fromChunk, toChunk)
                .catch(e => console.error('Error sección:', e.message));
            }
          }
        );
      }
    }
  );
};

// ─── Obtener notas y adjuntos de la reunión ───────────────────────────────────
const getMeetingSupplements = (meetingId) => {
  return Promise.all([
    new Promise(resolve =>
      db.all('SELECT * FROM meeting_notes WHERE meeting_id = ? ORDER BY created_at',
        [meetingId], (_, r) => resolve(r || []))),
    new Promise(resolve =>
      db.all(`SELECT file_name, transcription FROM meeting_attachments
              WHERE meeting_id = ? AND transcription_status = 'done' AND transcription IS NOT NULL`,
        [meetingId], (_, r) => resolve(r || [])))
  ]).then(([notes, audioTranscriptions]) => ({ notes, audioTranscriptions }));
};

// ─── Generación de Acta Final ──────────────────────────────────────────────────
const generateActaFromSections = async (meetingId, meta, fechaDefault) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT section_num, from_chunk, to_chunk, summary_json
       FROM section_summaries WHERE meeting_id = ? ORDER BY section_num`,
      [meetingId],
      async (err, sections) => {
        if (err) return reject(err);

        // Obtener notas y transcripciones de audios adicionales
        const { notes, audioTranscriptions } = await getMeetingSupplements(meetingId);

        let actaJson = null;

        if (sections.length > 0) {
          const sectionInputs = sections.map((s, i) => {
            const sum = parseJSON(s.summary_json) || {};
            const minStart = Math.round(s.from_chunk * 1.5);
            const minEnd   = Math.round((s.to_chunk + 1) * 1.5);
            const puntosStr = (sum.puntos_criticos || []).length > 0
              ? `\nPuntos críticos: ${(sum.puntos_criticos).join('; ')}`
              : '';
            return `--- SECCIÓN ${i+1} (min ${minStart}-${minEnd}) ---
Temas: ${(sum.temas || []).join(', ')}
Decisiones: ${(sum.decisiones || []).join('; ')}
Tareas: ${JSON.stringify(sum.tareas || [])}
Resumen: ${sum.resumen || ''}${puntosStr}`;
          }).join('\n\n');

          const allTareas = sections.flatMap(s => {
            const sum = parseJSON(s.summary_json) || {};
            return (sum.tareas || []).map(t => ({
              descripcion: t.tarea || t.descripcion || '',
              responsable: t.quien || t.responsable || '',
              fecha_compromiso: t.cuando || t.fecha_compromiso || ''
            }));
          });

          // Construir sección de fuentes adicionales
          let fuentesAdicionales = '';
          if (notes.length > 0) {
            fuentesAdicionales += `\nNOTAS APORTADAS POR PARTICIPANTES (${notes.length} nota${notes.length > 1 ? 's' : ''}):\n`;
            fuentesAdicionales += notes.map(n =>
              `• ${n.author ? `[${n.author}]: ` : ''}${n.content}`
            ).join('\n');
          }
          if (audioTranscriptions.length > 0) {
            fuentesAdicionales += `\n\nTRANSCRIPCIONES DE AUDIOS ADICIONALES (${audioTranscriptions.length} archivo${audioTranscriptions.length > 1 ? 's' : ''}):\n`;
            fuentesAdicionales += audioTranscriptions.map(a =>
              `--- Archivo: ${a.file_name} ---\n${a.transcription}`
            ).join('\n\n');
          }

          const prompt = `Eres un redactor experto en actas de reunión corporativas. Tu objetivo es producir un documento COMPLETO, CONCRETO y ACCIONABLE.

DATOS DE IDENTIFICACIÓN (usa EXACTAMENTE estos valores):
cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}",
participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}",
hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}"

═══════════════════════════════════════
FUENTE PRINCIPAL: TRANSCRIPCIÓN GRABADA
═══════════════════════════════════════
${sectionInputs}
${fuentesAdicionales ? `\n═══════════════════════════════════════\nFUENTES COMPLEMENTARIAS\n═══════════════════════════════════════${fuentesAdicionales}` : ''}

TAREAS DETECTADAS EN TRANSCRIPCIÓN (pre-procesadas por sección):
${JSON.stringify(allTareas, null, 2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCCIONES DE REDACCIÓN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Para "resumen_reunion" (MUY IMPORTANTE):
- Escribe 4-6 frases en prosa ejecutiva, fluida y narrativa
- Debe cubrir: contexto/objetivo de la reunión → temas principales debatidos → decisiones tomadas → próximos pasos
- Si hay notas o audios adicionales, integra su contenido relevante naturalmente
- NUNCA hagas listas. Escribe como un párrafo ejecutivo que alguien que no asistió pueda leer y entender todo

Para "tareas_nuevas" (CRÍTICO):
- CONSOLIDA tareas duplicadas o muy similares entre secciones y fuentes en UNA SOLA tarea
- INCLUYE tareas detectadas tanto en la grabación como en notas y audios adicionales
- ELIMINA tareas vagas: "revisar", "mejorar", "hacer seguimiento", "continuar", "coordinar" (sin objeto concreto)
- Cada tarea debe tener: acción concreta + objeto específico + responsable + fecha
- Responsable: usa el nombre de un participante o deja vacío si no se mencionó
- fecha_compromiso: fecha específica si se mencionó, si no usa "${fechaDefault}"
- Máximo 15 tareas priorizadas por importancia
- IDs secuenciales: tarea_1, tarea_2...

Para "observaciones_generales":
- Incluye puntos críticos, bloqueos, riesgos o alertas detectadas
- Si hay información relevante de las fuentes adicionales que no cabe en el resumen, ponla aquí

Genera este JSON exacto:
{
  "identificacion": {
    "cliente": "", "proyecto": "", "fecha": "", "hora_inicio": "",
    "hora_fin": "", "responsable": "", "participantes": []
  },
  "tareas_anteriores": [],
  "tareas_nuevas": [
    {"id": "tarea_1", "descripcion": "descripción clara y específica", "responsable": "nombre", "fecha_compromiso": "${fechaDefault}"}
  ],
  "resumen_reunion": "Narrativa ejecutiva fluida de 4-6 frases...",
  "observaciones_generales": ""
}

RESPONDE SOLO JSON VÁLIDO.`;

          try {
            const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
            actaJson = parseJSON(raw);
          } catch (e) {
            console.error(`Error acta desde secciones:`, e.message);
          }
        }

        if (!actaJson) {
          console.log(`[${meetingId}] Fallback: generando acta desde transcripción...`);
          actaJson = await generateActaFromRawTranscript(meetingId, meta, fechaDefault);
        }

        if (!actaJson) {
          actaJson = {
            identificacion: { ...meta },
            tareas_anteriores: [], tareas_nuevas: [],
            resumen_reunion: 'No se pudo generar el acta automáticamente.',
            observaciones_generales: ''
          };
        }

        actaJson.identificacion = { ...meta };
        resolve(actaJson);
      }
    );
  });
};

// Fallback: acta desde transcripción cruda
const generateActaFromRawTranscript = async (meetingId, meta, fechaDefault) => {
  return new Promise((resolve) => {
    db.all(
      `SELECT speaker, text, chunk_number FROM transcriptions
       WHERE meeting_id = ? ORDER BY chunk_number, id`,
      [meetingId],
      async (err, rows) => {
        if (err || rows.length === 0) return resolve(null);

        const { notes, audioTranscriptions } = await getMeetingSupplements(meetingId);

        const fullTranscript = rows.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
        const wordCount = fullTranscript.split(/\s+/).length;

        let transcriptInput = fullTranscript;

        if (wordCount > WORDS_PER_CHUNK) {
          const words = fullTranscript.split(/\s+/);
          const sectionTexts = [];
          for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
            sectionTexts.push(words.slice(i, i + WORDS_PER_CHUNK).join(' '));
          }
          const extracts = [];
          for (let i = 0; i < sectionTexts.length; i++) {
            const raw = await callLLM(
              `Analiza esta sección de reunión y extrae en JSON:
{"temas": ["tema"], "decisiones": ["decisión"], "tareas": [{"tarea":"acción concreta","quien":"nombre","cuando":"fecha"}], "resumen": "2-3 frases"}

CRÍTICO: solo tareas EXPLÍCITAS con acción concreta. NO genéricas.

Texto: ${sectionTexts[i]}

SOLO JSON válido.`,
              'llama-3.1-8b-instant'
            ).catch(() => null);
            if (raw) { const p = parseJSON(raw); if (p) extracts.push(p); }
            if (i < sectionTexts.length - 1) await sleep(1200);
          }
          transcriptInput = extracts.map((e, i) =>
            `Sección ${i+1}: ${e.resumen || ''} | Tareas: ${JSON.stringify(e.tareas || [])}`
          ).join('\n');
        }

        let fuentesAdicionales = '';
        if (notes.length > 0) {
          fuentesAdicionales += `\nNOTAS ADICIONALES:\n${notes.map(n => `• ${n.author ? `[${n.author}]: ` : ''}${n.content}`).join('\n')}`;
        }
        if (audioTranscriptions.length > 0) {
          fuentesAdicionales += `\n\nAUDIOS ADICIONALES:\n${audioTranscriptions.map(a => `--- ${a.file_name} ---\n${a.transcription}`).join('\n\n')}`;
        }

        const prompt = `Eres un redactor experto en actas corporativas.

DATOS: cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}", participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}", hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}"

TRANSCRIPCIÓN PRINCIPAL:
${transcriptInput}
${fuentesAdicionales}

Genera el acta en JSON:
{
  "identificacion": {"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},
  "tareas_anteriores": [],
  "tareas_nuevas": [{"id":"tarea_1","descripcion":"acción concreta y específica","responsable":"nombre","fecha_compromiso":"${fechaDefault}"}],
  "resumen_reunion": "Narrativa ejecutiva de 4-6 frases que explique: qué se trató, qué se decidió, y cuáles son los próximos pasos. En prosa, NO listas.",
  "observaciones_generales": ""
}

REGLAS tareas: solo explícitas y concretas, consolida duplicados, máximo 15, IDs secuenciales.
RESPONDE SOLO JSON VÁLIDO.`;

        try {
          const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
          resolve(parseJSON(raw));
        } catch (e) {
          console.error('Error acta raw:', e.message);
          resolve(null);
        }
      }
    );
  });
};

// ─── Finalizar reunión ────────────────────────────────────────────────────────
const finalizeMeeting = async (meetingId) => {
  db.get(
    `SELECT cliente, proyecto, responsable, participantes, started_at, ended_at FROM meetings WHERE id = ?`,
    [meetingId],
    async (err, meeting) => {
      if (err || !meeting) return;

      let participantes = [];
      try { participantes = JSON.parse(meeting.participantes || '[]'); } catch(_) {}

      // Esperar chunks en vuelo (máx 5 min para reuniones largas)
      let waited = 0;
      const MAX_WAIT = 5 * 60 * 1000;
      while (waited < MAX_WAIT) {
        const pending = await new Promise(resolve =>
          db.get('SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ? AND processed = 0',
            [meetingId], (_, r) => resolve(r?.cnt || 0)));
        if (pending === 0) break;
        await sleep(3000);
        waited += 3000;
      }

      // Generar sección final con chunks no cubiertos
      const lastSectionRow = await new Promise(resolve =>
        db.get('SELECT MAX(to_chunk) as lastCovered FROM section_summaries WHERE meeting_id = ?',
          [meetingId], (_, r) => resolve(r)));
      const lastCovered = lastSectionRow?.lastCovered ?? -1;

      const lastChunkRow = await new Promise(resolve =>
        db.get('SELECT MAX(chunk_number) as lastChunk FROM chunks WHERE meeting_id = ? AND processed = 1',
          [meetingId], (_, r) => resolve(r)));
      const lastChunk = lastChunkRow?.lastChunk;

      if (lastChunk !== null && lastChunk !== undefined && lastChunk > lastCovered) {
        const sectionsCount = await new Promise(resolve =>
          db.get('SELECT COUNT(*) as cnt FROM section_summaries WHERE meeting_id = ?',
            [meetingId], (_, r) => resolve(r?.cnt || 0)));

        console.log(`[${meetingId}] Generando sección final (chunks ${lastCovered+1}-${lastChunk})`);
        await generateSectionSummary(meetingId, sectionsCount + 1, lastCovered + 1, lastChunk);
      }

      const startedDate = meeting.started_at ? new Date(meeting.started_at) : null;
      const endedDate   = meeting.ended_at   ? new Date(meeting.ended_at)   : null;
      const meta = {
        cliente: meeting.cliente || '',
        proyecto: meeting.proyecto || '',
        responsable: meeting.responsable || '',
        participantes,
        fecha: startedDate ? startedDate.toISOString().split('T')[0] : '',
        hora_inicio: startedDate
          ? `${String(startedDate.getHours()).padStart(2,'0')}:${String(startedDate.getMinutes()).padStart(2,'0')}`
          : '',
        hora_fin: endedDate
          ? `${String(endedDate.getHours()).padStart(2,'0')}:${String(endedDate.getMinutes()).padStart(2,'0')}`
          : ''
      };
      const fechaDefault = addBusinessDays(meta.fecha || new Date().toISOString().split('T')[0], 3);

      console.log(`[${meetingId}] Generando acta final...`);
      const actaJson = await generateActaFromSections(meetingId, meta, fechaDefault);
      actaJson.identificacion = { ...meta };

      db.run('INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)',
        [meetingId, JSON.stringify(actaJson)]);

      db.run('DELETE FROM tareas WHERE meeting_id = ?', [meetingId], () => {
        const seen = new Set();
        let counter = 1;
        (actaJson.tareas_nuevas || [])
          .filter(t => {
            const desc = (t.descripcion || '').trim().toLowerCase();
            if (!desc || desc.length < 8 || seen.has(desc)) return false;
            seen.add(desc); return true;
          })
          .forEach(t => {
            db.run(
              'INSERT INTO tareas (meeting_id, tarea_id, tipo, descripcion, responsable, estado, fecha_compromiso) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [meetingId, `tarea_${counter++}`, 'nueva',
               (t.descripcion||'').trim(), (t.responsable||'').trim(),
               'pendiente', t.fecha_compromiso || fechaDefault]
            );
          });
      });

      console.log(`[${meetingId}] ✅ Acta lista. ${actaJson.tareas_nuevas?.length||0} tareas.`);
    }
  );
};

// ─── Conversión audio: webm → mp3 ────────────────────────────────────────────
const convertToMp3 = async (inputPath) => {
  const outputPath = inputPath.replace(/\.(webm|wav|m4a|ogg|mp4)$/, '.mp3');
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPath, '-vn',
      '-ar', '16000', '-ac', '1', '-b:a', '64k',
      outputPath
    ]);
    return outputPath;
  } catch (e) {
    console.error('ffmpeg error:', e.message);
    return null;
  }
};

// ─── Transcripción Whisper ────────────────────────────────────────────────────
const processChunkWithWhisper = async (filePath, meetingId, chunkNumber, participantes = []) => {
  if (!GROQ_API_KEY) {
    db.run('UPDATE chunks SET processed = 2 WHERE meeting_id = ? AND chunk_number = ?', [meetingId, chunkNumber]);
    return null;
  }

  let fileToSend = filePath;
  let mp3Path = null;

  try {
    mp3Path = await convertToMp3(filePath);
    if (mp3Path && fs.existsSync(mp3Path)) {
      const mp3Size = fs.statSync(mp3Path).size;
      if (mp3Size > 1000) fileToSend = mp3Path;
    }
  } catch (_) {}

  try {
    const fileSizeKB = fs.statSync(fileToSend).size / 1024;
    if (fileSizeKB < 1) {
      db.run('UPDATE chunks SET processed = 1 WHERE meeting_id = ? AND chunk_number = ?', [meetingId, chunkNumber]);
      return null;
    }

    const whisperPrompt = participantes.length > 0
      ? `Reunión de trabajo en español. Participantes: ${participantes.join(', ')}.`
      : 'Reunión de trabajo en español.';

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(fileToSend),
      model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json',
      language: 'es',
      prompt: whisperPrompt
    });

    const segments = Array.isArray(transcription.segments) ? transcription.segments : [];
    if (segments.length > 0) {
      let speakerCounter = 1;
      const speakerMap = {};
      for (const seg of segments) {
        const key = seg.spk || seg.speaker || 'speaker';
        if (!speakerMap[key]) speakerMap[key] = `Speaker${speakerCounter++}`;
        if ((seg.text || '').trim()) {
          db.run(
            'INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
            [meetingId, chunkNumber, speakerMap[key], seg.text.trim(), new Date().toISOString()]
          );
        }
      }
    } else if (transcription.text?.trim()) {
      db.run(
        'INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
        [meetingId, chunkNumber, 'Speaker1', transcription.text.trim(), new Date().toISOString()]
      );
    }

    if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);

    db.run('UPDATE chunks SET processed = 1 WHERE meeting_id = ? AND chunk_number = ?',
      [meetingId, chunkNumber], () => {
        checkAndTriggerSectionSummary(meetingId);
      });

    return transcription;
  } catch (error) {
    if (mp3Path && fs.existsSync(mp3Path)) try { fs.unlinkSync(mp3Path); } catch(_) {}
    const code = error.status === 429 ? 2 : -1;
    db.run('UPDATE chunks SET processed = ? WHERE meeting_id = ? AND chunk_number = ?',
      [code, meetingId, chunkNumber]);

    if (error.status === 429) {
      setTimeout(() => {
        db.run('UPDATE chunks SET processed = 0 WHERE meeting_id = ? AND chunk_number = ? AND processed = 2',
          [meetingId, chunkNumber], () => {
            processChunkWithWhisper(filePath, meetingId, chunkNumber, participantes).catch(() => {});
          });
      }, 60000);
    }
    return null;
  }
};

// ─── Transcripción de adjunto de audio ────────────────────────────────────────
const processAudioAttachment = async (attachmentId, filePath, meetingId, participantes = []) => {
  if (!GROQ_API_KEY) {
    db.run('UPDATE meeting_attachments SET transcription_status = ? WHERE id = ?', ['error', attachmentId]);
    return;
  }

  db.run('UPDATE meeting_attachments SET transcription_status = ? WHERE id = ?', ['processing', attachmentId]);

  let fileToSend = filePath;
  let mp3Path = null;

  try {
    mp3Path = await convertToMp3(filePath);
    if (mp3Path && fs.existsSync(mp3Path)) {
      const mp3Size = fs.statSync(mp3Path).size;
      if (mp3Size > 1000) fileToSend = mp3Path;
    }
  } catch (_) {}

  try {
    const fileSizeKB = fs.statSync(fileToSend).size / 1024;
    if (fileSizeKB < 1) {
      db.run('UPDATE meeting_attachments SET transcription_status = ?, transcription = ? WHERE id = ?',
        ['done', '(archivo de audio vacío)', attachmentId]);
      return;
    }

    const whisperPrompt = participantes.length > 0
      ? `Audio de participante en reunión de trabajo en español. Participantes: ${participantes.join(', ')}.`
      : 'Audio de participante en reunión de trabajo en español.';

    console.log(`[adjunto ${attachmentId}] Transcribiendo con Whisper...`);

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(fileToSend),
      model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json',
      language: 'es',
      prompt: whisperPrompt
    });

    let transcriptText = '';
    const segments = Array.isArray(transcription.segments) ? transcription.segments : [];
    if (segments.length > 0) {
      transcriptText = segments
        .filter(s => (s.text || '').trim())
        .map(s => s.text.trim())
        .join(' ');
    } else if (transcription.text?.trim()) {
      transcriptText = transcription.text.trim();
    }

    if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);

    db.run('UPDATE meeting_attachments SET transcription_status = ?, transcription = ? WHERE id = ?',
      ['done', transcriptText, attachmentId]);

    console.log(`[adjunto ${attachmentId}] ✅ Transcripción lista (${transcriptText.split(/\s+/).length} palabras)`);
  } catch (error) {
    if (mp3Path && fs.existsSync(mp3Path)) try { fs.unlinkSync(mp3Path); } catch(_) {}
    console.error(`[adjunto ${attachmentId}] Error Whisper:`, error.message);
    db.run('UPDATE meeting_attachments SET transcription_status = ? WHERE id = ?', ['error', attachmentId]);
  }
};

// ─── Reunión desde texto manual ───────────────────────────────────────────────
const generateActaFromText = async (texto, modo, meta, fechaDefault) => {
  const contextoPorModo = {
    notas: `El texto son NOTAS LIBRES tomadas durante o después de una reunión. Puede estar desordenado, con abreviaciones o bullets. Interpreta e integra todo el contenido.`,
    transcripcion: `El texto es una TRANSCRIPCIÓN de reunión con diálogos entre participantes. Identifica los speakers y extrae compromisos de cada uno.`,
    email: `El texto es un EMAIL o MENSAJE DE RESUMEN post-reunión. Extrae compromisos, acuerdos y pendientes. El autor del email es generalmente el moderador.`,
  };

  const contexto = contextoPorModo[modo] || contextoPorModo.notas;
  const wordCount = texto.split(/\s+/).length;

  if (wordCount > 3000) {
    const words = texto.split(/\s+/);
    const sections = [];
    for (let i = 0; i < words.length; i += 2500) sections.push(words.slice(i, i + 2500).join(' '));
    const extracts = [];
    for (let i = 0; i < sections.length; i++) {
      const raw = await callLLM(
        `Analiza esta sección de reunión y extrae en JSON:
{"temas": ["tema"], "decisiones": ["decisión"], "tareas": [{"tarea":"acción concreta","quien":"nombre","cuando":"fecha"}], "resumen": "2-3 frases"}
CRÍTICO: solo tareas EXPLÍCITAS con acción concreta.
Texto: ${sections[i]}
SOLO JSON válido.`,
        'llama-3.1-8b-instant'
      ).catch(() => null);
      if (raw) { const p = parseJSON(raw); if (p) extracts.push(p); }
      if (i < sections.length - 1) await sleep(1200);
    }
    texto = extracts.map((e, i) =>
      `Sección ${i+1}: ${e.resumen || ''} | Tareas: ${JSON.stringify(e.tareas || [])}`
    ).join('\n');
  }

  const prompt = `Eres un redactor experto en actas de reunión corporativas.

TIPO DE ENTRADA: ${contexto}

DATOS DE IDENTIFICACIÓN (usa EXACTAMENTE estos valores):
cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}",
participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}",
hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}"

CONTENIDO DE LA REUNIÓN:
${texto}

Genera el acta en JSON exacto:
{
  "identificacion": {"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},
  "tareas_anteriores": [],
  "tareas_nuevas": [{"id":"tarea_1","descripcion":"descripción clara y específica de la acción","responsable":"nombre","fecha_compromiso":"${fechaDefault}"}],
  "resumen_reunion": "",
  "observaciones_generales": ""
}

REGLAS para "resumen_reunion":
- 4-6 frases en prosa ejecutiva y fluida (NO listas)
- Cubre: objetivo → temas tratados → decisiones → próximos pasos
- Útil para alguien que no asistió

REGLAS para "tareas_nuevas":
- SOLO tareas EXPLÍCITAS: "Juan enviará el informe", "María prepara el documento"
- NUNCA tareas vagas: "revisar", "mejorar", "continuar", "hacer seguimiento"
- Un responsable claro por tarea (vacío si no se mencionó)
- fecha_compromiso: fecha específica mencionada, o "${fechaDefault}"
- Máximo 15 tareas, consolida duplicados, IDs secuenciales

RESPONDE SOLO JSON VÁLIDO.`;

  const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
  return parseJSON(raw);
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── RUTAS ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ── Rutas públicas (sin auth) ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), hasGroqKey: Boolean(GROQ_API_KEY) });
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const token = jwt.sign({ role: 'user', ts: Date.now() }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, expiresIn: '30d' });
});

// ── Auth middleware para todas las rutas siguientes ───────────────────────────
app.use(authMiddleware);

// ── Rutas de reuniones ────────────────────────────────────────────────────────
app.post('/startMeeting', (req, res) => {
  const meetingId = uuidv4();
  const { user_id = 'default', cliente = '', proyecto = '', responsable = '' } = req.body;
  const participantes = Array.isArray(req.body.participantes) ? JSON.stringify(req.body.participantes) : '[]';
  fs.mkdirSync(path.join(storagePath, meetingId), { recursive: true });
  db.run(
    'INSERT INTO meetings (id, user_id, status, started_at, cliente, proyecto, responsable, participantes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [meetingId, user_id, 'active', new Date().toISOString(), cliente, proyecto, responsable, participantes],
    err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ meetingId, status: 'active' });
    }
  );
});

app.post('/endMeeting', (req, res) => {
  const { meetingId } = req.body;
  if (!meetingId) return res.status(400).json({ error: 'Missing meetingId' });
  db.run('UPDATE meetings SET status = ?, ended_at = ? WHERE id = ?',
    ['ended', new Date().toISOString(), meetingId],
    err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ meetingId, status: 'ended', actaStatus: 'processing' });
      finalizeMeeting(meetingId).catch(e => console.error('Error finalizeMeeting:', e.message));
    }
  );
});

app.post('/chunk', upload.single('audio'), async (req, res) => {
  const { meetingId, chunkNumber } = req.body;
  if (!meetingId || chunkNumber === undefined || !req.file)
    return res.status(400).json({ error: 'Missing fields' });

  const audioDir  = path.join(storagePath, meetingId);
  const filePath  = path.join(audioDir, `chunk_${chunkNumber}.webm`);
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(filePath, req.file.buffer);

  db.get('SELECT participantes FROM meetings WHERE id = ?', [meetingId], (_, meeting) => {
    let participantes = [];
    try { participantes = JSON.parse(meeting?.participantes || '[]'); } catch(_) {}

    db.run('INSERT INTO chunks (meeting_id, chunk_number, file_path, processed) VALUES (?, ?, ?, ?)',
      [meetingId, parseInt(chunkNumber), filePath, 0],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ chunkId: this.lastID, meetingId, chunkNumber: parseInt(chunkNumber) });
        processChunkWithWhisper(filePath, meetingId, parseInt(chunkNumber), participantes)
          .catch(console.error);
      }
    );
  });
});

app.get('/meetings/:id/progress', (req, res) => {
  const { id } = req.params;
  Promise.all([
    new Promise(resolve => db.get('SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ?', [id], (_, r) => resolve(r?.cnt || 0))),
    new Promise(resolve => db.get('SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ? AND processed = 1', [id], (_, r) => resolve(r?.cnt || 0))),
    new Promise(resolve => db.get('SELECT COUNT(*) as cnt FROM section_summaries WHERE meeting_id = ?', [id], (_, r) => resolve(r?.cnt || 0))),
    new Promise(resolve => db.get('SELECT COUNT(*) as cnt FROM transcriptions WHERE meeting_id = ?', [id], (_, r) => resolve(r?.cnt || 0))),
    new Promise(resolve => db.get('SELECT status FROM meetings WHERE id = ?', [id], (_, r) => resolve(r?.status || 'unknown'))),
  ]).then(([chunksTotal, chunksProcessed, sectionsGenerated, transcriptionLines, status]) => {
    res.json({ chunksTotal, chunksProcessed, sectionsGenerated, transcriptionLines, status });
  });
});

// ── Reunión desde texto manual ────────────────────────────────────────────────
app.post('/meetings/from-text', async (req, res) => {
  const {
    user_id = 'default', cliente = '', proyecto = '', responsable = '',
    participantes: pRaw = [], texto = '', modo = 'notas',
    fecha = null, hora_inicio = '', hora_fin = ''
  } = req.body;

  if (!texto || texto.trim().split(/\s+/).length < 10)
    return res.status(400).json({ error: 'Necesitas al menos 10 palabras de contenido.' });

  const meetingId = uuidv4();
  const participantesArr = Array.isArray(pRaw)
    ? pRaw
    : pRaw.toString().split(/[,;]/).map(p => p.trim()).filter(Boolean);
  const participantesStr = JSON.stringify(participantesArr);

  const startedAt = fecha
    ? new Date(`${fecha}T${hora_inicio || '09:00'}:00`).toISOString()
    : new Date().toISOString();
  const endedAt = fecha && hora_fin
    ? new Date(`${fecha}T${hora_fin}:00`).toISOString()
    : new Date().toISOString();

  db.run(
    'INSERT INTO meetings (id, user_id, status, started_at, ended_at, cliente, proyecto, responsable, participantes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [meetingId, user_id, 'ended', startedAt, endedAt, cliente, proyecto, responsable, participantesStr],
    async err => {
      if (err) return res.status(500).json({ error: err.message });

      insertTextAsTranscription(meetingId, texto.trim(), 0);
      res.json({ meetingId, status: 'ended', message: 'Procesando...' });

      try {
        const startedDate = new Date(startedAt);
        const endedDate   = new Date(endedAt);
        const meta = {
          cliente, proyecto, responsable,
          participantes: participantesArr,
          fecha: startedDate.toISOString().split('T')[0],
          hora_inicio: hora_inicio || `${String(startedDate.getHours()).padStart(2,'0')}:${String(startedDate.getMinutes()).padStart(2,'0')}`,
          hora_fin: hora_fin || `${String(endedDate.getHours()).padStart(2,'0')}:${String(endedDate.getMinutes()).padStart(2,'0')}`,
        };
        const fechaDefault = addBusinessDays(meta.fecha, 3);
        let actaJson = await generateActaFromText(texto.trim(), modo, meta, fechaDefault);

        if (!actaJson) {
          actaJson = {
            identificacion: { ...meta },
            tareas_anteriores: [], tareas_nuevas: [],
            resumen_reunion: 'No se pudo generar el acta automáticamente.',
            observaciones_generales: ''
          };
        }
        actaJson.identificacion = { ...meta };

        db.run('INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)',
          [meetingId, JSON.stringify(actaJson)]);

        const seen = new Set();
        let counter = 1;
        (actaJson.tareas_nuevas || [])
          .filter(t => {
            const desc = (t.descripcion || '').trim().toLowerCase();
            if (!desc || desc.length < 8 || seen.has(desc)) return false;
            seen.add(desc); return true;
          })
          .forEach(t => {
            db.run(
              'INSERT INTO tareas (meeting_id, tarea_id, tipo, descripcion, responsable, estado, fecha_compromiso) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [meetingId, `tarea_${counter++}`, 'nueva',
               (t.descripcion||'').trim(), (t.responsable||'').trim(),
               'pendiente', t.fecha_compromiso || addBusinessDays(meta.fecha, 3)]
            );
          });

        db.run('UPDATE meetings SET status = ? WHERE id = ?', ['ended', meetingId]);
      } catch (e) {
        console.error(`[${meetingId}] Error:`, e.message);
        db.run('UPDATE meetings SET status = ? WHERE id = ?', ['ended', meetingId]);
      }
    }
  );
});

app.post('/meetings/:id/add-transcript', (req, res) => {
  const { texto = '' } = req.body;
  if (!texto.trim()) return res.status(400).json({ error: 'Texto vacío' });
  db.get('SELECT id FROM meetings WHERE id = ?', [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Reunión no encontrada' });
    db.get('SELECT MAX(chunk_number) as maxChunk FROM transcriptions WHERE meeting_id = ?',
      [req.params.id], (_, r) => {
        insertTextAsTranscription(req.params.id, texto, (r?.maxChunk || 0) + 1);
        res.json({ ok: true });
      });
  });
});

function insertTextAsTranscription(meetingId, texto, startChunk) {
  const lineas = texto.split('\n').filter(l => l.trim());
  let currentSpeaker = 'Texto';
  let segNum = startChunk;
  for (const linea of lineas) {
    const match = linea.match(/^\[?([^\]:]{1,50})\]?:\s*(.+)$/);
    if (match) {
      currentSpeaker = match[1].trim();
      const text = match[2].trim();
      if (text) db.run('INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
        [meetingId, segNum++, currentSpeaker, text, new Date().toISOString()]);
    } else if (linea.trim()) {
      db.run('INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
        [meetingId, segNum++, currentSpeaker, linea.trim(), new Date().toISOString()]);
    }
  }
}

// ── Rutas de consulta ─────────────────────────────────────────────────────────
app.get('/meetings', (req, res) => {
  const userId = req.query.user_id || 'default';
  db.all('SELECT * FROM meetings WHERE user_id = ? ORDER BY started_at DESC', [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/meetings/:id', (req, res) => {
  db.get('SELECT * FROM meetings WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });
});

app.get('/meetings/:id/transcription', (req, res) => {
  db.all('SELECT * FROM transcriptions WHERE meeting_id = ? ORDER BY chunk_number, id',
    [req.params.id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
});

app.get('/meetings/:id/acta', (req, res) => {
  const meetingId = req.params.id;
  db.get('SELECT status FROM meetings WHERE id = ?', [meetingId], (err, meeting) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    db.get('SELECT acta_json FROM actas WHERE meeting_id = ?', [meetingId], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(202).json({ status: 'processing', meetingStatus: meeting.status, message: 'El acta aún se está generando' });
      res.json({ status: 'ready', acta: JSON.parse(row.acta_json) });
    });
  });
});

app.get('/meetings/:id/tareas', (req, res) => {
  db.all('SELECT * FROM tareas WHERE meeting_id = ? ORDER BY id', [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.put('/meetings/:id/acta', (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid body' });
  db.run('INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)',
    [req.params.id, JSON.stringify(req.body)], err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
});

app.put('/meetings/:id/tareas', (req, res) => {
  const tareas = Array.isArray(req.body) ? req.body : req.body?.tareas;
  if (!Array.isArray(tareas)) return res.status(400).json({ error: 'tareas array required' });
  db.run('DELETE FROM tareas WHERE meeting_id = ?', [req.params.id], err => {
    if (err) return res.status(500).json({ error: err.message });
    if (!tareas.length) return res.json({ ok: true });
    const stmt = db.prepare('INSERT INTO tareas (meeting_id, tarea_id, tipo, descripcion, responsable, estado, fecha_compromiso) VALUES (?, ?, ?, ?, ?, ?, ?)');
    tareas.forEach(t => stmt.run(req.params.id, t.tarea_id||'', t.tipo||'nueva', t.descripcion||'', t.responsable||'', t.estado||'pendiente', t.fecha_compromiso||''));
    stmt.finalize(() => res.json({ ok: true }));
  });
});

app.post('/meetings/:id/reprocess-acta', async (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM tareas WHERE meeting_id = ?', [id], () => {
    db.run('DELETE FROM actas WHERE meeting_id = ?', [id], () => {
      db.run('DELETE FROM section_summaries WHERE meeting_id = ?', [id], () => {
        res.json({ ok: true, message: 'Reprocesando desde cero...' });
        finalizeMeeting(id).catch(e => console.error('Reprocess error:', e.message));
      });
    });
  });
});

// ── NUEVAS RUTAS: Notas ───────────────────────────────────────────────────────
app.get('/meetings/:id/notes', (req, res) => {
  db.all('SELECT * FROM meeting_notes WHERE meeting_id = ? ORDER BY created_at',
    [req.params.id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
});

app.post('/meetings/:id/notes', (req, res) => {
  const { content = '', author = '' } = req.body;
  if (!content.trim()) return res.status(400).json({ error: 'Contenido vacío' });
  db.get('SELECT id FROM meetings WHERE id = ?', [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Reunión no encontrada' });
    db.run('INSERT INTO meeting_notes (meeting_id, content, author) VALUES (?, ?, ?)',
      [req.params.id, content.trim(), author.trim()],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, meeting_id: req.params.id, content: content.trim(), author: author.trim() });
      }
    );
  });
});

app.delete('/meetings/:id/notes/:noteId', (req, res) => {
  db.run('DELETE FROM meeting_notes WHERE id = ? AND meeting_id = ?',
    [req.params.noteId, req.params.id], err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    });
});

// ── NUEVAS RUTAS: Adjuntos ────────────────────────────────────────────────────
app.get('/meetings/:id/attachments', (req, res) => {
  db.all('SELECT id, meeting_id, file_name, file_type, mime_type, transcription_status, uploaded_at FROM meeting_attachments WHERE meeting_id = ? ORDER BY uploaded_at',
    [req.params.id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
});

app.post('/meetings/:id/attachments', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  const meetingId = req.params.id;
  db.get('SELECT id, participantes FROM meetings WHERE id = ?', [meetingId], (err, meeting) => {
    if (err || !meeting) return res.status(404).json({ error: 'Reunión no encontrada' });

    const mimeType   = req.file.mimetype || '';
    const isAudio    = mimeType.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i.test(req.file.originalname);
    const fileType   = isAudio ? 'audio' : 'document';

    const dir      = path.join(attachmentPath, meetingId);
    fs.mkdirSync(dir, { recursive: true });
    const safeFileName = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(dir, safeFileName);
    fs.writeFileSync(filePath, req.file.buffer);

    const transcriptionStatus = isAudio ? 'pending' : 'n/a';

    db.run(
      'INSERT INTO meeting_attachments (meeting_id, file_name, file_path, file_type, mime_type, transcription_status) VALUES (?, ?, ?, ?, ?, ?)',
      [meetingId, req.file.originalname, filePath, fileType, mimeType, transcriptionStatus],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const attachId = this.lastID;
        res.json({ id: attachId, file_name: req.file.originalname, file_type: fileType, transcription_status: transcriptionStatus });

        if (isAudio) {
          let participantes = [];
          try { participantes = JSON.parse(meeting.participantes || '[]'); } catch(_) {}
          processAudioAttachment(attachId, filePath, meetingId, participantes).catch(console.error);
        }
      }
    );
  });
});

app.delete('/meetings/:id/attachments/:attachId', (req, res) => {
  db.get('SELECT file_path FROM meeting_attachments WHERE id = ? AND meeting_id = ?',
    [req.params.attachId, req.params.id], (err, row) => {
      if (err || !row) return res.status(404).json({ error: 'Adjunto no encontrado' });
      db.run('DELETE FROM meeting_attachments WHERE id = ?', [req.params.attachId], err => {
        if (err) return res.status(500).json({ error: err.message });
        try { if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path); } catch(_) {}
        res.json({ ok: true });
      });
    });
});

// Descargar adjunto (documentos)
app.get('/meetings/:id/attachments/:attachId/download', (req, res) => {
  db.get('SELECT file_name, file_path, mime_type FROM meeting_attachments WHERE id = ? AND meeting_id = ?',
    [req.params.attachId, req.params.id], (err, row) => {
      if (err || !row) return res.status(404).json({ error: 'Adjunto no encontrado' });
      if (!fs.existsSync(row.file_path)) return res.status(404).json({ error: 'Archivo no encontrado en disco' });
      res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
      if (row.mime_type) res.setHeader('Content-Type', row.mime_type);
      res.sendFile(path.resolve(row.file_path));
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
