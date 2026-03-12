const API_URL = import.meta.env.VITE_API_BASE_URL;

// ─── Sistema de refresco de token ─────────────────────────────────────────────
let isRefreshing = false;
let pendingQueue = [];

const processQueue = (error, newToken = null) => {
  pendingQueue.forEach(({ resolve, reject }) => error ? reject(error) : resolve(newToken));
  pendingQueue = [];
};

const dispatchAuthExpired = () => {
  window.dispatchEvent(new CustomEvent('auth:expired'));
};

// ─── apiFetch principal ───────────────────────────────────────────────────────
export const apiFetch = async (path, options = {}, _skipRefresh = false) => {
  const token     = localStorage.getItem('auth_token');
  const isFormData = options.body instanceof FormData;
  const headers   = { ...(options.headers || {}) };

  if (!isFormData) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  // Si no es 401, retornar normalmente
  if (res.status !== 401) return res;

  // Evitar loop en rutas de autenticación
  if (_skipRefresh || path === '/auth/refresh' || path === '/login' || path === '/client-login') {
    return res;
  }

  // Intentar refrescar el token
  if (isRefreshing) {
    // Ya hay un refresco en curso — encolar esta petición
    return new Promise((resolve, reject) => {
      pendingQueue.push({
        resolve: async (newToken) => {
          const newHeaders = { ...headers, Authorization: `Bearer ${newToken}` };
          resolve(await fetch(`${API_URL}${path}`, { ...options, headers: newHeaders }));
        },
        reject,
      });
    });
  }

  isRefreshing = true;

  try {
    const currentToken = localStorage.getItem('auth_token');
    const refreshRes   = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}),
      },
    });

    if (refreshRes.ok) {
      const data     = await refreshRes.json();
      const newToken = data.token;
      localStorage.setItem('auth_token', newToken);

      processQueue(null, newToken);

      // Reintentar la petición original con el nuevo token
      const newHeaders = { ...headers, Authorization: `Bearer ${newToken}` };
      return fetch(`${API_URL}${path}`, { ...options, headers: newHeaders });
    } else {
      // No se pudo refrescar → cerrar sesión
      processQueue(new Error('Sesión expirada'));
      localStorage.removeItem('auth_token');
      dispatchAuthExpired();
      return res;
    }
  } catch (e) {
    processQueue(e);
    localStorage.removeItem('auth_token');
    dispatchAuthExpired();
    return res;
  } finally {
    isRefreshing = false;
  }
};

// ─── clientFetch (portal de clientes) ────────────────────────────────────────
export const clientFetch = async (path, options = {}) => {
  const token   = localStorage.getItem('client_token');
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${API_URL}${path}`, { ...options, headers });
};

export { API_URL };
