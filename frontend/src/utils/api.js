const API_URL = import.meta.env.VITE_API_BASE_URL;

export const apiFetch = async (path, options = {}) => {
  const token = localStorage.getItem('auth_token');
  const isFormData = options.body instanceof FormData;
  const headers = { ...(options.headers || {}) };
  if (!isFormData) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${API_URL}${path}`, { ...options, headers });
};

export const clientFetch = async (path, options = {}) => {
  const token = localStorage.getItem('client_token');
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${API_URL}${path}`, { ...options, headers });
};

export { API_URL };
