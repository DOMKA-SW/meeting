// ═══════════════════════════════════════════════════════════════════════════════
// server.js — Sistema de Actas — Versión Hardened (6 Fases de Seguridad)
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express       = require('express');
const mysql         = require('mysql2/promise');
const { v4: uuidv4 }  = require('uuid');
const multer        = require('multer');
const fs            = require('fs');
const path          = require('path');
const bcrypt        = require('bcrypt');
const jwt           = require('jsonwebtoken');
const crypto        = require('crypto');
const cookieParser  = require('cookie-parser');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const OpenAI        = require('openai');
const execFileAsync = promisify(execFile);

const {
  helmetMiddleware, corsMiddleware,
  loginLimiter, apiLimiter, chunkLimiter, uploadLimiter, refreshLimiter,
  authMiddleware, requireRole, clientAuth, canAccess, requireMeetingAccess,
  validate, schemas, handleError, IS_PROD,
} = require('./middleware');

// ─── FASE 1: Validar ENV obligatorias antes de arrancar ───────────────────────
const REQUIRED_ALWAYS = ['JWT_SECRET'];
const REQUIRED_PROD   = ['SUPERADMIN_PASSWORD', 'FRONTEND_URL', 'GROQ_API_KEY'];

const missingAlways = REQUIRED_ALWAYS.filter(k => !process.env[k]);
if (missingAlways.length) {
  console.error('❌ Variables obligatorias no definidas:', missingAlways.join(', '));
  process.exit(1);
}
if (IS_PROD) {
  const missingProd = REQUIRED_PROD.filter(k => !process.env[k]);
  if (missingProd.length) {
    console.error('❌ Variables obligatorias en producción:', missingProd.join(', '));
    process.exit(1);
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────
const JWT_SECRET        = process.env.JWT_SECRET;
const JWT_ACCESS_EXP    = process.env.JWT_ACCESS_EXP    || '15m';
const REFRESH_TOKEN_EXP = parseInt(process.env.REFRESH_TOKEN_EXP_DAYS || '30');
const SUPERADMIN_EMAIL  = process.env.SUPERADMIN_EMAIL  || 'admin@actas.com';
const BCRYPT_ROUNDS     = 12;
const SECTION_SIZE      = 12;
const WORDS_PER_CHUNK   = 2500;
const SPEAKER_BATCH     = 60;
const storagePath       = process.env.STORAGE_PATH || path.join(__dirname, '..', 'storage', 'audio');
const attachmentPath    = process.env.ATTACH_PATH  || path.join(__dirname, '..', 'storage', 'attachments');
fs.mkdirSync(storagePath,    { recursive: true });
fs.mkdirSync(attachmentPath, { recursive: true });

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express();

// FASE 1: Security headers
app.use(helmetMiddleware);

// FASE 1: CORS seguro
app.use(corsMiddleware);

// FASE 2: Cookie parser (para refresh tokens httpOnly)
app.use(cookieParser(JWT_SECRET));

app.use(express.json({ limit: '10mb' }));

// FASE 1: Rate limiting global
app.use(apiLimiter);

// Logging estructurado (sin datos sensibles)
app.use((req, res, next) => {
  // No loggear passwords ni tokens
  console.log(`${new Date().toISOString()} ${req.method} ${req.path} [${req.ip}]`);
  next();
});

// ─── MySQL ────────────────────────────────────────────────────────────────────
let db;
const initDB = async () => {
  const config = process.env.MYSQL_URL
    ? { uri: process.env.MYSQL_URL, ssl: { rejectUnauthorized: false } }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '3306'),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'actas_db'
      };

  db = await mysql.createPool({
    ...(config.uri ? { uri: config.uri, ssl: config.ssl } : config),
    waitForConnections: true,
    connectionLimit: 10,
    timezone: '+00:00'
  });
  console.log('✅ MySQL conectado');
  await createTables();
  await createSuperadmin();

  // Limpiar refresh tokens expirados cada 6 horas
  setInterval(() => cleanExpiredTokens().catch(console.error), 6 * 60 * 60 * 1000);
};

const createTables = async () => {
  // --- Tablas existentes (sin cambios de estructura mayor) ---
  await db.execute(`CREATE TABLE IF NOT EXISTS companies (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE, active TINYINT(1) DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  // VARCHAR(80) para soportar bcrypt hashes (60 chars)
  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY, company_id INT NOT NULL,
    name VARCHAR(200) NOT NULL, email VARCHAR(200) NOT NULL UNIQUE,
    password_hash VARCHAR(80) NOT NULL,
    role ENUM('superadmin','admin','member') DEFAULT 'member',
    active TINYINT(1) DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE)`);

  await db.execute(`CREATE TABLE IF NOT EXISTS clients (
    id INT AUTO_INCREMENT PRIMARY KEY, company_id INT NOT NULL,
    name VARCHAR(200) NOT NULL, username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(80) NOT NULL, active TINYINT(1) DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE)`);

  // Columna client_id añadida para vincular por ID (FASE 3)
  await db.execute(`CREATE TABLE IF NOT EXISTS meetings (
    id VARCHAR(36) PRIMARY KEY, company_id INT NOT NULL, created_by INT NOT NULL,
    client_id INT DEFAULT NULL,
    status VARCHAR(20) DEFAULT 'active', started_at DATETIME, ended_at DATETIME,
    cliente VARCHAR(200), proyecto VARCHAR(200), responsable VARCHAR(200),
    participantes TEXT, linked_meeting_id VARCHAR(36), terminology TEXT,
    approved_at DATETIME DEFAULT NULL, approved_by_client VARCHAR(200) DEFAULT NULL,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL)`);

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
    id INT AUTO_INCREMENT PRIMARY KEY, meeting_id VARCHAR(36) NOT NULL,
    tarea_id VARCHAR(50), tipo VARCHAR(20) DEFAULT 'nueva', descripcion TEXT,
    responsable VARCHAR(200), estado VARCHAR(50) DEFAULT 'pendiente', fecha_compromiso VARCHAR(50))`);

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

  // ─── NUEVAS TABLAS DE SEGURIDAD ───────────────────────────────────────────

  // FASE 2: Refresh Tokens — almacena hash del token + metadatos
  await db.execute(`CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token_hash CHAR(64) NOT NULL UNIQUE,
    user_id INT NOT NULL,
    expires_at DATETIME NOT NULL,
    revoked_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip VARCHAR(45),
    user_agent VARCHAR(500),
    INDEX idx_rt_user (user_id),
    INDEX idx_rt_expires (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);

  // FASE 6: Audit Logs — registro inmutable de acciones críticas
  await db.execute(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT DEFAULT NULL,
    client_id INT DEFAULT NULL,
    user_email VARCHAR(200),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id VARCHAR(100),
    ip VARCHAR(45),
    user_agent VARCHAR(500),
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_al_user (user_id),
    INDEX idx_al_action (action),
    INDEX idx_al_created (created_at),
    INDEX idx_al_resource (resource_type, resource_id))`);

  console.log('✅ Tablas listas');
};

// ─── FASE 6: Audit Log ────────────────────────────────────────────────────────
const auditLog = async (action, opts = {}) => {
  try {
    const { userId, clientId, email, resourceType, resourceId, ip, ua, details } = opts;
    await db.execute(
      `INSERT INTO audit_logs (user_id, client_id, user_email, action,
        resource_type, resource_id, ip, user_agent, details)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [userId || null, clientId || null, email || null, action,
       resourceType || null, resourceId ? String(resourceId) : null,
       ip || null, ua || null, details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    // Nunca bloquear el flujo principal por un error de auditoría
    console.error('[auditLog error]', e.message);
  }
};

// ─── FASE 1: Password hashing con bcrypt ─────────────────────────────────────
const hashPwd = (pwd) => bcrypt.hash(pwd, BCRYPT_ROUNDS);

// Verificación con migración automática SHA-256 → bcrypt
const verifyPwd = async (pwd, storedHash) => {
  // Detectar hash SHA-256 legacy (exactamente 64 chars hex)
  if (/^[a-f0-9]{64}$/.test(storedHash)) {
    const legacyHash = crypto.createHash('sha256')
      .update(pwd + JWT_SECRET).digest('hex');
    if (legacyHash !== storedHash) return { valid: false };
    return { valid: true, needsRehash: true };
  }
  const valid = await bcrypt.compare(pwd, storedHash);
  return { valid };
};

// ─── FASE 2: Refresh Token helpers ───────────────────────────────────────────
const REFRESH_COOKIE_NAME = 'rt';

const generateRefreshToken = async (userId, ip, ua) => {
  const token = uuidv4() + uuidv4(); // 72 chars entropy
  const hash  = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXP * 24 * 60 * 60 * 1000);

  await db.execute(
    `INSERT INTO refresh_tokens (token_hash, user_id, expires_at, ip, user_agent)
     VALUES (?,?,?,?,?)`,
    [hash, userId, expiresAt, ip || null, ua ? ua.substring(0, 500) : null]
  );
  return { token, expiresAt };
};

const setRefreshCookie = (res, token, expiresAt) => {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,              // Solo HTTPS en producción
    sameSite: IS_PROD ? 'none' : 'lax', // 'none' necesario cross-origin en prod
    expires: expiresAt,
    path: '/auth/',               // Solo enviado en rutas /auth/
  });
};

const clearRefreshCookie = (res) => {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
    path: '/auth/',
  });
};

// Limpiar tokens expirados de la BD
const cleanExpiredTokens = async () => {
  const [result] = await db.execute(
    'DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked_at IS NOT NULL'
  );
  if (result.affectedRows > 0) {
    console.log(`[Cleanup] ${result.affectedRows} refresh tokens eliminados`);
  }
};

// ─── Superadmin ───────────────────────────────────────────────────────────────
const createSuperadmin = async () => {
  try {
    const [rows] = await db.execute("SELECT id FROM users WHERE role='superadmin'");
    if (rows.length > 0) return;

    const pwd = process.env.SUPERADMIN_PASSWORD;
    if (!pwd) {
      console.warn('⚠️  SUPERADMIN_PASSWORD no definida. Define la variable y reinicia.');
      return;
    }

    const [comp] = await db.execute(
      "INSERT INTO companies (name,slug) VALUES ('Mi Empresa','mi-empresa')"
    );
    const hash = await hashPwd(pwd);
    await db.execute(
      'INSERT INTO users (company_id,name,email,password_hash,role) VALUES (?,?,?,?,?)',
      [comp.insertId, 'Super Admin', SUPERADMIN_EMAIL, hash, 'superadmin']
    );
    console.log(`✅ Superadmin creado: ${SUPERADMIN_EMAIL}`);
  } catch (e) {
    console.error('createSuperadmin:', e.message);
  }
};

// ─── Groq / OpenAI ───────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const groq = new OpenAI({ apiKey: GROQ_API_KEY || 'dummy', baseURL: 'https://api.groq.com/openai/v1' });

// FASE 4: Multer con validación de tipo y tamaño
const ALLOWED_AUDIO_MIMES = new Set([
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm',
  'audio/mp4', 'audio/aac', 'audio/flac', 'audio/x-m4a',
  'video/webm', // algunos navegadores envían webm como video
]);
const ALLOWED_DOC_MIMES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/gif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB max
  fileFilter: (req, file, cb) => {
    const mime = file.mimetype || '';
    const ext  = path.extname(file.originalname).toLowerCase();
    const isAudioExt = ['.mp3','.wav','.m4a','.ogg','.webm','.aac','.flac','.mp4'].includes(ext);
    if (ALLOWED_AUDIO_MIMES.has(mime) || ALLOWED_DOC_MIMES.has(mime) || isAudioExt) {
      return cb(null, true);
    }
    cb(new Error(`Tipo de archivo no permitido: ${mime}`));
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep      = ms => new Promise(r => setTimeout(r, ms));
const addBizDays = (start, days) => {
  const d = new Date(start); let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d.toISOString().split('T')[0];
};
const fmtId    = n => `tarea_${String(n).padStart(3, '0')}`;
const callLLM  = async (prompt, model = 'llama-3.3-70b-versatile', retries = 3) => {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await groq.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
      return r.choices?.[0]?.message?.content || null;
    } catch (e) {
      if (e.status === 429 && i < retries) await sleep((i + 1) * 8000);
      else throw e;
    }
  }
  return null;
};
const parseJSON = raw => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) {
    const m = raw.match(/\{[\s\S]*\}/);
    try { return m ? JSON.parse(m[0]) : null; } catch (_) { return null; }
  }
};
const isMeetingApproved = async id => {
  const [[r]] = await db.execute('SELECT approved_at FROM meetings WHERE id=?', [id]);
  return r && r.approved_at !== null;
};
const getLinkedTareas = async id => {
  if (!id) return [];
  const [r] = await db.execute(
    `SELECT * FROM tareas WHERE meeting_id=? AND tipo='nueva' ORDER BY id`, [id]
  );
  return r;
};

// ─── Suplementos (notas + audios adjuntos) ────────────────────────────────────
const getSupplements = async mid => {
  const [notes]  = await db.execute('SELECT * FROM meeting_notes WHERE meeting_id=? ORDER BY created_at', [mid]);
  const [audios] = await db.execute(
    `SELECT file_name,transcription FROM meeting_attachments
     WHERE meeting_id=? AND transcription_status='done'
       AND transcription IS NOT NULL AND transcription!=''`, [mid]
  );
  return { notes, audioTranscriptions: audios };
};

const extractTareasFromSupplements = async (notes, audioTranscriptions) => {
  if (!GROQ_API_KEY || (notes.length === 0 && audioTranscriptions.length === 0)) return [];
  const textoParts = [];
  if (notes.length) {
    textoParts.push('=== NOTAS ===');
    notes.forEach(n => textoParts.push(`• ${n.author ? `[${n.author}]: ` : ''}${n.content}`));
  }
  if (audioTranscriptions.length) {
    textoParts.push('=== AUDIOS ADICIONALES ===');
    audioTranscriptions.forEach(a => textoParts.push(`--- ${a.file_name} ---\n${a.transcription}`));
  }
  const texto = textoParts.join('\n');
  const prompt = `Extrae TODAS las tareas, compromisos y pendientes mencionados en este texto.
REGLAS:
- Solo tareas con acción concreta + objeto específico (✅ "Enviar contrato al cliente" ✅ "Corregir bug del login")
- NO vagas (❌ "Revisar" ❌ "Hacer seguimiento" ❌ "Ver el tema")
- Incluye quién es responsable si se menciona
- Si no hay tareas claras, devuelve array vacío
JSON: {"tareas":[{"descripcion":"acción concreta","responsable":"nombre o vacío","cuando":"fecha o vacío"}]}
TEXTO:
${texto}
SOLO JSON.`;
  try {
    const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
    const p   = parseJSON(raw);
    return (p?.tareas || []).filter(t => t.descripcion && t.descripcion.trim().length > 8);
  } catch (e) {
    console.warn('extractTareasFromSupplements:', e.message);
    return [];
  }
};

const waitAudios = async (mid, maxMs = 5 * 60 * 1000) => {
  let w = 0;
  while (w < maxMs) {
    const [[{ cnt }]] = await db.execute(
      `SELECT COUNT(*) as cnt FROM meeting_attachments
       WHERE meeting_id=? AND file_type='audio' AND transcription_status IN ('pending','processing')`,
      [mid]
    );
    if (!cnt) break;
    await sleep(5000);
    w += 5000;
  }
};

const suppBlock = (notes, audios) => {
  let b = '';
  if (notes.length) {
    b += `\n\n═══ NOTAS DE PARTICIPANTES (${notes.length}) ═══\n`;
    b += notes.map(n => `• ${n.author ? `[${n.author}]: ` : ''}${n.content}`).join('\n');
  }
  if (audios.length) {
    b += `\n\n═══ AUDIOS TRANSCRITOS (${audios.length}) ═══\n`;
    b += audios.map(a => `--- ${a.file_name} ---\n${a.transcription}`).join('\n\n');
  }
  return b;
};

const dedup = tareas => {
  const s = new Set();
  return tareas.filter(t => {
    const d = (t.descripcion || t.tarea || '').trim().toLowerCase();
    if (!d || d.length < 8) return false;
    const k = d
      .replace(/\b(el|la|los|las|un|una|de|del|al|y|o|en|que|se|por|con|para)\b/g, '')
      .replace(/\s+/g, ' ').trim().slice(0, 40);
    if (s.has(k)) return false;
    s.add(k);
    return true;
  });
};

// ─── Speaker improvement ──────────────────────────────────────────────────────
const improveSpeak = async (trans, parts = []) => {
  if (!GROQ_API_KEY || !trans.length) return trans;
  const res  = [...trans];
  const hint = parts.length
    ? `PARTICIPANTES: ${parts.join(', ')}. Asigna su nombre exacto cuando sea claro.` : '';
  for (let s = 0; s < trans.length; s += SPEAKER_BATCH) {
    const batch = trans.slice(s, s + SPEAKER_BATCH);
    const lines = batch.map((t, i) => `[${s + i}]: ${t.text}`).join('\n');
    const prompt = `Experto en diarización de reuniones en español.
${hint}
Detecta cambios de speaker: preguntas→respuestas, cambios de rol, referencias a otros.
Usa nombres de participantes cuando es claro; si no, Speaker1/Speaker2 consistente.
JSON: {"lines":[{"index":N,"speaker":"Nombre"}]}
Transcripción:
${lines}`;
    try {
      const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
      const p   = parseJSON(raw);
      (p?.lines || []).forEach(l => {
        if (l.index >= 0 && l.index < res.length && l.speaker) {
          res[l.index] = { ...res[l.index], speaker: l.speaker };
        }
      });
    } catch (e) { console.warn(`Speaker batch ${s}:`, e.message); }
  }
  return res;
};

// ─── Sección ──────────────────────────────────────────────────────────────────
const genSection = async (mid, secNum, from, to) => {
  const [trans] = await db.execute(
    `SELECT id,speaker,text,chunk_number FROM transcriptions
     WHERE meeting_id=? AND chunk_number>=? AND chunk_number<=?
     ORDER BY chunk_number,id`,
    [mid, from, to]
  );
  if (!trans.length) return null;
  const [[meet]] = await db.execute(
    'SELECT participantes,cliente,proyecto FROM meetings WHERE id=?', [mid]
  );
  let parts = []; try { parts = JSON.parse(meet?.participantes || '[]'); } catch (_) {}
  const imp = await improveSpeak(trans, parts);
  for (let i = 0; i < imp.length; i++) {
    if (imp[i].speaker !== trans[i].speaker) {
      await db.execute('UPDATE transcriptions SET speaker=? WHERE id=?', [imp[i].speaker, trans[i].id]);
    }
  }
  const tscr = imp.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
  const ctx  = [meet?.cliente, meet?.proyecto].filter(Boolean).join(' - ');
  const prompt = `Analiza SECCIÓN ${secNum} (min ~${Math.round(from * 1.5)}–${Math.round((to + 1) * 1.5)})${ctx ? ` de ${ctx}` : ''}.
CRITERIOS: temas específicos, decisiones TOMADAS, tareas EXPLÍCITAS (acción+objeto+quién).
✅ {"tarea":"Enviar contrato al cliente","quien":"Juan","cuando":"viernes"}
❌ "Revisar tema" ❌ "Hacer seguimiento" ❌ "Mejorar proceso"
JSON: {"temas":[],"decisiones":[],"tareas":[{"tarea":"","quien":"","cuando":""}],"puntos_criticos":[],"resumen":""}
Transcripción:
${tscr}
SOLO JSON válido.`;
  try {
    const raw = await callLLM(prompt, 'llama-3.3-70b-versatile');
    const sum = parseJSON(raw);
    if (sum) {
      await db.execute(
        `INSERT INTO section_summaries (meeting_id,section_num,from_chunk,to_chunk,summary_json)
         VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE summary_json=VALUES(summary_json)`,
        [mid, secNum, from, to, JSON.stringify(sum)]
      );
      console.log(`[${mid}] Sección ${secNum} OK`);
      return sum;
    }
  } catch (e) { console.error(`Sección ${secNum}:`, e.message); }
  return null;
};

const checkSection = async mid => {
  const [[{ cnt }]] = await db.execute(
    'SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id=? AND processed=1', [mid]
  );
  const proc = cnt || 0;
  if (proc > 0 && proc % SECTION_SIZE === 0) {
    const sn = Math.floor(proc / SECTION_SIZE);
    const fc = (sn - 1) * SECTION_SIZE;
    const tc = sn * SECTION_SIZE - 1;
    const [ex] = await db.execute(
      'SELECT id FROM section_summaries WHERE meeting_id=? AND section_num=?', [mid, sn]
    );
    if (!ex.length) {
      console.log(`[${mid}] Disparando sección ${sn}`);
      genSection(mid, sn, fc, tc).catch(console.error);
    }
  }
};

// ─── Acta final ───────────────────────────────────────────────────────────────
const buildActaPrompt = (meta, sectionInputs, allTareasBruto, tareasAnt, suppBlk, hasSup, fechaDef) =>
  `Redactor experto en actas corporativas en español.
DATOS: cliente="${meta.cliente}", proyecto="${meta.proyecto}", responsable="${meta.responsable}",
participantes=${JSON.stringify(meta.participantes)}, fecha="${meta.fecha}",
hora_inicio="${meta.hora_inicio}", hora_fin="${meta.hora_fin}"
${tareasAnt.length ? `\nTAREAS ANTERIORES (NO incluir en nuevas):\n${tareasAnt.map(t => `• [${t.estado}] ${t.descripcion} (${t.responsable || '—'})`).join('\n')}` : ''}

TRANSCRIPCIÓN:
${sectionInputs}
${suppBlk}

TAREAS PRE-PROCESADAS: ${JSON.stringify(allTareasBruto, null, 2)}

━━ REGLAS ━━
"resumen_reunion": 4-6 frases prosa ejecutiva. Objetivo→temas→decisiones→próximos pasos.${hasSup ? '\nIntegra info de notas y audios.' : ''}
"tareas_nuevas": SOLO acción+objeto+identificable. ✅ "Juan enviará el contrato el viernes" ❌ "Revisar" ❌ "Hacer seguimiento"
- Las tareas marcadas [NOTA] en PRE-PROCESADAS vienen de notas escritas — INCLÚYELAS si son concretas (quita el prefijo [NOTA] en la descripción final)
- NO duplicar anteriores. Consolida duplicados. Máx 15. IDs tarea_001/002/003...
"tareas_anteriores": ${tareasAnt.length ? `incluye las ${tareasAnt.length} anteriores con su estado` : '[]'}

JSON: {"identificacion":{"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},"tareas_anteriores":[],"tareas_nuevas":[{"id":"tarea_001","descripcion":"","responsable":"","fecha_compromiso":"${fechaDef}"}],"resumen_reunion":"","observaciones_generales":""}
SOLO JSON VÁLIDO.`;

const genActa = async (mid, meta, fechaDef, tareasAnt = []) => {
  const [secs] = await db.execute(
    'SELECT section_num,from_chunk,to_chunk,summary_json FROM section_summaries WHERE meeting_id=? ORDER BY section_num',
    [mid]
  );
  const { notes, audioTranscriptions } = await getSupplements(mid);
  const sb    = suppBlock(notes, audioTranscriptions);
  const hasSup = notes.length > 0 || audioTranscriptions.length > 0;
  let actaJson = null;

  const tareasDeNotas = await extractTareasFromSupplements(notes, audioTranscriptions);
  if (tareasDeNotas.length > 0) console.log(`[${mid}] ${tareasDeNotas.length} tareas de notas/adjuntos`);

  if (secs.length > 0) {
    const sectionInputs = secs.map((s, i) => {
      const sum = parseJSON(s.summary_json) || {};
      return `--- SECCIÓN ${i + 1} ---\nTemas: ${(sum.temas || []).join(', ')}\nDecisiones: ${(sum.decisiones || []).join('; ')}\nTareas: ${JSON.stringify(sum.tareas || [])}\nResumen: ${sum.resumen || ''}`;
    }).join('\n\n');

    const tareasDeTranscripcion = secs.flatMap(s => {
      const sum = parseJSON(s.summary_json) || {};
      return (sum.tareas || []).map(t => ({
        descripcion: (t.tarea || t.descripcion || '').trim(),
        responsable: (t.quien || t.responsable || '').trim(),
        fecha_compromiso: (t.cuando || t.fecha_compromiso || '').trim()
      }));
    });
    const allTareas = [
      ...tareasDeTranscripcion,
      ...tareasDeNotas.map(t => ({ ...t, descripcion: `[NOTA] ${t.descripcion}` }))
    ];

    try {
      const raw = await callLLM(buildActaPrompt(meta, sectionInputs, allTareas, tareasAnt, sb, hasSup, fechaDef), 'llama-3.3-70b-versatile');
      actaJson  = parseJSON(raw);
    } catch (e) { console.error('genActa secciones:', e.message); }
  }

  if (!actaJson) {
    const [rows] = await db.execute(
      'SELECT speaker,text FROM transcriptions WHERE meeting_id=? ORDER BY chunk_number,id', [mid]
    );
    if (rows.length) {
      let tscr = rows.map(t => `[${t.speaker}]: ${t.text}`).join('\n');
      if (tscr.split(/\s+/).length > WORDS_PER_CHUNK) {
        const ws = tscr.split(/\s+/);
        const sc = [];
        for (let i = 0; i < ws.length; i += 2500) sc.push(ws.slice(i, i + 2500).join(' '));
        const ex = [];
        for (let i = 0; i < sc.length; i++) {
          const r = await callLLM(`JSON:{"temas":[],"tareas":[{"tarea":"","quien":"","cuando":""}],"resumen":""}SOLO tareas explícitas.Texto:${sc[i]}SOLO JSON.`, 'llama-3.1-8b-instant').catch(() => null);
          if (r) { const p = parseJSON(r); if (p) ex.push(p); }
          if (i < sc.length - 1) await sleep(1200);
        }
        tscr = ex.map((e, i) => `Sección ${i + 1}: ${e.resumen || ''} | Tareas: ${JSON.stringify(e.tareas || [])}`).join('\n');
      }
      const antStr   = tareasAnt.length ? `\nTAREAS ANTERIORES:\n${tareasAnt.map(t => `• [${t.estado}] ${t.descripcion}`).join('\n')}` : '';
      const notasStr = tareasDeNotas.length > 0 ? `\nTAREAS DETECTADAS EN NOTAS ADICIONALES:\n${tareasDeNotas.map(t => `• ${t.descripcion}${t.responsable ? ' (' + t.responsable + ')' : ''}`).join('\n')}` : '';
      try {
        const raw = await callLLM(
          `Genera acta. DATOS:cliente="${meta.cliente}",proyecto="${meta.proyecto}",responsable="${meta.responsable}",participantes=${JSON.stringify(meta.participantes)},fecha="${meta.fecha}",hora_inicio="${meta.hora_inicio}",hora_fin="${meta.hora_fin}"${antStr}${notasStr}\nTRANSCRIPCIÓN:${tscr}${sb}\nJSON:{"identificacion":{"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},"tareas_anteriores":[],"tareas_nuevas":[{"id":"tarea_001","descripcion":"","responsable":"","fecha_compromiso":"${fechaDef}"}],"resumen_reunion":"4-6 frases prosa ejecutiva","observaciones_generales":""}\nREGLAS: tareas explícitas, NO duplicar anteriores, IDs tarea_001/002..., máx 15. SOLO JSON.`,
          'llama-3.3-70b-versatile'
        );
        actaJson = parseJSON(raw);
      } catch (e) { console.error('genActa raw:', e.message); }
    }
  }

  if (!actaJson) actaJson = { identificacion: { ...meta }, tareas_anteriores: [], tareas_nuevas: [], resumen_reunion: 'No se pudo generar el acta.', observaciones_generales: '' };
  actaJson.identificacion = { ...meta };
  if (Array.isArray(actaJson.tareas_nuevas)) actaJson.tareas_nuevas = actaJson.tareas_nuevas.map((t, i) => ({ ...t, id: fmtId(i + 1) }));
  return actaJson;
};

const genActaText = async (texto, modo, meta, fechaDef, tareasAnt = []) => {
  let input = texto;
  if (texto.split(/\s+/).length > 3000) {
    const ws = texto.split(/\s+/);
    const sc = [];
    for (let i = 0; i < ws.length; i += 2500) sc.push(ws.slice(i, i + 2500).join(' '));
    const ex = [];
    for (let i = 0; i < sc.length; i++) {
      const r = await callLLM(`JSON:{"temas":[],"tareas":[{"tarea":"","quien":"","cuando":""}],"resumen":""}SOLO explícitas.Texto:${sc[i]}SOLO JSON.`, 'llama-3.1-8b-instant').catch(() => null);
      if (r) { const p = parseJSON(r); if (p) ex.push(p); }
      if (i < sc.length - 1) await sleep(1200);
    }
    input = ex.map((e, i) => `Sección ${i + 1}: ${e.resumen || ''} | Tareas: ${JSON.stringify(e.tareas || [])}`).join('\n');
  }
  const ctx    = { notas: 'NOTAS LIBRES.', transcripcion: 'TRANSCRIPCIÓN con diálogos.', email: 'EMAIL resumen.' };
  const antStr = tareasAnt.length ? `\nTAREAS ANTERIORES:\n${tareasAnt.map(t => `• [${t.estado}] ${t.descripcion}`).join('\n')}` : '';
  const raw    = await callLLM(
    `Redactor actas. TIPO:${ctx[modo] || ctx.notas}\nDATOS:cliente="${meta.cliente}",proyecto="${meta.proyecto}",responsable="${meta.responsable}",participantes=${JSON.stringify(meta.participantes)},fecha="${meta.fecha}",hora_inicio="${meta.hora_inicio}",hora_fin="${meta.hora_fin}"${antStr}\nCONTENIDO:${input}\nJSON:{"identificacion":{"cliente":"","proyecto":"","fecha":"","hora_inicio":"","hora_fin":"","responsable":"","participantes":[]},"tareas_anteriores":[],"tareas_nuevas":[{"id":"tarea_001","descripcion":"","responsable":"","fecha_compromiso":"${fechaDef}"}],"resumen_reunion":"4-6 frases prosa ejecutiva","observaciones_generales":""}\nREGLAS: solo explícitas+concretas, NO duplicar anteriores, IDs tarea_001/002..., máx 15. SOLO JSON.`,
    'llama-3.3-70b-versatile'
  );
  const p = parseJSON(raw);
  if (p?.tareas_nuevas) p.tareas_nuevas = p.tareas_nuevas.map((t, i) => ({ ...t, id: fmtId(i + 1) }));
  return p;
};

// ─── Finalizar reunión ────────────────────────────────────────────────────────
const finalizeMeeting = async mid => {
  const [[meet]] = await db.execute(
    'SELECT cliente,proyecto,responsable,participantes,started_at,ended_at,linked_meeting_id FROM meetings WHERE id=?', [mid]
  );
  if (!meet) return;
  let parts = []; try { parts = JSON.parse(meet.participantes || '[]'); } catch (_) {}
  let w = 0;
  while (w < 5 * 60 * 1000) {
    const [[{ cnt }]] = await db.execute('SELECT COUNT(*) as cnt FROM chunks WHERE meeting_id=? AND processed=0', [mid]);
    if (!cnt) break;
    await sleep(3000);
    w += 3000;
  }
  await waitAudios(mid, 5 * 60 * 1000);
  const [[ls]] = await db.execute('SELECT MAX(to_chunk) as lc FROM section_summaries WHERE meeting_id=?', [mid]);
  const lc     = ls?.lc ?? -1;
  const [[lk]] = await db.execute('SELECT MAX(chunk_number) as mk FROM chunks WHERE meeting_id=? AND processed=1', [mid]);
  const mk     = lk?.mk;
  if (mk != null && mk > lc) {
    const [[{ cnt: sc }]] = await db.execute('SELECT COUNT(*) as cnt FROM section_summaries WHERE meeting_id=?', [mid]);
    await genSection(mid, (sc || 0) + 1, lc + 1, mk);
  }
  const tareasAnt = await getLinkedTareas(meet.linked_meeting_id);
  const sd = meet.started_at ? new Date(meet.started_at) : null;
  const ed = meet.ended_at   ? new Date(meet.ended_at)   : null;
  const meta = {
    cliente: meet.cliente || '', proyecto: meet.proyecto || '', responsable: meet.responsable || '',
    participantes: parts,
    fecha:      sd ? sd.toISOString().split('T')[0] : '',
    hora_inicio: sd ? `${String(sd.getHours()).padStart(2, '0')}:${String(sd.getMinutes()).padStart(2, '0')}` : '',
    hora_fin:   ed ? `${String(ed.getHours()).padStart(2, '0')}:${String(ed.getMinutes()).padStart(2, '0')}` : '',
  };
  const fd       = addBizDays(meta.fecha || new Date().toISOString().split('T')[0], 3);
  console.log(`[${mid}] Generando acta...`);
  const actaJson = await genActa(mid, meta, fd, tareasAnt);
  actaJson.identificacion = { ...meta };
  if (tareasAnt.length) {
    actaJson.tareas_anteriores = tareasAnt.map((t, i) => ({
      id: `ant_${String(i + 1).padStart(3, '0')}`,
      descripcion: t.descripcion, responsable: t.responsable,
      estado: t.estado, fecha_compromiso: t.fecha_compromiso || ''
    }));
  }
  await db.execute(
    'INSERT INTO actas (meeting_id,acta_json) VALUES (?,?) ON DUPLICATE KEY UPDATE acta_json=VALUES(acta_json)',
    [mid, JSON.stringify(actaJson)]
  );
  await db.execute('DELETE FROM tareas WHERE meeting_id=?', [mid]);
  for (const t of tareasAnt) {
    await db.execute(
      'INSERT INTO tareas (meeting_id,tarea_id,tipo,descripcion,responsable,estado,fecha_compromiso) VALUES (?,?,?,?,?,?,?)',
      [mid, t.tarea_id || uuidv4(), 'anterior', t.descripcion || '', t.responsable || '', t.estado || 'pendiente', t.fecha_compromiso || '']
    );
  }
  const td = dedup(actaJson.tareas_nuevas || []);
  for (let i = 0; i < td.length; i++) {
    const t = td[i];
    await db.execute(
      'INSERT INTO tareas (meeting_id,tarea_id,tipo,descripcion,responsable,estado,fecha_compromiso) VALUES (?,?,?,?,?,?,?)',
      [mid, fmtId(i + 1), 'nueva', (t.descripcion || '').trim(), (t.responsable || '').trim(), 'pendiente', t.fecha_compromiso || fd]
    );
  }
  await db.execute("UPDATE meetings SET status='ended' WHERE id=?", [mid]);
  console.log(`[${mid}] ✅ ${td.length} tareas nuevas`);
};

// ─── Whisper / Audio ──────────────────────────────────────────────────────────
const toMp3 = async ip => {
  const op = ip.replace(/\.(webm|wav|m4a|ogg|mp4|aac|flac)$/i, '.mp3');
  try {
    await execFileAsync('ffmpeg', ['-y', '-i', ip, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', op]);
    return op;
  } catch (e) { console.error('ffmpeg:', e.message); return null; }
};

const whisperPrompt = (parts, cli, proj, term) => {
  const p = ['Reunión de trabajo en español.'];
  if (cli || proj) p.push(`Empresa/proyecto: ${[cli, proj].filter(Boolean).join(' — ')}.`);
  if (parts.length) p.push(`Participantes: ${parts.join(', ')}.`);
  if (term) p.push(`Términos: ${term}.`);
  p.push('Transcribe en español. No traduzcas. Mantén nombres propios.');
  return p.join(' ');
};

const procChunk = async (fp, mid, cn, parts = [], cli = '', proj = '', term = '') => {
  if (!GROQ_API_KEY) {
    await db.execute('UPDATE chunks SET processed=2 WHERE meeting_id=? AND chunk_number=?', [mid, cn]);
    return null;
  }
  let fs2 = fp, mp = null;
  try { mp = await toMp3(fp); if (mp && fs.existsSync(mp) && fs.statSync(mp).size > 1000) fs2 = mp; } catch (_) {}
  try {
    if (fs.statSync(fs2).size / 1024 < 1) {
      await db.execute('UPDATE chunks SET processed=1 WHERE meeting_id=? AND chunk_number=?', [mid, cn]);
      return null;
    }
    const tr   = await groq.audio.transcriptions.create({
      file: fs.createReadStream(fs2), model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json', language: 'es',
      prompt: whisperPrompt(parts, cli, proj, term)
    });
    const segs = Array.isArray(tr.segments) ? tr.segments : [];
    if (segs.length > 0) {
      let sc = 1;
      const sm = {};
      for (const s of segs) {
        const k = s.spk || s.speaker || 'sp';
        if (!sm[k]) sm[k] = `Speaker${sc++}`;
        if ((s.text || '').trim()) {
          await db.execute(
            'INSERT INTO transcriptions (meeting_id,chunk_number,speaker,text,timestamp) VALUES (?,?,?,?,?)',
            [mid, cn, sm[k], s.text.trim(), new Date()]
          );
        }
      }
    } else if (tr.text?.trim()) {
      await db.execute(
        'INSERT INTO transcriptions (meeting_id,chunk_number,speaker,text,timestamp) VALUES (?,?,?,?,?)',
        [mid, cn, 'Speaker1', tr.text.trim(), new Date()]
      );
    }
    if (mp && fs.existsSync(mp)) fs.unlinkSync(mp);
    await db.execute('UPDATE chunks SET processed=1 WHERE meeting_id=? AND chunk_number=?', [mid, cn]);
    checkSection(mid).catch(console.error);
    return tr;
  } catch (error) {
    if (mp && fs.existsSync(mp)) try { fs.unlinkSync(mp); } catch (_) {}
    const code = error.status === 429 ? 2 : -1;
    await db.execute('UPDATE chunks SET processed=? WHERE meeting_id=? AND chunk_number=?', [code, mid, cn]);
    if (error.status === 429) {
      setTimeout(async () => {
        const [[r]] = await db.execute('SELECT processed FROM chunks WHERE meeting_id=? AND chunk_number=?', [mid, cn]);
        if (r?.processed === 2) {
          await db.execute('UPDATE chunks SET processed=0 WHERE meeting_id=? AND chunk_number=?', [mid, cn]);
          procChunk(fp, mid, cn, parts, cli, proj, term).catch(() => {});
        }
      }, 60000);
    }
    return null;
  }
};

const procAudio = async (aid, fp, mid, parts = [], cli = '', proj = '', term = '') => {
  if (!GROQ_API_KEY) {
    await db.execute('UPDATE meeting_attachments SET transcription_status=? WHERE id=?', ['error', aid]);
    return;
  }
  await db.execute('UPDATE meeting_attachments SET transcription_status=? WHERE id=?', ['processing', aid]);
  let fs2 = fp, mp = null;
  try { mp = await toMp3(fp); if (mp && fs.existsSync(mp) && fs.statSync(mp).size > 1000) fs2 = mp; } catch (_) {}
  try {
    if (fs.statSync(fs2).size / 1024 < 1) {
      await db.execute('UPDATE meeting_attachments SET transcription_status=?,transcription=? WHERE id=?', ['done', '', aid]);
      return;
    }
    const tr   = await groq.audio.transcriptions.create({
      file: fs.createReadStream(fs2), model: 'whisper-large-v3-turbo',
      response_format: 'verbose_json', language: 'es',
      prompt: whisperPrompt(parts, cli, proj, term)
    });
    let text   = '';
    const segs = Array.isArray(tr.segments) ? tr.segments : [];
    if (segs.length) text = segs.filter(s => (s.text || '').trim()).map(s => s.text.trim()).join(' ');
    else if (tr.text?.trim()) text = tr.text.trim();
    if (mp && fs.existsSync(mp)) fs.unlinkSync(mp);
    await db.execute(
      'UPDATE meeting_attachments SET transcription_status=?,transcription=? WHERE id=?',
      ['done', text, aid]
    );
  } catch (e) {
    if (mp && fs.existsSync(mp)) try { fs.unlinkSync(mp); } catch (_) {}
    await db.execute('UPDATE meeting_attachments SET transcription_status=? WHERE id=?', ['error', aid]);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── FASE 2: Auth Endpoints ───────────────────────────────────────────────────

// POST /login — emite accessToken (15min) + refreshToken (cookie httpOnly 30d)
app.post('/login', loginLimiter, validate(schemas.login), async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await db.execute(
      `SELECT u.*,c.name as company_name,c.slug as company_slug
       FROM users u JOIN companies c ON c.id=u.company_id
       WHERE u.email=? AND u.active=1`,
      [email.trim().toLowerCase()]
    );

    if (!rows.length) {
      await auditLog('LOGIN_FAILED', { email, ip: req.ip, ua: req.headers['user-agent'],
                                       details: { reason: 'user_not_found' } });
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const u = rows[0];
    const { valid, needsRehash } = await verifyPwd(password, u.password_hash);

    if (!valid) {
      await auditLog('LOGIN_FAILED', { userId: u.id, email, ip: req.ip, ua: req.headers['user-agent'] });
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    // Migración automática SHA-256 → bcrypt
    if (needsRehash) {
      const newHash = await hashPwd(password);
      await db.execute('UPDATE users SET password_hash=? WHERE id=?', [newHash, u.id]);
      console.log(`[Migration] Usuario ${u.id} migrado SHA-256→bcrypt`);
    }

    // Access token: corta duración, solo en memoria del cliente
    const accessToken = jwt.sign(
      { id: u.id, email: u.email, name: u.name, role: u.role,
        company_id: u.company_id, company_name: u.company_name, company_slug: u.company_slug },
      JWT_SECRET,
      { expiresIn: JWT_ACCESS_EXP }
    );

    // Refresh token: larga duración, httpOnly cookie
    const { token: refreshToken, expiresAt } = await generateRefreshToken(
      u.id, req.ip, req.headers['user-agent']
    );
    setRefreshCookie(res, refreshToken, expiresAt);

    await auditLog('LOGIN_SUCCESS', { userId: u.id, email, ip: req.ip,
                                       ua: req.headers['user-agent'],
                                       resourceType: 'user', resourceId: u.id });

    res.json({
      accessToken,
      expiresIn: JWT_ACCESS_EXP,
      user: { id: u.id, name: u.name, email: u.email, role: u.role, company_name: u.company_name }
    });
  } catch (e) { handleError(res, e); }
});

// POST /auth/refresh — renueva accessToken usando refreshToken de cookie
app.post('/auth/refresh', refreshLimiter, async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!refreshToken) return res.status(401).json({ error: 'No hay sesión activa.', code: 'NO_REFRESH' });

  const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  try {
    const [[rt]] = await db.execute(
      `SELECT rt.*, u.id as uid, u.email, u.name, u.role, u.active,
              u.company_id, c.name as company_name, c.slug as company_slug
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       JOIN companies c ON c.id = u.company_id
       WHERE rt.token_hash=?`,
      [hash]
    );

    if (!rt) {
      await auditLog('REFRESH_FAILED', { ip: req.ip, details: { reason: 'token_not_found' } });
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Sesión inválida.', code: 'INVALID_REFRESH' });
    }

    if (rt.revoked_at) {
      // Posible robo de token — revocar TODOS los tokens del usuario
      await db.execute('UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=?', [rt.user_id]);
      await auditLog('REFRESH_REUSE_ATTACK', { userId: rt.user_id, ip: req.ip,
                                                details: { token_id: rt.id } });
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Sesión comprometida. Inicia sesión nuevamente.', code: 'TOKEN_REUSE' });
    }

    if (new Date(rt.expires_at) < new Date()) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Sesión expirada.', code: 'REFRESH_EXPIRED' });
    }

    if (!rt.active) {
      clearRefreshCookie(res);
      return res.status(403).json({ error: 'Cuenta desactivada.', code: 'USER_INACTIVE' });
    }

    // Rotación del refresh token (token rotation)
    await db.execute('UPDATE refresh_tokens SET revoked_at=NOW() WHERE id=?', [rt.id]);
    const { token: newRefreshToken, expiresAt: newExp } = await generateRefreshToken(
      rt.user_id, req.ip, req.headers['user-agent']
    );
    setRefreshCookie(res, newRefreshToken, newExp);

    const accessToken = jwt.sign(
      { id: rt.uid, email: rt.email, name: rt.name, role: rt.role,
        company_id: rt.company_id, company_name: rt.company_name, company_slug: rt.company_slug },
      JWT_SECRET,
      { expiresIn: JWT_ACCESS_EXP }
    );

    res.json({
      accessToken,
      expiresIn: JWT_ACCESS_EXP,
      user: { id: rt.uid, name: rt.name, email: rt.email, role: rt.role, company_name: rt.company_name }
    });
  } catch (e) { handleError(res, e); }
});

// POST /auth/logout — revoca el refresh token actual
app.post('/auth/logout', async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (refreshToken) {
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await db.execute('UPDATE refresh_tokens SET revoked_at=NOW() WHERE token_hash=?', [hash])
      .catch(() => {}); // Silent — no bloquear logout
    // Intentar loggear el usuario si tiene token de acceso válido
    try {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        await auditLog('LOGOUT', { userId: decoded.id, ip: req.ip });
      }
    } catch (_) {}
  }
  clearRefreshCookie(res);
  res.json({ ok: true });
});

// POST /auth/logout-all — revoca todos los tokens del usuario (FASE 2)
app.post('/auth/logout-all', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Autenticación requerida' });
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    await db.execute('UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=? AND revoked_at IS NULL', [decoded.id]);
    await auditLog('LOGOUT_ALL', { userId: decoded.id, ip: req.ip });
    clearRefreshCookie(res);
    res.json({ ok: true, message: 'Todas las sesiones cerradas.' });
  } catch (e) { handleError(res, e); }
});

// POST /client-login
app.post('/client-login', loginLimiter, validate(schemas.clientLogin), async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await db.execute(
      'SELECT * FROM clients WHERE LOWER(username)=LOWER(?) AND active=1', [username]
    );
    if (!rows.length) {
      await auditLog('CLIENT_LOGIN_FAILED', { ip: req.ip, ua: req.headers['user-agent'],
                                               details: { username } });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const c = rows[0];
    const { valid, needsRehash } = await verifyPwd(password, c.password_hash);
    if (!valid) {
      await auditLog('CLIENT_LOGIN_FAILED', { clientId: c.id, ip: req.ip });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    if (needsRehash) {
      const newHash = await hashPwd(password);
      await db.execute('UPDATE clients SET password_hash=? WHERE id=?', [newHash, c.id]);
    }
    const token = jwt.sign(
      { role: 'client', client_id: c.id, client_name: c.name,
        company_id: c.company_id, username: c.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    await auditLog('CLIENT_LOGIN_SUCCESS', { clientId: c.id, ip: req.ip, resourceId: c.id });
    res.json({ token, client_name: c.name });
  } catch (e) { handleError(res, e); }
});

// ─── Portal cliente ───────────────────────────────────────────────────────────
app.get('/client/actas', clientAuth, async (req, res) => {
  try {
    // FASE 3: Filtra por client_id (FK) O por nombre (compatibilidad)
    const [rows] = await db.execute(
      `SELECT m.id,m.cliente,m.proyecto,m.responsable,m.started_at,m.ended_at,
              m.participantes,m.approved_at,m.approved_by_client,
              a.acta_json, a.created_at as acta_created_at
       FROM meetings m LEFT JOIN actas a ON a.meeting_id=m.id
       WHERE (m.client_id=? OR LOWER(m.cliente)=LOWER(?))
         AND m.company_id=? AND m.status='ended' AND a.acta_json IS NOT NULL
       ORDER BY m.started_at DESC`,
      [req.client.client_id, req.client.client_name, req.client.company_id]
    );
    res.json(rows.map(r => ({
      ...r,
      participantes: (() => { try { return JSON.parse(r.participantes || '[]'); } catch (_) { return []; } })(),
      acta: r.acta_json ? JSON.parse(r.acta_json) : null
    })));
  } catch (e) { handleError(res, e); }
});

app.post('/client/actas/:mid/approve', clientAuth, async (req, res) => {
  try {
    const [[m]] = await db.execute(
      'SELECT id,approved_at FROM meetings WHERE id=? AND company_id=?',
      [req.params.mid, req.client.company_id]
    );
    if (!m) return res.status(404).json({ error: 'No encontrada' });
    if (m.approved_at) return res.status(409).json({ error: 'Ya fue aprobada' });
    await db.execute(
      'UPDATE meetings SET approved_at=NOW(),approved_by_client=? WHERE id=?',
      [req.client.username, req.params.mid]
    );
    await auditLog('ACTA_APPROVED', {
      clientId: req.client.client_id, ip: req.ip,
      resourceType: 'meeting', resourceId: req.params.mid
    });
    res.json({ ok: true, approved_at: new Date().toISOString(), approved_by: req.client.username });
  } catch (e) { handleError(res, e); }
});

// ─── Auth middleware para el resto ────────────────────────────────────────────
app.use(authMiddleware(db));

// Shortcuts con db inyectado
const withAccess = requireMeetingAccess(db);

// ─── Superadmin: Empresas ─────────────────────────────────────────────────────
app.get('/superadmin/companies', requireRole('superadmin'), async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(50, parseInt(req.query.limit || '20'));
    const offset = (page - 1) * limit;
    const [r] = await db.execute(
      `SELECT c.*, COUNT(DISTINCT u.id) as user_count, COUNT(DISTINCT m.id) as meeting_count
       FROM companies c LEFT JOIN users u ON u.company_id=c.id
       LEFT JOIN meetings m ON m.company_id=c.id
       GROUP BY c.id ORDER BY c.name LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    const [[{ total }]] = await db.execute('SELECT COUNT(*) as total FROM companies');
    res.json({ data: r, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { handleError(res, e); }
});

app.post('/superadmin/companies', requireRole('superadmin'), validate(schemas.createCompany), async (req, res) => {
  const { name, admin_name, admin_email, admin_password } = req.body;
  try {
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const [cr] = await db.execute('INSERT INTO companies (name,slug) VALUES (?,?)', [name.trim(), slug]);
    const hash = await hashPwd(admin_password);
    await db.execute(
      'INSERT INTO users (company_id,name,email,password_hash,role) VALUES (?,?,?,?,?)',
      [cr.insertId, admin_name || 'Admin', admin_email.trim().toLowerCase(), hash, 'admin']
    );
    await auditLog('COMPANY_CREATED', { userId: req.user.id, ip: req.ip,
                                         resourceType: 'company', resourceId: cr.insertId });
    res.json({ id: cr.insertId, name, slug });
  } catch (e) {
    res.status(e.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ error: IS_PROD ? 'Error al crear empresa' : e.message });
  }
});

app.put('/superadmin/companies/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const { name, active } = req.body;
    if (name)             await db.execute('UPDATE companies SET name=? WHERE id=?', [name, req.params.id]);
    if (active !== undefined) await db.execute('UPDATE companies SET active=? WHERE id=?', [active ? 1 : 0, req.params.id]);
    await auditLog('COMPANY_UPDATED', { userId: req.user.id, ip: req.ip,
                                         resourceType: 'company', resourceId: req.params.id });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// ─── Admin: Usuarios ──────────────────────────────────────────────────────────
app.get('/admin/users', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const cid = req.user.role === 'superadmin' ? (req.query.company_id || req.user.company_id) : req.user.company_id;
    const [r] = await db.execute('SELECT id,name,email,role,active,created_at FROM users WHERE company_id=? ORDER BY name', [cid]);
    res.json(r);
  } catch (e) { handleError(res, e); }
});

app.post('/admin/users', requireRole('superadmin', 'admin'), validate(schemas.createUser), async (req, res) => {
  const { name, email, password, role = 'member' } = req.body;
  try {
    const hash = await hashPwd(password);
    const [r] = await db.execute(
      'INSERT INTO users (company_id,name,email,password_hash,role) VALUES (?,?,?,?,?)',
      [req.user.company_id, name.trim(), email.trim().toLowerCase(), hash, role]
    );
    await auditLog('USER_CREATED', { userId: req.user.id, ip: req.ip,
                                      resourceType: 'user', resourceId: r.insertId });
    res.json({ id: r.insertId, name, email, role });
  } catch (e) {
    res.status(e.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ error: IS_PROD ? 'Error al crear usuario' : e.message });
  }
});

app.put('/admin/users/:id', requireRole('superadmin', 'admin'), validate(schemas.updateUser), async (req, res) => {
  try {
    const { name, password, role, active } = req.body;
    const cid = req.user.company_id;
    if (name)     await db.execute('UPDATE users SET name=? WHERE id=? AND company_id=?', [name, req.params.id, cid]);
    if (password) {
      const hash = await hashPwd(password);
      await db.execute('UPDATE users SET password_hash=? WHERE id=? AND company_id=?', [hash, req.params.id, cid]);
    }
    if (role)            await db.execute('UPDATE users SET role=? WHERE id=? AND company_id=?', [role, req.params.id, cid]);
    if (active !== undefined) await db.execute('UPDATE users SET active=? WHERE id=? AND company_id=?', [active ? 1 : 0, req.params.id, cid]);
    await auditLog('USER_UPDATED', { userId: req.user.id, ip: req.ip,
                                      resourceType: 'user', resourceId: req.params.id,
                                      details: { fields: Object.keys(req.body) } });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.delete('/admin/users/:id', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
    await db.execute('DELETE FROM users WHERE id=? AND company_id=?', [req.params.id, req.user.company_id]);
    await auditLog('USER_DELETED', { userId: req.user.id, ip: req.ip,
                                      resourceType: 'user', resourceId: req.params.id });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// ─── Admin: Clientes Portal ───────────────────────────────────────────────────
app.get('/admin/clients', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const [r] = await db.execute(
      `SELECT c.id,c.name,c.username,c.active,c.created_at, COUNT(DISTINCT m.id) as meeting_count
       FROM clients c
       LEFT JOIN meetings m ON (m.client_id=c.id OR LOWER(m.cliente)=LOWER(c.name)) AND m.company_id=c.company_id
       WHERE c.company_id=? GROUP BY c.id ORDER BY c.name`,
      [req.user.company_id]
    );
    res.json(r);
  } catch (e) { handleError(res, e); }
});

app.post('/admin/clients', requireRole('superadmin', 'admin'), validate(schemas.createClient), async (req, res) => {
  const { name, username, password } = req.body;
  try {
    const hash = await hashPwd(password);
    const [r] = await db.execute(
      'INSERT INTO clients (company_id,name,username,password_hash) VALUES (?,?,?,?)',
      [req.user.company_id, name.trim(), username.trim().toLowerCase(), hash]
    );
    await auditLog('CLIENT_CREATED', { userId: req.user.id, ip: req.ip,
                                        resourceType: 'client', resourceId: r.insertId });
    res.json({ id: r.insertId, name, username: username.toLowerCase() });
  } catch (e) {
    res.status(e.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ error: IS_PROD ? 'Error al crear cliente' : e.message });
  }
});

app.put('/admin/clients/:id', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const { name, username, password, active } = req.body;
    const cid = req.user.company_id;
    if (name)     await db.execute('UPDATE clients SET name=? WHERE id=? AND company_id=?', [name, req.params.id, cid]);
    if (username) await db.execute('UPDATE clients SET username=? WHERE id=? AND company_id=?', [username.toLowerCase(), req.params.id, cid]);
    if (password) {
      const hash = await hashPwd(password);
      await db.execute('UPDATE clients SET password_hash=? WHERE id=? AND company_id=?', [hash, req.params.id, cid]);
    }
    if (active !== undefined) await db.execute('UPDATE clients SET active=? WHERE id=? AND company_id=?', [active ? 1 : 0, req.params.id, cid]);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.delete('/admin/clients/:id', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    await db.execute('DELETE FROM clients WHERE id=? AND company_id=?', [req.params.id, req.user.company_id]);
    await auditLog('CLIENT_DELETED', { userId: req.user.id, ip: req.ip,
                                        resourceType: 'client', resourceId: req.params.id });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.get('/admin/users/for-invite', async (req, res) => {
  try {
    const [r] = await db.execute(
      'SELECT id,name,email FROM users WHERE company_id=? AND active=1 AND id!=? ORDER BY name',
      [req.user.company_id, req.user.id]
    );
    res.json(r);
  } catch (e) { handleError(res, e); }
});

// FASE 6: Endpoint de audit logs para admins
app.get('/admin/audit-logs', requireRole('superadmin', 'admin'), async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(100, parseInt(req.query.limit || '50'));
    const offset = (page - 1) * limit;
    const cid   = req.user.role === 'superadmin' ? null : req.user.company_id;
    let sql = `SELECT al.id, al.user_email, al.action, al.resource_type, al.resource_id,
                      al.ip, al.details, al.created_at
               FROM audit_logs al LEFT JOIN users u ON u.id=al.user_id
               WHERE 1=1`;
    const params = [];
    if (cid) { sql += ' AND (u.company_id=? OR al.user_id IS NULL)'; params.push(cid); }
    sql += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const [r] = await db.execute(sql, params);
    res.json(r);
  } catch (e) { handleError(res, e); }
});

// ─── Reuniones ────────────────────────────────────────────────────────────────
app.post('/startMeeting', validate(schemas.startMeeting), async (req, res) => {
  const mid = uuidv4();
  const { cliente, proyecto, responsable, linked_meeting_id, terminology,
          invited_user_ids, client_id } = req.body;
  const parts = Array.isArray(req.body.participantes) ? JSON.stringify(req.body.participantes) : '[]';

  fs.mkdirSync(path.join(storagePath, mid), { recursive: true });
  try {
    // FASE 3: Validar que linked_meeting_id pertenece a la empresa
    if (linked_meeting_id) {
      const [[lm]] = await db.execute(
        'SELECT id FROM meetings WHERE id=? AND company_id=?',
        [linked_meeting_id, req.user.company_id]
      );
      if (!lm) return res.status(400).json({ error: 'Reunión vinculada no válida' });
    }
    // FASE 3: Validar que usuarios invitados pertenecen a la empresa
    for (const uid of invited_user_ids) {
      const [[u]] = await db.execute(
        'SELECT id FROM users WHERE id=? AND company_id=? AND active=1',
        [uid, req.user.company_id]
      );
      if (!u) return res.status(400).json({ error: `Usuario invitado ${uid} no válido` });
    }

    await db.execute(
      `INSERT INTO meetings (id,company_id,created_by,status,started_at,
        cliente,proyecto,responsable,participantes,linked_meeting_id,terminology,client_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [mid, req.user.company_id, req.user.id, 'active', new Date(),
       cliente, proyecto, responsable, parts, linked_meeting_id || null, terminology, client_id || null]
    );
    for (const uid of invited_user_ids) {
      if (uid !== req.user.id) {
        await db.execute('INSERT IGNORE INTO meeting_users (meeting_id,user_id) VALUES (?,?)', [mid, uid]);
      }
    }
    res.json({ meetingId: mid, status: 'active' });
  } catch (e) { handleError(res, e); }
});

app.post('/endMeeting', async (req, res) => {
  const { meetingId } = req.body;
  if (!meetingId) return res.status(400).json({ error: 'Missing meetingId' });
  try {
    if (await isMeetingApproved(meetingId)) return res.status(403).json({ error: 'Acta aprobada por el cliente.' });
    const ok = await canAccess(db, meetingId, req.user.id, req.user.company_id, req.user.role);
    if (!ok) return res.status(403).json({ error: 'Sin acceso a esta reunión.' });
    await db.execute("UPDATE meetings SET status='ended',ended_at=? WHERE id=?", [new Date(), meetingId]);
    await auditLog('MEETING_ENDED', { userId: req.user.id, ip: req.ip,
                                       resourceType: 'meeting', resourceId: meetingId });
    res.json({ meetingId, status: 'ended', actaStatus: 'processing' });
    finalizeMeeting(meetingId).catch(e => console.error('finalizeMeeting:', e.message));
  } catch (e) { handleError(res, e); }
});

app.post('/chunk', chunkLimiter, upload.single('audio'), async (req, res) => {
  const { meetingId, chunkNumber } = req.body;
  if (!meetingId || chunkNumber === undefined || !req.file) return res.status(400).json({ error: 'Missing fields' });
  // FASE 3: Verificar ownership
  const ok = await canAccess(db, meetingId, req.user.id, req.user.company_id, req.user.role);
  if (!ok) return res.status(403).json({ error: 'Sin acceso a esta reunión.' });

  const fp = path.join(storagePath, meetingId, `chunk_${chunkNumber}.webm`);
  fs.mkdirSync(path.join(storagePath, meetingId), { recursive: true });
  fs.writeFileSync(fp, req.file.buffer);
  try {
    const [[m]] = await db.execute(
      'SELECT participantes,cliente,proyecto,terminology FROM meetings WHERE id=?', [meetingId]
    );
    let parts = []; try { parts = JSON.parse(m?.participantes || '[]'); } catch (_) {}
    const [r] = await db.execute(
      'INSERT INTO chunks (meeting_id,chunk_number,file_path,processed) VALUES (?,?,?,?)',
      [meetingId, parseInt(chunkNumber), fp, 0]
    );
    res.json({ chunkId: r.insertId, meetingId, chunkNumber: parseInt(chunkNumber) });
    procChunk(fp, meetingId, parseInt(chunkNumber), parts, m?.cliente || '', m?.proyecto || '', m?.terminology || '').catch(console.error);
  } catch (e) { handleError(res, e); }
});

// FASE 3: Todos los endpoints de reunión protegidos con withAccess
app.get('/meetings/:id/progress', withAccess, async (req, res) => {
  try {
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
    res.json({ chunksTotal: total, chunksProcessed: processed, sectionsGenerated: sections,
               transcriptionLines: lines, notesCount: notes, status: meetingRows[0].status });
  } catch (e) { handleError(res, e); }
});

app.get('/meetings', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(50, parseInt(req.query.limit || '20'));
    const offset = (page - 1) * limit;
    let sql, params;
    if (req.user.role === 'superadmin') {
      sql    = 'SELECT m.*,u.name as creator_name FROM meetings m JOIN users u ON u.id=m.created_by ORDER BY m.started_at DESC LIMIT ? OFFSET ?';
      params = [limit, offset];
    } else if (req.user.role === 'admin') {
      sql    = 'SELECT m.*,u.name as creator_name FROM meetings m JOIN users u ON u.id=m.created_by WHERE m.company_id=? ORDER BY m.started_at DESC LIMIT ? OFFSET ?';
      params = [req.user.company_id, limit, offset];
    } else {
      sql    = `SELECT m.*,u.name as creator_name FROM meetings m JOIN users u ON u.id=m.created_by
               WHERE m.company_id=? AND (m.created_by=? OR EXISTS (SELECT 1 FROM meeting_users mu WHERE mu.meeting_id=m.id AND mu.user_id=?))
               ORDER BY m.started_at DESC LIMIT ? OFFSET ?`;
      params = [req.user.company_id, req.user.id, req.user.id, limit, offset];
    }
    const [r] = await db.execute(sql, params);
    res.json({ data: r, page, limit });
  } catch (e) { handleError(res, e); }
});

app.get('/meetings-for-link', async (req, res) => {
  try {
    const { cliente } = req.query;
    let sql = `SELECT m.id,m.cliente,m.proyecto,m.responsable,m.started_at,COUNT(t.id) as tareas_pendientes
               FROM meetings m LEFT JOIN tareas t ON t.meeting_id=m.id AND t.estado='pendiente' AND t.tipo='nueva'
               WHERE m.status='ended' AND m.company_id=?`;
    const p = [req.user.company_id];
    if (cliente) { sql += ' AND LOWER(m.cliente)=LOWER(?)'; p.push(cliente); }
    sql += ' GROUP BY m.id ORDER BY m.started_at DESC LIMIT 50';
    const [r] = await db.execute(sql, p);
    res.json(r);
  } catch (e) { handleError(res, e); }
});

app.get('/meetings/:id', withAccess, async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT m.*,u.name as creator_name FROM meetings m JOIN users u ON u.id=m.created_by WHERE m.id=?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const [inv] = await db.execute(
      'SELECT mu.user_id,u.name,u.email FROM meeting_users mu JOIN users u ON u.id=mu.user_id WHERE mu.meeting_id=?',
      [req.params.id]
    );
    res.json({ ...rows[0], invited_users: inv });
  } catch (e) { handleError(res, e); }
});

app.get('/meetings/:id/transcription', withAccess, async (req, res) => {
  try {
    const [r] = await db.execute('SELECT * FROM transcriptions WHERE meeting_id=? ORDER BY chunk_number,id', [req.params.id]);
    res.json(r);
  } catch (e) { handleError(res, e); }
});

app.get('/meetings/:id/acta', withAccess, async (req, res) => {
  try {
    const [[m]] = await db.execute('SELECT status,approved_at,approved_by_client FROM meetings WHERE id=?', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Not found' });
    const [a] = await db.execute('SELECT acta_json FROM actas WHERE meeting_id=?', [req.params.id]);
    if (!a.length) return res.status(202).json({ status: 'processing', meetingStatus: m.status });
    res.json({ status: 'ready', acta: JSON.parse(a[0].acta_json), approved_at: m.approved_at, approved_by_client: m.approved_by_client });
  } catch (e) { handleError(res, e); }
});

app.put('/meetings/:id/acta', withAccess, async (req, res) => {
  try {
    if (await isMeetingApproved(req.params.id)) return res.status(403).json({ error: 'Acta aprobada. No se puede modificar.' });
    await db.execute(
      'INSERT INTO actas (meeting_id,acta_json) VALUES (?,?) ON DUPLICATE KEY UPDATE acta_json=VALUES(acta_json)',
      [req.params.id, JSON.stringify(req.body)]
    );
    await auditLog('ACTA_UPDATED', { userId: req.user.id, ip: req.ip,
                                      resourceType: 'meeting', resourceId: req.params.id });
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.get('/meetings/:id/tareas', withAccess, async (req, res) => {
  try {
    const [r] = await db.execute('SELECT * FROM tareas WHERE meeting_id=? ORDER BY tipo DESC,id', [req.params.id]);
    res.json(r);
  } catch (e) { handleError(res, e); }
});

app.put('/meetings/:id/tareas', withAccess, async (req, res) => {
  try {
    if (await isMeetingApproved(req.params.id)) return res.status(403).json({ error: 'Acta aprobada. No se puede modificar.' });
    const tareas = Array.isArray(req.body) ? req.body : req.body?.tareas;
    if (!Array.isArray(tareas)) return res.status(400).json({ error: 'array required' });
    await db.execute('DELETE FROM tareas WHERE meeting_id=?', [req.params.id]);
    for (const t of tareas) {
      await db.execute(
        'INSERT INTO tareas (meeting_id,tarea_id,tipo,descripcion,responsable,estado,fecha_compromiso) VALUES (?,?,?,?,?,?,?)',
        [req.params.id, t.tarea_id || '', t.tipo || 'nueva', t.descripcion || '', t.responsable || '', t.estado || 'pendiente', t.fecha_compromiso || '']
      );
    }
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.post('/meetings/:id/reprocess-acta', withAccess, async (req, res) => {
  try {
    if (await isMeetingApproved(req.params.id)) return res.status(403).json({ error: 'Acta aprobada. No se puede reprocesar.' });
    await db.execute('DELETE FROM tareas WHERE meeting_id=?',           [req.params.id]);
    await db.execute('DELETE FROM actas WHERE meeting_id=?',            [req.params.id]);
    await db.execute('DELETE FROM section_summaries WHERE meeting_id=?',[req.params.id]);
    res.json({ ok: true, message: 'Reprocesando...' });
    finalizeMeeting(req.params.id).catch(console.error);
  } catch (e) { handleError(res, e); }
});

app.post('/meetings/from-text', validate(schemas.fromText), async (req, res) => {
  const { cliente, proyecto, responsable, participantes: pRaw, texto, modo,
          fecha, hora_inicio, hora_fin, linked_meeting_id, terminology,
          invited_user_ids, client_id } = req.body;
  const mid   = uuidv4();
  const parts = Array.isArray(pRaw) ? pRaw : (typeof pRaw === 'string' ? pRaw.split(/[,;]/).map(p => p.trim()).filter(Boolean) : []);
  const sd    = fecha ? new Date(`${fecha}T${hora_inicio || '09:00'}:00`) : new Date();
  const ed    = fecha && hora_fin ? new Date(`${fecha}T${hora_fin}:00`) : new Date();
  try {
    await db.execute(
      `INSERT INTO meetings (id,company_id,created_by,status,started_at,ended_at,
        cliente,proyecto,responsable,participantes,linked_meeting_id,terminology,client_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [mid, req.user.company_id, req.user.id, 'ended', sd, ed,
       cliente, proyecto, responsable, JSON.stringify(parts),
       linked_meeting_id || null, terminology, client_id || null]
    );
    for (const uid of (invited_user_ids || [])) {
      if (uid !== req.user.id) {
        await db.execute('INSERT IGNORE INTO meeting_users (meeting_id,user_id) VALUES (?,?)', [mid, uid]);
      }
    }
    res.json({ meetingId: mid, status: 'ended', message: 'Procesando...' });
    (async () => {
      try {
        const meta = {
          cliente: cliente || '', proyecto: proyecto || '', responsable: responsable || '',
          participantes: parts,
          fecha:       sd.toISOString().split('T')[0],
          hora_inicio: hora_inicio || `${String(sd.getHours()).padStart(2, '0')}:${String(sd.getMinutes()).padStart(2, '0')}`,
          hora_fin:    hora_fin    || `${String(ed.getHours()).padStart(2, '0')}:${String(ed.getMinutes()).padStart(2, '0')}`,
        };
        const fd       = addBizDays(meta.fecha, 3);
        const tareasAnt = await getLinkedTareas(linked_meeting_id);
        let actaJson   = await genActaText(texto.trim(), modo, meta, fd, tareasAnt);
        if (!actaJson) actaJson = { identificacion: { ...meta }, tareas_anteriores: [], tareas_nuevas: [], resumen_reunion: 'No se pudo generar.', observaciones_generales: '' };
        actaJson.identificacion = { ...meta };
        if (tareasAnt.length) {
          actaJson.tareas_anteriores = tareasAnt.map((t, i) => ({
            id: `ant_${String(i + 1).padStart(3, '0')}`, descripcion: t.descripcion,
            responsable: t.responsable, estado: t.estado, fecha_compromiso: t.fecha_compromiso || ''
          }));
        }
        await db.execute(
          'INSERT INTO actas (meeting_id,acta_json) VALUES (?,?) ON DUPLICATE KEY UPDATE acta_json=VALUES(acta_json)',
          [mid, JSON.stringify(actaJson)]
        );
        await db.execute('DELETE FROM tareas WHERE meeting_id=?', [mid]);
        for (const t of tareasAnt) {
          await db.execute(
            'INSERT INTO tareas (meeting_id,tarea_id,tipo,descripcion,responsable,estado,fecha_compromiso) VALUES (?,?,?,?,?,?,?)',
            [mid, t.tarea_id || uuidv4(), 'anterior', t.descripcion || '', t.responsable || '', t.estado || 'pendiente', t.fecha_compromiso || '']
          );
        }
        const td = dedup(actaJson.tareas_nuevas || []);
        for (let i = 0; i < td.length; i++) {
          const t = td[i];
          await db.execute(
            'INSERT INTO tareas (meeting_id,tarea_id,tipo,descripcion,responsable,estado,fecha_compromiso) VALUES (?,?,?,?,?,?,?)',
            [mid, fmtId(i + 1), 'nueva', (t.descripcion || '').trim(), (t.responsable || '').trim(), 'pendiente', t.fecha_compromiso || addBizDays(meta.fecha, 3)]
          );
        }
      } catch (e) { console.error(`[${mid}] from-text error:`, e.message); }
    })();
  } catch (e) { handleError(res, e); }
});

// Notas
app.get('/meetings/:id/notes', withAccess, async (req, res) => {
  try {
    const [r] = await db.execute('SELECT * FROM meeting_notes WHERE meeting_id=? ORDER BY created_at', [req.params.id]);
    res.json(r);
  } catch (e) { handleError(res, e); }
});

app.post('/meetings/:id/notes', withAccess, validate(schemas.addNote), async (req, res) => {
  const { content, author = '' } = req.body;
  try {
    if (await isMeetingApproved(req.params.id)) return res.status(403).json({ error: 'Acta aprobada.' });
    const [r] = await db.execute(
      'INSERT INTO meeting_notes (meeting_id,user_id,content,author) VALUES (?,?,?,?)',
      [req.params.id, req.user.id, content.trim(), author.trim() || req.user.name]
    );
    res.json({ id: r.insertId, content: content.trim(), author: author.trim() || req.user.name });
  } catch (e) { handleError(res, e); }
});

app.delete('/meetings/:id/notes/:nid', withAccess, async (req, res) => {
  try {
    const [[note]] = await db.execute(
      'SELECT user_id FROM meeting_notes WHERE id=? AND meeting_id=?',
      [req.params.nid, req.params.id]
    );
    if (!note) return res.status(404).json({ error: 'Nota no encontrada' });
    // Solo el autor o un admin puede borrar
    const canDel = note.user_id === req.user.id || ['admin', 'superadmin'].includes(req.user.role);
    if (!canDel) return res.status(403).json({ error: 'No puedes eliminar esta nota' });
    await db.execute('DELETE FROM meeting_notes WHERE id=? AND meeting_id=?', [req.params.nid, req.params.id]);
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

// Adjuntos
app.get('/meetings/:id/attachments', withAccess, async (req, res) => {
  try {
    const [r] = await db.execute(
      'SELECT id,meeting_id,file_name,file_type,mime_type,transcription_status,uploaded_at FROM meeting_attachments WHERE meeting_id=? ORDER BY uploaded_at',
      [req.params.id]
    );
    res.json(r);
  } catch (e) { handleError(res, e); }
});

app.post('/meetings/:id/attachments', withAccess, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No archivo' });
  try {
    const [[m]] = await db.execute('SELECT id,participantes,cliente,proyecto,terminology FROM meetings WHERE id=?', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'No encontrada' });
    const mime    = req.file.mimetype || '';
    const isAudio = mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i.test(req.file.originalname);
    const dir     = path.join(attachmentPath, req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    // FASE 4: Sanitizar nombre de archivo
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 200);
    const sn       = `${Date.now()}_${safeName}`;
    const fp       = path.join(dir, sn);
    fs.writeFileSync(fp, req.file.buffer);
    const [r] = await db.execute(
      'INSERT INTO meeting_attachments (meeting_id,file_name,file_path,file_type,mime_type,transcription_status) VALUES (?,?,?,?,?,?)',
      [req.params.id, req.file.originalname.substring(0, 500), fp, isAudio ? 'audio' : 'document', mime, isAudio ? 'pending' : 'n/a']
    );
    res.json({ id: r.insertId, file_name: req.file.originalname, file_type: isAudio ? 'audio' : 'document', transcription_status: isAudio ? 'pending' : 'n/a' });
    if (isAudio) {
      let parts = []; try { parts = JSON.parse(m.participantes || '[]'); } catch (_) {}
      procAudio(r.insertId, fp, req.params.id, parts, m.cliente || '', m.proyecto || '', m.terminology || '').catch(console.error);
    }
  } catch (e) { handleError(res, e); }
});

app.delete('/meetings/:id/attachments/:aid', withAccess, async (req, res) => {
  try {
    const [[r]] = await db.execute(
      'SELECT file_path FROM meeting_attachments WHERE id=? AND meeting_id=?',
      [req.params.aid, req.params.id]
    );
    if (!r) return res.status(404).json({ error: 'No encontrado' });
    await db.execute('DELETE FROM meeting_attachments WHERE id=?', [req.params.aid]);
    try { if (fs.existsSync(r.file_path)) fs.unlinkSync(r.file_path); } catch (_) {}
    res.json({ ok: true });
  } catch (e) { handleError(res, e); }
});

app.get('/meetings/:id/attachments/:aid/download', withAccess, async (req, res) => {
  try {
    const [[r]] = await db.execute(
      'SELECT file_name,file_path,mime_type FROM meeting_attachments WHERE id=? AND meeting_id=?',
      [req.params.aid, req.params.id]
    );
    if (!r || !fs.existsSync(r.file_path)) return res.status(404).json({ error: 'No encontrado' });
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(r.file_name)}"`);
    if (r.mime_type) res.setHeader('Content-Type', r.mime_type);
    res.sendFile(path.resolve(r.file_path));
  } catch (e) { handleError(res, e); }
});

// ─── Arrancar ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () =>
    console.log(`🚀 Puerto ${PORT} | ENV=${process.env.NODE_ENV || 'development'} | CORS=${ALLOWED_ORIGINS.join(',')}`)
  ))
  .catch(e => { console.error('❌ DB init failed:', e.message); process.exit(1); });

