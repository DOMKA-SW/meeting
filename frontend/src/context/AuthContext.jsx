import { createContext, useContext, useState, useCallback } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken]     = useState(() => localStorage.getItem('auth_token'));
  const [user, setUser]       = useState(() => { try { const t=localStorage.getItem('auth_token'); if(!t)return null; return JSON.parse(atob(t.split('.')[1])); } catch(_){ return null; } });
  const [loginError, setLoginError] = useState('');
  const [loading, setLoading] = useState(false);

  const isAuthenticated = Boolean(token);

  const login = useCallback(async (email, password) => {
    setLoading(true); setLoginError('');
    try {
      const res  = await fetch(`${import.meta.env.VITE_API_BASE_URL}/login`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) { setLoginError(data.error || 'Credenciales incorrectas'); return false; }
      localStorage.setItem('auth_token', data.token);
      setToken(data.token);
      setUser(data.user);
      return true;
    } catch { setLoginError('No se pudo conectar al servidor'); return false; }
    finally { setLoading(false); }
  }, []);

  const logout = useCallback((isRecording=false) => {
    if (isRecording) return;
    localStorage.removeItem('auth_token');
    setToken(null); setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, user, isAuthenticated, login, logout, loginError, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
