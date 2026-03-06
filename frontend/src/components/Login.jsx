import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login, loginError, loading } = useAuth();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e) => { e.preventDefault(); await login(email, password); };

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', backgroundColor:'#0f172a', padding:16 }}>
      <div style={{ width:'100%', maxWidth:380, backgroundColor:'#1e293b', borderRadius:16, padding:'40px 36px', boxShadow:'0 25px 60px rgba(0,0,0,0.5)', border:'1px solid #334155' }}>
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <div style={{ fontSize:40, marginBottom:12 }}>🎙️</div>
          <h1 style={{ margin:0, fontSize:22, fontWeight:700, color:'#f1f5f9' }}>Sistema de Actas</h1>
          <p style={{ margin:'8px 0 0', fontSize:13, color:'#94a3b8' }}>Ingresa con tu cuenta</p>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', marginBottom:6, fontSize:13, fontWeight:600, color:'#cbd5e1' }}>Email</label>
            <input type="email" value={email} onChange={e=>setEmail(e.target.value)}
              placeholder="tu@empresa.com" autoFocus
              style={{ width:'100%', padding:'11px 14px', backgroundColor:'#0f172a', border:'1px solid #334155', borderRadius:8, fontSize:14, color:'#f1f5f9', outline:'none', boxSizing:'border-box' }} />
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={{ display:'block', marginBottom:6, fontSize:13, fontWeight:600, color:'#cbd5e1' }}>Contraseña</label>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)}
              placeholder="••••••••"
              style={{ width:'100%', padding:'11px 14px', backgroundColor:'#0f172a', border:'1px solid #334155', borderRadius:8, fontSize:14, color:'#f1f5f9', outline:'none', boxSizing:'border-box', letterSpacing:3 }} />
          </div>
          {loginError && (
            <div style={{ padding:'10px 14px', backgroundColor:'rgba(239,68,68,0.15)', border:'1px solid rgba(239,68,68,0.4)', borderRadius:8, fontSize:13, color:'#fca5a5', marginBottom:16 }}>
              ⚠️ {loginError}
            </div>
          )}
          <button type="submit" disabled={loading||!email||!password}
            style={{ width:'100%', padding:13, background:loading||!email||!password?'#334155':'linear-gradient(135deg,#3b82f6,#6366f1)', color:loading||!email||!password?'#64748b':'white', border:'none', borderRadius:8, fontSize:15, fontWeight:600, cursor:loading||!email||!password?'default':'pointer' }}>
            {loading?'⏳ Verificando...':'→ Ingresar'}
          </button>
        </form>
        <p style={{ textAlign:'center', marginTop:20, fontSize:12, color:'#475569' }}>Sesión de 30 días</p>
      </div>
    </div>
  );
}
