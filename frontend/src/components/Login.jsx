import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login, loginError, loading } = useAuth();
  const [password, setPassword] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    await login(password);
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#0f172a',
      padding: 16
    }}>
      <div style={{
        width: '100%',
        maxWidth: 380,
        backgroundColor: '#1e293b',
        borderRadius: 16,
        padding: '40px 36px',
        boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
        border: '1px solid #334155'
      }}>
        {/* Logo / Título */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            fontSize: 40,
            marginBottom: 12,
            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            display: 'inline-block'
          }}>🎙️</div>
          <h1 style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 700,
            color: '#f1f5f9',
            letterSpacing: '-0.5px'
          }}>
            Sistema de Actas
          </h1>
          <p style={{
            margin: '8px 0 0',
            fontSize: 13,
            color: '#94a3b8'
          }}>
            Acceso privado — Solo equipo interno
          </p>
        </div>

        {/* Formulario */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 20 }}>
            <label style={{
              display: 'block',
              marginBottom: 8,
              fontSize: 13,
              fontWeight: 600,
              color: '#cbd5e1'
            }}>
              Contraseña de acceso
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoFocus
              style={{
                width: '100%',
                padding: '12px 14px',
                backgroundColor: '#0f172a',
                border: loginError ? '1px solid #ef4444' : '1px solid #334155',
                borderRadius: 8,
                fontSize: 15,
                color: '#f1f5f9',
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'border-color 0.15s',
                letterSpacing: 3
              }}
              onFocus={e => { if (!loginError) e.target.style.borderColor = '#3b82f6'; }}
              onBlur={e => { if (!loginError) e.target.style.borderColor = '#334155'; }}
            />
          </div>

          {loginError && (
            <div style={{
              padding: '10px 14px',
              backgroundColor: 'rgba(239,68,68,0.15)',
              border: '1px solid rgba(239,68,68,0.4)',
              borderRadius: 8,
              fontSize: 13,
              color: '#fca5a5',
              marginBottom: 16
            }}>
              ⚠️ {loginError}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            style={{
              width: '100%',
              padding: '13px',
              background: loading || !password
                ? '#334155'
                : 'linear-gradient(135deg, #3b82f6, #6366f1)',
              color: loading || !password ? '#64748b' : 'white',
              border: 'none',
              borderRadius: 8,
              fontSize: 15,
              fontWeight: 600,
              cursor: loading || !password ? 'default' : 'pointer',
              transition: 'all 0.2s',
              letterSpacing: '0.3px'
            }}
          >
            {loading ? '⏳ Verificando...' : '→ Ingresar'}
          </button>
        </form>

        <p style={{
          textAlign: 'center',
          marginTop: 24,
          fontSize: 12,
          color: '#475569'
        }}>
          La sesión dura 30 días. No expira durante grabaciones activas.
        </p>
      </div>
    </div>
  );
}
