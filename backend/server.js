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
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    routes: {
      putActa: true,
      putTareas: true
    }
  });
});

const dbDir = path.join(__dirname, '..', 'storage', 'db');
const storagePath = path.join(__dirname, '..', 'storage', 'audio');
const dbPath = path.join(dbDir, 'meetings.db');

fs.mkdirSync(dbDir, { recursive: true });
fs.mkdirSync(storagePath, { recursive: true });

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    status TEXT,
    started_at TEXT,
    ended_at TEXT,
    cliente TEXT,
    proyecto TEXT,
    responsable TEXT,
    participantes TEXT
  )`);
  db.run(`ALTER TABLE meetings ADD COLUMN cliente TEXT`, () => {});
  db.run(`ALTER TABLE meetings ADD COLUMN proyecto TEXT`, () => {});
  db.run(`ALTER TABLE meetings ADD COLUMN responsable TEXT`, () => {});
  db.run(`ALTER TABLE meetings ADD COLUMN participantes TEXT`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT,
    chunk_number INTEGER,
    file_path TEXT,
    processed INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transcriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT,
    chunk_number INTEGER,
    speaker TEXT,
    text TEXT,
    timestamp TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS actas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT UNIQUE,
    acta_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tareas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT,
    tarea_id TEXT,
    tipo TEXT,
    descripcion TEXT,
    responsable TEXT,
    estado TEXT DEFAULT 'pendiente',
    fecha_compromiso TEXT
  )`);
});

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.warn('⚠️  GROQ_API_KEY no está definida en .env. Transcripción y actas no funcionarán.');
} else {
  console.log('Groq API key cargada:', GROQ_API_KEY.slice(0, 10) + '...' + GROQ_API_KEY.slice(-4));
}

const groq = new OpenAI({
  apiKey: GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});

const upload = multer({ storage: multer.memoryStorage() });

const processChunkWithWhisper = async (filePath, meetingId, chunkNumber) => {
  if (!GROQ_API_KEY) {
    console.warn('Groq API key no configurada. Omitting chunk.', meetingId, chunkNumber);
    db.run('UPDATE chunks SET processed = 2 WHERE meeting_id = ? AND chunk_number = ?', [meetingId, chunkNumber]);
    return null;
  }
  try {
    const fileStream = fs.createReadStream(filePath);
    const transcription = await groq.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json'
    });

    const segments = Array.isArray(transcription.segments)
      ? transcription.segments
      : [];

    if (segments.length > 0) {
      let speakerCounter = 1;
      const speakerMap = {};

      for (const segment of segments) {
        const key = segment.spk || segment.speaker || 'speaker';
        if (!speakerMap[key]) {
          speakerMap[key] = `speaker${speakerCounter}`;
          speakerCounter += 1;
        }

        db.run(
          'INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
          [
            meetingId,
            chunkNumber,
            speakerMap[key],
            segment.text || '',
            new Date().toISOString()
          ]
        );
      }
    } else if (transcription.text) {
      db.run(
        'INSERT INTO transcriptions (meeting_id, chunk_number, speaker, text, timestamp) VALUES (?, ?, ?, ?, ?)',
        [
          meetingId,
          chunkNumber,
          'speaker1',
          transcription.text,
          new Date().toISOString()
        ]
      );
    }

    db.run(
      'UPDATE chunks SET processed = 1 WHERE meeting_id = ? AND chunk_number = ?',
      [meetingId, chunkNumber]
    );

    await generateActaIfReady(meetingId);

    return transcription;
  } catch (error) {
    if (error.code === 'insufficient_quota' || error.status === 429) {
      console.warn(`⚠️  Groq quota exceeded for chunk ${chunkNumber} of meeting ${meetingId}.`);
      db.run(
        'UPDATE chunks SET processed = 2 WHERE meeting_id = ? AND chunk_number = ?',
        [meetingId, chunkNumber]
      );
      return null;
    }
    console.error('Error processing chunk with Whisper (Groq):', error.message);
    db.run(
      'UPDATE chunks SET processed = -1 WHERE meeting_id = ? AND chunk_number = ?',
      [meetingId, chunkNumber]
    );
    return null;
  }
};

const addBusinessDays = (startDate, days) => {
  const date = new Date(startDate);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) {
      added++;
    }
  }
  return date.toISOString().split('T')[0];
};

const improveSpeakersWithLLM = async (transcriptions) => {
  if (!GROQ_API_KEY || transcriptions.length === 0) {
    return transcriptions;
  }
  const rawLines = transcriptions.map((t, i) => `[${i}]: ${t.text}`).join('\n');
  const prompt = `Analiza esta transcripción de reunión. Cada línea tiene un número [0], [1], etc. Identifica cambios de hablante basándote en:
- Cambios de tema o contexto
- Patrones de pregunta-respuesta
- Cambios en el tono o estilo de habla
- Referencias a otros participantes

Responde SOLO con el mismo formato pero reemplazando [número] con [Speaker N] donde N es un número único por hablante. Usa Speaker 1, Speaker 2, Speaker 3, etc. Si puedes identificar roles (Cliente, Moderador, Técnico), úsalos en lugar de números.

Transcripción:
${rawLines}

Responde en el mismo formato, solo cambiando los identificadores de speaker.`;
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1
    });
    const content = completion.choices?.[0]?.message?.content || '';
    const lines = content.split('\n').filter(Boolean);
    const result = [];
    const speakerMap = {};
    let speakerCounter = 1;
    
    for (let i = 0; i < lines.length && i < transcriptions.length; i++) {
      const line = lines[i];
      const match = line.match(/\[(\d+)\]:\s*\[([^\]]+)\]:\s*(.*)$/) || line.match(/\[([^\]]+)\]:\s*(.*)$/);
      if (match) {
        const speakerLabel = match[2] || match[1];
        if (!speakerMap[speakerLabel]) {
          speakerMap[speakerLabel] = `Speaker${speakerCounter}`;
          speakerCounter++;
        }
        result.push({
          ...transcriptions[i],
          speaker: speakerMap[speakerLabel],
          text: (match[3] || match[2] || line).trim()
        });
      } else {
        result.push(transcriptions[i]);
      }
    }
    while (result.length < transcriptions.length) {
      result.push(transcriptions[result.length]);
    }
    return result.length ? result : transcriptions;
  } catch (e) {
    console.warn('Speaker improvement failed:', e.message);
    return transcriptions;
  }
};

const generateActaIfReady = async (meetingId) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT cliente, proyecto, responsable, participantes, started_at, ended_at FROM meetings WHERE id = ?', [meetingId], (errMeet, meeting) => {
      if (errMeet || !meeting) {
        return reject(errMeet || new Error('Meeting not found'));
      }
      db.all(
        'SELECT id, text, speaker, chunk_number FROM transcriptions WHERE meeting_id = ? ORDER BY chunk_number, id',
        [meetingId],
        async (err, transcriptions) => {
          if (err) {
            return reject(err);
          }
          if (transcriptions.length === 0) {
            return resolve(null);
          }

          const improved = await improveSpeakersWithLLM(transcriptions);
          for (let i = 0; i < improved.length && i < transcriptions.length; i++) {
            const imp = improved[i];
            const orig = transcriptions[i];
            if (orig.id && (imp.speaker !== orig.speaker || imp.text !== orig.text)) {
              db.run('UPDATE transcriptions SET speaker = ?, text = ? WHERE id = ?', [imp.speaker, imp.text, orig.id]);
            }
          }
          const fullTranscript = improved.map(t => `[${t.speaker}]: ${t.text}`).join('\n');

          let participantesArr = [];
          try {
            participantesArr = JSON.parse(meeting.participantes || '[]');
          } catch (_) {}
          const startedDate = meeting.started_at ? new Date(meeting.started_at) : null;
          const endedDate = meeting.ended_at ? new Date(meeting.ended_at) : null;
          
          const meta = {
            cliente: meeting.cliente || '',
            proyecto: meeting.proyecto || '',
            responsable: meeting.responsable || '',
            participantes: Array.isArray(participantesArr) ? participantesArr : [],
            fecha: startedDate ? startedDate.toISOString().split('T')[0] : '',
            hora_inicio: startedDate ? `${String(startedDate.getHours()).padStart(2, '0')}:${String(startedDate.getMinutes()).padStart(2, '0')}` : '',
            hora_fin: endedDate ? `${String(endedDate.getHours()).padStart(2, '0')}:${String(endedDate.getMinutes()).padStart(2, '0')}` : ''
          };

          const fechaHoy = meta.fecha || new Date().toISOString().split('T')[0];
          const fechaDefault = addBusinessDays(fechaHoy, 3);

          const prompt = `Genera un acta de reunión en JSON. Usa OBLIGATORIAMENTE estos datos de identificación (no los cambies): cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}", participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}", hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}".

Estructura JSON:
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
  "tareas_nuevas": [],
  "resumen_reunion": "",
  "observaciones_generales": ""
}

Reglas CRÍTICAS:
- identificacion: usa EXACTAMENTE los datos proporcionados arriba (cliente, proyecto, responsable, participantes, fecha, hora_inicio, hora_fin).
- resumen_reunion: resumen conciso y útil (2-4 frases) de los temas principales tratados.
- tareas_nuevas: 
  * SOLO extrae tareas REALES y ESPECÍFICAS mencionadas explícitamente en la transcripción.
  * Cada tarea debe tener: id (tarea_1, tarea_2, tarea_3... secuencial y único), descripcion (clara, específica, accionable - NO genérica como "seguir trabajando" o "revisar"), responsable (nombre mencionado o inferido del contexto), fecha_compromiso (si se menciona fecha específica, úsala; si NO se menciona, usa "${fechaDefault}").
  * NO inventes tareas que no estén en la transcripción.
  * NO incluyas tareas genéricas, vagas o repetitivas.
  * Si dos tareas son similares, combínalas en una sola.
  * Máximo 10 tareas. Si hay más, selecciona las más importantes.
- tareas_anteriores: solo si en la transcripción se mencionan EXPLÍCITAMENTE tareas de reuniones anteriores o pendientes previas. Si no hay mención, deja el array vacío.
- observaciones_generales: notas breves adicionales si aplica.

Transcripción:
${fullTranscript}

IMPORTANTE: Analiza cuidadosamente la transcripción. Solo extrae tareas que sean REALMENTE mencionadas. Si no hay tareas claras, deja tareas_nuevas vacío. Responde SOLO con el JSON válido, sin texto adicional.`;

          try {
            const completion = GROQ_API_KEY
              ? await groq.chat.completions.create({
                  model: 'llama-3.3-70b-versatile',
                  messages: [{ role: 'user', content: prompt }],
                  temperature: 0.2,
                  response_format: { type: 'json_object' }
                })
              : null;

            if (!completion || !completion.choices?.[0]?.message?.content) {
              return resolve(null);
            }

            let raw = completion.choices[0].message.content.trim();
            
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              raw = jsonMatch[0];
            }

            raw = raw.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            raw = raw.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
            
            let actaJson;
            try {
              actaJson = JSON.parse(raw);
            } catch (parseError) {
              console.error('Error parsing JSON, attempting fix:', parseError.message);
              console.error('Raw response:', raw.substring(0, 500));
              
              try {
                raw = raw.replace(/\/\*[\s\S]*?\*\//g, '');
                raw = raw.replace(/\/\/.*$/gm, '');
                actaJson = JSON.parse(raw);
              } catch (secondError) {
                console.error('Failed to parse JSON after cleanup. Creating default acta.');
                actaJson = {
                  identificacion: {
                    cliente: '',
                    proyecto: '',
                    fecha: new Date().toISOString().split('T')[0],
                    hora_inicio: '',
                    hora_fin: '',
                    responsable: '',
                    participantes: []
                  },
                  tareas_anteriores: [],
                  tareas_nuevas: [],
                  resumen_reunion: 'Error al generar acta automáticamente. Por favor revisa la transcripción.',
                  observaciones_generales: ''
                };
              }
            }

            actaJson.identificacion = {
              cliente: meta.cliente,
              proyecto: meta.proyecto,
              responsable: meta.responsable,
              participantes: meta.participantes,
              fecha: meta.fecha,
              hora_inicio: meta.hora_inicio,
              hora_fin: meta.hora_fin
            };

            db.run(
              'INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)',
              [meetingId, JSON.stringify(actaJson)],
              function(err) {
                if (err) {
                  return reject(err);
                }

                db.run('DELETE FROM tareas WHERE meeting_id = ?', [meetingId], () => {
                  if (Array.isArray(actaJson.tareas_nuevas) && actaJson.tareas_nuevas.length > 0) {
                    const tareasToProcess = actaJson.tareas_nuevas.filter(t => t.descripcion && t.descripcion.trim().length > 0);
                    const uniqueTareas = [];
                    const seenDescriptions = new Set();
                    
                    for (const tarea of tareasToProcess) {
                      const descNorm = (tarea.descripcion || '').trim().toLowerCase();
                      if (!seenDescriptions.has(descNorm) && descNorm.length > 5) {
                        seenDescriptions.add(descNorm);
                        uniqueTareas.push(tarea);
                      }
                    }
                    
                    let counter = 1;
                    uniqueTareas.forEach((tarea) => {
                      const tareaId = `tarea_${counter}`;
                      counter++;
                      
                      const fechaCompromiso = tarea.fecha_compromiso || addBusinessDays(meta.fecha || new Date().toISOString().split('T')[0], 3);
                      
                      db.run(
                        'INSERT INTO tareas (meeting_id, tarea_id, tipo, descripcion, responsable, estado, fecha_compromiso) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [
                          meetingId,
                          tareaId,
                          'nueva',
                          (tarea.descripcion || '').trim(),
                          (tarea.responsable || '').trim(),
                          'pendiente',
                          fechaCompromiso
                        ]
                      );
                    });
                  }
                });

                resolve(actaJson);
              }
            );
          } catch (error) {
            console.error('Error generating acta:', error.message);
            resolve(null);
          }
        }
      );
    });
  });
};

app.post('/startMeeting', (req, res) => {
  const meetingId = uuidv4();
  const userId = req.body.user_id || 'default';
  const cliente = req.body.cliente || '';
  const proyecto = req.body.proyecto || '';
  const responsable = req.body.responsable || '';
  const participantes = Array.isArray(req.body.participantes)
    ? JSON.stringify(req.body.participantes)
    : (req.body.participantes != null ? String(req.body.participantes) : '[]');

  const audioDir = path.join(storagePath, meetingId);
  fs.mkdirSync(audioDir, { recursive: true });

  db.run(
    'INSERT INTO meetings (id, user_id, status, started_at, cliente, proyecto, responsable, participantes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [meetingId, userId, 'active', new Date().toISOString(), cliente, proyecto, responsable, participantes],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ meetingId, userId, status: 'active' });
    }
  );
});

app.post('/endMeeting', (req, res) => {
  const { meetingId } = req.body;

  if (!meetingId) {
    return res.status(400).json({ error: 'Missing meetingId' });
  }

  db.run(
    'UPDATE meetings SET status = ?, ended_at = ? WHERE id = ?',
    ['ended', new Date().toISOString(), meetingId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ meetingId, status: 'ended' });
    }
  );
});

app.post('/chunk', upload.single('audio'), async (req, res) => {
  const { meetingId, chunkNumber } = req.body;
  const audioFile = req.file;

  if (!meetingId || chunkNumber === undefined || !audioFile) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const audioDir = path.join(storagePath, meetingId);
  const fileName = `chunk_${chunkNumber}.webm`;
  const filePath = path.join(audioDir, fileName);

  fs.mkdirSync(audioDir, { recursive: true });
  fs.writeFileSync(filePath, audioFile.buffer);

  db.run(
    'INSERT INTO chunks (meeting_id, chunk_number, file_path, processed) VALUES (?, ?, ?, ?)',
    [meetingId, parseInt(chunkNumber), filePath, 0],
    async function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      res.json({
        chunkId: this.lastID,
        meetingId,
        chunkNumber: parseInt(chunkNumber),
        filePath
      });

      processChunkWithWhisper(filePath, meetingId, parseInt(chunkNumber)).catch(err => {
        console.error('Background processing error:', err);
      });
    }
  );
});

app.get('/meetings', (req, res) => {
  const userId = req.query.user_id || 'default';

  db.all(
    'SELECT * FROM meetings WHERE user_id = ? ORDER BY started_at DESC',
    [userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

app.get('/meetings/:id', (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM meetings WHERE id = ?', [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Meeting not found' });
    }
    res.json(row);
  });
});

app.get('/meetings/:id/transcription', (req, res) => {
  const { id } = req.params;

  db.all(
    'SELECT * FROM transcriptions WHERE meeting_id = ? ORDER BY chunk_number, id',
    [id],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
});

app.get('/meetings/:id/acta', (req, res) => {
  const { id } = req.params;

  db.get('SELECT acta_json FROM actas WHERE meeting_id = ?', [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Acta not found' });
    }
    res.json(JSON.parse(row.acta_json));
  });
});

app.get('/meetings/:id/tareas', (req, res) => {
  const { id } = req.params;

  db.all('SELECT * FROM tareas WHERE meeting_id = ? ORDER BY id', [id], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

app.put('/meetings/:id/acta', (req, res) => {
  const { id } = req.params;
  const actaJson = req.body;

  if (!actaJson || typeof actaJson !== 'object') {
    return res.status(400).json({ error: 'acta_json object required' });
  }

  db.run(
    'INSERT OR REPLACE INTO actas (meeting_id, acta_json) VALUES (?, ?)',
    [id, JSON.stringify(actaJson)],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ ok: true });
    }
  );
});

app.put('/meetings/:id/tareas', (req, res) => {
  const { id } = req.params;
  const tareas = Array.isArray(req.body) ? req.body : req.body.tareas;

  if (!Array.isArray(tareas)) {
    return res.status(400).json({ error: 'tareas array required' });
  }

  db.run('DELETE FROM tareas WHERE meeting_id = ?', [id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (tareas.length === 0) {
      return res.json({ ok: true });
    }
    const stmt = db.prepare(
      'INSERT INTO tareas (meeting_id, tarea_id, tipo, descripcion, responsable, estado, fecha_compromiso) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    tareas.forEach(t => {
      stmt.run(
        id,
        t.tarea_id || t.id || '',
        t.tipo || 'nueva',
        t.descripcion || '',
        t.responsable || '',
        t.estado || 'pendiente',
        t.fecha_compromiso || ''
      );
    });
    stmt.finalize(() => res.json({ ok: true }));
  });
});

app.post('/meetings/:id/reprocess-acta', async (req, res) => {
  const { id } = req.params;
  
  db.run('DELETE FROM tareas WHERE meeting_id = ?', [id], async (err) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    try {
      await generateActaIfReady(id);
      res.json({ ok: true, message: 'Acta reprocesada correctamente' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
