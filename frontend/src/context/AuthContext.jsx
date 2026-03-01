import { createContext, useContext, useState, useCallback } from 'react';
import { apiFetch } from '../utils/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('auth_token'));
  const [loginError, setLoginError] = useState('');
  const [loading, setLoading] = useState(false);

  const isAuthenticated = Boolean(token);

  const login = useCallback(async (password) => {
    setLoading(true);
    setLoginError('');
    try {
      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || 'Contraseña incorrecta');
        return false;
      }
      localStorage.setItem('auth_token', data.token);
      setToken(data.token);
      return true;
    } catch (e) {
      setLoginError('No se pudo conectar al servidor');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback((isRecording = false) => {
    // Nunca cerrar sesión si hay grabación activa
    if (isRecording) return;
    localStorage.removeItem('auth_token');
    setToken(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, isAuthenticated, login, logout, loginError, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
