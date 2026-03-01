const API_URL = import.meta.env.VITE_API_BASE_URL;

/**
 * Wrapper de fetch que agrega automáticamente el token JWT.
 * Úsalo en lugar de fetch() para todas las llamadas al backend.
 */
export const apiFetch = async (path, options = {}) => {
  const token = localStorage.getItem('auth_token');
  const isFormData = options.body instanceof FormData;

  const headers = { ...(options.headers || {}) };
  if (!isFormData) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return fetch(`${API_URL}${path}`, { ...options, headers });
};

export { API_URL };
