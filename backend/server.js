require('dotenv').config();
const express  = require('express');
const sqlite3  = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const cors     = require('cors');
const OpenAI   = require('openai');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => { console.log(`${new Date().toISOString()} ${req.method} ${req.path}`); next(); });

// ─── Config ───────────────────────────────────────────────────────────────────
const SECTION_SIZE    = 12;
const WORDS_PER_CHUNK = 2500;
const SPEAKER_BATCH   = 60;

const dbDir          = path.join(__dirname, '..', 'storage', 'db');
const storagePath    = path.join(__dirname, '..', 'storage', 'audio');
const attachmentPath = path.join(__dirname, '..', 'storage', 'attachments');
const dbPath         = path.join(dbDir, 'meetings.db');
fs.mkdirSync(dbDir,          { recursive: true });
fs.mkdirSync(storagePath,    { recursive: true });
fs.mkdirSync(attachmentPath, { recursive: true });

// ─── Auth ─────────────────────────────────────────────────────────────────────
const JWT_SECRET   = process.env.JWT_SECRET   || 'meeting-secret-change-in-production';
const APP_PASSWORD = process.env.APP_PASSWORD || 'actas2025';

const hashPwd = (pwd) => crypto.createHash('sha256').update(pwd + JWT_SECRET).digest('hex');

const authMiddleware = (req, res, next) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Autenticación requerida' });
  try { req.user = jwt.verify(h.split(' ')[1], JWT_SECRET); next(); }
  catch { return res.status(403).json({ error: 'Token inválido o expirado.' }); }
};

const clientAuthMiddleware = (req, res, next) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Autenticación requerida' });
  try {
    const decoded = jwt.verify(h.split(' ')[1], JWT_SECRET);
    if (decoded.role !== 'client') return res.status(403).json({ error: 'Acceso denegado' });
    req.client = decoded;
    next();
  } catch { return res.status(403).json({ error: 'Token inválido.' }); }
};

// ─── Base de datos ────────────────────────────────────────────────────────────
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY, user_id TEXT, status TEXT,
    started_at TEXT, ended_at TEXT, cliente TEXT,
    proyecto TEXT, responsable TEXT, participantes TEXT
  )`);
  // Columnas opcionales — ignorar error si ya existen
  ['cliente','proyecto','responsable','participantes',
   'linked_meeting_id','terminology'].forEach(col =>
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
  db.run(`CREATE TABLE IF NOT EXISTS meeting_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL,
    content TEXT NOT NULL, author TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS meeting_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT NOT NULL,
    file_name TEXT NOT NULL, file_path TEXT NOT NULL, file_type TEXT NOT NULL,
    mime_type TEXT DEFAULT '', transcription TEXT,
    transcription_status TEXT DEFAULT 'pending',
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  // ── NUEVA TABLA: clientes del portal público ──────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
});

// ─── Groq ─────────────────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) console.warn('⚠️  GROQ_API_KEY no definida');
else console.log('Groq key:', GROQ_API_KEY.slice(0,10) + '...');

const groq   = new OpenAI({ apiKey: GROQ_API_KEY || 'dummy', baseURL: 'https://api.groq.com/openai/v1' });
const upload = multer({ storage: multer.memoryStorage() });

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

// ID de tarea con formato tarea_001, tarea_002...
const formatTaskId = (n) => `tarea_${String(n).padStart(3, '0')}`;

const callLLM = async (prompt, model = 'llama-3.3-70b-versatile', retries = 3) => {
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
        const w = (i + 1) * 8000;
        console.warn(`Rate limit, esperando ${w/1000}s...`);
        await sleep(w);
      } else { console.error('LLM error:', e.message); throw e; }
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

// ─── Cargar tareas de reunión anterior (linked meeting) ───────────────────────
const getLinkedTareas = async (linkedMeetingId) => {
  if (!linkedMeetingId) return [];
  return new Promise(resolve =>
    db.all(
      `SELECT t.*, m.cliente, m.proyecto, m.started_at
       FROM tareas t JOIN meetings m ON t.meeting_id = m.id
       WHERE t.meeting_id = ? AND t.tipo = 'nueva'
       ORDER BY t.id`,
      [linkedMeetingId],
      (_, rows) => resolve(rows || [])
    )
  );
};

// ─── Speaker Improvement ──────────────────────────────────────────────────────
const improveSpeakersInSection = async (transcriptions, participantes = [], terminology = '', speakerRegistry = {}) => {
  if (!GROQ_API_KEY || transcriptions.length === 0) return transcriptions;

  const result = [...transcriptions];
  const knownNames = Object.values(speakerRegistry).filter(v => v && !v.startsWith('Speaker'));

  const participantesHint = participantes.length > 0
    ? `PARTICIPANTES CONFIRMADOS: ${participantes.join(', ')}.
Cuando el contenido indique claramente quién habla, asigna su nombre EXACTO de esta lista.`
    : knownNames.length > 0
      ? `Speakers identificados previamente: ${knownNames.join(', ')}.`
      : '';

  for (let start = 0; start < transcriptions.length; start += SPEAKER_BATCH) {
    const batch = transcriptions.slice(start, start + SPEAKER_BATCH);
    const lines = batch.map((t, i) => `[${start + i}]: ${t.text}`).join('\n');

    const prompt = `Eres experto en diarización de audio de reuniones corporativas en español latinoamericano.

${participantesHint}

SEÑALES PARA DETECTAR CAMBIO DE SPEAKER:
- Preguntas seguidas de respuestas → siempre speakers distintos
- "Yo creo...", "Desde mi lado...", "En mi caso..." → cambio de persona
- Referencias a otro: "Como dijo Juan...", "¿Tú qué opinas, María?" → cambio
- Cambio de rol: quien reporta vs quien toma decisiones
- Transiciones temáticas iniciadas por alguien nuevo

REGLAS:
1. Asigna nombres de la lista de participantes cuando el contexto lo indique claramente
2. Si no puedes inferir el nombre, usa Speaker1, Speaker2... (CONSISTENTE en toda la sesión)
3. NUNCA inventes nombres fuera de la lista de participantes
4. Mantén consistencia: el mismo speaker = mismo nombre siempre

Responde SOLO JSON: {"lines": [{"index": N, "speaker": "Nombre"}]}

Transcripción:
${lines}`;

    try {
      const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
      const parsed = parseJSON(raw);
      const linesOut = Array.isArray(parsed?.lines) ? parsed.lines : [];
      for (const line of linesOut) {
        if (line.index >= 0 && line.index < result.length && line.speaker) {
          result[line.index] = { ...result[line.index], speaker: line.speaker };
          const orig = transcriptions[line.index]?.speaker;
          if (orig && !speakerRegistry[orig]) speakerRegistry[orig] = line.speaker;
        }
      }
    } catch (e) { console.warn(`Speaker batch ${start} falló:`, e.message); }
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
        db.get('SELECT participantes, cliente, proyecto, terminology FROM meetings WHERE id = ?', [meetingId], async (_, meeting) => {
          let participantes = [];
          try { participantes = JSON.parse(meeting?.participantes || '[]'); } catch(_) {}
          const terminology = meeting?.terminology || '';

          const improved = await improveSpeakersInSection(transcriptions, participantes, terminology);
          for (let i = 0; i < improved.length; i++) {
            if (improved[i].speaker !== transcriptions[i].speaker)
              db.run('UPDATE transcriptions SET speaker = ? WHERE id = ?', [improved[i].speaker, transcriptions[i].id]);
          }

          const transcript   = improved.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
          const minStart     = Math.round(fromChunk * 1.5);
          const minEnd       = Math.round((toChunk + 1) * 1.5);
          const clienteCtx   = [meeting?.cliente, meeting?.proyecto].filter(Boolean).join(' - ');

          const prompt = `Eres un asistente experto en análisis de reuniones corporativas en español.
${clienteCtx ? `Reunión de: ${clienteCtx}` : ''}

Analiza la SECCIÓN ${sectionNum} (minutos ~${minStart}–${minEnd}).

CRITERIOS ESTRICTOS DE EXTRACCIÓN:

"temas": temas REALES y específicos debatidos. Ej: "Revisión módulo de pagos v2.3" NO "Revisión de sistema"

"decisiones": SOLO acuerdos FIRMEMENTE tomados en esta sección. Ej: "Se aprobó lanzar en Q2" NO "Se habló del lanzamiento"

"tareas": ÚNICAMENTE compromisos EXPLÍCITOS con las 3 partes:
  ✅ VÁLIDO: {"tarea": "Enviar contrato actualizado al cliente", "quien": "Juan", "cuando": "viernes 28"}
  ✅ VÁLIDO: {"tarea": "Preparar demo del módulo de reportes", "quien": "María", "cuando": ""}
  ❌ INVÁLIDO: "Revisar el tema" — demasiado vago, no dice QUÉ exactamente
  ❌ INVÁLIDO: "Mejorar el proceso" — sin acción ni objeto concreto
  ❌ INVÁLIDO: "Hacer seguimiento" — sin objeto específico
  ❌ INVÁLIDO: "Continuar con el desarrollo" — sin hito concreto
  REGLA: si no puedes describir QUÉ exactamente se hará, NO es una tarea válida

"puntos_criticos": bloqueos, riesgos o alertas que requieren atención

"resumen": 3-4 frases narrativas y densas capturando la esencia de esta sección

JSON:
{
  "temas": ["tema específico"],
  "decisiones": ["decisión concreta"],
  "tareas": [{"tarea": "acción + objeto concreto", "quien": "nombre o vacío", "cuando": "fecha o vacío"}],
  "puntos_criticos": [],
  "resumen": "narrativa fluida"
}

Transcripción:
${transcript}

SOLO JSON válido.`;

          try {
            const raw     = await callLLM(prompt, 'llama-3.3-70b-versatile');
            const summary = parseJSON(raw);
            if (summary) {
              db.run(
                `INSERT OR REPLACE INTO section_summaries (meeting_id, section_num, from_chunk, to_chunk, summary_json)
                 VALUES (?, ?, ?, ?, ?)`,
                [meetingId, sectionNum, fromChunk, toChunk, JSON.stringify(summary)],
                () => { console.log(`[${meetingId}] Sección ${sectionNum} OK`); resolve(summary); }
              );
            } else resolve(null);
          } catch (e) { console.error(`Error sección ${sectionNum}:`, e.message); resolve(null); }
        });
      }
    );
  });
};

const checkAndTriggerSectionSummary = (meetingId) => {
  db.get(`SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ? AND processed = 1`, [meetingId], (err, row) => {
    const processed = row?.cnt || 0;
    if (processed > 0 && processed % SECTION_SIZE === 0) {
      const sectionNum = Math.floor(processed / SECTION_SIZE);
      const fromChunk  = (sectionNum - 1) * SECTION_SIZE;
      const toChunk    = sectionNum * SECTION_SIZE - 1;
      db.get(`SELECT id FROM section_summaries WHERE meeting_id = ? AND section_num = ?`, [meetingId, sectionNum], (_, existing) => {
        if (!existing) {
          console.log(`[${meetingId}] Disparando sección ${sectionNum}`);
          generateSectionSummary(meetingId, sectionNum, fromChunk, toChunk).catch(console.error);
        }
      });
    }
  });
};

// ─── Obtener suplementos (notas + audios transcritos) ─────────────────────────
const getMeetingSupplements = (meetingId) => {
  return Promise.all([
    new Promise(resolve =>
      db.all('SELECT * FROM meeting_notes WHERE meeting_id = ? ORDER BY created_at', [meetingId], (_, r) => resolve(r || []))),
    new Promise(resolve =>
      db.all(`SELECT file_name, transcription FROM meeting_attachments
              WHERE meeting_id = ? AND transcription_status = 'done' AND transcription IS NOT NULL AND transcription != ''`,
        [meetingId], (_, r) => resolve(r || [])))
  ]).then(([notes, audioTranscriptions]) => ({ notes, audioTranscriptions }));
};

// ─── Esperar a que los audios adjuntos terminen de transcribir ────────────────
const waitForAudioAttachments = async (meetingId, maxWaitMs = 5 * 60 * 1000) => {
  let waited = 0;
  while (waited < maxWaitMs) {
    const pending = await new Promise(resolve =>
      db.get(
        `SELECT COUNT(*) as cnt FROM meeting_attachments
         WHERE meeting_id = ? AND file_type = 'audio' AND transcription_status IN ('pending','processing')`,
        [meetingId], (_, r) => resolve(r?.cnt || 0)
      )
    );
    if (pending === 0) break;
    console.log(`[${meetingId}] Esperando ${pending} audio(s) adjunto(s)...`);
    await sleep(5000);
    waited += 5000;
  }
};

// ─── Prompt helper: construir bloque de fuentes adicionales ───────────────────
const buildSupplementsBlock = (notes, audioTranscriptions) => {
  let block = '';
  if (notes.length > 0) {
    block += `\n\n═══════════════════════════════════════
NOTAS APORTADAS POR PARTICIPANTES (${notes.length})
═══════════════════════════════════════
${notes.map(n => `• ${n.author ? `[${n.author}]: ` : ''}${n.content}`).join('\n')}`;
  }
  if (audioTranscriptions.length > 0) {
    block += `\n\n═══════════════════════════════════════
AUDIOS DE PARTICIPANTES TRANSCRITOS (${audioTranscriptions.length})
═══════════════════════════════════════
${audioTranscriptions.map(a => `--- Archivo: ${a.file_name} ---\n${a.transcription}`).join('\n\n')}`;
  }
  return block;
};

// ─── Deduplicar tareas ────────────────────────────────────────────────────────
const deduplicateTareas = (tareas) => {
  const seen    = new Set();
  const result  = [];
  for (const t of tareas) {
    const desc = (t.descripcion || t.tarea || '').trim().toLowerCase();
    if (!desc || desc.length < 8) continue;
    // Normalizar: quitar stopwords y comparar primeras 40 chars
    const key = desc.replace(/\b(el|la|los|las|un|una|de|del|al|y|o|en|que|se|por|con|para)\b/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(t);
  }
  return result;
};

// ─── Generar acta final ───────────────────────────────────────────────────────
const generateActaFromSections = async (meetingId, meta, fechaDefault, tareasAnteriores = []) => {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT section_num, from_chunk, to_chunk, summary_json
       FROM section_summaries WHERE meeting_id = ? ORDER BY section_num`,
      [meetingId],
      async (err, sections) => {
        if (err) return reject(err);

        const { notes, audioTranscriptions } = await getMeetingSupplements(meetingId);
        const suppBlock = buildSupplementsBlock(notes, audioTranscriptions);
        const hasSupplement = notes.length > 0 || audioTranscriptions.length > 0;

        let actaJson = null;

        if (sections.length > 0) {
          const sectionInputs = sections.map((s, i) => {
            const sum      = parseJSON(s.summary_json) || {};
            const minStart = Math.round(s.from_chunk * 1.5);
            const minEnd   = Math.round((s.to_chunk + 1) * 1.5);
            const criticos = (sum.puntos_criticos || []).length > 0 ? `\nAlertas: ${sum.puntos_criticos.join('; ')}` : '';
            return `--- SECCIÓN ${i+1} (min ${minStart}-${minEnd}) ---
Temas: ${(sum.temas || []).join(', ')}
Decisiones: ${(sum.decisiones || []).join('; ')}
Tareas: ${JSON.stringify(sum.tareas || [])}
Resumen: ${sum.resumen || ''}${criticos}`;
          }).join('\n\n');

          const allTareasBruto = sections.flatMap(s => {
            const sum = parseJSON(s.summary_json) || {};
            return (sum.tareas || []).map(t => ({
              descripcion: (t.tarea || t.descripcion || '').trim(),
              responsable: (t.quien || t.responsable || '').trim(),
              fecha_compromiso: (t.cuando || t.fecha_compromiso || '').trim()
            }));
          });

          const tareasAntStr = tareasAnteriores.length > 0
            ? `\nTAREAS ANTERIORES (de la reunión previa, ya asignadas — NO las incluyas en tareas nuevas):
${tareasAnteriores.map(t => `• [${t.estado}] ${t.descripcion} (${t.responsable || 'sin responsable'})`).join('\n')}`
            : '';

          const prompt = `Eres un redactor ejecutivo especializado en actas de reunión corporativas en español.
Tu objetivo: acta COMPLETA, CONCRETA, ACCIONABLE — no genérica.

DATOS DE IDENTIFICACIÓN (copia EXACTAMENTE):
cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}",
participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}",
hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}"
${tareasAntStr}

═══════════════════════════════════════
FUENTE 1: TRANSCRIPCIÓN GRABADA (${sections.length} secciones)
═══════════════════════════════════════
${sectionInputs}
${suppBlock}

TAREAS DETECTADAS EN GRABACIÓN (pre-procesadas):
${JSON.stringify(allTareasBruto, null, 2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTRUCCIONES CRÍTICAS DE REDACCIÓN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

"resumen_reunion" — OBLIGATORIO:
  • 4-6 frases en prosa ejecutiva continua (NO listas, NO bullets)
  • Estructura: contexto/objetivo → temas debatidos → decisiones → próximos pasos
  • Integra información de notas y audios adicionales si existen
  • Debe ser útil para alguien que NO asistió
  • Ejemplo bueno: "La reunión tuvo como objetivo revisar el avance del sprint 4 del proyecto App Móvil. Se analizaron los módulos de login y pagos, donde Carlos identificó 3 bugs críticos que bloquean el lanzamiento. El equipo decidió priorizar la corrección de bugs antes del viernes. María y Carlos asumieron los compromisos de entregar las correcciones y la documentación respectivamente."

"tareas_nuevas" — FILTRO ESTRICTO:
  INCLUIR solo si tiene las 3 partes:
    ✅ ACCIÓN CONCRETA (verbo específico: enviar, preparar, corregir, implementar, revisar [con objeto])
    ✅ OBJETO ESPECÍFICO (qué exactamente: "el contrato de servicio", "el módulo de login", "el bug #123")
    ✅ IDENTIFICABLE (que alguien pueda ejecutarla sin pedir más explicaciones)

  EXCLUIR sin excepción:
    ❌ "Revisar el tema" — ¿qué tema? ¿revisar cómo?
    ❌ "Hacer seguimiento" — sin objeto concreto
    ❌ "Mejorar el proceso" — sin especificar qué proceso ni cómo
    ❌ "Continuar con el desarrollo" — sin hito o entregable concreto
    ❌ "Coordinar con el equipo" — sin decir qué se coordina
    ❌ Tareas ya listadas en "tareas_anteriores"

  CONSOLIDAR: si dos tareas dicen lo mismo con diferentes palabras, quedan como UNA sola
  RESPONSABLE: nombre de un participante, o vacío si no se mencionó explícitamente
  FECHA: fecha específica si se mencionó, si no: "${fechaDefault}"
  IDs: tarea_001, tarea_002, tarea_003... (siempre 3 dígitos)
  MÁXIMO: 15 tareas (prioriza las más importantes e impactantes)
${hasSupplement ? '\n  IMPORTANTE: incluye tareas detectadas en notas y audios adicionales si cumplen los criterios.' : ''}

"tareas_anteriores":
  ${tareasAnteriores.length > 0 ? `Incluye las ${tareasAnteriores.length} tareas anteriores listadas arriba con su estado actual.` : 'Array vacío [] — no hubo reunión previa vinculada.'}

"observaciones_generales":
  Bloqueos, riesgos, puntos de atención. Puede incluir info de fuentes adicionales no cubierta en resumen.

JSON exacto a retornar:
{
  "identificacion": {"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},
  "tareas_anteriores": [],
  "tareas_nuevas": [{"id":"tarea_001","descripcion":"acción + objeto concreto","responsable":"nombre","fecha_compromiso":"${fechaDefault}"}],
  "resumen_reunion": "narrativa ejecutiva de 4-6 frases...",
  "observaciones_generales": ""
}

RESPONDE SOLO JSON VÁLIDO, sin texto antes ni después.`;

          try {
            const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
            actaJson  = parseJSON(raw);
          } catch (e) { console.error('Error acta secciones:', e.message); }
        }

        if (!actaJson) {
          actaJson = await generateActaFromRawTranscript(meetingId, meta, fechaDefault, tareasAnteriores);
        }
        if (!actaJson) {
          actaJson = {
            identificacion: { ...meta }, tareas_anteriores: tareasAnteriores.map((t, i) => ({
              id: `ant_${String(i+1).padStart(3,'0')}`, descripcion: t.descripcion,
              responsable: t.responsable, estado: t.estado
            })),
            tareas_nuevas: [], resumen_reunion: 'No se pudo generar el acta.', observaciones_generales: ''
          };
        }
        actaJson.identificacion = { ...meta };
        // Normalizar IDs de tareas nuevas
        if (Array.isArray(actaJson.tareas_nuevas)) {
          actaJson.tareas_nuevas = actaJson.tareas_nuevas.map((t, i) => ({
            ...t, id: formatTaskId(i + 1)
          }));
        }
        resolve(actaJson);
      }
    );
  });
};

// Fallback: desde transcripción cruda
const generateActaFromRawTranscript = async (meetingId, meta, fechaDefault, tareasAnteriores = []) => {
  return new Promise((resolve) => {
    db.all(
      `SELECT speaker, text, chunk_number FROM transcriptions WHERE meeting_id = ? ORDER BY chunk_number, id`,
      [meetingId],
      async (err, rows) => {
        if (err || rows.length === 0) return resolve(null);
        const { notes, audioTranscriptions } = await getMeetingSupplements(meetingId);
        const suppBlock = buildSupplementsBlock(notes, audioTranscriptions);
        let transcriptInput = rows.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
        const wordCount = transcriptInput.split(/\s+/).length;

        if (wordCount > WORDS_PER_CHUNK) {
          const words = transcriptInput.split(/\s+/);
          const secs  = [];
          for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) secs.push(words.slice(i, i + WORDS_PER_CHUNK).join(' '));
          const extracts = [];
          for (let i = 0; i < secs.length; i++) {
            const raw = await callLLM(
              `Extrae de esta sección en JSON compacto:
{"temas":[],"decisiones":[],"tareas":[{"tarea":"","quien":"","cuando":""}],"resumen":""}
SOLO tareas EXPLÍCITAS con acción + objeto concreto. Texto: ${secs[i]}
SOLO JSON válido.`, 'llama-3.1-8b-instant'
            ).catch(() => null);
            if (raw) { const p = parseJSON(raw); if (p) extracts.push(p); }
            if (i < secs.length - 1) await sleep(1200);
          }
          transcriptInput = extracts.map((e,i) => `Sección ${i+1}: ${e.resumen||''} | Tareas: ${JSON.stringify(e.tareas||[])}`).join('\n');
        }

        const tareasAntStr = tareasAnteriores.length > 0
          ? `\nTAREAS ANTERIORES:\n${tareasAnteriores.map(t => `• [${t.estado}] ${t.descripcion}`).join('\n')}`
          : '';

        const prompt = `Genera acta de reunión en JSON.
DATOS: cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}", participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}", hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}"
${tareasAntStr}

TRANSCRIPCIÓN:
${transcriptInput}
${suppBlock}

JSON:
{
  "identificacion":{"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},
  "tareas_anteriores":[],
  "tareas_nuevas":[{"id":"tarea_001","descripcion":"acción + objeto concreto","responsable":"nombre","fecha_compromiso":"${fechaDefault}"}],
  "resumen_reunion":"4-6 frases narrativas ejecutivas. NO listas.",
  "observaciones_generales":""
}

REGLAS tareas: solo explícitas y concretas, consolida duplicados, máx 15, IDs tarea_001/002/003...
NO incluyas en tareas_nuevas las tareas ya listadas en tareas_anteriores.
RESPONDE SOLO JSON VÁLIDO.`;

        try {
          const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
          const parsed = parseJSON(raw);
          if (parsed && Array.isArray(parsed.tareas_nuevas)) {
            parsed.tareas_nuevas = parsed.tareas_nuevas.map((t, i) => ({ ...t, id: formatTaskId(i+1) }));
          }
          resolve(parsed);
        } catch (e) { console.error('Error acta raw:', e.message); resolve(null); }
      }
    );
  });
};

// ─── Finalizar reunión ────────────────────────────────────────────────────────
const finalizeMeeting = async (meetingId) => {
  db.get(
    `SELECT cliente, proyecto, responsable, participantes, started_at, ended_at, linked_meeting_id, terminology
     FROM meetings WHERE id = ?`,
    [meetingId],
    async (err, meeting) => {
      if (err || !meeting) return;
      let participantes = [];
      try { participantes = JSON.parse(meeting.participantes || '[]'); } catch(_) {}

      // 1. Esperar chunks en vuelo (máx 5 min)
      let waited = 0;
      while (waited < 5 * 60 * 1000) {
        const pending = await new Promise(resolve =>
          db.get('SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id = ? AND processed = 0', [meetingId], (_, r) => resolve(r?.cnt || 0)));
        if (pending === 0) break;
        await sleep(3000); waited += 3000;
      }

      // 2. Esperar audios adjuntos (máx 5 min adicionales)
      await waitForAudioAttachments(meetingId, 5 * 60 * 1000);

      // 3. Generar sección final
      const lastSectionRow = await new Promise(resolve =>
        db.get('SELECT MAX(to_chunk) as lastCovered FROM section_summaries WHERE meeting_id = ?', [meetingId], (_, r) => resolve(r)));
      const lastCovered = lastSectionRow?.lastCovered ?? -1;
      const lastChunkRow = await new Promise(resolve =>
        db.get('SELECT MAX(chunk_number) as lastChunk FROM chunks WHERE meeting_id = ? AND processed = 1', [meetingId], (_, r) => resolve(r)));
      const lastChunk = lastChunkRow?.lastChunk;

      if (lastChunk !== null && lastChunk !== undefined && lastChunk > lastCovered) {
        const sectionsCount = await new Promise(resolve =>
          db.get('SELECT COUNT(*) as cnt FROM section_summaries WHERE meeting_id = ?', [meetingId], (_, r) => resolve(r?.cnt || 0)));
        console.log(`[${meetingId}] Generando sección final (chunks ${lastCovered+1}-${lastChunk})`);
        await generateSectionSummary(meetingId, sectionsCount + 1, lastCovered + 1, lastChunk);
      }

      // 4. Cargar tareas anteriores (reunión vinculada)
      const tareasAnteriores = await getLinkedTareas(meeting.linked_meeting_id);

      const startedDate = meeting.started_at ? new Date(meeting.started_at) : null;
      const endedDate   = meeting.ended_at   ? new Date(meeting.ended_at)   : null;
      const meta = {
        cliente: meeting.cliente || '', proyecto: meeting.proyecto || '',
        responsable: meeting.responsable || '', participantes,
        fecha: startedDate ? startedDate.toISOString().split('T')[0] : '',
        hora_inicio: startedDate ? `${String(startedDate.getHours()).padStart(2,'0')}:${String(startedDate.getMinutes()).padStart(2,'0')}` : '',
        hora_fin: endedDate ? `${String(endedDate.getHours()).padStart(2,'0')}:${String(endedDate.getMinutes()).padStart(2,'0')}` : ''
      };
      const fechaDefault = addBusinessDays(meta.fecha || new Date().toISOString().split('T')[0], 3);

      // 5. Generar acta final
      console.log(`[${meetingId}] Generando acta final... (${tareasAnteriores.length} tareas anteriores)`);
      const actaJson = await generateActaFromSections(meetingId, meta, fechaDefault, tareasAnteriores);
      actaJson.identificacion = { ...meta };

      // 6. Inyectar tareas anteriores con estado correcto
      if (tareasAnteriores.length > 0) {
        actaJson.tareas_anteriores = tareasAnteriores.map((t, i) => ({
          id: `ant_${String(i+1).padStart(3,'0')}`,
          descripcion: t.descripcion, responsable: t.responsable,
          estado: t.estado, fecha_compromiso: t.fecha_compromiso || ''
        }));
      }

      // 7. Guardar acta
      db.run('INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)',
        [meetingId, JSON.stringify(actaJson)]);

      // 8. Guardar tareas nuevas deduplicadas con IDs tarea_001...
      db.run('DELETE FROM tareas WHERE meeting_id = ?', [meetingId], () => {
        // Primero guardar tareas anteriores
        tareasAnteriores.forEach(t => {
          db.run(
            'INSERT INTO tareas (meeting_id, tarea_id, tipo, descripcion, responsable, estado, fecha_compromiso) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [meetingId, t.tarea_id || uuidv4(), 'anterior', t.descripcion||'', t.responsable||'', t.estado||'pendiente', t.fecha_compromiso||'']
          );
        });
        // Luego tareas nuevas
        const tareasNuevasDedup = deduplicateTareas(actaJson.tareas_nuevas || []);
        tareasNuevasDedup.forEach((t, i) => {
          const taskId = formatTaskId(i + 1);
          db.run(
            'INSERT INTO tareas (meeting_id, tarea_id, tipo, descripcion, responsable, estado, fecha_compromiso) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [meetingId, taskId, 'nueva', (t.descripcion||'').trim(), (t.responsable||'').trim(), 'pendiente', t.fecha_compromiso || fechaDefault]
          );
        });
      });

      console.log(`[${meetingId}] ✅ Acta lista. ${actaJson.tareas_nuevas?.length||0} tareas nuevas.`);
    }
  );
};

// ─── Conversión audio ─────────────────────────────────────────────────────────
const convertToMp3 = async (inputPath) => {
  const outputPath = inputPath.replace(/\.(webm|wav|m4a|ogg|mp4|aac|flac)$/i, '.mp3');
  try {
    await execFileAsync('ffmpeg', ['-y', '-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', outputPath]);
    return outputPath;
  } catch (e) { console.error('ffmpeg error:', e.message); return null; }
};

// ─── Whisper: prompt mejorado con vocabulario ─────────────────────────────────
const buildWhisperPrompt = (participantes, cliente, proyecto, terminology) => {
  const parts = ['Reunión de trabajo en español.'];
  if (cliente || proyecto) parts.push(`Empresa/proyecto: ${[cliente, proyecto].filter(Boolean).join(' — ')}.`);
  if (participantes.length > 0) parts.push(`Participantes: ${participantes.join(', ')}.`);
  if (terminology) parts.push(`Términos clave: ${terminology}.`);
  parts.push('Transcribe en español. No traduzcas. Mantén nombres propios tal como suenan.');
  return parts.join(' ');
};

// ─── Transcripción Whisper ────────────────────────────────────────────────────
const processChunkWithWhisper = async (filePath, meetingId, chunkNumber, participantes = [], cliente = '', proyecto = '', terminology = '') => {
  if (!GROQ_API_KEY) {
    db.run('UPDATE chunks SET processed = 2 WHERE meeting_id = ? AND chunk_number = ?', [meetingId, chunkNumber]);
    return null;
  }

  let fileToSend = filePath;
  let mp3Path    = null;
  try {
    mp3Path = await convertToMp3(filePath);
    if (mp3Path && fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 1000) fileToSend = mp3Path;
  } catch (_) {}

  try {
    const fileSizeKB = fs.statSync(fileToSend).size / 1024;
    if (fileSizeKB < 1) {
      db.run('UPDATE chunks SET processed = 1 WHERE meeting_id = ? AND chunk_number = ?', [meetingId, chunkNumber]);
      return null;
    }

    const whisperPrompt = buildWhisperPrompt(participantes, cliente, proyecto, terminology);
    console.log(`[chunk ${chunkNumber}] Whisper: ${(fileSizeKB).toFixed(0)}KB | prompt: ${whisperPrompt.slice(0,80)}...`);

    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(fileToSend),
      model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json',
      language: 'es',
      prompt: whisperPrompt
    });

    const segments = Array.isArray(transcription.segments) ? transcription.segments : [];
    if (segments.length > 0) {
      let spkCounter = 1;
      const spkMap   = {};
      for (const seg of segments) {
        const key = seg.spk || seg.speaker || 'speaker';
        if (!spkMap[key]) spkMap[key] = `Speaker${spkCounter++}`;
        if ((seg.text || '').trim())
          db.run('INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
            [meetingId, chunkNumber, spkMap[key], seg.text.trim(), new Date().toISOString()]);
      }
      console.log(`[chunk ${chunkNumber}] ✅ ${segments.length} segmentos`);
    } else if (transcription.text?.trim()) {
      db.run('INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
        [meetingId, chunkNumber, 'Speaker1', transcription.text.trim(), new Date().toISOString()]);
      console.log(`[chunk ${chunkNumber}] ✅ texto plano`);
    } else {
      console.warn(`[chunk ${chunkNumber}] ⚠️ Sin texto (silencio o audio inaudible)`);
    }

    if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
    db.run('UPDATE chunks SET processed = 1 WHERE meeting_id = ? AND chunk_number = ?', [meetingId, chunkNumber],
      () => { checkAndTriggerSectionSummary(meetingId); });

    return transcription;
  } catch (error) {
    if (mp3Path && fs.existsSync(mp3Path)) try { fs.unlinkSync(mp3Path); } catch(_) {}
    const code = error.status === 429 ? 2 : -1;
    db.run('UPDATE chunks SET processed = ? WHERE meeting_id = ? AND chunk_number = ?', [code, meetingId, chunkNumber]);
    if (error.status === 429) {
      console.warn(`Rate limit Whisper chunk ${chunkNumber} — reintentando en 60s`);
      setTimeout(() => {
        db.run('UPDATE chunks SET processed = 0 WHERE meeting_id = ? AND chunk_number = ? AND processed = 2',
          [meetingId, chunkNumber], () => {
            db.get('SELECT cliente, proyecto, terminology, participantes FROM meetings WHERE id = ?', [meetingId], (_, m) => {
              let parts = [];
              try { parts = JSON.parse(m?.participantes || '[]'); } catch(_) {}
              processChunkWithWhisper(filePath, meetingId, chunkNumber, parts, m?.cliente||'', m?.proyecto||'', m?.terminology||'').catch(() => {});
            });
          });
      }, 60000);
    }
    return null;
  }
};

// ─── Transcripción de adjunto de audio ────────────────────────────────────────
const processAudioAttachment = async (attachmentId, filePath, meetingId, participantes = [], cliente = '', proyecto = '', terminology = '') => {
  if (!GROQ_API_KEY) {
    db.run('UPDATE meeting_attachments SET transcription_status = ? WHERE id = ?', ['error', attachmentId]);
    return;
  }
  db.run('UPDATE meeting_attachments SET transcription_status = ? WHERE id = ?', ['processing', attachmentId]);

  let fileToSend = filePath;
  let mp3Path    = null;
  try {
    mp3Path = await convertToMp3(filePath);
    if (mp3Path && fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 1000) fileToSend = mp3Path;
  } catch (_) {}

  try {
    const fileSizeKB = fs.statSync(fileToSend).size / 1024;
    if (fileSizeKB < 1) {
      db.run('UPDATE meeting_attachments SET transcription_status = ?, transcription = ? WHERE id = ?', ['done', '', attachmentId]);
      return;
    }
    const whisperPrompt = buildWhisperPrompt(participantes, cliente, proyecto, terminology);
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(fileToSend),
      model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json',
      language: 'es',
      prompt: whisperPrompt
    });
    let text = '';
    const segs = Array.isArray(transcription.segments) ? transcription.segments : [];
    if (segs.length > 0) text = segs.filter(s => (s.text||'').trim()).map(s => s.text.trim()).join(' ');
    else if (transcription.text?.trim()) text = transcription.text.trim();

    if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
    db.run('UPDATE meeting_attachments SET transcription_status = ?, transcription = ? WHERE id = ?', ['done', text, attachmentId]);
    console.log(`[adjunto ${attachmentId}] ✅ ${text.split(/\s+/).length} palabras`);
  } catch (error) {
    if (mp3Path && fs.existsSync(mp3Path)) try { fs.unlinkSync(mp3Path); } catch(_) {}
    console.error(`[adjunto ${attachmentId}] Error:`, error.message);
    db.run('UPDATE meeting_attachments SET transcription_status = ? WHERE id = ?', ['error', attachmentId]);
  }
};

// ─── Texto manual → acta ──────────────────────────────────────────────────────
const generateActaFromText = async (texto, modo, meta, fechaDefault, tareasAnteriores = []) => {
  const ctx = {
    notas: 'NOTAS LIBRES tomadas durante o después de una reunión. Puede estar desordenado.',
    transcripcion: 'TRANSCRIPCIÓN de reunión con diálogos. Identifica speakers y extrae compromisos.',
    email: 'EMAIL o MENSAJE DE RESUMEN post-reunión. Extrae compromisos y acuerdos.',
  };
  const wordCount = texto.split(/\s+/).length;
  let inputTexto  = texto;

  if (wordCount > 3000) {
    const words = texto.split(/\s+/);
    const secs  = [];
    for (let i = 0; i < words.length; i += 2500) secs.push(words.slice(i, i + 2500).join(' '));
    const extracts = [];
    for (let i = 0; i < secs.length; i++) {
      const raw = await callLLM(
        `Extrae en JSON: {"temas":[],"tareas":[{"tarea":"","quien":"","cuando":""}],"resumen":""}
SOLO tareas explícitas con acción+objeto concreto. Texto: ${secs[i]} SOLO JSON.`, 'llama-3.1-8b-instant').catch(() => null);
      if (raw) { const p = parseJSON(raw); if (p) extracts.push(p); }
      if (i < secs.length - 1) await sleep(1200);
    }
    inputTexto = extracts.map((e,i) => `Sección ${i+1}: ${e.resumen||''} | Tareas: ${JSON.stringify(e.tareas||[])}`).join('\n');
  }

  const tareasAntStr = tareasAnteriores.length > 0
    ? `\nTAREAS ANTERIORES:\n${tareasAnteriores.map(t => `• [${t.estado}] ${t.descripcion}`).join('\n')}`
    : '';

  const prompt = `Redactor experto en actas corporativas en español.
TIPO: ${ctx[modo] || ctx.notas}
DATOS: cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}", participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}", hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}"
${tareasAntStr}

CONTENIDO:
${inputTexto}

JSON:
{
  "identificacion":{"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},
  "tareas_anteriores":[],
  "tareas_nuevas":[{"id":"tarea_001","descripcion":"acción + objeto concreto","responsable":"nombre","fecha_compromiso":"${fechaDefault}"}],
  "resumen_reunion":"4-6 frases en prosa ejecutiva. NO listas. Objetivo→temas→decisiones→próximos pasos.",
  "observaciones_generales":""
}

REGLAS tareas nuevas: solo explícitas (acción+objeto), NO incluir las de tareas_anteriores, consolida duplicados, máx 15, IDs tarea_001/002/003...
RESPONDE SOLO JSON VÁLIDO.`;

  const raw    = await callLLM(prompt, 'llama-3.3-70b-versatile');
  const parsed = parseJSON(raw);
  if (parsed && Array.isArray(parsed.tareas_nuevas)) {
    parsed.tareas_nuevas = parsed.tareas_nuevas.map((t, i) => ({ ...t, id: formatTaskId(i+1) }));
  }
  return parsed;
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── RUTAS ────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ── Rutas públicas ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString(), hasGroqKey: Boolean(GROQ_API_KEY) }));

// Login admin
app.post('/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== APP_PASSWORD) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const token = jwt.sign({ role: 'admin', ts: Date.now() }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, expiresIn: '30d' });
});

// Login portal de cliente
app.post('/client-login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  db.get('SELECT * FROM clients WHERE LOWER(username) = LOWER(?) AND active = 1', [username], (err, client) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!client) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const ph = hashPwd(password);
    if (client.password_hash !== ph) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const token = jwt.sign({ role: 'client', client_id: client.id, client_name: client.name, username: client.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, client_name: client.name, expiresIn: '7d' });
  });
});

// Actas del portal de cliente (sin auth admin — usa token de cliente)
app.get('/client/actas', clientAuthMiddleware, (req, res) => {
  const clientName = req.client.client_name;
  db.all(
    `SELECT m.id, m.cliente, m.proyecto, m.responsable, m.started_at, m.ended_at, m.status,
            m.participantes, a.acta_json, a.created_at as acta_created_at
     FROM meetings m
     LEFT JOIN actas a ON a.meeting_id = m.id
     WHERE LOWER(m.cliente) = LOWER(?) AND m.status = 'ended' AND a.acta_json IS NOT NULL
     ORDER BY m.started_at DESC`,
    [clientName],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const result = rows.map(r => ({
        id: r.id, cliente: r.cliente, proyecto: r.proyecto,
        responsable: r.responsable, started_at: r.started_at, ended_at: r.ended_at,
        participantes: (() => { try { return JSON.parse(r.participantes || '[]'); } catch(_) { return []; } })(),
        acta: r.acta_json ? JSON.parse(r.acta_json) : null,
        acta_created_at: r.acta_created_at
      }));
      res.json(result);
    }
  );
});

// ── Auth middleware para rutas admin ──────────────────────────────────────────
app.use(authMiddleware);

// ── Rutas admin: gestión de clientes ─────────────────────────────────────────
app.get('/admin/clients', (req, res) => {
  db.all(
    `SELECT c.*, 
            (SELECT COUNT(*) FROM meetings WHERE LOWER(cliente) = LOWER(c.name)) as meeting_count
     FROM clients c ORDER BY c.name`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map(r => ({ ...r, password_hash: undefined })));
    }
  );
});

app.post('/admin/clients', (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Nombre, usuario y contraseña son requeridos' });
  const ph = hashPwd(password);
  db.run('INSERT INTO clients (name, username, password_hash) VALUES (?, ?, ?)', [name.trim(), username.trim().toLowerCase(), ph],
    function(err) {
      if (err) return res.status(err.message.includes('UNIQUE') ? 409 : 500).json({ error: err.message });
      res.json({ id: this.lastID, name, username: username.toLowerCase(), active: 1 });
    }
  );
});

app.put('/admin/clients/:id', (req, res) => {
  const { name, username, password, active } = req.body;
  const updates = [];
  const params  = [];
  if (name !== undefined)     { updates.push('name = ?');          params.push(name.trim()); }
  if (username !== undefined) { updates.push('username = ?');      params.push(username.trim().toLowerCase()); }
  if (password)               { updates.push('password_hash = ?'); params.push(hashPwd(password)); }
  if (active !== undefined)   { updates.push('active = ?');        params.push(active ? 1 : 0); }
  if (!updates.length) return res.status(400).json({ error: 'Nada que actualizar' });
  params.push(req.params.id);
  db.run(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`, params, err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.delete('/admin/clients/:id', (req, res) => {
  db.run('DELETE FROM clients WHERE id = ?', [req.params.id], err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ── Reuniones ─────────────────────────────────────────────────────────────────
app.post('/startMeeting', (req, res) => {
  const meetingId = uuidv4();
  const { user_id = 'default', cliente = '', proyecto = '', responsable = '', linked_meeting_id = null, terminology = '' } = req.body;
  const participantes = Array.isArray(req.body.participantes) ? JSON.stringify(req.body.participantes) : '[]';
  fs.mkdirSync(path.join(storagePath, meetingId), { recursive: true });
  db.run(
    'INSERT INTO meetings (id, user_id, status, started_at, cliente, proyecto, responsable, participantes, linked_meeting_id, terminology) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [meetingId, user_id, 'active', new Date().toISOString(), cliente, proyecto, responsable, participantes, linked_meeting_id, terminology],
    err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ meetingId, status: 'active' });
    }
  );
});

app.post('/endMeeting', (req, res) => {
  const { meetingId } = req.body;
  if (!meetingId) return res.status(400).json({ error: 'Missing meetingId' });
  db.run('UPDATE meetings SET status = ?, ended_at = ? WHERE id = ?', ['ended', new Date().toISOString(), meetingId], err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ meetingId, status: 'ended', actaStatus: 'processing' });
    finalizeMeeting(meetingId).catch(e => console.error('Error finalizeMeeting:', e.message));
  });
});

app.post('/chunk', upload.single('audio'), async (req, res) => {
  const { meetingId, chunkNumber } = req.body;
  if (!meetingId || chunkNumber === undefined || !req.file)
    return res.status(400).json({ error: 'Missing fields' });

  const audioDir = path.join(storagePath, meetingId);
  const filePath = path.join(audioDir, `chunk_${chunkNumber}.webm`);
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(filePath, req.file.buffer);

  db.get('SELECT participantes, cliente, proyecto, terminology FROM meetings WHERE id = ?', [meetingId], (_, meeting) => {
    let participantes = [];
    try { participantes = JSON.parse(meeting?.participantes || '[]'); } catch(_) {}
    db.run('INSERT INTO chunks (meeting_id, chunk_number, file_path, processed) VALUES (?, ?, ?, ?)',
      [meetingId, parseInt(chunkNumber), filePath, 0],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ chunkId: this.lastID, meetingId, chunkNumber: parseInt(chunkNumber) });
        processChunkWithWhisper(filePath, meetingId, parseInt(chunkNumber), participantes, meeting?.cliente||'', meeting?.proyecto||'', meeting?.terminology||'')
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
  ]).then(([chunksTotal, chunksProcessed, sectionsGenerated, transcriptionLines, status]) =>
    res.json({ chunksTotal, chunksProcessed, sectionsGenerated, transcriptionLines, status }));
});

// Obtener reuniones anteriores (para selector de linked meeting)
app.get('/meetings-for-link', (req, res) => {
  const { cliente } = req.query;
  let sql = `SELECT m.id, m.cliente, m.proyecto, m.responsable, m.started_at,
                    COUNT(t.id) as tareas_pendientes
             FROM meetings m
             LEFT JOIN tareas t ON t.meeting_id = m.id AND t.estado = 'pendiente' AND t.tipo = 'nueva'
             WHERE m.status = 'ended'`;
  const params = [];
  if (cliente) { sql += ` AND LOWER(m.cliente) = LOWER(?)`; params.push(cliente); }
  sql += ` GROUP BY m.id ORDER BY m.started_at DESC LIMIT 50`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ── Texto manual ──────────────────────────────────────────────────────────────
app.post('/meetings/from-text', async (req, res) => {
  const {
    user_id = 'default', cliente = '', proyecto = '', responsable = '',
    participantes: pRaw = [], texto = '', modo = 'notas',
    fecha = null, hora_inicio = '', hora_fin = '',
    linked_meeting_id = null, terminology = ''
  } = req.body;

  if (!texto || texto.trim().split(/\s+/).length < 10)
    return res.status(400).json({ error: 'Necesitas al menos 10 palabras.' });

  const meetingId       = uuidv4();
  const participantesArr = Array.isArray(pRaw) ? pRaw : pRaw.toString().split(/[,;]/).map(p => p.trim()).filter(Boolean);
  const startedAt = fecha ? new Date(`${fecha}T${hora_inicio || '09:00'}:00`).toISOString() : new Date().toISOString();
  const endedAt   = fecha && hora_fin ? new Date(`${fecha}T${hora_fin}:00`).toISOString() : new Date().toISOString();

  db.run(
    'INSERT INTO meetings (id, user_id, status, started_at, ended_at, cliente, proyecto, responsable, participantes, linked_meeting_id, terminology) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [meetingId, user_id, 'ended', startedAt, endedAt, cliente, proyecto, responsable, JSON.stringify(participantesArr), linked_meeting_id, terminology],
    async err => {
      if (err) return res.status(500).json({ error: err.message });
      insertTextAsTranscription(meetingId, texto.trim(), 0);
      res.json({ meetingId, status: 'ended', message: 'Procesando...' });

      try {
        const startedDate = new Date(startedAt);
        const endedDate   = new Date(endedAt);
        const meta = {
          cliente, proyecto, responsable, participantes: participantesArr,
          fecha: startedDate.toISOString().split('T')[0],
          hora_inicio: hora_inicio || `${String(startedDate.getHours()).padStart(2,'0')}:${String(startedDate.getMinutes()).padStart(2,'0')}`,
          hora_fin: hora_fin || `${String(endedDate.getHours()).padStart(2,'0')}:${String(endedDate.getMinutes()).padStart(2,'0')}`,
        };
        const fechaDefault   = addBusinessDays(meta.fecha, 3);
        const tareasAnteriores = await getLinkedTareas(linked_meeting_id);

        let actaJson = await generateActaFromText(texto.trim(), modo, meta, fechaDefault, tareasAnteriores);
        if (!actaJson) actaJson = { identificacion: { ...meta }, tareas_anteriores: [], tareas_nuevas: [], resumen_reunion: 'No se pudo generar el acta.', observaciones_generales: '' };
        actaJson.identificacion = { ...meta };

        // Inyectar tareas anteriores
        if (tareasAnteriores.length > 0) {
          actaJson.tareas_anteriores = tareasAnteriores.map((t, i) => ({
            id: `ant_${String(i+1).padStart(3,'0')}`, descripcion: t.descripcion,
            responsable: t.responsable, estado: t.estado, fecha_compromiso: t.fecha_compromiso || ''
          }));
        }

        db.run('INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)', [meetingId, JSON.stringify(actaJson)]);

        db.run('DELETE FROM tareas WHERE meeting_id = ?', [meetingId], () => {
          tareasAnteriores.forEach(t => {
            db.run('INSERT INTO tareas (meeting_id, tarea_id, tipo, descripcion, responsable, estado, fecha_compromiso) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [meetingId, t.tarea_id || uuidv4(), 'anterior', t.descripcion||'', t.responsable||'', t.estado||'pendiente', t.fecha_compromiso||'']);
          });
          const tareasDedup = deduplicateTareas(actaJson.tareas_nuevas || []);
          tareasDedup.forEach((t, i) => {
            const taskId = formatTaskId(i + 1);
            db.run('INSERT INTO tareas (meeting_id, tarea_id, tipo, descripcion, responsable, estado, fecha_compromiso) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [meetingId, taskId, 'nueva', (t.descripcion||'').trim(), (t.responsable||'').trim(), 'pendiente', t.fecha_compromiso || addBusinessDays(meta.fecha, 3)]);
          });
        });
        db.run('UPDATE meetings SET status = ? WHERE id = ?', ['ended', meetingId]);
      } catch (e) {
        console.error(`[${meetingId}] Error:`, e.message);
        db.run('UPDATE meetings SET status = ? WHERE id = ?', ['ended', meetingId]);
      }
    }
  );
});

// ── Consultas ─────────────────────────────────────────────────────────────────
app.post('/meetings/:id/add-transcript', (req, res) => {
  const { texto = '' } = req.body;
  if (!texto.trim()) return res.status(400).json({ error: 'Texto vacío' });
  db.get('SELECT id FROM meetings WHERE id = ?', [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Reunión no encontrada' });
    db.get('SELECT MAX(chunk_number) as maxChunk FROM transcriptions WHERE meeting_id = ?', [req.params.id], (_, r) => {
      insertTextAsTranscription(req.params.id, texto, (r?.maxChunk || 0) + 1);
      res.json({ ok: true });
    });
  });
});

function insertTextAsTranscription(meetingId, texto, startChunk) {
  const lineas = texto.split('\n').filter(l => l.trim());
  let currentSpeaker = 'Texto'; let segNum = startChunk;
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
  db.all('SELECT * FROM transcriptions WHERE meeting_id = ? ORDER BY chunk_number, id', [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/meetings/:id/acta', (req, res) => {
  db.get('SELECT status FROM meetings WHERE id = ?', [req.params.id], (err, meeting) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!meeting) return res.status(404).json({ error: 'Not found' });
    db.get('SELECT acta_json FROM actas WHERE meeting_id = ?', [req.params.id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(202).json({ status: 'processing', meetingStatus: meeting.status });
      res.json({ status: 'ready', acta: JSON.parse(row.acta_json) });
    });
  });
});

app.get('/meetings/:id/tareas', (req, res) => {
  db.all('SELECT * FROM tareas WHERE meeting_id = ? ORDER BY tipo DESC, id', [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.put('/meetings/:id/acta', (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid body' });
  db.run('INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)', [req.params.id, JSON.stringify(req.body)], err => {
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
        res.json({ ok: true, message: 'Reprocesando...' });
        finalizeMeeting(id).catch(e => console.error('Reprocess error:', e.message));
      });
    });
  });
});

// ── Notas ─────────────────────────────────────────────────────────────────────
app.get('/meetings/:id/notes', (req, res) => {
  db.all('SELECT * FROM meeting_notes WHERE meeting_id = ? ORDER BY created_at', [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/meetings/:id/notes', (req, res) => {
  const { content = '', author = '' } = req.body;
  if (!content.trim()) return res.status(400).json({ error: 'Contenido vacío' });
  db.get('SELECT id FROM meetings WHERE id = ?', [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'No encontrada' });
    db.run('INSERT INTO meeting_notes (meeting_id, content, author) VALUES (?, ?, ?)', [req.params.id, content.trim(), author.trim()],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, meeting_id: req.params.id, content: content.trim(), author: author.trim() });
      }
    );
  });
});

app.delete('/meetings/:id/notes/:noteId', (req, res) => {
  db.run('DELETE FROM meeting_notes WHERE id = ? AND meeting_id = ?', [req.params.noteId, req.params.id], err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// ── Adjuntos ──────────────────────────────────────────────────────────────────
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
  db.get('SELECT id, participantes, cliente, proyecto, terminology FROM meetings WHERE id = ?', [meetingId], (err, meeting) => {
    if (err || !meeting) return res.status(404).json({ error: 'Reunión no encontrada' });
    const mimeType = req.file.mimetype || '';
    const isAudio  = mimeType.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i.test(req.file.originalname);
    const fileType = isAudio ? 'audio' : 'document';
    const dir      = path.join(attachmentPath, meetingId);
    fs.mkdirSync(dir, { recursive: true });
    const safeFileName = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(dir, safeFileName);
    fs.writeFileSync(filePath, req.file.buffer);
    const transcriptionStatus = isAudio ? 'pending' : 'n/a';
    db.run('INSERT INTO meeting_attachments (meeting_id, file_name, file_path, file_type, mime_type, transcription_status) VALUES (?, ?, ?, ?, ?, ?)',
      [meetingId, req.file.originalname, filePath, fileType, mimeType, transcriptionStatus],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const attachId = this.lastID;
        res.json({ id: attachId, file_name: req.file.originalname, file_type: fileType, transcription_status: transcriptionStatus });
        if (isAudio) {
          let participantes = [];
          try { participantes = JSON.parse(meeting.participantes || '[]'); } catch(_) {}
          processAudioAttachment(attachId, filePath, meetingId, participantes, meeting.cliente||'', meeting.proyecto||'', meeting.terminology||'').catch(console.error);
        }
      }
    );
  });
});

app.delete('/meetings/:id/attachments/:attachId', (req, res) => {
  db.get('SELECT file_path FROM meeting_attachments WHERE id = ? AND meeting_id = ?', [req.params.attachId, req.params.id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'No encontrado' });
    db.run('DELETE FROM meeting_attachments WHERE id = ?', [req.params.attachId], err => {
      if (err) return res.status(500).json({ error: err.message });
      try { if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path); } catch(_) {}
      res.json({ ok: true });
    });
  });
});

app.get('/meetings/:id/attachments/:attachId/download', (req, res) => {
  db.get('SELECT file_name, file_path, mime_type FROM meeting_attachments WHERE id = ? AND meeting_id = ?',
    [req.params.attachId, req.params.id], (err, row) => {
      if (err || !row || !fs.existsSync(row.file_path)) return res.status(404).json({ error: 'No encontrado' });
      res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
      if (row.mime_type) res.setHeader('Content-Type', row.mime_type);
      res.sendFile(path.resolve(row.file_path));
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
