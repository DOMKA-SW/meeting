// ═══════════════════════════════════════════════════════════════════════════════
// middleware.js — Seguridad completa del Sistema de Actas
// Fases: 1 (base), 2 (auth robusta), 3 (RBAC/ABAC), 4 (validación), 6 (audit)
// ═══════════════════════════════════════════════════════════════════════════════

const helmet      = require('helmet');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const jwt         = require('jsonwebtoken');
const crypto      = require('crypto');
const Joi         = require('joi');

// ─── ENV ──────────────────────────────────────────────────────────────────────
const IS_PROD    = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;

// ─── FASE 1: Helmet — 14 security headers en una línea ───────────────────────
const helmetMiddleware = helmet({
  // Content-Security-Policy para el backend (API)
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'none'"],
      scriptSrc:      ["'none'"],
      styleSrc:       ["'none'"],
      imgSrc:         ["'none'"],
      connectSrc:     ["'self'"],
      frameSrc:       ["'none'"],
      objectSrc:      ["'none'"],
      upgradeInsecureRequests: IS_PROD ? [] : null,
    },
  },
  // HSTS — fuerza HTTPS por 1 año
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  // Previene clickjacking
  frameguard: { action: 'deny' },
  // Previene MIME sniffing
  noSniff: true,
  // X-XSS-Protection
  xssFilter: true,
  // Oculta que es Express
  hidePoweredBy: true,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

// ─── FASE 1: CORS seguro — lista blanca de orígenes ──────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  process.env.FRONTEND_URL_2,
  ...(IS_PROD ? [] : [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
  ])
].filter(Boolean);

// ⚠️  Advertencia clara si falta FRONTEND_URL en producción
if (IS_PROD && !process.env.FRONTEND_URL) {
  console.error('❌ CORS ERROR: FRONTEND_URL no está definida en las variables de entorno.');
  console.error('   Ve a Railway → Variables → agrega FRONTEND_URL=https://tu-app.vercel.app');
  console.error('   Sin esto, NINGÚN request del frontend funcionará.');
}

console.log(`[CORS] Orígenes permitidos: ${ALLOWED_ORIGINS.join(', ') || '(ninguno — configura FRONTEND_URL)'}`);

const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Sin origin: requests directos (Postman, curl, health checks internos)
    if (!origin) {
      // En prod solo bloquear si hay lista definida (evitar romper health checks de Railway)
      if (IS_PROD && ALLOWED_ORIGINS.length > 0) return callback(null, false);
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    console.warn(`[CORS] Origen bloqueado: ${origin}`);
    // Devolver false (no error) para que el browser reciba 200 sin header CORS
    // — más seguro que lanzar error que podría exponer info
    callback(null, false);
  },
  credentials: true,                                // Requerido para cookies httpOnly
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-RateLimit-Remaining'],
  optionsSuccessStatus: 200,                        // Algunos browsers viejos usan 204
});

// ─── FASE 1: Rate Limiting ────────────────────────────────────────────────────

// Login estricto: 10 intentos / 15min por IP + email
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const id = (req.body?.email || req.body?.username || '').toLowerCase();
    return `${req.ip}:${id}`;
  },
  skipSuccessfulRequests: true,   // No contar logins exitosos
});

// API general: 300 req / 15min por IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Demasiadas peticiones. Intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
});

// Chunks de audio: 300 / hora por usuario autenticado
const chunkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  message: { error: 'Límite de subida de audio alcanzado por hora.' },
  keyGenerator: (req) => `chunk:${req.user?.id || req.ip}`,
});

// Upload de adjuntos: 50 / hora por usuario
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { error: 'Límite de subida de archivos alcanzado.' },
  keyGenerator: (req) => `upload:${req.user?.id || req.ip}`,
});

// Refresh token: 60 / hora por IP (evitar abuso)
const refreshLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: { error: 'Demasiadas renovaciones de sesión.' },
  keyGenerator: (req) => `refresh:${req.ip}`,
});

// ─── FASE 2: Auth Middleware ──────────────────────────────────────────────────

// Verifica JWT de acceso en el header Authorization
// También verifica que el usuario siga activo en BD
const authMiddleware = (db) => async (req, res, next) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Autenticación requerida' });
  }
  try {
    const decoded = jwt.verify(h.split(' ')[1], JWT_SECRET);

    // FASE 2: Verificar que el usuario siga activo (no solo verificar el token)
    // Cache de 1 minuto para no golpear BD en cada request
    const cacheKey = `user_active_${decoded.id}`;
    if (!req._userCache) req._userCache = {};

    const cached = req._userCache[cacheKey];
    if (!cached || Date.now() - cached.ts > 60000) {
      const [[user]] = await db.execute(
        'SELECT id, active, role, company_id FROM users WHERE id=? AND active=1',
        [decoded.id]
      );
      if (!user) return res.status(403).json({ error: 'Cuenta desactivada o no encontrada.' });
      req._userCache[cacheKey] = { ts: Date.now(), user };
    }

    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión expirada. Por favor inicia sesión nuevamente.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(403).json({ error: 'Token inválido.' });
  }
};

// FASE 3: Verificación de rol (RBAC)
const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) {
    return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
  }
  next();
};

// Auth para portal de cliente
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

// FASE 3: ABAC — Verifica acceso a reunión específica (company isolation)
const canAccess = async (db, mid, uid, cid, role) => {
  if (role === 'superadmin') return true;
  // SIEMPRE incluir company_id para company isolation
  const [[m]] = await db.execute(
    'SELECT created_by, company_id FROM meetings WHERE id=? AND company_id=?',
    [mid, cid]
  );
  if (!m) return false;
  if (role === 'admin') return true;
  if (m.created_by === uid) return true;
  const [inv] = await db.execute(
    'SELECT id FROM meeting_users WHERE meeting_id=? AND user_id=?',
    [mid, uid]
  );
  return inv.length > 0;
};

// Middleware reutilizable que aplica canAccess
const requireMeetingAccess = (db) => async (req, res, next) => {
  try {
    const ok = await canAccess(db, req.params.id, req.user.id, req.user.company_id, req.user.role);
    if (!ok) return res.status(403).json({ error: 'Sin acceso a esta reunión.' });
    next();
  } catch (e) {
    console.error('[requireMeetingAccess]', e.message);
    res.status(500).json({ error: IS_PROD ? 'Error interno' : e.message });
  }
};

// ─── FASE 4: Validación con Joi ───────────────────────────────────────────────

const schemas = {
  login: Joi.object({
    email: Joi.string().email().max(200).required().messages({
      'string.email': 'Email inválido',
      'any.required': 'Email requerido'
    }),
    password: Joi.string().min(1).max(200).required()
  }),

  clientLogin: Joi.object({
    username: Joi.string().alphanum().min(3).max(100).required(),
    password: Joi.string().min(1).max(200).required()
  }),

  createUser: Joi.object({
    name:     Joi.string().min(2).max(200).required(),
    email:    Joi.string().email().max(200).required(),
    password: Joi.string().min(8).max(200).required().messages({
      'string.min': 'La contraseña debe tener al menos 8 caracteres'
    }),
    role: Joi.string().valid('admin', 'member').default('member')
    // 'superadmin' intencionalmente excluido del schema
  }),

  updateUser: Joi.object({
    name:     Joi.string().min(2).max(200).optional(),
    password: Joi.string().min(8).max(200).optional(),
    role:     Joi.string().valid('admin', 'member').optional(),
    active:   Joi.boolean().optional()
  }),

  createClient: Joi.object({
    name:     Joi.string().min(2).max(200).required(),
    username: Joi.string().alphanum().min(3).max(100).required(),
    password: Joi.string().min(8).max(200).required()
  }),

  createCompany: Joi.object({
    name:           Joi.string().min(2).max(200).required(),
    admin_name:     Joi.string().min(2).max(200).optional(),
    admin_email:    Joi.string().email().max(200).required(),
    admin_password: Joi.string().min(8).max(200).required()
  }),

  startMeeting: Joi.object({
    cliente:          Joi.string().max(200).allow('').default(''),
    proyecto:         Joi.string().max(200).allow('').default(''),
    responsable:      Joi.string().max(200).allow('').default(''),
    participantes:    Joi.array().items(Joi.string().max(200)).max(50).default([]),
    linked_meeting_id: Joi.string().uuid().allow(null).optional(),
    terminology:      Joi.string().max(2000).allow('').default(''),
    invited_user_ids: Joi.array().items(Joi.number().integer().positive()).max(50).default([]),
    client_id:        Joi.number().integer().positive().allow(null).optional()
  }),

  fromText: Joi.object({
    cliente:          Joi.string().max(200).allow('').default(''),
    proyecto:         Joi.string().max(200).allow('').default(''),
    responsable:      Joi.string().max(200).allow('').default(''),
    participantes:    Joi.alternatives().try(
                        Joi.array().items(Joi.string().max(200)).max(50),
                        Joi.string().max(5000)
                      ).optional(),
    texto:            Joi.string().min(10).max(100000).required().messages({
      'string.min': 'Necesitas al menos 10 caracteres.'
    }),
    modo:             Joi.string().valid('notas', 'transcripcion', 'email').default('notas'),
    fecha:            Joi.string().isoDate().allow(null).optional(),
    hora_inicio:      Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).allow('').optional(),
    hora_fin:         Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).allow('').optional(),
    linked_meeting_id: Joi.string().uuid().allow(null).optional(),
    terminology:      Joi.string().max(2000).allow('').default(''),
    invited_user_ids: Joi.array().items(Joi.number().integer().positive()).max(50).default([]),
    client_id:        Joi.number().integer().positive().allow(null).optional()
  }),

  addNote: Joi.object({
    content: Joi.string().min(1).max(5000).required().messages({
      'string.max': 'Nota demasiado larga (máx 5000 caracteres)'
    }),
    author: Joi.string().max(200).allow('').optional()
  }),
};

// Middleware validador genérico
const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    const messages = error.details.map(d => d.message).join(', ');
    return res.status(400).json({ error: messages });
  }
  req.body = value; // Usar los valores sanitizados
  next();
};

// ─── FASE 6: Error handler que no expone detalles en producción ───────────────
const handleError = (res, e, statusCode = 500) => {
  const isKnown = [400, 401, 403, 404, 409, 422].includes(statusCode);
  if (!isKnown) console.error('[Server Error]', e.message, IS_PROD ? '' : e.stack);
  const msg = IS_PROD && !isKnown ? 'Error interno del servidor' : e.message;
  res.status(statusCode).json({ error: msg });
};

module.exports = {
  helmetMiddleware,
  corsMiddleware,
  loginLimiter,
  apiLimiter,
  chunkLimiter,
  uploadLimiter,
  refreshLimiter,
  authMiddleware,
  requireRole,
  clientAuth,
  canAccess,
  requireMeetingAccess,
  validate,
  schemas,
  handleError,
  IS_PROD,
};
