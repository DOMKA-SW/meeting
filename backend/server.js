require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => { console.log(`${new Date().toISOString()} ${req.method} ${req.path}`); next(); });

// ─── Config ──────────────────────────────────────────────────────────────────
const SECTION_SIZE = 12;        // chunks por sección (~18 min con chunks de 90s)
const WORDS_PER_CHUNK = 2500;   // fallback para texto manual largo
const SPEAKER_BATCH = 60;       // líneas por batch de speaker improvement

const dbDir = path.join(__dirname, '..', 'storage', 'db');
const storagePath = path.join(__dirname, '..', 'storage', 'audio');
const dbPath = path.join(dbDir, 'meetings.db');
fs.mkdirSync(dbDir, { recursive: true });
fs.mkdirSync(storagePath, { recursive: true });

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

  // Nueva tabla: resúmenes progresivos por sección
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
});

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

// LLM con retry y modelo configurable
const callLLM = async (prompt, model = 'llama-3.1-8b-instant', retries = 2) => {
  for (let i = 0; i <= retries; i++) {
    try {
      const completion = await groq.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
      return completion.choices?.[0]?.message?.content || null;
    } catch (e) {
      if (e.status === 429 && i < retries) {
        console.warn(`Rate limit, esperando ${(i+1)*5}s...`);
        await sleep((i+1) * 5000);
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

// ─── Speaker Improvement (modelo rápido, por sección) ─────────────────────────
const improveSpeakersInSection = async (transcriptions, participantes = [], speakerRegistry = {}) => {
  if (!GROQ_API_KEY || transcriptions.length === 0) return transcriptions;

  const result = [...transcriptions];
  const knownNames = Object.values(speakerRegistry).filter(v => v && !v.startsWith('Speaker'));
  const hint = participantes.length > 0
    ? `Participantes conocidos: ${participantes.join(', ')}.`
    : knownNames.length > 0
      ? `Speakers identificados hasta ahora: ${knownNames.join(', ')}.`
      : '';

  for (let start = 0; start < transcriptions.length; start += SPEAKER_BATCH) {
    const batch = transcriptions.slice(start, start + SPEAKER_BATCH);
    const lines = batch.map((t, i) => `[${start + i}]: ${t.text}`).join('\n');

    const prompt = `Eres un experto en diarización de reuniones. ${hint}

Asigna quién habla en cada línea numerada. Detecta cambios de speaker por:
- Preguntas y respuestas (distintos speakers)
- Cambios de perspectiva o tema
- Referencias a otros ("como dijo X...", "¿Y tú qué opinas?")
- Cambios de rol (quien dirige vs quien reporta)

REGLAS:
- Si puedes inferir el nombre real del participante, úsalo
- Si no, usa Speaker1, Speaker2, etc. (CONSISTENTE con speakers previos si los conoces)
- NO inventes nombres que no estén en el audio

Responde SOLO JSON: {"lines": [{"index": N, "speaker": "Nombre"}]}

Transcripción:
${lines}`;

    try {
      const raw = await callLLM(prompt, 'llama-3.1-8b-instant');
      const parsed = parseJSON(raw);
      const linesOut = Array.isArray(parsed?.lines) ? parsed.lines : [];
      for (const line of linesOut) {
        if (line.index >= 0 && line.index < result.length && line.speaker) {
          result[line.index] = { ...result[line.index], speaker: line.speaker };
          // Actualizar registry
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

// ─── Resumen de Sección (modelo rápido) ──────────────────────────────────────
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

        // Obtener participantes del meeting
        db.get('SELECT participantes FROM meetings WHERE id = ?', [meetingId], async (_, meeting) => {
          let participantes = [];
          try { participantes = JSON.parse(meeting?.participantes || '[]'); } catch(_) {}

          // Mejorar speakers en esta sección
          const improved = await improveSpeakersInSection(transcriptions, participantes);

          // Guardar speakers mejorados
          for (let i = 0; i < improved.length; i++) {
            if (improved[i].speaker !== transcriptions[i].speaker) {
              db.run('UPDATE transcriptions SET speaker = ? WHERE id = ?',
                [improved[i].speaker, transcriptions[i].id]);
            }
          }

          const transcript = improved.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
          const sectionMinStart = fromChunk * 1.5; // aprox minutos (chunks de 90s)
          const sectionMinEnd = (toChunk + 1) * 1.5;

          const prompt = `Analiza la sección ${sectionNum} (min ~${Math.round(sectionMinStart)}-${Math.round(sectionMinEnd)}) de esta reunión.

Extrae en JSON COMPACTO solo lo verdaderamente importante:
{
  "temas": ["tema breve 1", "tema breve 2"],
  "decisiones": ["decisión concreta tomada"],
  "tareas": [
    {"tarea": "descripción específica y accionable", "quien": "nombre o vacío", "cuando": "fecha mencionada o vacío"}
  ],
  "resumen": "2-3 frases densas con el núcleo de esta sección"
}

CRÍTICO para tareas:
- SOLO compromisos EXPLÍCITOS: "Juan va a enviar X el viernes", "María prepara el documento"
- NUNCA tareas vagas: "revisar", "mejorar", "continuar", "seguir trabajando"
- Si no hay tareas concretas, deja el array vacío

Transcripción:
${transcript}

Responde SOLO JSON válido.`;

          try {
            const raw = await callLLM(prompt, 'llama-3.1-8b-instant');
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

// Verificar si toca generar sección tras procesar un chunk
const checkAndTriggerSectionSummary = (meetingId) => {
  db.get(
    `SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ? AND processed = 1`,
    [meetingId],
    (err, row) => {
      const processed = row?.cnt || 0;
      if (processed > 0 && processed % SECTION_SIZE === 0) {
        const sectionNum = Math.floor(processed / SECTION_SIZE);
        const fromChunk = (sectionNum - 1) * SECTION_SIZE;
        const toChunk = sectionNum * SECTION_SIZE - 1;
        // Solo si no existe ya
        db.get(
          `SELECT id FROM section_summaries WHERE meeting_id = ? AND section_num = ?`,
          [meetingId, sectionNum],
          (_, existing) => {
            if (!existing) {
              console.log(`[${meetingId}] Disparando resumen sección ${sectionNum} (chunks ${fromChunk}-${toChunk})`);
              generateSectionSummary(meetingId, sectionNum, fromChunk, toChunk)
                .catch(e => console.error('Error sección:', e.message));
            }
          }
        );
      }
    }
  );
};

// ─── Generación de Acta Final (combina secciones) ───────────────────────────
const generateActaFromSections = async (meetingId, meta, fechaDefault) => {
  return new Promise((resolve, reject) => {
    // Obtener todos los resúmenes de sección
    db.all(
      `SELECT section_num, from_chunk, to_chunk, summary_json
       FROM section_summaries WHERE meeting_id = ? ORDER BY section_num`,
      [meetingId],
      async (err, sections) => {
        if (err) return reject(err);

        let actaJson = null;

        if (sections.length > 0) {
          // Combinar secciones en input compacto para LLM
          const sectionInputs = sections.map((s, i) => {
            const sum = parseJSON(s.summary_json) || {};
            const minStart = Math.round(s.from_chunk * 1.5);
            const minEnd = Math.round((s.to_chunk + 1) * 1.5);
            return `--- SECCIÓN ${i+1} (min ${minStart}-${minEnd}) ---
Temas: ${(sum.temas || []).join(', ')}
Decisiones: ${(sum.decisiones || []).join('; ')}
Tareas: ${JSON.stringify(sum.tareas || [])}
Resumen: ${sum.resumen || ''}`;
          }).join('\n\n');

          const allTareas = sections.flatMap(s => {
            const sum = parseJSON(s.summary_json) || {};
            return (sum.tareas || []).map(t => ({
              descripcion: t.tarea || t.descripcion || '',
              responsable: t.quien || t.responsable || '',
              fecha_compromiso: t.cuando || t.fecha_compromiso || ''
            }));
          });

          const prompt = `Genera el acta final de esta reunión combinando los resúmenes de ${sections.length} secciones.

DATOS DE IDENTIFICACIÓN (usa EXACTAMENTE estos):
cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}",
participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}",
hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}"

RESÚMENES POR SECCIÓN:
${sectionInputs}

TODAS LAS TAREAS IDENTIFICADAS (consolida duplicados):
${JSON.stringify(allTareas, null, 2)}

Genera JSON:
{
  "identificacion": {
    "cliente": "", "proyecto": "", "fecha": "", "hora_inicio": "",
    "hora_fin": "", "responsable": "", "participantes": []
  },
  "tareas_anteriores": [],
  "tareas_nuevas": [
    {"id": "tarea_1", "descripcion": "descripción clara", "responsable": "nombre", "fecha_compromiso": "${fechaDefault}"}
  ],
  "resumen_reunion": "Resumen fluido y coherente de toda la reunión en 4-6 frases, capturando objetivos, temas tratados y conclusiones principales.",
  "observaciones_generales": ""
}

REGLAS CRÍTICAS:
1. resumen_reunion: narrativo y útil, no una lista. Captura el arco completo de la reunión.
2. tareas_nuevas:
   - CONSOLIDA tareas similares en una sola
   - ELIMINA duplicados entre secciones
   - SOLO tareas específicas y accionables (NO "revisar", "mejorar", "continuar")
   - fecha_compromiso: usa fecha mencionada o "${fechaDefault}"
   - IDs secuenciales: tarea_1, tarea_2...
   - Máximo 15 tareas, prioriza las más importantes
3. tareas_anteriores: solo si se mencionaron explícitamente tareas de reuniones previas

Responde SOLO JSON válido.`;

          try {
            const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
            actaJson = parseJSON(raw);
          } catch (e) {
            console.error(`Error acta desde secciones:`, e.message);
          }
        }

        // Si no hay secciones o falló, intentar desde transcripción cruda
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

        // Forzar identificación correcta
        actaJson.identificacion = { ...meta };
        resolve(actaJson);
      }
    );
  });
};

// Fallback: acta desde transcripción cruda (para reuniones cortas sin secciones)
const generateActaFromRawTranscript = async (meetingId, meta, fechaDefault) => {
  return new Promise((resolve) => {
    db.all(
      `SELECT speaker, text, chunk_number FROM transcriptions
       WHERE meeting_id = ? ORDER BY chunk_number, id`,
      [meetingId],
      async (err, rows) => {
        if (err || rows.length === 0) return resolve(null);

        const fullTranscript = rows.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
        const wordCount = fullTranscript.split(/\s+/).length;

        let prompt;
        if (wordCount > WORDS_PER_CHUNK) {
          // Map-reduce para transcripciones largas sin secciones previas
          const words = fullTranscript.split(/\s+/);
          const sectionTexts = [];
          for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
            sectionTexts.push(words.slice(i, i + WORDS_PER_CHUNK).join(' '));
          }

          const extracts = [];
          for (let i = 0; i < sectionTexts.length; i++) {
            const raw = await callLLM(
              `Extrae de esta sección de reunión en JSON: {"temas": [], "tareas": [{"tarea":"","quien":"","cuando":""}], "resumen": ""}

Sección:
${sectionTexts[i]}

SOLO JSON válido.`,
              'llama-3.1-8b-instant'
            ).catch(() => null);
            if (raw) { const p = parseJSON(raw); if (p) extracts.push(p); }
            if (i < sectionTexts.length - 1) await sleep(1500);
          }

          const allTareas = extracts.flatMap(e => e.tareas || []);
          const resumenes = extracts.map((e,i) => `Parte ${i+1}: ${e.resumen||''}`).join('\n');

          prompt = `Genera acta de reunión en JSON.
IDENTIFICACIÓN (usa exactamente): cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}", participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}", hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}"

RESÚMENES: ${resumenes}
TAREAS IDENTIFICADAS: ${JSON.stringify(allTareas)}

JSON: {"identificacion":{...},"tareas_anteriores":[],"tareas_nuevas":[{"id":"tarea_1","descripcion":"","responsable":"","fecha_compromiso":"${fechaDefault}"}],"resumen_reunion":"","observaciones_generales":""}

REGLAS tareas: consolida duplicados, máximo 15, solo concretas y específicas.
SOLO JSON válido.`;
        } else {
          prompt = `Genera acta de reunión en JSON.
IDENTIFICACIÓN (usa exactamente): cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}", participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}", hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}"

JSON: {"identificacion":{...},"tareas_anteriores":[],"tareas_nuevas":[{"id":"tarea_1","descripcion":"","responsable":"","fecha_compromiso":"${fechaDefault}"}],"resumen_reunion":"","observaciones_generales":""}

REGLAS tareas:
- SOLO tareas EXPLÍCITAS y CONCRETAS del texto
- NO genéricas ("revisar", "mejorar"). Máximo 15, IDs secuenciales.
- fecha_compromiso: fecha mencionada o "${fechaDefault}"

Transcripción:
${fullTranscript}

SOLO JSON válido.`;
        }

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

// ─── Función principal de post-proceso al terminar reunión ─────────────────────
const finalizeMeeting = async (meetingId) => {
  db.get(
    `SELECT cliente, proyecto, responsable, participantes, started_at, ended_at FROM meetings WHERE id = ?`,
    [meetingId],
    async (err, meeting) => {
      if (err || !meeting) return;

      let participantes = [];
      try { participantes = JSON.parse(meeting.participantes || '[]'); } catch(_) {}

      // Esperar a que terminen los chunks en vuelo (máx 30s)
      let waited = 0;
      while (waited < 30000) {
        const pending = await new Promise(resolve =>
          db.get('SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ? AND processed = 0',
            [meetingId], (_, r) => resolve(r?.cnt || 0)));
        if (pending === 0) break;
        await sleep(2000);
        waited += 2000;
      }

      // Generar sección final con los chunks restantes no cubiertos por secciones previas
      const lastSectionRow = await new Promise(resolve =>
        db.get('SELECT MAX(to_chunk) as lastCovered FROM section_summaries WHERE meeting_id = ?',
          [meetingId], (_, r) => resolve(r)));
      const lastCovered = lastSectionRow?.lastCovered ?? -1;

      const lastChunkRow = await new Promise(resolve =>
        db.get('SELECT MAX(chunk_number) as lastChunk FROM chunks WHERE meeting_id = ? AND processed = 1',
          [meetingId], (_, r) => resolve(r)));
      const lastChunk = lastChunkRow?.lastChunk;

      if (lastChunk !== null && lastChunk !== undefined && lastChunk > lastCovered) {
        // Hay chunks sin cubrir → generar sección final
        const sectionsCount = await new Promise(resolve =>
          db.get('SELECT COUNT(*) as cnt FROM section_summaries WHERE meeting_id = ?',
            [meetingId], (_, r) => resolve(r?.cnt || 0)));

        console.log(`[${meetingId}] Generando sección final (chunks ${lastCovered+1}-${lastChunk})`);
        await generateSectionSummary(meetingId, sectionsCount + 1, lastCovered + 1, lastChunk);
      }

      // Construir meta
      const startedDate = meeting.started_at ? new Date(meeting.started_at) : null;
      const endedDate = meeting.ended_at ? new Date(meeting.ended_at) : null;
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

      // Generar acta final
      console.log(`[${meetingId}] Generando acta final...`);
      const actaJson = await generateActaFromSections(meetingId, meta, fechaDefault);
      actaJson.identificacion = { ...meta };

      // Guardar acta
      db.run('INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)',
        [meetingId, JSON.stringify(actaJson)]);

      // Guardar tareas
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

// ─── Transcripción Whisper ────────────────────────────────────────────────────
const processChunkWithWhisper = async (filePath, meetingId, chunkNumber, participantes = []) => {
  if (!GROQ_API_KEY) {
    db.run('UPDATE chunks SET processed = 2 WHERE meeting_id = ? AND chunk_number = ?', [meetingId, chunkNumber]);
    return null;
  }
  try {
    // Prompt para Whisper: ayuda con nombres propios y contexto
    const whisperPrompt = participantes.length > 0
      ? `Reunión de trabajo. Participantes: ${participantes.join(', ')}.`
      : 'Reunión de trabajo en español.';

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json',
      language: 'es',          // Hint de idioma → más preciso y rápido
      prompt: whisperPrompt    // Ayuda con nombres propios
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

    db.run('UPDATE chunks SET processed = 1 WHERE meeting_id = ? AND chunk_number = ?',
      [meetingId, chunkNumber], () => {
        // Verificar si toca generar resumen de sección
        checkAndTriggerSectionSummary(meetingId);
      });

    return transcription;
  } catch (error) {
    const code = error.status === 429 ? 2 : -1;
    if (error.status === 429) console.warn(`Rate limit Whisper - chunk ${chunkNumber}`);
    else console.error('Error Whisper:', error.message);
    db.run('UPDATE chunks SET processed = ? WHERE meeting_id = ? AND chunk_number = ?',
      [code, meetingId, chunkNumber]);
    return null;
  }
};

// ─── Rutas ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), hasGroqKey: Boolean(GROQ_API_KEY) });
});

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
      res.json({ meetingId, status: 'ended' });
      console.log(`[${meetingId}] Reunión finalizada. Iniciando post-proceso...`);
      finalizeMeeting(meetingId).catch(e => console.error('Error finalizeMeeting:', e.message));
    }
  );
});

app.post('/chunk', upload.single('audio'), async (req, res) => {
  const { meetingId, chunkNumber } = req.body;
  if (!meetingId || chunkNumber === undefined || !req.file)
    return res.status(400).json({ error: 'Missing fields' });

  const audioDir = path.join(storagePath, meetingId);
  const filePath = path.join(audioDir, `chunk_${chunkNumber}.webm`);
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(filePath, req.file.buffer);

  // Obtener participantes para Whisper prompt
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

// Endpoint de progreso para el frontend
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

// ── Reunión desde texto manual — procesamiento directo sin chunks ──────────────
const generateActaFromText = async (texto, modo, meta, fechaDefault) => {
  // Prompts específicos por tipo de entrada
  const contextoPorModo = {
    notas: `El texto es un conjunto de NOTAS LIBRES tomadas durante o después de una reunión. 
Puede estar desordenado, con abreviaciones, bullets o párrafos mezclados.
Tu trabajo es interpretar el contenido y estructurarlo en un acta profesional.`,
    transcripcion: `El texto es una TRANSCRIPCIÓN de reunión, con diálogos entre participantes.
Puede tener formato [Nombre]: texto o simplemente diálogo libre.
Identifica los speakers y extrae los compromisos de cada uno.`,
    email: `El texto es un EMAIL o MENSAJE DE RESUMEN enviado después de la reunión.
Extrae los compromisos, acuerdos y pendientes mencionados.
El autor del email generalmente es el moderador o responsable.`,
  };

  const contexto = contextoPorModo[modo] || contextoPorModo.notas;
  const wordCount = texto.split(/\s+/).length;

  // Para textos muy largos, hacer map-reduce primero
  if (wordCount > 3000) {
    console.log(`Texto largo (${wordCount} palabras) - usando map-reduce...`);
    const words = texto.split(/\s+/);
    const sections = [];
    for (let i = 0; i < words.length; i += 2500) {
      sections.push(words.slice(i, i + 2500).join(' '));
    }
    const extracts = [];
    for (let i = 0; i < sections.length; i++) {
      const raw = await callLLM(
        `Analiza esta sección de reunión y extrae en JSON:
{"temas": ["tema"], "decisiones": ["decisión"], "tareas": [{"tarea":"acción concreta","quien":"nombre","cuando":"fecha"}], "resumen": "2-3 frases"}

CRÍTICO: solo tareas EXPLÍCITAS con acción concreta. NO genéricas.

Texto: ${sections[i]}

SOLO JSON válido.`,
        'llama-3.1-8b-instant'
      ).catch(() => null);
      if (raw) { const p = parseJSON(raw); if (p) extracts.push(p); }
      if (i < sections.length - 1) await sleep(1200);
    }
    // Combinar extracts
    texto = extracts.map((e, i) =>
      `Sección ${i+1}: ${e.resumen || ''} | Tareas: ${JSON.stringify(e.tareas || [])}`
    ).join('\n');
  }

  const prompt = `Eres un asistente experto en redacción de actas de reunión.

TIPO DE ENTRADA: ${contexto}

DATOS DE IDENTIFICACIÓN (usa EXACTAMENTE estos valores, no los cambies):
- cliente: "${meta.cliente}"
- proyecto: "${meta.proyecto}"  
- responsable: "${meta.responsable}"
- participantes: ${JSON.stringify(meta.participantes)}
- fecha: "${meta.fecha}"
- hora_inicio: "${meta.hora_inicio}"
- hora_fin: "${meta.hora_fin}"

TEXTO DE LA REUNIÓN:
${texto}

Genera el acta en este JSON exacto:
{
  "identificacion": {
    "cliente": "",
    "proyecto": "",
    "fecha": "",
    "hora_inicio": "",
    "hora_fin": "",
    "responsable": "",
    "participantes": []
  },
  "tareas_anteriores": [],
  "tareas_nuevas": [
    {
      "id": "tarea_1",
      "descripcion": "Descripción clara y específica de la acción a realizar",
      "responsable": "Nombre de quien debe ejecutarla",
      "fecha_compromiso": "${fechaDefault}"
    }
  ],
  "resumen_reunion": "",
  "observaciones_generales": ""
}

REGLAS CRÍTICAS — léelas con atención:

Para "resumen_reunion":
- Escribe 3-5 frases fluidas y narrativas que cuenten qué pasó en la reunión
- Incluye: objetivo de la reunión, temas principales tratados, decisiones tomadas
- NO hagas listas, escribe en prosa como un párrafo ejecutivo
- Debe ser útil para alguien que no asistió

Para "tareas_nuevas":
- SOLO tareas EXPLÍCITAS: "Juan va a enviar el informe", "María prepara el documento"  
- NUNCA tareas vagas: "revisar", "mejorar", "continuar", "hacer seguimiento", "coordinar" (sin objeto concreto)
- Cada tarea debe tener UN responsable claro (si no se menciona, deja vacío)
- fecha_compromiso: usa la fecha específica mencionada, o "${fechaDefault}" si no se menciona
- IDs secuenciales: tarea_1, tarea_2, tarea_3...
- Máximo 15 tareas. Si hay más, prioriza las más importantes y urgentes
- Consolida tareas duplicadas o muy similares en una sola

Para "tareas_anteriores":
- Solo si el texto menciona EXPLÍCITAMENTE pendientes de reuniones anteriores
- Si no hay mención, deja el array vacío []

Para "observaciones_generales":
- Notas adicionales relevantes que no encajen en el resumen
- Puede estar vacío si no hay nada adicional

RESPONDE SOLO CON EL JSON VÁLIDO, sin texto antes ni después.`;

  const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
  return parseJSON(raw);
};

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
    [meetingId, user_id, 'procesando', startedAt, endedAt, cliente, proyecto, responsable, participantesStr],
    async err => {
      if (err) return res.status(500).json({ error: err.message });

      // Guardar texto como transcripción para verlo en la UI
      insertTextAsTranscription(meetingId, texto.trim(), 0);

      // Responder inmediatamente
      res.json({ meetingId, status: 'procesando', message: 'Procesando...' });

      // Procesar en segundo plano
      try {
        const startedDate = new Date(startedAt);
        const endedDate = new Date(endedAt);
        const meta = {
          cliente, proyecto, responsable,
          participantes: participantesArr,
          fecha: startedDate.toISOString().split('T')[0],
          hora_inicio: hora_inicio || `${String(startedDate.getHours()).padStart(2,'0')}:${String(startedDate.getMinutes()).padStart(2,'0')}`,
          hora_fin: hora_fin || `${String(endedDate.getHours()).padStart(2,'0')}:${String(endedDate.getMinutes()).padStart(2,'0')}`,
        };
        const fechaDefault = addBusinessDays(meta.fecha, 3);

        console.log(`[${meetingId}] Generando acta desde texto (modo: ${modo}, ${texto.split(/\s+/).length} palabras)...`);
        let actaJson = await generateActaFromText(texto.trim(), modo, meta, fechaDefault);

        if (!actaJson) {
          actaJson = {
            identificacion: { ...meta },
            tareas_anteriores: [], tareas_nuevas: [],
            resumen_reunion: 'No se pudo generar el acta automáticamente. Revisa el texto ingresado.',
            observaciones_generales: ''
          };
        }

        // Forzar identificación correcta
        actaJson.identificacion = { ...meta };

        // Guardar acta
        db.run('INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)',
          [meetingId, JSON.stringify(actaJson)]);

        // Guardar tareas
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

        // Marcar como terminado
        db.run('UPDATE meetings SET status = ? WHERE id = ?', ['ended', meetingId]);
        console.log(`[${meetingId}] ✅ Acta lista. ${actaJson.tareas_nuevas?.length||0} tareas.`);
      } catch (e) {
        console.error(`[${meetingId}] Error procesando texto:`, e.message);
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

const insertTextAsTranscription = (meetingId, texto, startChunk) => {
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

// ── Rutas de consulta ──────────────────────────────────────────────────────────
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
  db.get('SELECT acta_json FROM actas WHERE meeting_id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Acta not found' });
    res.json(JSON.parse(row.acta_json));
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
