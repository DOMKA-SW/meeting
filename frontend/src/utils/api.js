// ═══════════════════════════════════════════════════════════════════════════════
// api.js — Token management seguro
// FASE 2: Access token en MEMORIA (no localStorage), refresh vía cookie httpOnly
// ═══════════════════════════════════════════════════════════════════════════════

const API_URL = import.meta.env.VITE_API_BASE_URL;

// ─── Token Store en memoria ───────────────────────────────────────────────────
// Los tokens NUNCA se guardan en localStorage ni sessionStorage.
// Se mantienen solo en variables de módulo (memoria JS).
// Se pierden al recargar la página → el AuthContext llama /auth/refresh al montar.

let _accessToken  = null;
let _clientToken  = null;
let _refreshTimer = null;

export const tokenStore = {
  // Access token para usuarios admin/member
  setAccess: (token, expiresIn) => {
    _accessToken = token;
    // Auto-refresh 1 minuto antes de que expire
    if (_refreshTimer) clearTimeout(_refreshTimer);
    const expiresMs = parseExpiry(expiresIn) - 60 * 1000; // 1min antes
    if (expiresMs > 0) {
      _refreshTimer = setTimeout(() => {
        tokenStore.refresh().catch(console.error);
      }, expiresMs);
    }
  },
  getAccess: () => _accessToken,
  clearAccess: () => {
    _accessToken = null;
    if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
  },

  // Token para portal de cliente (se puede mantener en sessionStorage — menos riesgo)
  setClient: (token) => {
    _clientToken = token;
    // sessionStorage: persiste en la pestaña, se borra al cerrarla
    // Mejor que localStorage pero peor que cookie httpOnly
    try { sessionStorage.setItem('client_session', '1'); } catch (_) {}
  },
  getClient: () => _clientToken,
  clearClient: () => {
    _clientToken = null;
    try { sessionStorage.removeItem('client_session'); } catch (_) {}
  },

  // Llamada al endpoint de refresh (usa la cookie httpOnly automáticamente)
  refresh: async () => {
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include', // Envía la cookie httpOnly automáticamente
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        tokenStore.clearAccess();
        return null;
      }
      const data = await res.json();
      if (data.accessToken) {
        tokenStore.setAccess(data.accessToken, data.expiresIn || '15m');
        return data;
      }
      return null;
    } catch (e) {
      console.error('[tokenStore.refresh]', e.message);
      return null;
    }
  },
};

// Parsear string de expiración JWT ("15m", "1h", "7d") a milliseconds
function parseExpiry(exp) {
  if (!exp) return 15 * 60 * 1000; // default 15min
  if (typeof exp === 'number') return exp * 1000;
  const match = String(exp).match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 15 * 60 * 1000;
  const [, n, unit] = match;
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(n) * multipliers[unit];
}

// ─── Fetch autenticado para usuarios admin/member ─────────────────────────────
export const apiFetch = async (path, options = {}, retryOnExpiry = true) => {
  const token      = tokenStore.getAccess();
  const isFormData = options.body instanceof FormData;
  const headers    = { ...(options.headers || {}) };

  if (!isFormData) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers, credentials: 'include' });

  // Si el token expiró, intentar refresh automático (una sola vez)
  if (res.status === 401 && retryOnExpiry) {
    const data = await res.json().catch(() => ({}));
    if (data.code === 'TOKEN_EXPIRED') {
      const refreshed = await tokenStore.refresh();
      if (refreshed?.accessToken) {
        // Reintentar con el nuevo token
        return apiFetch(path, options, false);
      }
    }
    // Si no se pudo refrescar, devolver la respuesta 401 original
    return new Response(JSON.stringify(data), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  return res;
};

// ─── Fetch para portal de cliente ─────────────────────────────────────────────
export const clientFetch = async (path, options = {}) => {
  const token   = tokenStore.getClient();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${API_URL}${path}`, { ...options, headers });
};

export { API_URL };
