import { useState, useEffect } from 'react';
import { apiFetch } from '../utils/api';
import { useAuth } from '../context/AuthContext';

function Modal({ user, onSave, onClose }) {
  const isNew = !user;
  const [form, setForm] = useState({ name:user?.name||'', email:user?.email||'', password:'', role:user?.role||'member', active:user?.active??1 });
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const set = (k,v) => setForm(f=>({...f,[k]:v}));
  const inp = { width:'100%', padding:'9px 12px', border:'1px solid #dde1e7', borderRadius:6, fontSize:14, boxSizing:'border-box', outline:'none' };
  const lbl = { display:'block', marginBottom:5, fontSize:13, fontWeight:600, color:'#444' };

  const save = async () => {
    if(!form.name.trim()) return setError('El nombre es requerido');
    if(!form.email.trim()) return setError('El email es requerido');
    if(isNew && !form.password.trim()) return setError('La contraseña es requerida');
    setSaving(true); setError('');
    try {
      const body = { name:form.name.trim(), email:form.email.trim().toLowerCase(), role:form.role, active:form.active };
      if(form.password.trim()) body.password = form.password.trim();
      const res = isNew
        ? await apiFetch('/admin/users', { method:'POST', body:JSON.stringify(body) })
        : await apiFetch(`/admin/users/${user.id}`, { method:'PUT', body:JSON.stringify(body) });
      const data = await res.json();
      if(!res.ok) { setError(data.error||'Error'); setSaving(false); return; }
      onSave();
    } catch(e) { setError(e.message); }
    setSaving(false);
  };

  return (
    <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
      onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div style={{ backgroundColor:'white', borderRadius:12, width:'100%', maxWidth:440, boxShadow:'0 20px 60px rgba(0,0,0,0.25)', overflow:'hidden' }}>
        <div style={{ padding:'16px 24px', backgroundColor:'#1565C0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ color:'white', fontSize:16, fontWeight:700 }}>{isNew?'➕ Nuevo usuario':'✏️ Editar usuario'}</span>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.2)', border:'none', color:'white', borderRadius:6, width:30, height:30, cursor:'pointer', fontSize:16 }}>×</button>
        </div>
        <div style={{ padding:24, display:'flex', flexDirection:'column', gap:14 }}>
          <div><label style={lbl}>Nombre *</label><input style={inp} value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Juan Pérez" /></div>
          <div><label style={lbl}>Email *</label><input type="email" style={inp} value={form.email} onChange={e=>set('email',e.target.value)} placeholder="juan@empresa.com" /></div>
          <div>
            <label style={lbl}>{isNew?'Contraseña *':'Nueva contraseña (vacío = no cambiar)'}</label>
            <input type="password" style={inp} value={form.password} onChange={e=>set('password',e.target.value)} placeholder="••••••••" />
          </div>
          <div>
            <label style={lbl}>Rol</label>
            <select style={inp} value={form.role} onChange={e=>set('role',e.target.value)}>
              <option value="member">👤 Miembro — solo ve sus reuniones</option>
              <option value="admin">⚙️ Admin — ve todas las reuniones de la empresa</option>
            </select>
          </div>
          {!isNew && (
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <input type="checkbox" id="act" checked={Boolean(form.active)} onChange={e=>set('active',e.target.checked?1:0)} style={{ width:16, height:16 }} />
              <label htmlFor="act" style={{ fontSize:13, cursor:'pointer' }}>Usuario activo</label>
            </div>
          )}
          {error && <div style={{ padding:'8px 12px', backgroundColor:'#fef2f2', border:'1px solid #fecaca', borderRadius:6, fontSize:13, color:'#dc2626' }}>⚠️ {error}</div>}
        </div>
        <div style={{ padding:'14px 24px', borderTop:'1px solid #eee', display:'flex', justifyContent:'flex-end', gap:8, backgroundColor:'#fafafa' }}>
          <button onClick={onClose} style={{ padding:'9px 18px', border:'1px solid #ddd', borderRadius:6, background:'white', fontSize:13, cursor:'pointer' }}>Cancelar</button>
          <button onClick={save} disabled={saving} style={{ padding:'9px 20px', border:'none', borderRadius:6, background:saving?'#ccc':'#1565C0', color:'white', fontSize:13, cursor:saving?'default':'pointer', fontWeight:600 }}>{saving?'⏳...':'✓ Guardar'}</button>
        </div>
      </div>
    </div>
  );
}

export default function UsersAdmin() {
  const { user: me } = useAuth();
  const [users, setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]   = useState(null);
  const [deleting, setDeleting] = useState(null);

  const fetch_ = async () => {
    try { const r=await apiFetch('/admin/users'); if(r.ok) setUsers(await r.json()); setLoading(false); }
    catch { setLoading(false); }
  };
  useEffect(() => { fetch_(); }, []);

  const del = async (id, name) => {
    if(!confirm(`¿Eliminar usuario "${name}"?`)) return;
    setDeleting(id); await apiFetch(`/admin/users/${id}`, {method:'DELETE'}); await fetch_(); setDeleting(null);
  };

  const roleLabel = r => ({ superadmin:'⭐ Superadmin', admin:'⚙️ Admin', member:'👤 Miembro' }[r]||r);
  const roleColor = r => ({ superadmin:'#7c3aed', admin:'#1565C0', member:'#475569' }[r]||'#666');

  if(loading) return <div style={{ padding:40 }}>Cargando...</div>;

  return (
    <div>
      {modal && <Modal user={modal==='new'?null:modal} onSave={()=>{ setModal(null); fetch_(); }} onClose={()=>setModal(null)} />}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20 }}>
        <div>
          <h1 style={{ margin:0 }}>👥 Usuarios del equipo</h1>
          <p style={{ margin:'6px 0 0', fontSize:13, color:'#666' }}>Gestiona quién puede acceder al sistema de actas.</p>
        </div>
        <button onClick={()=>setModal('new')} style={{ padding:'10px 20px', backgroundColor:'#1565C0', color:'white', border:'none', borderRadius:8, fontSize:14, cursor:'pointer', fontWeight:600 }}>
          ➕ Nuevo usuario
        </button>
      </div>

      <div style={{ padding:12, backgroundColor:'#eff6ff', borderRadius:8, marginBottom:20, fontSize:13, border:'1px solid #bfdbfe' }}>
        <strong>💡 Roles:</strong> <strong>Admin</strong> ve todas las reuniones de la empresa y gestiona usuarios/clientes.
        <strong> Miembro</strong> solo ve reuniones donde fue creador o fue invitado al crearlas.
      </div>

      {users.length === 0 ? (
        <div style={{ padding:40, textAlign:'center', backgroundColor:'#f9fafb', borderRadius:10, border:'2px dashed #e5e7eb' }}>
          <p>No hay usuarios aún.</p>
          <button onClick={()=>setModal('new')} style={{ padding:'10px 24px', backgroundColor:'#1565C0', color:'white', border:'none', borderRadius:8, fontSize:14, cursor:'pointer' }}>
            ➕ Crear primer usuario
          </button>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {users.map(u => (
            <div key={u.id} style={{ padding:14, backgroundColor:'white', borderRadius:10, border:'1px solid #e5e7eb', display:'flex', alignItems:'center', gap:14, boxShadow:'0 1px 3px rgba(0,0,0,0.04)' }}>
              <div style={{ width:40, height:40, borderRadius:10, backgroundColor:u.active?'#dbeafe':'#f1f5f9', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>
                {u.active?'👤':'🔒'}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3, flexWrap:'wrap' }}>
                  <span style={{ fontSize:15, fontWeight:700, color:'#111' }}>{u.name}</span>
                  {u.id === me?.id && <span style={{ fontSize:11, backgroundColor:'#f0fdf4', color:'#16a34a', padding:'1px 8px', borderRadius:20, border:'1px solid #bbf7d0', fontWeight:600 }}>Tú</span>}
                  <span style={{ fontSize:12, fontWeight:600, color:roleColor(u.role), backgroundColor:roleColor(u.role)+'15', padding:'2px 9px', borderRadius:20, border:`1px solid ${roleColor(u.role)}33` }}>{roleLabel(u.role)}</span>
                  {!u.active && <span style={{ fontSize:11, backgroundColor:'#fef2f2', color:'#dc2626', padding:'1px 8px', borderRadius:20, border:'1px solid #fecaca' }}>Inactivo</span>}
                </div>
                <div style={{ fontSize:13, color:'#6b7280' }}>📧 {u.email}</div>
              </div>
              <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                <button onClick={()=>setModal(u)} style={{ padding:'7px 12px', backgroundColor:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:6, fontSize:12, cursor:'pointer', color:'#1565C0', fontWeight:600 }}>✏️ Editar</button>
                {u.id !== me?.id && (
                  <button onClick={()=>del(u.id,u.name)} disabled={deleting===u.id}
                    style={{ padding:'7px 12px', backgroundColor:'#fff1f2', border:'1px solid #fecdd3', borderRadius:6, fontSize:12, cursor:deleting===u.id?'default':'pointer', color:'#dc2626', fontWeight:600 }}>
                    {deleting===u.id?'...':'🗑️'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
