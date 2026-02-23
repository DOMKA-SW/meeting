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

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), hasGroqKey: Boolean(process.env.GROQ_API_KEY) });
});

const dbDir = path.join(__dirname, '..', 'storage', 'db');
const storagePath = path.join(__dirname, '..', 'storage', 'audio');
const dbPath = path.join(dbDir, 'meetings.db');
fs.mkdirSync(dbDir, { recursive: true });
fs.mkdirSync(storagePath, { recursive: true });

const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, started_at TEXT, ended_at TEXT, cliente TEXT, proyecto TEXT, responsable TEXT, participantes TEXT)`);
  ['cliente','proyecto','responsable','participantes'].forEach(col => db.run(`ALTER TABLE meetings ADD COLUMN ${col} TEXT`, () => {}));
  db.run(`CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, chunk_number INTEGER, file_path TEXT, processed INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS transcriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, chunk_number INTEGER, speaker TEXT, text TEXT, timestamp TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS actas (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT UNIQUE, acta_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS tareas (id INTEGER PRIMARY KEY AUTOINCREMENT, meeting_id TEXT, tarea_id TEXT, tipo TEXT, descripcion TEXT, responsable TEXT, estado TEXT DEFAULT 'pendiente', fecha_compromiso TEXT)`);
});

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) console.warn('GROQ_API_KEY no definida');
else console.log('Groq key:', GROQ_API_KEY.slice(0,10) + '...' + GROQ_API_KEY.slice(-4));

const groq = new OpenAI({ apiKey: GROQ_API_KEY || 'dummy', baseURL: 'https://api.groq.com/openai/v1' });
const upload = multer({ storage: multer.memoryStorage() });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const addBusinessDays = (startDate, days) => {
  const date = new Date(startDate);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return date.toISOString().split('T')[0];
};

// ─── LLM call con retry ──────────────────────────────────────────────────────
const callLLM = async (prompt, retries = 2) => {
  for (let i = 0; i <= retries; i++) {
    try {
      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
      return completion.choices?.[0]?.message?.content || null;
    } catch (e) {
      if (e.status === 429 && i < retries) { console.warn('Rate limit, espera 5s...'); await sleep(5000); }
      else throw e;
    }
  }
  return null;
};

// ─── Mejora de speakers en lotes ─────────────────────────────────────────────
const improveSpeakersWithLLM = async (transcriptions, participantes = []) => {
  if (!GROQ_API_KEY || transcriptions.length === 0) return transcriptions;
  const BATCH = 80;
  const result = [...transcriptions];
  for (let start = 0; start < transcriptions.length; start += BATCH) {
    const batch = transcriptions.slice(start, start + BATCH);
    const rawLines = batch.map((t, i) => `[${start + i}]: ${t.text}`).join('\n');
    const hint = participantes.length > 0 ? `\nParticipantes conocidos: ${participantes.join(', ')}. Usa sus nombres si puedes inferirlos.` : '';
    const prompt = `Analiza esta transcripción y asigna quién habla en cada línea.${hint}

Identifica cambios de speaker por: patrones pregunta-respuesta, cambios de tema, referencias ("como dijo Juan"), cambios de rol.

REGLAS:
- Usa nombre real del participante si puedes inferirlo, si no usa Speaker1, Speaker2... (consistente)
- Responde SOLO con JSON: {"lines": [{"index": N, "speaker": "Nombre", "text": "texto"}]}

Transcripción:
${rawLines}`;
    try {
      const raw = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
      const parsed = JSON.parse(raw.choices?.[0]?.message?.content || '{}');
      const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
      for (const line of lines) {
        if (line.index >= 0 && line.index < result.length && line.speaker) {
          result[line.index] = { ...result[line.index], speaker: line.speaker, text: line.text || result[line.index].text };
        }
      }
    } catch (e) {
      console.warn(`Speaker improvement batch ${start} falló:`, e.message);
    }
  }
  return result;
};

// ─── Extracción de una sección (para reuniones largas) ───────────────────────
const extractFromSection = async (sectionText, num, total) => {
  const prompt = `Analiza SECCIÓN ${num}/${total} de una transcripción de reunión.

Extrae en JSON:
{
  "temas_tratados": ["tema1"],
  "decisiones": ["decisión1"],
  "tareas_mencionadas": [{"descripcion": "...", "responsable": "nombre o vacío", "fecha": "fecha o vacío"}],
  "resumen_breve": "2-3 frases"
}

CRÍTICO para tareas: solo tareas EXPLÍCITAS y CONCRETAS. NO genéricas como "revisar", "mejorar".

Sección:
${sectionText}

Responde SOLO JSON válido.`;
  try {
    const content = await callLLM(prompt);
    return content ? JSON.parse(content) : null;
  } catch (e) {
    console.warn(`Error sección ${num}:`, e.message);
    return null;
  }
};

// ─── Merge final de extractos (map-reduce) ───────────────────────────────────
const mergeAndGenerateActa = async (extracts, meta, fechaDefault) => {
  const allTemas = [...new Set(extracts.flatMap(e => e?.temas_tratados || []))];
  const allDecisiones = [...new Set(extracts.flatMap(e => e?.decisiones || []))];
  const allTareas = extracts.flatMap(e => e?.tareas_mencionadas || []);
  const resumenes = extracts.map((e, i) => `Parte ${i+1}: ${e?.resumen_breve || ''}`).join('\n');

  const prompt = `Genera acta final en JSON a partir de estos extractos consolidados.

DATOS DE IDENTIFICACIÓN (usa EXACTAMENTE):
cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}",
participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}",
hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}"

TEMAS: ${allTemas.join(' | ')}
DECISIONES: ${allDecisiones.join(' | ')}
RESÚMENES: ${resumenes}
TAREAS IDENTIFICADAS: ${JSON.stringify(allTareas)}

JSON requerido:
{
  "identificacion": {"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},
  "tareas_anteriores": [],
  "tareas_nuevas": [{"id":"tarea_1","descripcion":"","responsable":"","fecha_compromiso":"${fechaDefault}"}],
  "resumen_reunion": "",
  "observaciones_generales": ""
}

REGLAS tareas_nuevas:
- Consolida duplicados en una sola tarea
- Solo tareas REALES y ESPECÍFICAS, máximo 15
- IDs secuenciales: tarea_1, tarea_2...
- fecha_compromiso: fecha mencionada o "${fechaDefault}"

Responde SOLO JSON válido.`;

  const content = await callLLM(prompt);
  if (!content) return null;
  try { return JSON.parse(content); }
  catch (e) { const m = content.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
};

// ─── Acta en una pasada (reuniones cortas) ────────────────────────────────────
const generateActaSinglePass = async (fullTranscript, meta, fechaDefault) => {
  const prompt = `Genera acta de reunión en JSON. Usa OBLIGATORIAMENTE estos datos:
cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}",
participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}",
hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}".

{
  "identificacion": {"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},
  "tareas_anteriores": [],
  "tareas_nuevas": [{"id":"tarea_1","descripcion":"","responsable":"","fecha_compromiso":"${fechaDefault}"}],
  "resumen_reunion": "",
  "observaciones_generales": ""
}

REGLAS tareas_nuevas:
- Solo tareas REALES y ESPECÍFICAS de la transcripción
- NO genéricas ("revisar", "mejorar", "seguir trabajando")
- Combina duplicados, máximo 15, IDs secuenciales
- fecha_compromiso: fecha mencionada o "${fechaDefault}"

Transcripción:
${fullTranscript}

Responde SOLO JSON válido.`;

  const content = await callLLM(prompt);
  if (!content) return null;
  try { return JSON.parse(content); }
  catch (e) { const m = content.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
};

// ─── Función principal de generación de acta ─────────────────────────────────
const WORDS_PER_CHUNK = 2500;

const generateActaIfReady = async (meetingId) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT cliente, proyecto, responsable, participantes, started_at, ended_at FROM meetings WHERE id = ?', [meetingId], (errMeet, meeting) => {
      if (errMeet || !meeting) return reject(errMeet || new Error('Meeting not found'));
      db.all('SELECT id, text, speaker, chunk_number FROM transcriptions WHERE meeting_id = ? ORDER BY chunk_number, id', [meetingId], async (err, transcriptions) => {
        if (err) return reject(err);
        if (transcriptions.length === 0) return resolve(null);

        let participantesArr = [];
        try { participantesArr = JSON.parse(meeting.participantes || '[]'); } catch (_) {}

        console.log(`[${meetingId}] Mejorando speakers (${transcriptions.length} segmentos)...`);
        const improved = await improveSpeakersWithLLM(transcriptions, participantesArr);

        for (let i = 0; i < improved.length; i++) {
          const imp = improved[i], orig = transcriptions[i];
          if (orig.id && (imp.speaker !== orig.speaker || imp.text !== orig.text)) {
            db.run('UPDATE transcriptions SET speaker = ?, text = ? WHERE id = ?', [imp.speaker, imp.text, orig.id]);
          }
        }

        const fullTranscript = improved.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
        const wordCount = fullTranscript.split(/\s+/).length;
        const startedDate = meeting.started_at ? new Date(meeting.started_at) : null;
        const endedDate = meeting.ended_at ? new Date(meeting.ended_at) : null;
        const meta = {
          cliente: meeting.cliente || '', proyecto: meeting.proyecto || '',
          responsable: meeting.responsable || '', participantes: participantesArr,
          fecha: startedDate ? startedDate.toISOString().split('T')[0] : '',
          hora_inicio: startedDate ? `${String(startedDate.getHours()).padStart(2,'0')}:${String(startedDate.getMinutes()).padStart(2,'0')}` : '',
          hora_fin: endedDate ? `${String(endedDate.getHours()).padStart(2,'0')}:${String(endedDate.getMinutes()).padStart(2,'0')}` : ''
        };
        const fechaDefault = addBusinessDays(meta.fecha || new Date().toISOString().split('T')[0], 3);

        let actaJson = null;
        try {
          if (wordCount > WORDS_PER_CHUNK) {
            console.log(`[${meetingId}] Transcript largo (${wordCount} palabras) - usando map-reduce...`);
            const words = fullTranscript.split(/\s+/);
            const sections = [];
            for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) sections.push(words.slice(i, i + WORDS_PER_CHUNK).join(' '));
            console.log(`[${meetingId}] ${sections.length} secciones a procesar`);
            const extracts = [];
            for (let i = 0; i < sections.length; i++) {
              const extract = await extractFromSection(sections[i], i + 1, sections.length);
              if (extract) extracts.push(extract);
              if (i < sections.length - 1) await sleep(1500);
            }
            actaJson = await mergeAndGenerateActa(extracts, meta, fechaDefault);
          } else {
            console.log(`[${meetingId}] Transcript normal (${wordCount} palabras) - acta directa`);
            actaJson = await generateActaSinglePass(fullTranscript, meta, fechaDefault);
          }
        } catch (error) {
          console.error(`[${meetingId}] Error generando acta:`, error.message);
        }

        if (!actaJson) {
          actaJson = {
            identificacion: { ...meta },
            tareas_anteriores: [], tareas_nuevas: [],
            resumen_reunion: 'Error al generar acta. Revisa la transcripción.',
            observaciones_generales: ''
          };
        }
        // Forzar datos de identificación correctos siempre
        actaJson.identificacion = { ...meta };

        db.run('INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)', [meetingId, JSON.stringify(actaJson)], function (err) {
          if (err) return reject(err);
          db.run('DELETE FROM tareas WHERE meeting_id = ?', [meetingId], () => {
            if (Array.isArray(actaJson.tareas_nuevas) && actaJson.tareas_nuevas.length > 0) {
              const seen = new Set();
              let counter = 1;
              actaJson.tareas_nuevas.filter(t => {
                const desc = (t.descripcion || '').trim().toLowerCase();
                if (!desc || desc.length < 5 || seen.has(desc)) return false;
                seen.add(desc); return true;
              }).forEach(tarea => {
                db.run('INSERT INTO tareas (meeting_id, tarea_id, tipo, descripcion, responsable, estado, fecha_compromiso) VALUES (?, ?, ?, ?, ?, ?, ?)',
                  [meetingId, `tarea_${counter++}`, 'nueva', (tarea.descripcion||'').trim(), (tarea.responsable||'').trim(), 'pendiente', tarea.fecha_compromiso || fechaDefault]);
              });
            }
          });
          console.log(`[${meetingId}] Acta lista con ${actaJson.tareas_nuevas?.length||0} tareas.`);
          resolve(actaJson);
        });
      });
    });
  });
};

// ─── Transcripción Whisper ────────────────────────────────────────────────────
const processChunkWithWhisper = async (filePath, meetingId, chunkNumber) => {
  if (!GROQ_API_KEY) { db.run('UPDATE chunks SET processed = 2 WHERE meeting_id = ? AND chunk_number = ?', [meetingId, chunkNumber]); return null; }
  try {
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath), model: 'whisper-large-v3-turbo', response_format: 'verbose_json'
    });
    const segments = Array.isArray(transcription.segments) ? transcription.segments : [];
    if (segments.length > 0) {
      let speakerCounter = 1; const speakerMap = {};
      for (const segment of segments) {
        const key = segment.spk || segment.speaker || 'speaker';
        if (!speakerMap[key]) speakerMap[key] = `speaker${speakerCounter++}`;
        db.run('INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
          [meetingId, chunkNumber, speakerMap[key], segment.text || '', new Date().toISOString()]);
      }
    } else if (transcription.text) {
      db.run('INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
        [meetingId, chunkNumber, 'speaker1', transcription.text, new Date().toISOString()]);
    }
    db.run('UPDATE chunks SET processed = 1 WHERE meeting_id = ? AND chunk_number = ?', [meetingId, chunkNumber]);
    // NO generar acta aquí - solo al endMeeting
    return transcription;
  } catch (error) {
    if (error.status === 429) { db.run('UPDATE chunks SET processed = 2 WHERE meeting_id = ? AND chunk_number = ?', [meetingId, chunkNumber]); }
    else { console.error('Error Whisper:', error.message); db.run('UPDATE chunks SET processed = -1 WHERE meeting_id = ? AND chunk_number = ?', [meetingId, chunkNumber]); }
    return null;
  }
};

// ─── Rutas ─────────────────────────────────────────────────────────────────────

app.post('/startMeeting', (req, res) => {
  const meetingId = uuidv4();
  const { user_id = 'default', cliente = '', proyecto = '', responsable = '' } = req.body;
  const participantes = Array.isArray(req.body.participantes) ? JSON.stringify(req.body.participantes) : '[]';
  fs.mkdirSync(path.join(storagePath, meetingId), { recursive: true });
  db.run('INSERT INTO meetings (id, user_id, status, started_at, cliente, proyecto, responsable, participantes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [meetingId, user_id, 'active', new Date().toISOString(), cliente, proyecto, responsable, participantes],
    function(err) { if (err) return res.status(500).json({ error: err.message }); res.json({ meetingId, userId: user_id, status: 'active' }); });
});

app.post('/endMeeting', (req, res) => {
  const { meetingId } = req.body;
  if (!meetingId) return res.status(400).json({ error: 'Missing meetingId' });
  db.run('UPDATE meetings SET status = ?, ended_at = ? WHERE id = ?', ['ended', new Date().toISOString(), meetingId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ meetingId, status: 'ended' });
    console.log(`[${meetingId}] Generando acta post-reunión...`);
    generateActaIfReady(meetingId).catch(e => console.error(`Error acta:`, e.message));
  });
});

app.post('/chunk', upload.single('audio'), async (req, res) => {
  const { meetingId, chunkNumber } = req.body;
  if (!meetingId || chunkNumber === undefined || !req.file) return res.status(400).json({ error: 'Missing fields' });
  const audioDir = path.join(storagePath, meetingId);
  const filePath = path.join(audioDir, `chunk_${chunkNumber}.webm`);
  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(filePath, req.file.buffer);
  db.run('INSERT INTO chunks (meeting_id, chunk_number, file_path, processed) VALUES (?, ?, ?, ?)',
    [meetingId, parseInt(chunkNumber), filePath, 0], async function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ chunkId: this.lastID, meetingId, chunkNumber: parseInt(chunkNumber) });
      processChunkWithWhisper(filePath, meetingId, parseInt(chunkNumber)).catch(console.error);
    });
});

// ── NUEVA: Crear reunión desde texto manual ────────────────────────────────────
app.post('/meetings/from-text', async (req, res) => {
  const { user_id = 'default', cliente = '', proyecto = '', responsable = '', participantes: pRaw = [], texto = '', fecha = null, hora_inicio = '', hora_fin = '' } = req.body;
  if (!texto || texto.trim().length < 10) return res.status(400).json({ error: 'El campo "texto" es requerido.' });

  const meetingId = uuidv4();
  const participantes = Array.isArray(pRaw) ? JSON.stringify(pRaw)
    : JSON.stringify(pRaw.toString().split(/[,;]/).map(p => p.trim()).filter(Boolean));
  const startedAt = fecha ? new Date(`${fecha}T${hora_inicio || '00:00'}:00`).toISOString() : new Date().toISOString();
  const endedAt = fecha && hora_fin ? new Date(`${fecha}T${hora_fin}:00`).toISOString() : new Date().toISOString();

  db.run('INSERT INTO meetings (id, user_id, status, started_at, ended_at, cliente, proyecto, responsable, participantes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [meetingId, user_id, 'ended', startedAt, endedAt, cliente, proyecto, responsable, participantes],
    async function(err) {
      if (err) return res.status(500).json({ error: err.message });
      insertTextAsTranscription(meetingId, texto, 0);
      res.json({ meetingId, status: 'ended', message: 'Reunión creada. Procesando acta...' });
      setTimeout(() => generateActaIfReady(meetingId).catch(e => console.error(`Error acta from-text:`, e.message)), 500);
    });
});

// ── NUEVA: Agregar texto a reunión existente ────────────────────────────────────
app.post('/meetings/:id/add-transcript', (req, res) => {
  const { id } = req.params;
  const { texto = '' } = req.body;
  if (!texto.trim()) return res.status(400).json({ error: 'Texto vacío' });
  db.get('SELECT id FROM meetings WHERE id = ?', [id], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Reunión no encontrada' });
    db.get('SELECT MAX(chunk_number) as maxChunk FROM transcriptions WHERE meeting_id = ?', [id], (err2, r) => {
      insertTextAsTranscription(id, texto, (r?.maxChunk || 0) + 1);
      res.json({ ok: true, message: 'Texto agregado' });
    });
  });
});

const insertTextAsTranscription = (meetingId, texto, startChunk) => {
  const lineas = texto.split('\n').filter(l => l.trim().length > 0);
  let currentSpeaker = 'Texto';
  let segNum = startChunk;
  for (const linea of lineas) {
    const speakerMatch = linea.match(/^\[?([^\]:]{1,40})\]?:\s*(.+)$/);
    if (speakerMatch) {
      currentSpeaker = speakerMatch[1].trim();
      const text = speakerMatch[2].trim();
      if (text) db.run('INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
        [meetingId, segNum++, currentSpeaker, text, new Date().toISOString()]);
    } else if (linea.trim()) {
      db.run('INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
        [meetingId, segNum++, currentSpeaker, linea.trim(), new Date().toISOString()]);
    }
  }
};

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
    if (!row) return res.status(404).json({ error: 'Meeting not found' });
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
  const actaJson = req.body;
  if (!actaJson || typeof actaJson !== 'object') return res.status(400).json({ error: 'acta_json object required' });
  db.run('INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)', [req.params.id, JSON.stringify(actaJson)], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.put('/meetings/:id/tareas', (req, res) => {
  const tareas = Array.isArray(req.body) ? req.body : req.body.tareas;
  if (!Array.isArray(tareas)) return res.status(400).json({ error: 'tareas array required' });
  db.run('DELETE FROM tareas WHERE meeting_id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (tareas.length === 0) return res.json({ ok: true });
    const stmt = db.prepare('INSERT INTO tareas (meeting_id, tarea_id, tipo, descripcion, responsable, estado, fecha_compromiso) VALUES (?, ?, ?, ?, ?, ?, ?)');
    tareas.forEach(t => stmt.run(req.params.id, t.tarea_id||'', t.tipo||'nueva', t.descripcion||'', t.responsable||'', t.estado||'pendiente', t.fecha_compromiso||''));
    stmt.finalize(() => res.json({ ok: true }));
  });
});

app.post('/meetings/:id/reprocess-acta', async (req, res) => {
  db.run('DELETE FROM tareas WHERE meeting_id = ?', [req.params.id], async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    try {
      await generateActaIfReady(req.params.id);
      res.json({ ok: true, message: 'Acta reprocesada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
