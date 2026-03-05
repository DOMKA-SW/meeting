import { useState, useEffect } from 'react';
import { apiFetch } from '../utils/api';

const API_URL = import.meta.env.VITE_API_BASE_URL;

function Badge({ children, color = '#475569' }) {
  return (
    <span style={{ padding:'2px 10px', borderRadius:20, backgroundColor:color+'22', color, fontSize:12, fontWeight:600, border:`1px solid ${color}44` }}>
      {children}
    </span>
  );
}

function ModalClient({ client, onSave, onClose }) {
  const isNew = !client;
  const [form, setForm] = useState({ name: client?.name||'', username: client?.username||'', password: '', active: client?.active??1 });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.name.trim()) return setError('El nombre es requerido');
    if (!form.username.trim()) return setError('El usuario es requerido');
    if (isNew && !form.password.trim()) return setError('La contraseña es requerida para cliente nuevo');
    setSaving(true); setError('');
    try {
      const body = { name: form.name.trim(), username: form.username.trim().toLowerCase(), active: form.active };
      if (form.password.trim()) body.password = form.password.trim();
      const res = isNew
        ? await apiFetch('/admin/clients', { method:'POST', body:JSON.stringify(body) })
        : await apiFetch(`/admin/clients/${client.id}`, { method:'PUT', body:JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Error al guardar'); setSaving(false); return; }
      onSave();
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const inp = { width:'100%', padding:'9px 12px', border:'1px solid #dde1e7', borderRadius:6, fontSize:14, boxSizing:'border-box', outline:'none' };
  const lbl = { display:'block', marginBottom:5, fontSize:13, fontWeight:600, color:'#444' };

  return (
    <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
      onClick={e => { if (e.target===e.currentTarget) onClose(); }}>
      <div style={{ backgroundColor:'white', borderRadius:12, width:'100%', maxWidth:460, boxShadow:'0 20px 60px rgba(0,0,0,0.25)', overflow:'hidden' }}>
        <div style={{ padding:'18px 24px', borderBottom:'1px solid #eee', backgroundColor:'#1565C0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ color:'white', fontSize:16, fontWeight:700 }}>{isNew ? '➕ Nuevo cliente' : `✏️ Editar: ${client.name}`}</div>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.2)', border:'none', color:'white', borderRadius:6, width:30, height:30, cursor:'pointer', fontSize:16 }}>×</button>
        </div>
        <div style={{ padding:24, display:'flex', flexDirection:'column', gap:14 }}>
          <div>
            <label style={lbl}>Nombre del cliente <span style={{ color:'#dc2626' }}>*</span></label>
            <input value={form.name} onChange={e=>set('name',e.target.value)} style={inp} placeholder="Ej: LEVAPAN" />
            <p style={{ fontSize:11, color:'#888', marginTop:3 }}>Debe coincidir EXACTAMENTE con el campo "Cliente" en las reuniones (no distingue mayúsculas).</p>
          </div>
          <div>
            <label style={lbl}>Usuario de acceso <span style={{ color:'#dc2626' }}>*</span></label>
            <input value={form.username} onChange={e=>set('username',e.target.value.toLowerCase())} style={inp} placeholder="Ej: levapan" />
            <p style={{ fontSize:11, color:'#888', marginTop:3 }}>Se usa para ingresar al portal de actas. Solo letras, números y guiones.</p>
          </div>
          <div>
            <label style={lbl}>
              Contraseña {isNew ? <span style={{ color:'#dc2626' }}>*</span> : <span style={{ fontWeight:400, color:'#888' }}>(dejar vacío para no cambiar)</span>}
            </label>
            <input type="password" value={form.password} onChange={e=>set('password',e.target.value)} style={inp} placeholder={isNew ? 'Contraseña segura' : '••••••••'} />
          </div>
          {!isNew && (
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <input type="checkbox" id="active" checked={Boolean(form.active)} onChange={e=>set('active',e.target.checked?1:0)} style={{ width:16, height:16 }} />
              <label htmlFor="active" style={{ fontSize:13, cursor:'pointer' }}>Cliente activo (puede iniciar sesión)</label>
            </div>
          )}
          {error && <div style={{ padding:'8px 12px', backgroundColor:'#fef2f2', border:'1px solid #fecaca', borderRadius:6, fontSize:13, color:'#dc2626' }}>⚠️ {error}</div>}
        </div>
        <div style={{ padding:'14px 24px', borderTop:'1px solid #eee', display:'flex', justifyContent:'space-between', alignItems:'center', backgroundColor:'#fafafa' }}>
          <div>
            {!isNew && (
              <div style={{ fontSize:12, color:'#888' }}>
                Portal: <a href="/portal" target="_blank" style={{ color:'#1565C0' }}>
                  {window.location.origin}/portal
                </a> · usuario: <strong>{form.username}</strong>
              </div>
            )}
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={onClose} style={{ padding:'9px 18px', border:'1px solid #ddd', borderRadius:6, background:'white', fontSize:13, cursor:'pointer' }}>Cancelar</button>
            <button onClick={handleSave} disabled={saving}
              style={{ padding:'9px 20px', border:'none', borderRadius:6, background: saving?'#ccc':'#1565C0', color:'white', fontSize:13, cursor: saving?'default':'pointer', fontWeight:600 }}>
              {saving ? '⏳...' : '✓ Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ClientsAdmin() {
  const [clients, setClients]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [modal, setModal]         = useState(null); // null | 'new' | client_obj
  const [deleting, setDeleting]   = useState(null);
  const [copied, setCopied]       = useState('');

  const portalUrl = `${window.location.origin}/portal`;

  const fetchClients = async () => {
    try {
      const r = await apiFetch('/admin/clients');
      if (r.ok) setClients(await r.json());
      setLoading(false);
    } catch { setLoading(false); }
  };

  useEffect(() => { fetchClients(); }, []);

  const handleDelete = async (id, name) => {
    if (!confirm(`¿Eliminar cliente "${name}"? Solo se elimina el acceso al portal, no las actas.`)) return;
    setDeleting(id);
    await apiFetch(`/admin/clients/${id}`, { method:'DELETE' });
    await fetchClients();
    setDeleting(null);
  };

  const copyText = (text, key) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(''), 2000);
    });
  };

  if (loading) return <div style={{ padding:40 }}>Cargando clientes...</div>;

  return (
    <div>
      {modal && (
        <ModalClient
          client={modal === 'new' ? null : modal}
          onSave={() => { setModal(null); fetchClients(); }}
          onClose={() => setModal(null)}
        />
      )}

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20 }}>
        <div>
          <h1 style={{ margin:0 }}>👥 Portal de Clientes</h1>
          <p style={{ margin:'6px 0 0', fontSize:13, color:'#666' }}>
            Gestiona qué clientes pueden ver sus actas en el portal público.
          </p>
        </div>
        <button onClick={() => setModal('new')}
          style={{ padding:'10px 20px', backgroundColor:'#1565C0', color:'white', border:'none', borderRadius:8, fontSize:14, cursor:'pointer', fontWeight:600 }}>
          ➕ Nuevo cliente
        </button>
      </div>

      {/* Info del portal */}
      <div style={{ padding:16, backgroundColor:'#eff6ff', borderRadius:10, border:'1px solid #bfdbfe', marginBottom:24 }}>
        <div style={{ fontSize:14, fontWeight:700, color:'#1e40af', marginBottom:8 }}>🌐 Link del portal de clientes</div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <code style={{ flex:1, padding:'8px 12px', backgroundColor:'white', borderRadius:6, border:'1px solid #bfdbfe', fontSize:13, color:'#1e40af' }}>
            {portalUrl}
          </code>
          <button onClick={() => copyText(portalUrl, 'url')}
            style={{ padding:'8px 14px', backgroundColor: copied==='url'?'#16a34a':'#1565C0', color:'white', border:'none', borderRadius:6, fontSize:13, cursor:'pointer', fontWeight:600, flexShrink:0 }}>
            {copied==='url' ? '✓ Copiado' : '📋 Copiar'}
          </button>
        </div>
        <p style={{ fontSize:12, color:'#3b82f6', marginTop:8, marginBottom:0 }}>
          Comparte esta URL con tus clientes. Cada uno ingresa con su usuario y contraseña asignados aquí.
          Solo verán las actas donde el campo "Cliente" en la reunión coincida con el nombre registrado.
        </p>
      </div>

      {clients.length === 0 ? (
        <div style={{ padding:40, textAlign:'center', backgroundColor:'#f9fafb', borderRadius:10, border:'2px dashed #e5e7eb' }}>
          <div style={{ fontSize:40, marginBottom:12 }}>👥</div>
          <p style={{ fontSize:15, color:'#666', marginBottom:16 }}>No hay clientes registrados aún.</p>
          <button onClick={() => setModal('new')}
            style={{ padding:'10px 24px', backgroundColor:'#1565C0', color:'white', border:'none', borderRadius:8, fontSize:14, cursor:'pointer', fontWeight:600 }}>
            ➕ Crear primer cliente
          </button>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {clients.map(client => (
            <div key={client.id} style={{ padding:16, backgroundColor:'white', borderRadius:10, border:'1px solid #e5e7eb', display:'flex', alignItems:'center', gap:16, boxShadow:'0 1px 3px rgba(0,0,0,0.04)' }}>
              {/* Avatar */}
              <div style={{ width:44, height:44, borderRadius:10, backgroundColor: client.active ? '#dbeafe' : '#f1f5f9', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, flexShrink:0 }}>
                {client.active ? '🏢' : '🔒'}
              </div>

              {/* Info */}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap' }}>
                  <span style={{ fontSize:15, fontWeight:700, color:'#111' }}>{client.name}</span>
                  <Badge color={client.active ? '#16a34a' : '#dc2626'}>{client.active ? 'Activo' : 'Inactivo'}</Badge>
                  {client.meeting_count > 0 && (
                    <Badge color='#1565C0'>{client.meeting_count} reunión{client.meeting_count>1?'es':''}</Badge>
                  )}
                </div>
                <div style={{ fontSize:13, color:'#555', display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                  <span>👤 Usuario: <strong>{client.username}</strong></span>
                  <span style={{ color:'#999' }}>·</span>
                  <span style={{ color:'#888', fontSize:12 }}>
                    Creado {new Date(client.created_at).toLocaleDateString('es-ES')}
                  </span>
                </div>
              </div>

              {/* Credenciales rápidas */}
              <div style={{ flexShrink:0, display:'flex', gap:6 }}>
                <button
                  onClick={() => copyText(`URL: ${portalUrl}\nUsuario: ${client.username}`, `creds-${client.id}`)}
                  title="Copiar credenciales para enviar al cliente"
                  style={{ padding:'7px 12px', backgroundColor:'#f1f5f9', border:'1px solid #e2e8f0', borderRadius:6, fontSize:12, cursor:'pointer', color:'#475569', fontWeight:600 }}>
                  {copied===`creds-${client.id}` ? '✓ Copiado' : '📋 Creds'}
                </button>
                <button onClick={() => setModal(client)}
                  style={{ padding:'7px 12px', backgroundColor:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:6, fontSize:12, cursor:'pointer', color:'#1565C0', fontWeight:600 }}>
                  ✏️ Editar
                </button>
                <button onClick={() => handleDelete(client.id, client.name)} disabled={deleting===client.id}
                  style={{ padding:'7px 12px', backgroundColor:'#fff1f2', border:'1px solid #fecdd3', borderRadius:6, fontSize:12, cursor: deleting===client.id?'default':'pointer', color:'#dc2626', fontWeight:600 }}>
                  {deleting===client.id ? '...' : '🗑️'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
