// =============================================================================
// SISTEMA DE ACTAS — BACKEND PRINCIPAL
// =============================================================================
// Servidor Express que gestiona autenticacion, grabacion de reuniones,
// transcripcion con Whisper, generacion de actas con LLM (Groq u OpenAI),
// gestion de tareas y portal del cliente.
// Todos los endpoints protegidos requieren JWT en el header Authorization.
// =============================================================================

require('dotenv').config();
const express    = require('express');
const mysql      = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const multer     = require('multer');
const fs         = require('fs');
const path       = require('path');
const cors       = require('cors');
const OpenAI     = require('openai');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const bcrypt     = require('bcrypt');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// =============================================================================
// CONFIGURACION DE EXPRESS Y SEGURIDAD GLOBAL
// Helmet agrega cabeceras HTTP seguras automaticamente (X-Frame-Options,
// X-Content-Type-Options, HSTS, etc.).
// El middleware de sanitizacion recorre todo el body de cada request y
// elimina etiquetas <script> para prevenir ataques XSS.
// trust proxy le dice a Express que confie en la IP real enviada por Nginx.
// =============================================================================

const app = express();
app.set('trust proxy', 1); // Confiar en Nginx como proxy
// Sanitización básica anti-XSS en todos los inputs
app.use((req, _res, next) => {
  const san = v => typeof v==='string' ? v.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi,'').trim() : v;
  const deep = o => { if(o&&typeof o==='object') Object.keys(o).forEach(k=>{ o[k]=typeof o[k]==='string'?san(o[k]):deep(o[k]); }); return o; };
  if(req.body) deep(req.body);
  next();
});
// ── Logging de errores no capturados ─────────────────────────────────────────
process.on('uncaughtException',  (err) => console.error('[uncaughtException]',  err.message));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err?.message || err));


// ─── Seguridad: Helmet (cabeceras HTTP seguras) ───────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

// ─── CORS ─────────────────────────────────────────────────────────────────────
// En producción: definir CORS_ORIGIN=https://dataella.tech en .env
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : [
      'http://localhost:5173',
      'http://localhost:3000',
    ];


app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS bloqueado: ${origin}`);
      callback(new Error(`CORS: origen no permitido → ${origin}`));
    }
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// =============================================================================
// RATE LIMITING
// Proteccion contra fuerza bruta y abuso de la API.
// loginLimiter: maximo 15 intentos de login por IP en 15 minutos.
// apiLimiter:   maximo 200 peticiones por IP por minuto para el resto de rutas.
// =============================================================================
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 15,                   // máximo 15 intentos por IP
  message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 200,
  message: { error: 'Demasiadas solicitudes. Por favor espera un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/login', loginLimiter);
app.use('/client-login', loginLimiter);
app.use(apiLimiter);

// =============================================================================
// CONSTANTES Y RUTAS DE ALMACENAMIENTO
// SECTION_SIZE: cuantos chunks de audio forman una seccion a resumir.
// WORDS_PER_CHUNK: limite de palabras antes de dividir una transcripcion larga.
// Los directorios de storage se crean automaticamente si no existen.
// =============================================================================
const SECTION_SIZE    = 12;
const WORDS_PER_CHUNK = 2500;
const SPEAKER_BATCH   = 60;
const SALT_ROUNDS     = 12;
const storagePath     = process.env.STORAGE_PATH || path.join(__dirname,'..','storage','audio');
const attachmentPath  = process.env.ATTACH_PATH  || path.join(__dirname,'..','storage','attachments');
fs.mkdirSync(storagePath,    { recursive: true });
fs.mkdirSync(attachmentPath, { recursive: true });

// ── Validar secretos obligatorios ──────────────────────────────────────────────
if (!process.env.JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET no está definido en .env');
  process.exit(1);
}
if (!process.env.SUPERADMIN_PASSWORD) {
  console.error('❌ FATAL: SUPERADMIN_PASSWORD no está definido en .env');
  process.exit(1);
}
const JWT_SECRET       = process.env.JWT_SECRET;
const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL || 'admin@dataella.tech';

// Hash legacy SHA-256 (solo para migración de contraseñas antiguas)
// =============================================================================
// AUTENTICACION Y HASHING DE CONTRASENAS
// Se usa bcrypt para almacenar contrasenas de forma segura (12 rounds).
// sha256Hash existe solo para migrar contrasenas antiguas: al primer login
// exitoso con hash SHA-256 se rehashea automaticamente a bcrypt.
// authMiddleware: verifica el JWT en cada request protegido.
// requireRole:    middleware de autorizacion por rol (superadmin/admin/member).
// clientAuth:     variante para el portal del cliente (rol = 'client').
// canAccess:      verifica que el usuario tenga acceso a una reunion especifica
//                 respetando el aislamiento entre empresas.
// =============================================================================
const sha256Hash = pwd => crypto.createHash('sha256').update(pwd + JWT_SECRET).digest('hex');

// Hash nuevo con bcrypt
const hashPwd = async pwd => bcrypt.hash(pwd, SALT_ROUNDS);

// Verificar contraseña: soporta bcrypt Y sha256 legacy
const verifyPwd = async (pwd, storedHash) => {
  if (storedHash && (storedHash.startsWith('$2b$') || storedHash.startsWith('$2a$'))) {
    return bcrypt.compare(pwd, storedHash);
  }
  // Contraseña antigua con SHA-256
  return storedHash === sha256Hash(pwd);
};

const authMiddleware = (req, res, next) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Autenticación requerida' });
  try {
    req.user = jwt.verify(h.split(' ')[1], JWT_SECRET);
    next();
  } catch(e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión expirada. Inicia sesión nuevamente.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(403).json({ error: 'Token inválido.', code: 'TOKEN_INVALID' });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) return res.status(403).json({ error: 'No tienes permiso.' });
  next();
};

const clientAuth = (req, res, next) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Autenticación requerida' });
  try {
    const d = jwt.verify(h.split(' ')[1], JWT_SECRET);
    if (d.role !== 'client') return res.status(403).json({ error: 'Acceso denegado' });
    req.client = d;
    next();
  } catch {
    return res.status(403).json({ error: 'Token inválido.' });
  }
};

// =============================================================================
// BASE DE DATOS MYSQL
// Se usa un pool de conexiones para manejar multiples requests concurrentes.
// createTables() crea toda la estructura al arrancar si no existe (autogestionado).
// Incluye migracion automatica: si la tabla tareas ya existe con la estructura
// anterior, ALTER TABLE agrega las columnas nuevas sin perder datos.
// createSuperadmin() crea el primer usuario administrador solo si no hay
// ninguno con rol superadmin (ejecucion unica en el primer arranque).
// =============================================================================
let db;
const initDB = async () => {
  const config = process.env.MYSQL_URL
    ? { uri: process.env.MYSQL_URL, ssl: { rejectUnauthorized: false } }
    : { host: process.env.DB_HOST||'localhost', port: parseInt(process.env.DB_PORT||'3306'), user: process.env.DB_USER||'root', password: process.env.DB_PASSWORD||'', database: process.env.DB_NAME||'actas_db' };

  db = await mysql.createPool({
    ...(config.uri ? { uri: config.uri, ssl: config.ssl } : config),
    waitForConnections: true,
    connectionLimit: 10,
    timezone: '+00:00'
  });
  console.log('✅ MySQL conectado');
  await createTables();
  await createSuperadmin();
};

const createTables = async () => {
  await db.execute(`CREATE TABLE IF NOT EXISTS companies (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE, active TINYINT(1) DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY, company_id INT NOT NULL,
    name VARCHAR(200) NOT NULL, email VARCHAR(200) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    role ENUM('superadmin','admin','member') DEFAULT 'member',
    active TINYINT(1) DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE)`);

  await db.execute(`CREATE TABLE IF NOT EXISTS clients (
    id INT AUTO_INCREMENT PRIMARY KEY, company_id INT NOT NULL,
    name VARCHAR(200) NOT NULL, username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL, active TINYINT(1) DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE)`);

  await db.execute(`CREATE TABLE IF NOT EXISTS meetings (
    id VARCHAR(36) PRIMARY KEY, company_id INT NOT NULL, created_by INT NOT NULL,
    status VARCHAR(20) DEFAULT 'active', started_at DATETIME, ended_at DATETIME,
    cliente VARCHAR(200), proyecto VARCHAR(200), responsable VARCHAR(200),
    participantes TEXT, linked_meeting_id VARCHAR(36), terminology TEXT,
    approved_at DATETIME DEFAULT NULL, approved_by_client VARCHAR(200) DEFAULT NULL,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE)`);

  await db.execute(`CREATE TABLE IF NOT EXISTS meeting_users (
    id INT AUTO_INCREMENT PRIMARY KEY, meeting_id VARCHAR(36) NOT NULL, user_id INT NOT NULL,
    UNIQUE KEY uq_mu (meeting_id, user_id),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);

  await db.execute(`CREATE TABLE IF NOT EXISTS chunks (
    id INT AUTO_INCREMENT PRIMARY KEY, meeting_id VARCHAR(36) NOT NULL,
    chunk_number INT NOT NULL, file_path VARCHAR(500), processed INT DEFAULT 0)`);

  await db.execute(`CREATE TABLE IF NOT EXISTS transcriptions (
    id INT AUTO_INCREMENT PRIMARY KEY, meeting_id VARCHAR(36) NOT NULL,
    chunk_number INT NOT NULL, speaker VARCHAR(200), text TEXT, timestamp DATETIME)`);

  await db.execute(`CREATE TABLE IF NOT EXISTS section_summaries (
    id INT AUTO_INCREMENT PRIMARY KEY, meeting_id VARCHAR(36) NOT NULL,
    section_num INT NOT NULL, from_chunk INT, to_chunk INT,
    summary_json LONGTEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sec (meeting_id, section_num))`);

  await db.execute(`CREATE TABLE IF NOT EXISTS actas (
    id INT AUTO_INCREMENT PRIMARY KEY, meeting_id VARCHAR(36) NOT NULL UNIQUE,
    acta_json LONGTEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  await db.execute(`CREATE TABLE IF NOT EXISTS tareas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    meeting_id       VARCHAR(36)  NOT NULL,
    tarea_id         VARCHAR(50),
    tipo             VARCHAR(20)  DEFAULT 'nueva',
    descripcion      TEXT,
    asunto           VARCHAR(500) DEFAULT '',
    detalle          TEXT,
    responsable      VARCHAR(200),
    asignado_a       VARCHAR(200) DEFAULT '',
    user_create      VARCHAR(200) DEFAULT '',
    estado           VARCHAR(50)  DEFAULT 'pendiente',
    estado_tarea     INT          DEFAULT 1,
    prioridad        INT          DEFAULT 2,
    tipo_tarea       CHAR(1)      DEFAULT 'i',
    requerimiento_id VARCHAR(100) DEFAULT '',
    fecha_compromiso VARCHAR(50)  DEFAULT '',
    date_init        VARCHAR(50)  DEFAULT '',
    date_end         VARCHAR(50)  DEFAULT ''
  )`);
  // Migración: agregar columnas nuevas si la tabla ya existía
  for (const [col, def] of [
    ['asunto',           "VARCHAR(500) NOT NULL DEFAULT ''"],
    ['detalle',          'TEXT'],
    ['asignado_a',       "VARCHAR(200) NOT NULL DEFAULT ''"],
    ['user_create',      "VARCHAR(200) NOT NULL DEFAULT ''"],
    ['estado_tarea',     'INT NOT NULL DEFAULT 1'],
    ['prioridad',        'INT NOT NULL DEFAULT 2'],
    ['tipo_tarea',       "CHAR(1) NOT NULL DEFAULT 'i'"],
    ['requerimiento_id', "VARCHAR(100) NOT NULL DEFAULT ''"],
    ['date_init',        "VARCHAR(50) NOT NULL DEFAULT ''"],
    ['date_end',         "VARCHAR(50) NOT NULL DEFAULT ''"],
  ]) {
    try { await db.execute(`ALTER TABLE tareas ADD COLUMN ${col} ${def}`); } catch(_) {}
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS meeting_notes (
    id INT AUTO_INCREMENT PRIMARY KEY, meeting_id VARCHAR(36) NOT NULL,
    user_id INT, content TEXT NOT NULL, author VARCHAR(200) DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  await db.execute(`CREATE TABLE IF NOT EXISTS meeting_attachments (
    id INT AUTO_INCREMENT PRIMARY KEY, meeting_id VARCHAR(36) NOT NULL,
    file_name VARCHAR(500) NOT NULL, file_path VARCHAR(500) NOT NULL,
    file_type VARCHAR(20) NOT NULL, mime_type VARCHAR(100) DEFAULT '',
    transcription LONGTEXT, transcription_status VARCHAR(20) DEFAULT 'pending',
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  // Configuracion personalizada por empresa (prompt, tono, etc.)
  await db.execute(`CREATE TABLE IF NOT EXISTS company_settings (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    company_id   INT         NOT NULL UNIQUE,
    prompt_context TEXT,
    updated_at   DATETIME    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
  )`);

  // Grabaciones de video de reuniones
  await db.execute(`CREATE TABLE IF NOT EXISTS recordings (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    meeting_id   VARCHAR(36)  NOT NULL UNIQUE,
    file_path    VARCHAR(500) NOT NULL,
    file_size    BIGINT       DEFAULT 0,
    mime_type    VARCHAR(50)  DEFAULT 'video/webm',
    created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP
  )`);

  // Ampliar columna password_hash si sigue en 64 chars (para bcrypt de 60 chars)
  try {
    await db.execute(`ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(100) NOT NULL`);
    await db.execute(`ALTER TABLE clients MODIFY COLUMN password_hash VARCHAR(100) NOT NULL`);
  } catch(_) { /* ya tiene el tamaño correcto */ }

  console.log('✅ Tablas listas');
};

const createSuperadmin = async () => {
  try {
    const [rows] = await db.execute("SELECT id FROM users WHERE role='superadmin'");
    if (rows.length > 0) return;
    const [comp] = await db.execute("INSERT INTO companies (name,slug) VALUES ('Mi Empresa','mi-empresa')");
    const pwd = process.env.SUPERADMIN_PASSWORD;
       if (!pwd) { console.error('SUPERADMIN_PASSWORD no definido'); return; }
    await db.execute('INSERT INTO users (company_id,name,email,password_hash,role) VALUES (?,?,?,?,?)',
      [comp.insertId, 'Super Admin', SUPERADMIN_EMAIL, await hashPwd(pwd), 'superadmin']);
    console.log(`✅ Superadmin creado: ${SUPERADMIN_EMAIL}`);
  } catch(e) { console.error('createSuperadmin:', e.message); }
};

// =============================================================================
// PROVEEDORES DE IA: GROQ Y OPENAI
// El sistema soporta dos proveedores, seleccionables con AI_PROVIDER en el
// .env (valores: 'groq' o 'openai'). Esto aplica tanto al LLM (generacion de
// actas/tareas) como a Whisper (transcripcion de audio): si AI_PROVIDER=openai
// y hay OPENAI_API_KEY configurada, Whisper usa la API de OpenAI; si no,
// usa Groq (comportamiento por defecto, sin costo).
// callLLM() selecciona automaticamente el cliente correcto y maneja reintentos
// ante errores 429 (rate limit) con espera exponencial.
// =============================================================================
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AI_PROVIDER    = (process.env.AI_PROVIDER || 'groq').toLowerCase();

// Groq — activo si hay key configurada
const groq = new OpenAI({
  apiKey:  GROQ_API_KEY || 'dummy',
  baseURL: 'https://api.groq.com/openai/v1'
});

// OpenAI — solo si está configurado
const openaiClient = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Modelos activos según proveedor
const LLM_MODEL   = AI_PROVIDER === 'openai'
  ? (process.env.OPENAI_LLM_MODEL  || 'gpt-4o-mini')
  : (process.env.GROQ_LLM_MODEL    || 'llama-3.3-70b-versatile');

const FAST_MODEL  = AI_PROVIDER === 'openai' ? 'gpt-4o-mini'      : 'llama-3.1-8b-instant';

// Whisper: usa OpenAI si AI_PROVIDER=openai y hay key; si no, Groq.
const USE_OPENAI_WHISPER = AI_PROVIDER === 'openai' && !!openaiClient;
const whisperClient = USE_OPENAI_WHISPER ? openaiClient : groq;
const WHISPER_MODEL = USE_OPENAI_WHISPER
  ? (process.env.OPENAI_WHISPER_MODEL || 'whisper-1')
  : (process.env.GROQ_WHISPER_MODEL   || 'whisper-large-v3-turbo');
const WHISPER_KEY_PRESENT = USE_OPENAI_WHISPER ? !!OPENAI_API_KEY : !!GROQ_API_KEY;

console.log(`🤖 IA: ${AI_PROVIDER.toUpperCase()} | LLM: ${LLM_MODEL} | Whisper: ${WHISPER_MODEL} (${USE_OPENAI_WHISPER ? 'OpenAI' : 'Groq'})`);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },  // 500 MB — soporta videos de reuniones largas
  fileFilter: (req, file, cb) => {
    const allowed = [
      // Audio
      'audio/webm','audio/mp3','audio/mpeg','audio/wav',
      'audio/m4a','audio/ogg','audio/flac','audio/aac',
      // Video (grabaciones de reuniones)
      'video/webm','video/mp4','video/ogg','video/quicktime',
      // Documentos
      'application/pdf','image/jpeg','image/png','image/gif',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de archivo no permitido: ' + file.mimetype));
  }
});

// =============================================================================
// FUNCIONES AUXILIARES
// sleep:       pausa para reintentos ante rate limit.
// addBizDays:  calcula fechas de compromiso en dias habiles (lunes-viernes).
// fmtId:       formatea el numero de tarea como string: 1 -> "001".
// parseJSON:   parsea respuestas del LLM tolerando texto extra antes/despues del JSON.
// dedup:       elimina tareas duplicadas o muy vagas de la lista generada por el LLM.
// isMeetingApproved / canAccess: control de acceso y estado de aprobacion.
// =============================================================================
const sleep      = ms => new Promise(r => setTimeout(r, ms));

// Lista de frases que Whisper genera como "ruido" cuando no hay voz clara
// o cuando capta sonido ambiental, silencio, o su propio prompt de contexto.
// Estas lineas se filtran antes de guardar en BD y antes de pasarlas al LLM.
const WHISPER_NOISE = [
  'transcribe en español', 'no traduzcas', 'mantén nombres propios',
  'mantén nombres', 'subtítulos realizados', 'amara.org', 'gracias por ver',
  'gracias por participar', 'reuniones de trabajo en español',
  'reunión de trabajo en español', 'para participar en nuestros',
  'www.patreon.com', 'www.youtube.com', 'escríbeme su nombre',
  'escríbeme sus nombres', 'mantengan nombres', 'manténganlos propios',
];
const isNoiseLine = text => {
  const t = (text || '').toLowerCase().trim();
  if (t.length < 4) return true;
  return WHISPER_NOISE.some(n => t.includes(n));
};
const addBizDays = (start, days) => {
  const d = new Date(start); let added = 0;
  while (added < days) { d.setDate(d.getDate()+1); if (d.getDay()!==0 && d.getDay()!==6) added++; }
  return d.toISOString().split('T')[0];
};
const fmtId    = n => String(n).padStart(3,'0');  // IDs numericos: 001, 002, 003
const callLLM = async (prompt, model = LLM_MODEL, retries = 3) => {
  const client    = (AI_PROVIDER === 'openai' && openaiClient) ? openaiClient : groq;
  const useModel  = (model === 'llama-3.3-70b-versatile' || model === 'llama-3.1-8b-instant')
    ? (model === 'llama-3.1-8b-instant' ? FAST_MODEL : LLM_MODEL)
    : model;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await client.chat.completions.create({
        model:           useModel,
        messages:        [{ role: 'user', content: prompt }],
        temperature:     0.1,
        response_format: { type: 'json_object' },
      });
      return r.choices?.[0]?.message?.content || null;
    } catch(e) {
      if (e.status === 429 && i < retries) {
        const wait = AI_PROVIDER === 'openai' ? (i+1)*3000 : (i+1)*8000;
        console.warn(`[callLLM] Rate limit (${useModel}), reintento ${i+1} en ${wait/1000}s`);
        await sleep(wait);
      } else throw e;
    }
  }
  return null;
};
const parseJSON = raw => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(_) {
    const m = raw.match(/\{[\s\S]*\}/);
    try { return m ? JSON.parse(m[0]) : null; } catch(_) { return null; }
  }
};
const isMeetingApproved = async id => {
  const [[r]] = await db.execute('SELECT approved_at FROM meetings WHERE id=?', [id]);
  return r && r.approved_at !== null;
};
const canAccess = async (mid, uid, cid, role) => {
  if (role==='superadmin') return true;
  const [[m]] = await db.execute('SELECT created_by,company_id FROM meetings WHERE id=?', [mid]);
  if (!m) return false;
  if (m.company_id !== cid) return false;
  if (role==='admin') return true;
  if (m.created_by === uid) return true;
  const [inv] = await db.execute('SELECT id FROM meeting_users WHERE meeting_id=? AND user_id=?', [mid, uid]);
  return inv.length > 0;
};

// =============================================================================
// SUPLEMENTOS: NOTAS Y AUDIOS ADJUNTOS
// Las notas de texto y los audios adicionales subidos durante o despues de la
// reunion se incluyen como contexto extra en el prompt del acta final.
// extractTareasFromSupplements: usa el LLM para detectar tareas concretas
// dentro de las notas y transcripciones de audios adjuntos.
// waitAudios: espera a que todos los audios adjuntos terminen de transcribirse
// antes de generar el acta, para incluir su contenido completo.
// =============================================================================
const getSupplements = async mid => {
  const [notes]  = await db.execute('SELECT * FROM meeting_notes WHERE meeting_id=? ORDER BY created_at', [mid]);
  const [audios] = await db.execute(`SELECT file_name,transcription FROM meeting_attachments WHERE meeting_id=? AND transcription_status='done' AND transcription IS NOT NULL AND transcription!=''`, [mid]);
  return { notes, audioTranscriptions: audios };
};

const extractTareasFromSupplements = async (notes, audioTranscriptions) => {
  const llmAvailable = (AI_PROVIDER === 'openai' && OPENAI_API_KEY) || GROQ_API_KEY;
  if (!llmAvailable || (notes.length===0 && audioTranscriptions.length===0)) return [];
  const textoParts = [];
  if (notes.length > 0) {
    textoParts.push('=== NOTAS ===');
    notes.forEach(n => textoParts.push(`• ${n.author ? `[${n.author}]: ` : ''}${n.content}`));
  }
  if (audioTranscriptions.length > 0) {
    textoParts.push('=== AUDIOS ADICIONALES ===');
    audioTranscriptions.forEach(a => textoParts.push(`--- ${a.file_name} ---\n${a.transcription}`));
  }
  const texto = textoParts.join('\n');
  const prompt = `Extrae TODAS las tareas, compromisos y pendientes mencionados en este texto.\nREGLAS:\n- Solo tareas con acción concreta + objeto específico (✅ "Enviar contrato al cliente" ✅ "Corregir bug del login")\n- NO vagas (❌ "Revisar" ❌ "Hacer seguimiento" ❌ "Ver el tema")\n- Incluye quién es responsable si se menciona\n- Si no hay tareas claras, devuelve array vacío\nJSON: {"tareas":[{"descripcion":"acción concreta","responsable":"nombre o vacío","cuando":"fecha o vacío"}]}\nTEXTO:\n${texto}\nSOLO JSON.`;
  try {
    const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
    const p   = parseJSON(raw);
    return (p?.tareas || []).filter(t => t.descripcion && t.descripcion.trim().length > 8);
  } catch(e) {
    console.warn('extractTareasFromSupplements:', e.message);
    return [];
  }
};

const waitAudios = async (mid, maxMs=5*60*1000) => {
  let w = 0;
  while (w < maxMs) {
    const [[{cnt}]] = await db.execute(`SELECT COUNT(*) as cnt FROM meeting_attachments WHERE meeting_id=? AND file_type='audio' AND transcription_status IN ('pending','processing')`, [mid]);
    if (!cnt) break;
    await sleep(5000); w += 5000;
  }
};

const suppBlock = (notes, audios) => {
  let b = '';
  if (notes.length)  b += `\n\n═══ NOTAS DE PARTICIPANTES (${notes.length}) ═══\n${notes.map(n=>`• ${n.author?`[${n.author}]: `:''}${n.content}`).join('\n')}`;
  if (audios.length) b += `\n\n═══ AUDIOS TRANSCRITOS (${audios.length}) ═══\n${audios.map(a=>`--- ${a.file_name} ---\n${a.transcription}`).join('\n\n')}`;
  return b;
};

const dedup = tareas => {
  // Solo elimina tareas completamente vacias o duplicados exactos.
  // Filtro minimo para no perder tareas validas del LLM.
  const seen = new Set();
  return tareas.filter(t => {
    const d = (t.descripcion || t.tarea || t.asunto || '').trim();
    if (!d || d.length < 5) return false;
    const key = d.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const getLinkedTareas = async id => {
  if (!id) return [];
  const [r] = await db.execute(`SELECT * FROM tareas WHERE meeting_id=? AND tipo='nueva' ORDER BY id`, [id]);
  return r;
};

// =============================================================================
// DIARIZACION DE SPEAKERS
// Proceso de identificar quien habla en cada linea de la transcripcion.
// Whisper transcribe el audio pero no siempre identifica correctamente a los
// participantes. improveSpeak envia lotes de lineas al LLM con los nombres
// reales de los participantes para que asigne el speaker correcto.
// Se procesa en batches de SPEAKER_BATCH lineas para no exceder el limite
// de tokens del modelo.
// =============================================================================
const improveSpeak = async (trans, parts=[]) => {
  const llmAvailable = (AI_PROVIDER === 'openai' && OPENAI_API_KEY) || GROQ_API_KEY;
  if (!llmAvailable || !trans.length) return trans;
  const res = [...trans];
  const hint = parts.length ? `PARTICIPANTES: ${parts.join(', ')}. Asigna su nombre exacto cuando sea claro.` : '';
  for (let s = 0; s < trans.length; s += SPEAKER_BATCH) {
    const batch = trans.slice(s, s+SPEAKER_BATCH);
    const lines = batch.map((t,i) => `[${s+i}]: ${t.text}`).join('\n');
    const prompt = `Experto en diarización de reuniones en español.\n${hint}\nDetecta cambios de speaker: preguntas→respuestas, cambios de rol, referencias a otros.\nUsa nombres de participantes cuando es claro; si no, Speaker1/Speaker2 consistente.\nJSON: {"lines":[{"index":N,"speaker":"Nombre"}]}\nTranscripción:\n${lines}`;
    try {
      const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
      const p = parseJSON(raw);
      (p?.lines||[]).forEach(l => { if (l.index>=0 && l.index<res.length && l.speaker) res[l.index] = {...res[l.index], speaker: l.speaker}; });
    } catch(e) { console.warn(`Speaker batch ${s}:`, e.message); }
  }
  return res;
};

// =============================================================================
// PROCESAMIENTO POR SECCIONES
// Para reuniones largas, la transcripcion se divide en secciones de
// SECTION_SIZE chunks. Cada seccion se resume de forma independiente con
// temas, decisiones y tareas detectadas.
// Esto permite procesar reuniones de cualquier duracion sin exceder el
// limite de tokens del LLM al generar el acta final.
// checkSection: se llama despues de cada chunk procesado para disparar
// automaticamente el resumen cuando se completa una seccion.
// =============================================================================
const genSection = async (mid, secNum, from, to) => {
  const [trans] = await db.execute(`SELECT id,speaker,text,chunk_number FROM transcriptions WHERE meeting_id=? AND chunk_number>=? AND chunk_number<=? ORDER BY chunk_number,id`, [mid, from, to]);
  if (!trans.length) return null;
  const [[meet]] = await db.execute('SELECT participantes,cliente,proyecto FROM meetings WHERE id=?', [mid]);
  let parts = []; try { parts = JSON.parse(meet?.participantes||'[]'); } catch(_) {}
  const imp = await improveSpeak(trans, parts);
  for (let i = 0; i < imp.length; i++) if (imp[i].speaker !== trans[i].speaker) await db.execute('UPDATE transcriptions SET speaker=? WHERE id=?', [imp[i].speaker, trans[i].id]);
  const tscr = imp.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
  const ctx  = [meet?.cliente, meet?.proyecto].filter(Boolean).join(' - ');
  const prompt = `Analiza SECCIÓN ${secNum} (min ~${Math.round(from*1.5)}–${Math.round((to+1)*1.5)})${ctx?` de ${ctx}`:''}.
CRITERIOS: temas específicos, decisiones TOMADAS, tareas EXPLÍCITAS (acción+objeto+quién).
✅ {"tarea":"Enviar contrato al cliente","quien":"Juan","cuando":"viernes"}
❌ "Revisar tema" ❌ "Hacer seguimiento" ❌ "Mejorar proceso"
JSON: {"temas":[],"decisiones":[],"tareas":[{"tarea":"","quien":"","cuando":""}],"puntos_criticos":[],"resumen":""}
Transcripción:\n${tscr}\nSOLO JSON válido.`;
  try {
    const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
    const sum = parseJSON(raw);
    if (sum) {
      await db.execute(`INSERT INTO section_summaries (meeting_id,section_num,from_chunk,to_chunk,summary_json) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE summary_json=VALUES(summary_json)`, [mid, secNum, from, to, JSON.stringify(sum)]);
      console.log(`[${mid}] Sección ${secNum} OK`);
      return sum;
    }
  } catch(e) { console.error(`Sección ${secNum}:`, e.message); }
  return null;
};

const checkSection = async mid => {
  const [[{cnt}]] = await db.execute('SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id=? AND processed=1', [mid]);
  const proc = cnt || 0;
  if (proc > 0 && proc % SECTION_SIZE === 0) {
    const sn = Math.floor(proc/SECTION_SIZE); const fc = (sn-1)*SECTION_SIZE; const tc = sn*SECTION_SIZE-1;
    const [ex] = await db.execute('SELECT id FROM section_summaries WHERE meeting_id=? AND section_num=?', [mid, sn]);
    if (!ex.length) { console.log(`[${mid}] Disparando sección ${sn}`); genSection(mid, sn, fc, tc).catch(console.error); }
  }
};

// =============================================================================
// GENERACION DEL ACTA FINAL
// buildActaPrompt: construye el prompt estructurado para el LLM con todos
// los datos de la reunion, tareas pre-detectadas, contexto de suplementos
// e instrucciones precisas para generar el acta en el formato JSON requerido.
// genActa: orquesta la generacion usando resumenes de secciones (optimo) o
// la transcripcion completa directamente si no hay secciones.
// genActaText: version para reuniones manuales (texto, email, notas libres).
// El JSON del acta contiene: identificacion, tareas_anteriores, tareas_nuevas,
// resumen_reunion y observaciones_generales.
// =============================================================================
const buildActaPrompt = (meta, sectionInputs, allTareasBruto, tareasAnt, suppBlk, hasSup, fechaDef, promptCtx='') => [
  '=== ROL ===',
  promptCtx
    ? promptCtx  // Contexto personalizado definido por el superadmin
    : 'Eres un redactor senior de actas corporativas en español latinoamericano.',
  'Tu objetivo: generar un acta ejecutiva profesional, completa y accionable.',
  '',
  '=== DATOS DE LA REUNION ===',
  `Cliente: ${meta.cliente} | Proyecto: ${meta.proyecto}`,
  `Fecha: ${meta.fecha} | Inicio: ${meta.hora_inicio} | Fin: ${meta.hora_fin}`,
  `Responsable: ${meta.responsable}`,
  `Participantes: ${(meta.participantes || []).join(', ')}`,
  '',
  tareasAnt.length
    ? `=== TAREAS DE REUNION ANTERIOR (NO repetir en tareas_nuevas) ===\n${tareasAnt.map(t => `  [${t.estado.toUpperCase()}] ${t.descripcion} — ${t.responsable || 'sin asignar'}`).join('\n')}`
    : '',
  '',
  '=== CONTENIDO DE LA REUNION ===',
  sectionInputs,
  suppBlk,
  '',
  '=== TAREAS YA DETECTADAS (consolidar, ampliar, no omitir) ===',
  JSON.stringify(allTareasBruto, null, 2),
  '',
  '=== INSTRUCCIONES ===',
  '',
  '--- resumen_reunion ---',
  'Prosa ejecutiva de 5 a 8 frases con esta estructura:',
  '  1. Objetivo principal de la reunion.',
  '  2. Temas especificos tratados.',
  '  3. Decisiones tomadas — indica quien decidio.',
  '  4. Acuerdos alcanzados.',
  '  5. Proximos pasos generales del equipo.',
  'Tono formal. Tercera persona. Sin bullets. Solo prosa continua.',
  hasSup ? 'Integra la informacion de notas y audios adjuntos en el resumen.' : '',
  '',
  '--- tareas_nuevas ---',
  'Extrae TODAS las tareas concretas. Se exhaustivo, no omitas ninguna.',
  '',
  'INCLUIR: accion especifica + objeto identificable.',
  '  OK: "Enviar el contrato al cliente antes del viernes"',
  '  OK: "Actualizar el tablero de validacion con datos de mayo"',
  '  OK: "Ricardo revisara los numeros de distribuidor por distribuidor"',
  '',
  'DESCARTAR: vagas o sin objeto claro.',
  '  NO: "Revisar" / "Coordinar" / "Hacer seguimiento" / "Ver el tema"',
  '',
  'Campos obligatorios por tarea:',
  '  - descripcion: la accion completa en una oracion clara',
  '  - asunto: titulo de maximo 8 palabras que identifique la tarea',
  '  - detalle: contexto completo — que se discutio, por que importa,',
  '             datos especificos mencionados en la reunion',
  '  - responsable: nombre exacto si se menciono, vacio si no',
  `  - fecha_compromiso: SOLO una fecha en formato AAAA-MM-DD (dias habiles desde ${fechaDef}). NUNCA texto largo ni frases.`,
  '  - prioridad: 3=Alta si es urgente o bloquea otras tareas, 2=Media, 1=Baja',
  '  - tipo_tarea: "e" si involucra cliente o externos, "i" si es interna',
  '  - IDs: 001, 002, 003... Sin limite de cantidad.',
  '',
  `--- tareas_anteriores ---`,
  tareasAnt.length
    ? `Incluye las ${tareasAnt.length} tareas anteriores. Actualiza el estado si se menciono avance.`
    : 'Array vacio []',
  '',
  '--- observaciones_generales ---',
  'Riesgos, dependencias entre tareas, acuerdos de contexto, informacion',
  'relevante que no es tarea pero impacta el proyecto. Vacio si no hay nada.',
  '',
  '=== FORMATO ===',
  'SOLO JSON valido. Sin texto antes ni despues. Sin markdown.',
  `{"identificacion":{"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},"tareas_anteriores":[],"tareas_nuevas":[{"id":"001","descripcion":"","asunto":"","detalle":"","responsable":"","fecha_compromiso":"${fechaDef}","prioridad":2,"tipo_tarea":"i"}],"resumen_reunion":"","observaciones_generales":""}`,
].join('\n');

const genActa = async (mid, meta, fechaDef, tareasAnt=[]) => {
  const [secs]  = await db.execute('SELECT section_num,from_chunk,to_chunk,summary_json FROM section_summaries WHERE meeting_id=? ORDER BY section_num', [mid]);
  const { notes, audioTranscriptions } = await getSupplements(mid);
  const sb    = suppBlock(notes, audioTranscriptions);
  const hasSup = notes.length > 0 || audioTranscriptions.length > 0;
  let actaJson = null;

  const tareasDeNotas = await extractTareasFromSupplements(notes, audioTranscriptions);
  if (tareasDeNotas.length > 0) console.log(`[${mid}] ${tareasDeNotas.length} tareas extraídas de notas/adjuntos`);

  if (secs.length > 0) {
    const sectionInputs = secs.map((s,i) => {
      const sum = parseJSON(s.summary_json) || {};
      return `--- SECCIÓN ${i+1} ---\nTemas: ${(sum.temas||[]).join(', ')}\nDecisiones: ${(sum.decisiones||[]).join('; ')}\nTareas: ${JSON.stringify(sum.tareas||[])}\nResumen: ${sum.resumen||''}`;
    }).join('\n\n');
    const tareasDeTranscripcion = secs.flatMap(s => {
      const sum = parseJSON(s.summary_json) || {};
      return (sum.tareas||[]).map(t => ({ descripcion:(t.tarea||t.descripcion||'').trim(), responsable:(t.quien||t.responsable||'').trim(), fecha_compromiso:(t.cuando||t.fecha_compromiso||'').trim() }));
    });
    const allTareas = [...tareasDeTranscripcion, ...tareasDeNotas.map(t => ({...t, descripcion:`[NOTA] ${t.descripcion}`}))];
    try {
      const raw = await callLLM(buildActaPrompt(meta, sectionInputs, allTareas, tareasAnt, sb, hasSup, fechaDef), 'llama-3.3-70b-versatile');
      actaJson = parseJSON(raw);
    } catch(e) { console.error('genActa secciones:', e.message); }
  }

  if (!actaJson) {
    const [rows] = await db.execute('SELECT speaker,text FROM transcriptions WHERE meeting_id=? ORDER BY chunk_number,id', [mid]);
    if (rows.length) {
      let tscr = rows.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
      if (tscr.split(/\s+/).length > WORDS_PER_CHUNK) {
        const ws = tscr.split(/\s+/); const sc = [];
        for (let i = 0; i < ws.length; i += 2500) sc.push(ws.slice(i,i+2500).join(' '));
        const ex = [];
        for (let i = 0; i < sc.length; i++) {
          const r = await callLLM(`JSON:{"temas":[],"tareas":[{"tarea":"","quien":"","cuando":""}],"resumen":""}SOLO tareas explícitas.Texto:${sc[i]}SOLO JSON.`,'llama-3.1-8b-instant').catch(()=>null);
          if (r) { const p = parseJSON(r); if (p) ex.push(p); }
          if (i < sc.length-1) await sleep(1200);
        }
        tscr = ex.map((e,i) => `Sección ${i+1}: ${e.resumen||''} | Tareas: ${JSON.stringify(e.tareas||[])}`).join('\n');
      }
      const antStr   = tareasAnt.length ? `\nTAREAS ANTERIORES:\n${tareasAnt.map(t=>`• [${t.estado}] ${t.descripcion}`).join('\n')}` : '';
      const notasStr = tareasDeNotas.length > 0 ? `\nTAREAS DETECTADAS EN NOTAS ADICIONALES (inclúyelas si son concretas):\n${tareasDeNotas.map(t=>`• ${t.descripcion}${t.responsable?' ('+t.responsable+')':''}`).join('\n')}` : '';
      try {
        const rawPrompt = [
          'Redactor senior de actas en español. Genera acta completa y accionable.',
          '',
          `Cliente: ${meta.cliente} | Proyecto: ${meta.proyecto}`,
          `Fecha: ${meta.fecha} | Responsable: ${meta.responsable}`,
          `Participantes: ${(meta.participantes||[]).join(', ')}`,
          antStr,
          notasStr,
          '',
          'TRANSCRIPCION:',
          tscr,
          sb,
          '',
          'INSTRUCCIONES:',
          'resumen_reunion: 5-6 frases. Objetivo, temas tratados, decisiones tomadas, proximos pasos.',
          'tareas_nuevas: extrae TODAS las tareas concretas sin excepcion.',
          '  Incluir: accion+objeto especifico. Excluir: vagas sin objeto.',
          '  Por cada tarea: descripcion clara, asunto corto, detalle con contexto,',
          `  responsable, fecha_compromiso SOLO en formato AAAA-MM-DD (dias habiles desde ${fechaDef}, NUNCA texto largo), prioridad (3=Alta 2=Media 1=Baja), tipo_tarea (i=interna e=externa).`,
          '  IDs numericos: 001, 002, 003... Sin limite de tareas.',
          'observaciones_generales: riesgos, dependencias, acuerdos relevantes.',
          '',
          'FORMATO - SOLO JSON valido:',
          `{"identificacion":{"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},"tareas_anteriores":[],"tareas_nuevas":[{"id":"001","descripcion":"","asunto":"","detalle":"","responsable":"","fecha_compromiso":"${fechaDef}","prioridad":2,"tipo_tarea":"i"}],"resumen_reunion":"","observaciones_generales":""}`,
        ].join('\n');
        const raw = await callLLM(rawPrompt, 'llama-3.3-70b-versatile');
        actaJson = parseJSON(raw);
      } catch(e) { console.error('genActa raw:', e.message); }
    }
  }

  if (!actaJson) actaJson = { identificacion:{...meta}, tareas_anteriores:[], tareas_nuevas:[], resumen_reunion:'No se pudo generar el acta.', observaciones_generales:'' };
  actaJson.identificacion = {...meta};
  if (Array.isArray(actaJson.tareas_nuevas)) actaJson.tareas_nuevas = actaJson.tareas_nuevas.map((t,i) => ({...t, id: fmtId(i+1)}));
  return actaJson;
};

const genActaText = async (texto, modo, meta, fechaDef, tareasAnt=[]) => {
  let input = texto;
  if (texto.split(/\s+/).length > 3000) {
    const ws = texto.split(/\s+/); const sc = [];
    for (let i = 0; i < ws.length; i += 2500) sc.push(ws.slice(i,i+2500).join(' '));
    const ex = [];
    for (let i = 0; i < sc.length; i++) {
      const r = await callLLM(`JSON:{"temas":[],"tareas":[{"tarea":"","quien":"","cuando":""}],"resumen":""}SOLO explícitas.Texto:${sc[i]}SOLO JSON.`,'llama-3.1-8b-instant').catch(()=>null);
      if (r) { const p = parseJSON(r); if (p) ex.push(p); }
      if (i < sc.length-1) await sleep(1200);
    }
    input = ex.map((e,i) => `Sección ${i+1}: ${e.resumen||''} | Tareas: ${JSON.stringify(e.tareas||[])}`).join('\n');
  }
  const ctx    = { notas:'NOTAS LIBRES.', transcripcion:'TRANSCRIPCIÓN con diálogos.', email:'EMAIL resumen.' };
  const antStr = tareasAnt.length ? `\nTAREAS ANTERIORES:\n${tareasAnt.map(t=>`• [${t.estado}] ${t.descripcion}`).join('\n')}` : '';
  const prompt5 = [
    '=== ROL ===',
    'Redactor senior de actas corporativas en español latinoamericano.',
    `Tipo de entrada: ${ctx[modo] || ctx.notas}`,
    '',
    '=== DATOS ===',
    `Cliente: ${meta.cliente} | Proyecto: ${meta.proyecto}`,
    `Fecha: ${meta.fecha} | Inicio: ${meta.hora_inicio} | Fin: ${meta.hora_fin}`,
    `Responsable: ${meta.responsable} | Participantes: ${meta.participantes.join(', ')}`,
    antStr,
    '',
    '=== CONTENIDO ===',
    input,
    '',
    '=== INSTRUCCIONES ===',
    'resumen_reunion: prosa 5-8 frases. Objetivo, temas, decisiones con nombres, proximos pasos.',
    'tareas_nuevas: TODAS las concretas. descripcion+asunto+detalle+responsable+fecha+prioridad+tipo.',
    '  detalle: contexto completo de lo discutido sobre cada tarea.',
    '  VALIDAS: accion+objeto especifico. INVALIDAS: "Revisar"/"Coordinar"/"Ver el tema".',
    `  fecha: SOLO formato AAAA-MM-DD (dias habiles desde ${fechaDef}). NUNCA texto largo. prioridad: 3=Alta 2=Media 1=Baja. tipo: e=externa i=interna.`,
    '  IDs: 001, 002... Sin limite.',
    'observaciones_generales: riesgos, dependencias, acuerdos relevantes.',
    '',
    '=== FORMATO ===',
    'SOLO JSON valido. Sin texto ni markdown.',
    `{"identificacion":{"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},"tareas_anteriores":[],"tareas_nuevas":[{"id":"001","descripcion":"","asunto":"","detalle":"","responsable":"","fecha_compromiso":"${fechaDef}","prioridad":2,"tipo_tarea":"i"}],"resumen_reunion":"","observaciones_generales":""}`,
  ].join('\n');
  const raw = await callLLM(prompt5, 'llama-3.3-70b-versatile');
  const p = parseJSON(raw);
  if (p?.tareas_nuevas) p.tareas_nuevas = p.tareas_nuevas.map((t,i) => ({...t, id: fmtId(i+1)}));
  return p;
};

// =============================================================================
// FINALIZACION DE REUNION
// Se ejecuta de forma asincrona al recibir /endMeeting.
// Flujo: esperar chunks pendientes -> esperar audios adjuntos -> generar
// ultima seccion si quedo incompleta -> generar acta final -> guardar acta
// y tareas en la BD -> marcar reunion como 'ended'.
// Las tareas anteriores (de reunion vinculada) se copian con su estado actual.
// Las tareas nuevas se insertan con todos los campos extendidos.
// =============================================================================
const finalizeMeeting = async mid => {
  const [[meet]] = await db.execute('SELECT cliente,proyecto,responsable,participantes,started_at,ended_at,linked_meeting_id FROM meetings WHERE id=?', [mid]);
  if (!meet) return;
  let parts = []; try { parts = JSON.parse(meet.participantes||'[]'); } catch(_) {}
  let w = 0;
  while (w < 5*60*1000) {
    const [[{cnt}]] = await db.execute('SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id=? AND processed=0', [mid]);
    if (!cnt) break; await sleep(3000); w += 3000;
  }
  await waitAudios(mid, 5*60*1000);
  const [[ls]] = await db.execute('SELECT MAX(to_chunk) as lc FROM section_summaries WHERE meeting_id=?', [mid]);
  const lc = ls?.lc ?? -1;
  const [[lk]] = await db.execute('SELECT MAX(chunk_number) as mk FROM chunks WHERE meeting_id=? AND processed=1', [mid]);
  const mk = lk?.mk;
  if (mk!=null && mk>lc) {
    const [[{cnt:sc}]] = await db.execute('SELECT COUNT(*) as cnt FROM section_summaries WHERE meeting_id=?', [mid]);
    await genSection(mid, (sc||0)+1, lc+1, mk);
  }
  const tareasAnt = await getLinkedTareas(meet.linked_meeting_id);
  const sd = meet.started_at ? new Date(meet.started_at) : null;
  const ed = meet.ended_at   ? new Date(meet.ended_at)   : null;
  const meta = {
    cliente: meet.cliente||'', proyecto: meet.proyecto||'', responsable: meet.responsable||'', participantes: parts,
    fecha:      sd ? sd.toISOString().split('T')[0] : '',
    hora_inicio: sd ? `${String(sd.getHours()).padStart(2,'0')}:${String(sd.getMinutes()).padStart(2,'0')}` : '',
    hora_fin:    ed ? `${String(ed.getHours()).padStart(2,'0')}:${String(ed.getMinutes()).padStart(2,'0')}` : '',
  };
  const fd = addBizDays(meta.fecha || new Date().toISOString().split('T')[0], 3);
  console.log(`[${mid}] Generando acta...`);
  const actaJson = await genActa(mid, meta, fd, tareasAnt);
  actaJson.identificacion = {...meta};
  if (tareasAnt.length) actaJson.tareas_anteriores = tareasAnt.map((t,i) => ({ id:`ant_${String(i+1).padStart(3,'0')}`, descripcion:t.descripcion, responsable:t.responsable, estado:t.estado, fecha_compromiso:t.fecha_compromiso||'' }));
  await db.execute('INSERT INTO actas (meeting_id,acta_json) VALUES (?,?) ON DUPLICATE KEY UPDATE acta_json=VALUES(acta_json)', [mid, JSON.stringify(actaJson)]);
  await db.execute('DELETE FROM tareas WHERE meeting_id=?', [mid]);
  for (const t of tareasAnt) await db.execute('INSERT INTO tareas (meeting_id,tarea_id,tipo,descripcion,responsable,estado,fecha_compromiso) VALUES (?,?,?,?,?,?,?)', [mid, t.tarea_id||uuidv4(), 'anterior', t.descripcion||'', t.responsable||'', t.estado||'pendiente', t.fecha_compromiso||'']);
  const td = dedup(actaJson.tareas_nuevas || []);
  // Saneo defensivo: trunca cualquier campo de fecha a 50 chars para que jamas
  // pueda volver a tronar el INSERT, sin importar lo que devuelva el LLM.
  const safeFecha = (v, fallback) => {
    const s = String(v || fallback || '').trim();
    return s.length > 50 ? s.slice(0, 50) : (s || fallback);
  };
  for (let i = 0; i < td.length; i++) {
    const t = td[i];
    const fc = safeFecha(t.fecha_compromiso, fd);
    await db.execute(
      `INSERT INTO tareas (meeting_id,tarea_id,tipo,descripcion,asunto,detalle,responsable,asignado_a,
        user_create,estado,estado_tarea,prioridad,tipo_tarea,fecha_compromiso,date_end)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [mid, fmtId(i+1), 'nueva',
       (t.descripcion||'').trim(),
       (t.asunto||t.descripcion||'').substring(0,100).trim(),
       (t.detalle||t.descripcion||'').trim(),
       (t.responsable||'').trim(),
       (t.responsable||'').trim(),
       meta?.responsable||'',
       'pendiente', 1,
       t.prioridad||2,
       t.tipo_tarea||'i',
       fc,
       fc
      ]);
  }
  await db.execute("UPDATE meetings SET status='ended' WHERE id=?", [mid]);
  console.log(`[${mid}] tareas_nuevas del LLM: ${(actaJson.tareas_nuevas||[]).length} | despues de dedup: ${td.length}`);
  if ((actaJson.tareas_nuevas||[]).length > 0 && td.length === 0) {
    console.warn(`[${mid}] ATENCION: dedup elimino todas las tareas. Revisar contenido.`);
  }
};

// =============================================================================
// TRANSCRIPCION DE AUDIO CON WHISPER
// toMp3: convierte cualquier formato de audio a MP3 mono 16kHz con ffmpeg.
// Esto reduce el tamaño del archivo y mejora la velocidad de transcripcion.
// whisperPrompt: construye el contexto para Whisper con el nombre del proyecto,
// participantes y terminologia tecnica para mejorar precision de transcripcion.
// procChunk: procesa un chunk de grabacion en tiempo real. Maneja reintentos
// automaticos ante rate limit (429) esperando 60 segundos antes de reintentar.
// procAudio: transcribe un audio adjunto subido manualmente.
// =============================================================================
const toMp3 = async ip => {
  const op = ip.replace(/\.(webm|wav|m4a|ogg|mp4|aac|flac)$/i, '.mp3');
  try { await execFileAsync('ffmpeg', ['-y','-i',ip,'-vn','-ar','16000','-ac','1','-b:a','64k',op]); return op; }
  catch(e) { console.error('ffmpeg:', e.message); return null; }
};
const whisperPrompt = (parts, cli, proj, term) => {
  // IMPORTANTE: El prompt de Whisper NO son instrucciones — es el inicio
  // simulado de la conversacion. Whisper lo usa para calibrar el vocabulario
  // y nombres esperados. Si incluye frases como "Transcribe en español",
  // el modelo las reproduce literalmente en la transcripcion.
  // La estrategia correcta es simular como empezaria el acta: fecha, proyecto,
  // participantes — texto natural que Whisper reconoce como contexto.
  const parts_str = parts.length ? parts.join(', ') : '';
  const ctx_str   = [cli, proj].filter(Boolean).join(' - ');
  const term_str  = term || '';

  // Construir un "inicio de conversacion" natural que calibre a Whisper
  // sin que lo reproduzca como texto de la reunion
  const lines = [];
  if (ctx_str)   lines.push(ctx_str);
  if (parts_str) lines.push(parts_str);
  if (term_str)  lines.push(term_str);
  return lines.join('. ');
};

const procChunk = async (fp, mid, cn, parts=[], cli='', proj='', term='') => {
  if (!WHISPER_KEY_PRESENT) { await db.execute('UPDATE chunks SET processed=2 WHERE meeting_id=? AND chunk_number=?', [mid, cn]); return null; }
  let fs2 = fp, mp = null;
  try { mp = await toMp3(fp); if (mp && fs.existsSync(mp) && fs.statSync(mp).size > 1000) fs2 = mp; } catch(_) {}
  try {
    if (fs.statSync(fs2).size/1024 < 1) { await db.execute('UPDATE chunks SET processed=1 WHERE meeting_id=? AND chunk_number=?', [mid, cn]); return null; }
    const tr = await whisperClient.audio.transcriptions.create({ file: fs.createReadStream(fs2), model: WHISPER_MODEL, response_format:'verbose_json', language:'es', prompt:whisperPrompt(parts,cli,proj,term) });
    const segs = Array.isArray(tr.segments) ? tr.segments : [];
    if (segs.length > 0) {
      let sc = 1; const sm = {};
      for (const s of segs) { const k = s.spk||s.speaker||'sp'; if (!sm[k]) sm[k] = `Speaker${sc++}`; const txt = (s.text||'').trim(); if (txt && !isNoiseLine(txt)) await db.execute('INSERT INTO transcriptions (meeting_id,chunk_number,speaker,text,timestamp) VALUES (?,?,?,?,?)', [mid, cn, sm[k], txt, new Date()]); }
    } else if (tr.text?.trim() && !isNoiseLine(tr.text)) {
      await db.execute('INSERT INTO transcriptions (meeting_id,chunk_number,speaker,text,timestamp) VALUES (?,?,?,?,?)', [mid, cn, 'Speaker1', tr.text.trim(), new Date()]);
    }
    if (mp && fs.existsSync(mp)) fs.unlinkSync(mp);
    await db.execute('UPDATE chunks SET processed=1 WHERE meeting_id=? AND chunk_number=?', [mid, cn]);
    checkSection(mid).catch(console.error);
    return tr;
  } catch(error) {
    if (mp && fs.existsSync(mp)) try { fs.unlinkSync(mp); } catch(_) {}
    const code = error.status===429 ? 2 : -1;
    await db.execute('UPDATE chunks SET processed=? WHERE meeting_id=? AND chunk_number=?', [code, mid, cn]);
    if (error.status===429) {
      setTimeout(async () => {
        const [[r]] = await db.execute('SELECT processed FROM chunks WHERE meeting_id=? AND chunk_number=?', [mid, cn]);
        if (r?.processed===2) { await db.execute('UPDATE chunks SET processed=0 WHERE meeting_id=? AND chunk_number=?', [mid, cn]); procChunk(fp, mid, cn, parts, cli, proj, term).catch(()=>{}); }
      }, 60000);
    }
    return null;
  }
};

const procAudio = async (aid, fp, mid, parts=[], cli='', proj='', term='') => {
  if (!WHISPER_KEY_PRESENT) { await db.execute('UPDATE meeting_attachments SET transcription_status=? WHERE id=?', ['error', aid]); return; }
  await db.execute('UPDATE meeting_attachments SET transcription_status=? WHERE id=?', ['processing', aid]);
  let fs2 = fp, mp = null;
  try { mp = await toMp3(fp); if (mp && fs.existsSync(mp) && fs.statSync(mp).size > 1000) fs2 = mp; } catch(_) {}
  try {
    if (fs.statSync(fs2).size/1024 < 1) { await db.execute('UPDATE meeting_attachments SET transcription_status=?,transcription=? WHERE id=?', ['done','',aid]); return; }
    const tr = await whisperClient.audio.transcriptions.create({ file: fs.createReadStream(fs2), model: WHISPER_MODEL, response_format:'verbose_json', language:'es', prompt:whisperPrompt(parts,cli,proj,term) });
    let text = ''; const segs = Array.isArray(tr.segments) ? tr.segments : [];
    if (segs.length) text = segs.filter(s=>(s.text||'').trim()).map(s=>s.text.trim()).join(' ');
    else if (tr.text?.trim()) text = tr.text.trim();
    if (mp && fs.existsSync(mp)) fs.unlinkSync(mp);
    await db.execute('UPDATE meeting_attachments SET transcription_status=?,transcription=? WHERE id=?', ['done', text, aid]);
  } catch(e) {
    if (mp && fs.existsSync(mp)) try { fs.unlinkSync(mp); } catch(_) {}
    await db.execute('UPDATE meeting_attachments SET transcription_status=? WHERE id=?', ['error', aid]);
  }
};

// =============================================================================
// RUTAS PUBLICAS — Sin autenticacion requerida
// /health:         verificacion de estado del servidor.
// /login:          autenticacion de usuarios internos, emite JWT de 8 horas.
//                  Migra contrasenas SHA-256 legacy a bcrypt en primer login.
// /client-login:   autenticacion del portal del cliente, emite JWT de 7 dias.
// /auth/refresh:   renueva el JWT antes de que expire sin pedir contrasena.
//                  DEBE estar antes de app.use(authMiddleware).
// /client/actas:   lista actas del cliente autenticado (solo las de su empresa).
// /client/actas/:mid/approve: el cliente aprueba el acta (operacion irreversible).
// =============================================================================
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── Login ────────────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  try {
    const [rows] = await db.execute(
      `SELECT u.*,c.name as company_name,c.slug as company_slug FROM users u JOIN companies c ON c.id=u.company_id WHERE u.email=? AND u.active=1`,
      [email.trim().toLowerCase()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    const u = rows[0];
    const valid = await verifyPwd(password, u.password_hash);
    if (!valid) return res.status(401).json({ error: 'Email o contraseña incorrectos' });

    // Migración: si la contraseña está en SHA-256, rehashear con bcrypt
    if (!u.password_hash.startsWith('$2b$') && !u.password_hash.startsWith('$2a$')) {
      const newHash = await hashPwd(password);
      await db.execute('UPDATE users SET password_hash=? WHERE id=?', [newHash, u.id]);
      console.log(`[Auth] Contraseña migrada a bcrypt para usuario ${u.id}`);
    }

    const token = jwt.sign(
      { id:u.id, email:u.email, name:u.name, role:u.role, company_id:u.company_id, company_name:u.company_name, company_slug:u.company_slug },
      JWT_SECRET, { expiresIn: '8h' }
    );
    res.json({ token, user:{ id:u.id, name:u.name, email:u.email, role:u.role, company_name:u.company_name } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Client Login ─────────────────────────────────────────────────────────────
app.post('/client-login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  try {
    const [rows] = await db.execute('SELECT * FROM clients WHERE LOWER(username)=LOWER(?) AND active=1', [username]);
    if (!rows.length) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const c = rows[0];
    const valid = await verifyPwd(password, c.password_hash);
    if (!valid) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    // Migración SHA-256 → bcrypt
    if (!c.password_hash.startsWith('$2b$') && !c.password_hash.startsWith('$2a$')) {
      const newHash = await hashPwd(password);
      await db.execute('UPDATE clients SET password_hash=? WHERE id=?', [newHash, c.id]);
    }

    const token = jwt.sign(
      { role:'client', client_id:c.id, client_name:c.name, company_id:c.company_id, username:c.username },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ token, client_name: c.name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Refresh Token ────────────────────────────────────────────────────────────
// IMPORTANTE: debe estar ANTES de app.use(authMiddleware)
app.post('/auth/refresh', async (req, res) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(h.split(' ')[1], JWT_SECRET);
    const [[u]] = await db.execute(
      `SELECT u.*,c.name as company_name,c.slug as company_slug FROM users u JOIN companies c ON c.id=u.company_id WHERE u.id=? AND u.active=1`,
      [decoded.id]
    );
    if (!u) return res.status(401).json({ error: 'Usuario inactivo o no encontrado' });
    const token = jwt.sign(
      { id:u.id, email:u.email, name:u.name, role:u.role, company_id:u.company_id, company_name:u.company_name, company_slug:u.company_slug },
      JWT_SECRET, { expiresIn: '8h' }
    );
    res.json({ token });
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado. Inicia sesión nuevamente.', code: 'TOKEN_EXPIRED' });
  }
});

// ─── Portal cliente ───────────────────────────────────────────────────────────
app.get('/client/actas', clientAuth, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT m.id,m.cliente,m.proyecto,m.responsable,m.started_at,m.ended_at,m.participantes,m.approved_at,m.approved_by_client,a.acta_json,a.created_at as acta_created_at FROM meetings m LEFT JOIN actas a ON a.meeting_id=m.id WHERE LOWER(m.cliente)=LOWER(?) AND m.company_id=? AND m.status='ended' AND a.acta_json IS NOT NULL ORDER BY m.started_at DESC`,
      [req.client.client_name, req.client.company_id]
    );
    res.json(rows.map(r => ({
      ...r,
      participantes: (()=>{ try { return JSON.parse(r.participantes||'[]'); } catch(_) { return []; } })(),
      acta: r.acta_json ? JSON.parse(r.acta_json) : null,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/client/actas/:mid/approve', clientAuth, async (req, res) => {
  try {
    const [[m]] = await db.execute('SELECT id,approved_at FROM meetings WHERE id=? AND company_id=?', [req.params.mid, req.client.company_id]);
    if (!m) return res.status(404).json({ error: 'No encontrada' });
    if (m.approved_at) return res.status(409).json({ error: 'Ya fue aprobada' });
    await db.execute('UPDATE meetings SET approved_at=NOW(),approved_by_client=? WHERE id=?', [req.client.username, req.params.mid]);
    res.json({ ok:true, approved_at: new Date().toISOString(), approved_by: req.client.username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// A PARTIR DE AQUI TODAS LAS RUTAS REQUIEREN JWT VALIDO
// app.use(authMiddleware) aplica la verificacion a todos los endpoints
// que se definan despues de esta linea.
// =============================================================================
app.use(authMiddleware);

// =============================================================================
// CONFIGURACION DE EMPRESA — PROMPT PERSONALIZADO
// El superadmin puede definir un contexto de rol que se inyecta al inicio
// del prompt del LLM. Ejemplo: "Actua como experto en analisis financiero."
// Las variables internas del prompt nunca se exponen ni modifican.
// NOTA: estas rutas usan req.user, por lo que DEBEN ir despues de
// app.use(authMiddleware) — moverlas antes de esa linea causa 500
// (req.user es undefined) en vez del 403 esperado por falta de permiso.
// =============================================================================

// Obtener el prompt_context de la empresa (cacheable en memoria)
const getPromptContext = async (company_id) => {
  try {
    const [[r]] = await db.execute('SELECT prompt_context FROM company_settings WHERE company_id=?', [company_id]);
    return (r?.prompt_context || '').trim();
  } catch(_) { return ''; }
};

// Leer configuracion de la empresa
app.get('/admin/settings', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const [[r]] = await db.execute('SELECT prompt_context FROM company_settings WHERE company_id=?', [req.user.company_id]).catch(()=>[[null]]);
    res.json({ prompt_context: r?.prompt_context || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Guardar configuracion — solo superadmin puede cambiar el prompt
app.put('/admin/settings', requireRole('superadmin'), async (req, res) => {
  try {
    const { prompt_context = '' } = req.body;
    // Limite de 500 caracteres para evitar prompts excesivos
    const safe = String(prompt_context).slice(0, 500).trim();
    await db.execute(
      'INSERT INTO company_settings (company_id, prompt_context) VALUES (?,?) ON DUPLICATE KEY UPDATE prompt_context=VALUES(prompt_context)',
      [req.user.company_id, safe]
    );
    res.json({ ok: true, prompt_context: safe });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// GRABACION DE VIDEO
// El video completo se sube en un solo blob al finalizar la reunion.
// Se guarda en storage/recordings/ y se sirve con range requests para seek.
// Solo visible para usuarios internos con acceso — clientes no lo ven.
// NOTA: estas rutas usan req.user (via canAccess), por lo que DEBEN ir
// despues de app.use(authMiddleware).
// =============================================================================

app.post('/meetings/:id/recording', upload.single('video'), async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso' });
    if (!req.file) return res.status(400).json({ error: 'No se recibio video' });
    const recPath = path.join(storagePath, '..', 'recordings');
    fs.mkdirSync(recPath, { recursive: true });
    const fp = path.join(recPath, `${req.params.id}.webm`);
    fs.writeFileSync(fp, req.file.buffer);
    const size = req.file.buffer.length;
    // Crear tabla si no existe (tolerante a primer arranque)
    await db.execute(`CREATE TABLE IF NOT EXISTS recordings (
      id INT AUTO_INCREMENT PRIMARY KEY, meeting_id VARCHAR(36) NOT NULL UNIQUE,
      file_path VARCHAR(500) NOT NULL, file_size BIGINT DEFAULT 0,
      mime_type VARCHAR(50) DEFAULT 'video/webm', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.execute(
      'INSERT INTO recordings (meeting_id,file_path,file_size,mime_type) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE file_path=VALUES(file_path),file_size=VALUES(file_size)',
      [req.params.id, fp, size, req.file.mimetype || 'video/webm']
    );
    console.log(`[${req.params.id}] Video guardado: ${(size/1024/1024).toFixed(1)}MB`);
    res.json({ ok: true, size_mb: (size/1024/1024).toFixed(1) });
  } catch(e) { console.error('[recording POST]', e); res.status(500).json({ error: e.message }); }
});

app.get('/meetings/:id/recording/info', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso' });
    try {
      const [[r]] = await db.execute('SELECT file_size,mime_type,created_at FROM recordings WHERE meeting_id=?', [req.params.id]);
      if (!r) return res.json({ exists: false });
      res.json({ exists: true, size_mb: (r.file_size/1024/1024).toFixed(1), created_at: r.created_at });
    } catch(dbErr) {
      // Si la tabla no existe aún (primer arranque), responder como si no hubiera video
      if (dbErr.code === 'ER_NO_SUCH_TABLE') return res.json({ exists: false });
      throw dbErr;
    }
  } catch(e) { console.error('[recording INFO]', e); res.status(500).json({ error: e.message }); }
});

// Range requests permiten seek en el reproductor sin descargar el video completo
app.get('/meetings/:id/recording/stream', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso' });
    let r;
    try {
      const [[row]] = await db.execute('SELECT file_path,mime_type FROM recordings WHERE meeting_id=?', [req.params.id]);
      r = row;
    } catch(dbErr) {
      if (dbErr.code === 'ER_NO_SUCH_TABLE') return res.status(404).json({ error: 'Video no encontrado' });
      throw dbErr;
    }
    if (!r || !fs.existsSync(r.file_path)) return res.status(404).json({ error: 'Video no encontrado' });
    const stat  = fs.statSync(r.file_path);
    const range = req.headers.range;
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': end - start + 1,
        'Content-Type':   r.mime_type || 'video/webm',
      });
      fs.createReadStream(r.file_path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type':   r.mime_type || 'video/webm',
        'Accept-Ranges':  'bytes',
      });
      fs.createReadStream(r.file_path).pipe(res);
    }
  } catch(e) { console.error('[recording STREAM]', e); res.status(500).json({ error: e.message }); }
});

// =============================================================================
// ADMINISTRACION DE EMPRESAS (solo superadmin)
// El superadmin puede crear nuevas empresas con su primer usuario admin,
// listar todas las empresas con estadisticas, y activar o desactivar empresas.
// Cada empresa es un tenant independiente: sus datos no son visibles para otras.
// =============================================================================
app.get('/superadmin/companies', requireRole('superadmin'), async (req, res) => {
  try {
    const [r] = await db.execute(`SELECT c.*,COUNT(DISTINCT u.id) as user_count,COUNT(DISTINCT m.id) as meeting_count FROM companies c LEFT JOIN users u ON u.company_id=c.id LEFT JOIN meetings m ON m.company_id=c.id GROUP BY c.id ORDER BY c.name`);
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/superadmin/companies', requireRole('superadmin'), async (req, res) => {
  const { name, admin_name, admin_email, admin_password } = req.body;
  if (!name || !admin_email || !admin_password) return res.status(400).json({ error: 'Nombre, email y contraseña requeridos' });
  try {
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-');
    const [cr] = await db.execute('INSERT INTO companies (name,slug) VALUES (?,?)', [name.trim(), slug]);
    await db.execute('INSERT INTO users (company_id,name,email,password_hash,role) VALUES (?,?,?,?,?)',
      [cr.insertId, admin_name||'Admin', admin_email.trim().toLowerCase(), await hashPwd(admin_password), 'admin']);
    res.json({ id: cr.insertId, name, slug });
  } catch(e) { res.status(e.code==='ER_DUP_ENTRY'?409:500).json({ error: e.message }); }
});

app.put('/superadmin/companies/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const { name, active } = req.body;
    if (name)              await db.execute('UPDATE companies SET name=? WHERE id=?', [name, req.params.id]);
    if (active !== undefined) await db.execute('UPDATE companies SET active=? WHERE id=?', [active?1:0, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// ADMINISTRACION DE USUARIOS
// Solo admin y superadmin pueden gestionar usuarios.
// Cada admin solo puede ver y modificar usuarios de su propia empresa.
// Un usuario no puede eliminarse a si mismo para evitar quedarse sin acceso.
// =============================================================================
app.get('/admin/users', requireRole('superadmin','admin'), async (req, res) => {
  try {
    const cid = req.user.role==='superadmin' ? (req.query.company_id||req.user.company_id) : req.user.company_id;
    const [r]  = await db.execute('SELECT id,name,email,role,active,created_at FROM users WHERE company_id=? ORDER BY name', [cid]);
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/users', requireRole('superadmin','admin'), async (req, res) => {
  const { name, email, password, role='member' } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña requeridos' });
  try {
    const [r] = await db.execute('INSERT INTO users (company_id,name,email,password_hash,role) VALUES (?,?,?,?,?)',
      [req.user.company_id, name.trim(), email.trim().toLowerCase(), await hashPwd(password), role]);
    res.json({ id: r.insertId, name, email, role });
  } catch(e) { res.status(e.code==='ER_DUP_ENTRY'?409:500).json({ error: e.message }); }
});

app.put('/admin/users/:id', requireRole('superadmin','admin'), async (req, res) => {
  try {
    const { name, password, role, active } = req.body;
    const cid = req.user.company_id;
    if (name)     await db.execute('UPDATE users SET name=? WHERE id=? AND company_id=?', [name, req.params.id, cid]);
    if (password) await db.execute('UPDATE users SET password_hash=? WHERE id=? AND company_id=?', [await hashPwd(password), req.params.id, cid]);
    if (role)     await db.execute('UPDATE users SET role=? WHERE id=? AND company_id=?', [role, req.params.id, cid]);
    if (active !== undefined) await db.execute('UPDATE users SET active=? WHERE id=? AND company_id=?', [active?1:0, req.params.id, cid]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/users/:id', requireRole('superadmin','admin'), async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
    await db.execute('DELETE FROM users WHERE id=? AND company_id=?', [req.params.id, req.user.company_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// ADMINISTRACION DE CLIENTES DEL PORTAL
// Los clientes son personas externas (no usuarios del sistema) que tienen
// acceso al portal para revisar y aprobar actas de sus proyectos.
// Se identifican por el campo 'cliente' de las reuniones.
// =============================================================================
app.get('/admin/clients', requireRole('superadmin','admin'), async (req, res) => {
  try {
    const [r] = await db.execute(
      `SELECT c.id,c.name,c.username,c.active,c.created_at,COUNT(DISTINCT m.id) as meeting_count FROM clients c LEFT JOIN meetings m ON LOWER(m.cliente)=LOWER(c.name) AND m.company_id=c.company_id WHERE c.company_id=? GROUP BY c.id ORDER BY c.name`,
      [req.user.company_id]
    );
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/clients', requireRole('superadmin','admin'), async (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Nombre, usuario y contraseña requeridos' });
  try {
    const [r] = await db.execute('INSERT INTO clients (company_id,name,username,password_hash) VALUES (?,?,?,?)',
      [req.user.company_id, name.trim(), username.trim().toLowerCase(), await hashPwd(password)]);
    res.json({ id: r.insertId, name, username: username.toLowerCase() });
  } catch(e) { res.status(e.code==='ER_DUP_ENTRY'?409:500).json({ error: e.message }); }
});

app.put('/admin/clients/:id', requireRole('superadmin','admin'), async (req, res) => {
  try {
    const { name, username, password, active } = req.body;
    const cid = req.user.company_id;
    if (name)     await db.execute('UPDATE clients SET name=? WHERE id=? AND company_id=?', [name, req.params.id, cid]);
    if (username) await db.execute('UPDATE clients SET username=? WHERE id=? AND company_id=?', [username.toLowerCase(), req.params.id, cid]);
    if (password) await db.execute('UPDATE clients SET password_hash=? WHERE id=? AND company_id=?', [await hashPwd(password), req.params.id, cid]);
    if (active !== undefined) await db.execute('UPDATE clients SET active=? WHERE id=? AND company_id=?', [active?1:0, req.params.id, cid]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/clients/:id', requireRole('superadmin','admin'), async (req, res) => {
  try {
    await db.execute('DELETE FROM clients WHERE id=? AND company_id=?', [req.params.id, req.user.company_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// UTILIDADES DE USUARIOS
// for-invite:  lista usuarios disponibles para invitar a una reunion
//              (excluye al creador que ya tiene acceso como propietario).
// company:     lista todos los usuarios activos para selects de responsable
//              y asignado_a en las tareas.
// =============================================================================
app.get('/admin/users/for-invite', async (req, res) => {
  try {
    const [r] = await db.execute('SELECT id,name,email FROM users WHERE company_id=? AND active=1 AND id!=? ORDER BY name', [req.user.company_id, req.user.id]);
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Usuarios para selects (tareas) ─────────────────────────────────────────
app.get('/admin/users/company', async (req, res) => {
  try {
    const [r] = await db.execute(
      'SELECT id, name, email FROM users WHERE company_id=? AND active=1 ORDER BY name',
      [req.user.company_id]
    );
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// EXPORTACION DE TAREAS A CSV
// Se genera con BOM UTF-8 para que Excel abra correctamente los caracteres
// en espanol sin configuracion adicional.
// /meetings/:id/tareas/excel: exporta las tareas de una reunion especifica.
// /tareas/excel:              exporta todas las tareas de todas las reuniones
//                             de la empresa del usuario autenticado.
// =============================================================================
app.get('/meetings/:id/tareas/excel', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso' });
    const [[m]] = await db.execute('SELECT cliente,proyecto,started_at FROM meetings WHERE id=?', [req.params.id]);
    const [rows] = await db.execute('SELECT * FROM tareas WHERE meeting_id=? ORDER BY tipo DESC,id', [req.params.id]);
    const ESTADOS = {1:'Sin iniciar',2:'En progreso',3:'En revisión',4:'Finalizada',5:'Planeación',7:'Respuesta Cliente',8:'Pend otros procesos'};
    const PRIO    = {1:'Baja',2:'Media',3:'Alta'};
    const head = ['ID','Tipo','Asunto','Descripción','Detalle','Responsable','Asignado a','Estado','Prioridad','Tipo Tarea','Req ID','Fecha Compromiso','Fecha Inicio','Fecha Fin'];
    const data = rows.map(t => [
      t.tarea_id||t.id, t.tipo,
      t.asunto||'', t.descripcion||'', t.detalle||'',
      t.responsable||'', t.asignado_a||'',
      ESTADOS[t.estado_tarea]||t.estado||'',
      PRIO[t.prioridad]||'', t.tipo_tarea==='e'?'Externa':'Interna',
      t.requerimiento_id||'', t.fecha_compromiso||'', t.date_init||'', t.date_end||''
    ]);
    const csv = [head,...data].map(r=>r.map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
    const fecha = m?.started_at ? new Date(m.started_at).toISOString().split('T')[0] : 'sin-fecha';
    const nombre = `Tareas_${(m?.cliente||'').replace(/[^a-z0-9]/gi,'_')}_${(m?.proyecto||'').replace(/[^a-z0-9]/gi,'_')}_${fecha}.csv`;
    res.setHeader('Content-Type','text/csv;charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="${nombre}"`);
    res.send('\uFEFF' + csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Excel tareas empresa completa ────────────────────────────────────────────
app.get('/tareas/excel', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT t.*,m.cliente,m.proyecto,m.started_at FROM tareas t
       JOIN meetings m ON m.id=t.meeting_id
       WHERE m.company_id=? ORDER BY m.started_at DESC,t.tipo DESC,t.id`,
      [req.user.company_id]
    );
    const ESTADOS = {1:'Sin iniciar',2:'En progreso',3:'En revisión',4:'Finalizada',5:'Planeación',7:'Respuesta Cliente',8:'Pend otros procesos'};
    const PRIO    = {1:'Baja',2:'Media',3:'Alta'};
    const head = ['Reunión','Cliente','Proyecto','ID','Tipo','Asunto','Descripción','Detalle','Responsable','Asignado a','Estado','Prioridad','Tipo Tarea','Req ID','Fecha Compromiso','Fecha Inicio','Fecha Fin'];
    const data = rows.map(t => [
      t.started_at ? new Date(t.started_at).toISOString().split('T')[0] : '',
      t.cliente||'', t.proyecto||'',
      t.tarea_id||t.id, t.tipo,
      t.asunto||'', t.descripcion||'', t.detalle||'',
      t.responsable||'', t.asignado_a||'',
      ESTADOS[t.estado_tarea]||t.estado||'',
      PRIO[t.prioridad]||'',
      t.tipo_tarea==='e'?'Externa':'Interna',
      t.requerimiento_id||'', t.fecha_compromiso||'', t.date_init||'', t.date_end||''
    ]);
    const csv = [head,...data].map(r=>r.map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
    const hoy = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type','text/csv;charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="Tareas_Empresa_${hoy}.csv"`);
    res.send('\uFEFF' + csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// GESTION DE REUNIONES
// /startMeeting:      inicia una reunion de grabacion, crea el directorio de
//                     almacenamiento y registra usuarios invitados.
// /endMeeting:        finaliza la reunion y lanza la generacion del acta en
//                     background (no bloquea al usuario).
// /chunk:             recibe un fragmento de audio de ~30s durante la grabacion.
//                     La transcripcion se procesa de forma asincrona.
// /meetings/:id/progress: el frontend hace polling aqui para mostrar el
//                         progreso de procesamiento.
// /meetings:          lista reuniones segun el rol: superadmin ve todo,
//                     admin ve su empresa, member ve solo las suyas o invitado.
// /meetings-for-link: lista reuniones anteriores para vincular y heredar tareas.
// /meetings/:id/reprocess-acta: regenera el acta borrando la anterior.
// /meetings/from-text: crea acta desde texto manual (notas, email, transcripcion).
// =============================================================================
app.post('/startMeeting', async (req, res) => {
  const mid = uuidv4();
  const { cliente='', proyecto='', responsable='', linked_meeting_id=null, terminology='', invited_user_ids=[] } = req.body;
  const parts = Array.isArray(req.body.participantes) ? JSON.stringify(req.body.participantes) : '[]';
  fs.mkdirSync(path.join(storagePath, mid), { recursive: true });
  try {
    await db.execute('INSERT INTO meetings (id,company_id,created_by,status,started_at,cliente,proyecto,responsable,participantes,linked_meeting_id,terminology) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [mid, req.user.company_id, req.user.id, 'active', new Date(), cliente, proyecto, responsable, parts, linked_meeting_id, terminology]);
    for (const uid of invited_user_ids) if (uid !== req.user.id) await db.execute('INSERT IGNORE INTO meeting_users (meeting_id,user_id) VALUES (?,?)', [mid, uid]);
    res.json({ meetingId: mid, status: 'active' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ruta exclusiva para admin/superadmin: cerrar una reunion que quedo atascada.
// Util cuando el usuario cerro el navegador sin terminar la grabacion,
// o cuando una reunion lleva mas de N minutos activa sin actividad.
// Genera el acta con lo que haya transcrito hasta ese momento.
app.post('/admin/meetings/:id/force-end', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const [[m]] = await db.execute('SELECT id,status,company_id FROM meetings WHERE id=?', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Reunion no encontrada' });
    if (m.status === 'ended') return res.status(400).json({ error: 'La reunion ya estaba cerrada' });
    // Verificar que pertenece a la empresa del admin
    if (req.user.role !== 'superadmin' && m.company_id !== req.user.company_id) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    await db.execute("UPDATE meetings SET status='ended', ended_at=? WHERE id=?", [new Date(), req.params.id]);
    res.json({ ok: true, message: 'Reunion cerrada. Generando acta...' });
    // Generar acta con lo que haya
    finalizeMeeting(req.params.id).catch(e => console.error('force-end finalizeMeeting:', e.message));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/endMeeting', async (req, res) => {
  const { meetingId } = req.body;
  if (!meetingId) return res.status(400).json({ error: 'Missing meetingId' });
  try {
    if (await isMeetingApproved(meetingId)) return res.status(403).json({ error: 'Acta aprobada por el cliente.' });
    await db.execute("UPDATE meetings SET status='ended',ended_at=? WHERE id=?", [new Date(), meetingId]);
    res.json({ meetingId, status: 'ended', actaStatus: 'processing' });
    finalizeMeeting(meetingId).catch(e => console.error('finalizeMeeting:', e.message));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/chunk', upload.single('audio'), async (req, res) => {
  const { meetingId, chunkNumber } = req.body;
  if (!meetingId || chunkNumber === undefined || !req.file) return res.status(400).json({ error: 'Missing fields' });
  const fp = path.join(storagePath, meetingId, `chunk_${chunkNumber}.webm`);
  fs.mkdirSync(path.join(storagePath, meetingId), { recursive: true });
  fs.writeFileSync(fp, req.file.buffer);
  try {
    const [[m]] = await db.execute('SELECT participantes,cliente,proyecto,terminology FROM meetings WHERE id=?', [meetingId]);
    let parts = []; try { parts = JSON.parse(m?.participantes||'[]'); } catch(_) {}
    const [r] = await db.execute('INSERT INTO chunks (meeting_id,chunk_number,file_path,processed) VALUES (?,?,?,?)', [meetingId, parseInt(chunkNumber), fp, 0]);
    res.json({ chunkId: r.insertId, meetingId, chunkNumber: parseInt(chunkNumber) });
    procChunk(fp, meetingId, parseInt(chunkNumber), parts, m?.cliente||'', m?.proyecto||'', m?.terminology||'').catch(console.error);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/meetings/:id/progress', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    const safeCount = async (sql, params) => {
      const [rows] = await db.execute(sql, params);
      return rows[0] ? Object.values(rows[0])[0] : 0;
    };
    const [meetingRows] = await db.execute('SELECT status FROM meetings WHERE id=?', [req.params.id]);
    if (!meetingRows.length) return res.status(404).json({ error: 'Reunión no encontrada' });
    const total     = await safeCount('SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id=?', [req.params.id]);
    const processed = await safeCount('SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id=? AND processed=1', [req.params.id]);
    const sections  = await safeCount('SELECT COUNT(*) as cnt FROM section_summaries WHERE meeting_id=?', [req.params.id]);
    const lines     = await safeCount('SELECT COUNT(*) as cnt FROM transcriptions WHERE meeting_id=?', [req.params.id]);
    const notes     = await safeCount('SELECT COUNT(*) as cnt FROM meeting_notes WHERE meeting_id=?', [req.params.id]);
    res.json({ chunksTotal:total, chunksProcessed:processed, sectionsGenerated:sections, transcriptionLines:lines, notesCount:notes, status:meetingRows[0].status });
  } catch(e) { console.error('progress error:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/meetings', async (req, res) => {
  try {
    let sql, params;
    if (req.user.role==='superadmin') {
      sql    = 'SELECT m.*,u.name as creator_name FROM meetings m JOIN users u ON u.id=m.created_by ORDER BY m.started_at DESC';
      params = [];
    } else if (req.user.role==='admin') {
      sql    = 'SELECT m.*,u.name as creator_name FROM meetings m JOIN users u ON u.id=m.created_by WHERE m.company_id=? ORDER BY m.started_at DESC';
      params = [req.user.company_id];
    } else {
      sql    = `SELECT m.*,u.name as creator_name FROM meetings m JOIN users u ON u.id=m.created_by WHERE m.company_id=? AND (m.created_by=? OR EXISTS (SELECT 1 FROM meeting_users mu WHERE mu.meeting_id=m.id AND mu.user_id=?)) ORDER BY m.started_at DESC`;
      params = [req.user.company_id, req.user.id, req.user.id];
    }
    const [r] = await db.execute(sql, params);
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/meetings-for-link', async (req, res) => {
  try {
    const { cliente } = req.query;
    let sql = `SELECT m.id,m.cliente,m.proyecto,m.responsable,m.started_at,COUNT(t.id) as tareas_pendientes FROM meetings m LEFT JOIN tareas t ON t.meeting_id=m.id AND t.estado='pendiente' AND t.tipo='nueva' WHERE m.status='ended' AND m.company_id=?`;
    const p = [req.user.company_id];
    if (cliente) { sql += ' AND LOWER(m.cliente)=LOWER(?)'; p.push(cliente); }
    sql += ' GROUP BY m.id ORDER BY m.started_at DESC LIMIT 50';
    const [r] = await db.execute(sql, p);
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/meetings/:id', async (req, res) => {
  try {
    const [rows] = await db.execute(`SELECT m.*,u.name as creator_name FROM meetings m JOIN users u ON u.id=m.created_by WHERE m.id=?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const m = rows[0];
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role)) return res.status(403).json({ error: 'Sin acceso' });
    const [inv] = await db.execute('SELECT mu.user_id,u.name,u.email FROM meeting_users mu JOIN users u ON u.id=mu.user_id WHERE mu.meeting_id=?', [req.params.id]);
    res.json({ ...m, invited_users: inv });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/meetings/:id/transcription', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    const [r] = await db.execute('SELECT * FROM transcriptions WHERE meeting_id=? ORDER BY chunk_number,id', [req.params.id]); res.json(r); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/meetings/:id/acta', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    const [[m]] = await db.execute('SELECT status,approved_at,approved_by_client FROM meetings WHERE id=?', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Not found' });
    const [a] = await db.execute('SELECT acta_json FROM actas WHERE meeting_id=?', [req.params.id]);
    if (!a.length) return res.status(202).json({ status:'processing', meetingStatus: m.status });
    res.json({ status:'ready', acta: JSON.parse(a[0].acta_json), approved_at: m.approved_at, approved_by_client: m.approved_by_client });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/meetings/:id/acta', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    if (await isMeetingApproved(req.params.id)) return res.status(403).json({ error: 'Acta aprobada. No se puede modificar.' });
    await db.execute('INSERT INTO actas (meeting_id,acta_json) VALUES (?,?) ON DUPLICATE KEY UPDATE acta_json=VALUES(acta_json)', [req.params.id, JSON.stringify(req.body)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/meetings/:id/tareas', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    const [r] = await db.execute('SELECT * FROM tareas WHERE meeting_id=? ORDER BY tipo DESC,id', [req.params.id]); res.json(r); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/meetings/:id/tareas', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    if (await isMeetingApproved(req.params.id)) return res.status(403).json({ error: 'Acta aprobada. No se puede modificar.' });
    const tareas = Array.isArray(req.body) ? req.body : req.body?.tareas;
    if (!Array.isArray(tareas)) return res.status(400).json({ error: 'array required' });
    await db.execute('DELETE FROM tareas WHERE meeting_id=?', [req.params.id]);
    for (const t of tareas) await db.execute(
      `INSERT INTO tareas (meeting_id,tarea_id,tipo,descripcion,asunto,detalle,responsable,asignado_a,
        user_create,estado,estado_tarea,prioridad,tipo_tarea,requerimiento_id,fecha_compromiso,date_init,date_end)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id,
       t.tarea_id||'', t.tipo||'nueva',
       t.descripcion||'',
       t.asunto||t.descripcion||'',
       t.detalle||'',
       t.responsable||'',
       t.asignado_a||t.responsable||'',
       t.user_create||'',
       t.estado||'pendiente',
       t.estado_tarea||1,
       t.prioridad||2,
       t.tipo_tarea||'i',
       t.requerimiento_id||'',
       t.fecha_compromiso||'',
       t.date_init||'',
       t.date_end||''
      ]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/meetings/:id/reprocess-acta', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    if (await isMeetingApproved(req.params.id)) return res.status(403).json({ error: 'Acta aprobada. No se puede reprocesar.' });
    await db.execute('DELETE FROM tareas WHERE meeting_id=?', [req.params.id]);
    await db.execute('DELETE FROM actas WHERE meeting_id=?', [req.params.id]);
    await db.execute('DELETE FROM section_summaries WHERE meeting_id=?', [req.params.id]);
    res.json({ ok:true, message: 'Reprocesando...' });
    finalizeMeeting(req.params.id).catch(console.error);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/meetings/from-text', async (req, res) => {
  const { cliente='', proyecto='', responsable='', participantes:pRaw=[], texto='', modo='notas', fecha=null, hora_inicio='', hora_fin='', linked_meeting_id=null, terminology='', invited_user_ids=[] } = req.body;
  if (!texto || texto.trim().split(/\s+/).length < 10) return res.status(400).json({ error: 'Necesitas al menos 10 palabras.' });
  const mid   = uuidv4();
  const parts = Array.isArray(pRaw) ? pRaw : pRaw.toString().split(/[,;]/).map(p => p.trim()).filter(Boolean);
  const sd    = fecha ? new Date(`${fecha}T${hora_inicio||'09:00'}:00`) : new Date();
  const ed    = fecha && hora_fin ? new Date(`${fecha}T${hora_fin}:00`) : new Date();
  try {
    await db.execute('INSERT INTO meetings (id,company_id,created_by,status,started_at,ended_at,cliente,proyecto,responsable,participantes,linked_meeting_id,terminology) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [mid, req.user.company_id, req.user.id, 'ended', sd, ed, cliente, proyecto, responsable, JSON.stringify(parts), linked_meeting_id, terminology]);
    for (const uid of invited_user_ids) if (uid !== req.user.id) await db.execute('INSERT IGNORE INTO meeting_users (meeting_id,user_id) VALUES (?,?)', [mid, uid]);
    res.json({ meetingId: mid, status: 'ended', message: 'Procesando...' });
    (async () => {
      try {
        const meta = { cliente, proyecto, responsable, participantes: parts, fecha: sd.toISOString().split('T')[0], hora_inicio: hora_inicio||`${String(sd.getHours()).padStart(2,'0')}:${String(sd.getMinutes()).padStart(2,'0')}`, hora_fin: hora_fin||`${String(ed.getHours()).padStart(2,'0')}:${String(ed.getMinutes()).padStart(2,'0')}` };
        const fd = addBizDays(meta.fecha, 3);
        const tareasAnt = await getLinkedTareas(linked_meeting_id);
        let actaJson = await genActaText(texto.trim(), modo, meta, fd, tareasAnt);
        if (!actaJson) actaJson = { identificacion:{...meta}, tareas_anteriores:[], tareas_nuevas:[], resumen_reunion:'No se pudo generar.', observaciones_generales:'' };
        actaJson.identificacion = {...meta};
        if (tareasAnt.length) actaJson.tareas_anteriores = tareasAnt.map((t,i) => ({ id:`ant_${String(i+1).padStart(3,'0')}`, descripcion:t.descripcion, responsable:t.responsable, estado:t.estado, fecha_compromiso:t.fecha_compromiso||'' }));
        await db.execute('INSERT INTO actas (meeting_id,acta_json) VALUES (?,?) ON DUPLICATE KEY UPDATE acta_json=VALUES(acta_json)', [mid, JSON.stringify(actaJson)]);
        await db.execute('DELETE FROM tareas WHERE meeting_id=?', [mid]);
        for (const t of tareasAnt) await db.execute('INSERT INTO tareas (meeting_id,tarea_id,tipo,descripcion,responsable,estado,fecha_compromiso) VALUES (?,?,?,?,?,?,?)',
          [mid, t.tarea_id||uuidv4(), 'anterior', t.descripcion||'', t.responsable||'', t.estado||'pendiente', t.fecha_compromiso||'']);
        const td = dedup(actaJson.tareas_nuevas || []);
        for (let i = 0; i < td.length; i++) {
          const t = td[i];
          const fc = String(t.fecha_compromiso || addBizDays(meta.fecha,3)).trim().slice(0,50);
          await db.execute(
            `INSERT INTO tareas (meeting_id,tarea_id,tipo,descripcion,asunto,detalle,responsable,asignado_a,
              user_create,estado,estado_tarea,prioridad,tipo_tarea,fecha_compromiso,date_end)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [mid, fmtId(i+1), 'nueva',
             (t.descripcion||'').trim(),
             (t.asunto||t.descripcion||'').substring(0,100).trim(),
             (t.detalle||t.descripcion||'').trim(),
             (t.responsable||'').trim(),
             (t.responsable||'').trim(),
             meta.responsable||'',
             'pendiente', 1,
             t.prioridad||2,
             t.tipo_tarea||'i',
             fc,
             fc
            ]);
        }
      } catch(e) { console.error(`[${mid}] from-text error:`, e.message); }
    })();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// NOTAS DE REUNION
// Texto libre que los participantes agregan durante o despues de la reunion.
// Se incluyen automaticamente en el prompt del acta para enriquecer el contexto.
// No se pueden agregar notas a reuniones con acta ya aprobada por el cliente.
// =============================================================================
app.get('/meetings/:id/notes', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    const [r] = await db.execute('SELECT * FROM meeting_notes WHERE meeting_id=? ORDER BY created_at', [req.params.id]); res.json(r); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/meetings/:id/notes', async (req, res) => {
  const { content='', author='' } = req.body;
  if (!content.trim()) return res.status(400).json({ error: 'Vacío' });
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    if (await isMeetingApproved(req.params.id)) return res.status(403).json({ error: 'Acta aprobada.' });
    const [r] = await db.execute('INSERT INTO meeting_notes (meeting_id,user_id,content,author) VALUES (?,?,?,?)',
      [req.params.id, req.user.id, content.trim(), author.trim()||req.user.name]);
    res.json({ id: r.insertId, content: content.trim(), author: author.trim()||req.user.name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/meetings/:id/notes/:nid', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    await db.execute('DELETE FROM meeting_notes WHERE id=?', [req.params.nid, req.params.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// ADJUNTOS
// Soporta documentos (PDF, Word, imagenes) y audios adicionales.
// Los audios se transcriben automaticamente con Whisper y su contenido
// se incluye en el acta igual que las notas de texto.
// La descarga usa fetch con header Authorization porque los enlaces directos
// no envian el JWT y la ruta esta protegida con authMiddleware.
// =============================================================================
app.get('/meetings/:id/attachments', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    const [r] = await db.execute('SELECT id,meeting_id,file_name,file_type,mime_type,transcription_status,uploaded_at FROM meeting_attachments WHERE meeting_id=? ORDER BY uploaded_at', [req.params.id]); res.json(r); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/meetings/:id/attachments', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No archivo' });
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    const [[m]] = await db.execute('SELECT id,participantes,cliente,proyecto,terminology FROM meetings WHERE id=?', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'No encontrada' });
    const mime    = req.file.mimetype || '';
    const isAudio = mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i.test(req.file.originalname);
    const dir = path.join(attachmentPath, req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    const sn = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    const fp = path.join(dir, sn);
    fs.writeFileSync(fp, req.file.buffer);
    const [r] = await db.execute('INSERT INTO meeting_attachments (meeting_id,file_name,file_path,file_type,mime_type,transcription_status) VALUES (?,?,?,?,?,?)',
      [req.params.id, req.file.originalname, fp, isAudio?'audio':'document', mime, isAudio?'pending':'n/a']);
    res.json({ id:r.insertId, file_name:req.file.originalname, file_type:isAudio?'audio':'document', transcription_status:isAudio?'pending':'n/a' });
    if (isAudio) {
      let parts = []; try { parts = JSON.parse(m.participantes||'[]'); } catch(_) {}
      procAudio(r.insertId, fp, req.params.id, parts, m.cliente||'', m.proyecto||'', m.terminology||'').catch(console.error);
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/meetings/:id/attachments/:aid', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    const [[r]] = await db.execute('SELECT file_path FROM meeting_attachments WHERE id=? AND meeting_id=?', [req.params.aid, req.params.id]);
    if (!r) return res.status(404).json({ error: 'No encontrado' });
    await db.execute('DELETE FROM meeting_attachments WHERE id=?', [req.params.aid]);
    try { if (fs.existsSync(r.file_path)) fs.unlinkSync(r.file_path); } catch(_) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/meetings/:id/attachments/:aid/download', async (req, res) => {
  try {
    if (!await canAccess(req.params.id, req.user.id, req.user.company_id, req.user.role))
      return res.status(403).json({ error: 'Sin acceso a esta reunión' });
    const [[r]] = await db.execute('SELECT file_name,file_path,mime_type FROM meeting_attachments WHERE id=? AND meeting_id=?', [req.params.aid, req.params.id]);
    if (!r || !fs.existsSync(r.file_path)) return res.status(404).json({ error: 'No encontrado' });
    res.setHeader('Content-Disposition', `attachment; filename="${r.file_name}"`);
    if (r.mime_type) res.setHeader('Content-Type', r.mime_type);
    res.sendFile(path.resolve(r.file_path));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// ARRANQUE DEL SERVIDOR
// initDB() crea la conexion, las tablas y el superadmin inicial.
// Si la BD no esta disponible el proceso termina con exit(1) para que
// PM2 lo reinicie automaticamente.
// =============================================================================

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Puerto ${PORT} | CORS: ${allowedOrigins.join(', ')}`)))
  .catch(e => { console.error('❌ DB:', e.message); process.exit(1); });
