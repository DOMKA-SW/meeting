import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';

const AuthContext = createContext(null);

const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutos

export function AuthProvider({ children }) {
  const [token, setToken]     = useState(() => localStorage.getItem('auth_token'));
  const [user, setUser]       = useState(() => {
    try {
      const t = localStorage.getItem('auth_token');
      if (!t) return null;
      const payload = JSON.parse(atob(t.split('.')[1]));
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        localStorage.removeItem('auth_token');
        return null;
      }
      return payload;
    } catch(_) { return null; }
  });
  const [loginError, setLoginError] = useState('');
  const [loading, setLoading]       = useState(false);

  const isAuthenticated  = Boolean(token);
  const inactivityTimer  = useRef(null);
  const isRecordingRef   = useRef(false); // no causa re-renders

  // ─── Logout ────────────────────────────────────────────────────────────────
  const logout = useCallback((isRecording = false) => {
    if (isRecording) return;
    clearTimeout(inactivityTimer.current);
    localStorage.removeItem('auth_token');
    setToken(null);
    setUser(null);
  }, []);

  // ─── Reiniciar timer de inactividad ────────────────────────────────────────
  const resetInactivityTimer = useCallback(() => {
    // Si está grabando, no hacer nada — el timer se pausa
    if (isRecordingRef.current) return;

    clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(() => {
      // Doble check: si justo empezó a grabar, no cerrar
      if (isRecordingRef.current) return;
      console.info('[Auth] Sesión cerrada por inactividad (30 min)');
      logout(false);
    }, INACTIVITY_MS);
  }, [logout]);

  // ─── Escuchar actividad del usuario ────────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated) return;

    const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];
    const handleActivity = () => resetInactivityTimer();

    events.forEach(e => window.addEventListener(e, handleActivity, { passive: true }));
    resetInactivityTimer(); // arrancar el timer al iniciar sesión

    return () => {
      events.forEach(e => window.removeEventListener(e, handleActivity));
      clearTimeout(inactivityTimer.current);
    };
  }, [isAuthenticated, resetInactivityTimer]);

  // ─── Escuchar eventos de grabación ─────────────────────────────────────────
  // RecordingContext dispara estos eventos para pausar/reanudar el timer
  useEffect(() => {
    const onRecordingStart = () => {
      isRecordingRef.current = true;
      clearTimeout(inactivityTimer.current); // pausar timer durante grabación
      console.info('[Auth] Timer de inactividad pausado (grabando)');
    };

    const onRecordingStop = () => {
      isRecordingRef.current = false;
      resetInactivityTimer(); // reanudar timer al terminar grabación
      console.info('[Auth] Timer de inactividad reanudado');
    };

    window.addEventListener('recording:started', onRecordingStart);
    window.addEventListener('recording:stopped', onRecordingStop);
    return () => {
      window.removeEventListener('recording:started', onRecordingStart);
      window.removeEventListener('recording:stopped', onRecordingStop);
    };
  }, [resetInactivityTimer]);

  // ─── Sesión expirada por token inválido ────────────────────────────────────
  useEffect(() => {
    const handleAuthExpired = () => {
      console.warn('[Auth] Sesión expirada — cerrando sesión automáticamente');
      clearTimeout(inactivityTimer.current);
      localStorage.removeItem('auth_token');
      setToken(null);
      setUser(null);
    };
    window.addEventListener('auth:expired', handleAuthExpired);
    return () => window.removeEventListener('auth:expired', handleAuthExpired);
  }, []);

  // ─── Login ─────────────────────────────────────────────────────────────────
  const login = useCallback(async (email, password) => {
    setLoading(true);
    setLoginError('');
    try {
      const res  = await fetch(`${import.meta.env.VITE_API_BASE_URL}/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || 'Credenciales incorrectas');
        return false;
      }
      localStorage.setItem('auth_token', data.token);
      setToken(data.token);
      setUser(data.user);
      return true;
    } catch {
      setLoginError('No se pudo conectar al servidor');
      return false;
    } finally {
      setLoading(false);
    }
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
