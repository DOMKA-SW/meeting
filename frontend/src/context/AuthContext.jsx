// ═══════════════════════════════════════════════════════════════════════════════
// AuthContext.jsx — FASE 2: Refresh token flow + token en memoria solamente
// ═══════════════════════════════════════════════════════════════════════════════

import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { tokenStore } from '../utils/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user,       setUser]       = useState(null);
  const [loginError, setLoginError] = useState('');
  const [loading,    setLoading]    = useState(false);
  const [restoring,  setRestoring]  = useState(true); // true durante el restore inicial

  const API_URL = import.meta.env.VITE_API_BASE_URL;

  // ─── Al montar: intentar restaurar sesión con el refresh token (cookie httpOnly)
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const data = await tokenStore.refresh();
        if (data?.accessToken && data?.user) {
          tokenStore.setAccess(data.accessToken, data.expiresIn || '15m');
          setUser(data.user);
        }
        // Si falla el refresh (401), el usuario simplemente no está autenticado → login
      } catch (_) {
        // Sin sesión activa — mostrar pantalla de login
      } finally {
        setRestoring(false);
      }
    };
    restoreSession();
  }, []);

  const isAuthenticated = Boolean(user);

  // ─── Login ────────────────────────────────────────────────────────────────────
  const login = useCallback(async (email, password) => {
    setLoading(true);
    setLoginError('');
    try {
      const res = await fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',  // Necesario para recibir la cookie httpOnly del refresh token
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || 'Credenciales incorrectas');
        return false;
      }
      // Access token → memoria (NO localStorage)
      tokenStore.setAccess(data.accessToken, data.expiresIn || '15m');
      setUser(data.user);
      return true;
    } catch {
      setLoginError('No se pudo conectar al servidor');
      return false;
    } finally {
      setLoading(false);
    }
  }, [API_URL]);

  // ─── Logout ───────────────────────────────────────────────────────────────────
  const logout = useCallback(async (isRecording = false) => {
    if (isRecording) return;
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',  // Envía cookie para que el servidor la revoque
        headers: {
          'Content-Type': 'application/json',
          ...(tokenStore.getAccess() ? { Authorization: `Bearer ${tokenStore.getAccess()}` } : {}),
        },
      });
    } catch (_) {
      // El logout local siempre procede, incluso si el servidor falla
    }
    tokenStore.clearAccess();
    setUser(null);
  }, [API_URL]);

  // ─── Cerrar todas las sesiones ────────────────────────────────────────────────
  const logoutAll = useCallback(async () => {
    try {
      await fetch(`${API_URL}/auth/logout-all`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(tokenStore.getAccess() ? { Authorization: `Bearer ${tokenStore.getAccess()}` } : {}),
        },
      });
    } catch (_) {}
    tokenStore.clearAccess();
    setUser(null);
  }, [API_URL]);

  // ─── Token de acceso para componentes que lo necesiten directamente ───────────
  // La mayoría de componentes usa apiFetch() que lee el token internamente.
  // Este getter existe para casos especiales (ej: WebSocket auth).
  const getToken = useCallback(() => tokenStore.getAccess(), []);

  // Mostrar spinner durante el restore inicial (evita flash de pantalla de login)
  if (restoring) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', backgroundColor: '#0f172a'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🎙️</div>
          <p style={{ color: '#64748b', fontSize: 14 }}>Restaurando sesión...</p>
        </div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      login,
      logout,
      logoutAll,
      getToken,
      loginError,
      loading,
      // Compatibilidad: algunos componentes leen `token` directamente
      get token() { return tokenStore.getAccess(); },
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
