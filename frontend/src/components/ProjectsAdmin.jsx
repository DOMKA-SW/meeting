// =============================================================================
// ProjectsAdmin.jsx — Catálogo de proyectos reutilizables
// Permite ver todos los proyectos guardados de la empresa y crear nuevos,
// para que luego aparezcan sugeridos (autocompletar) al iniciar una reunión.
// =============================================================================
import { useState, useEffect } from 'react';
import { apiFetch } from '../utils/api';

function ModalProject({ onSave, onClose }) {
  const [name, setName]       = useState('');
  const [cliente, setCliente] = useState('');
  const [error, setError]     = useState('');
  const [saving, setSaving]   = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return setError('El nombre del proyecto es requerido');
    setSaving(true); setError('');
    try {
      const res = await apiFetch('/admin/projects', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), cliente: cliente.trim() })
      });
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
      <div style={{ backgroundColor:'white', borderRadius:12, width:'100%', maxWidth:440, boxShadow:'0 20px 60px rgba(0,0,0,0.25)', overflow:'hidden' }}>
        <div style={{ padding:'18px 24px', borderBottom:'1px solid #eee', backgroundColor:'#1565C0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ color:'white', fontSize:16, fontWeight:700 }}>➕ Nuevo proyecto</div>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.2)', border:'none', color:'white', borderRadius:6, width:30, height:30, cursor:'pointer', fontSize:16 }}>×</button>
        </div>
        <div style={{ padding:24, display:'flex', flexDirection:'column', gap:14 }}>
          <div>
            <label style={lbl}>Nombre del proyecto <span style={{ color:'#dc2626' }}>*</span></label>
            <input value={name} onChange={e=>setName(e.target.value)} style={inp} placeholder="Ej: Rediseño App Móvil" autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }} />
          </div>
          <div>
            <label style={lbl}>Cliente <span style={{ fontWeight:400, color:'#888' }}>(opcional)</span></label>
            <input value={cliente} onChange={e=>setCliente(e.target.value)} style={inp} placeholder="Ej: Levapan" />
            <p style={{ fontSize:11, color:'#888', marginTop:3 }}>Solo referencial, para ayudarte a identificar el proyecto en la lista.</p>
          </div>
          {error && <div style={{ padding:'8px 12px', backgroundColor:'#fef2f2', border:'1px solid #fecaca', borderRadius:6, fontSize:13, color:'#dc2626' }}>⚠️ {error}</div>}
        </div>
        <div style={{ padding:'14px 24px', borderTop:'1px solid #eee', display:'flex', justifyContent:'flex-end', gap:8, backgroundColor:'#fafafa' }}>
          <button onClick={onClose} style={{ padding:'9px 18px', border:'1px solid #ddd', borderRadius:6, background:'white', fontSize:13, cursor:'pointer' }}>Cancelar</button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding:'9px 20px', border:'none', borderRadius:6, background: saving?'#ccc':'#1565C0', color:'white', fontSize:13, cursor: saving?'default':'pointer', fontWeight:600 }}>
            {saving ? '⏳...' : '✓ Guardar'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ProjectsAdmin() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const fetchProjects = async () => {
    try {
      const r = await apiFetch('/admin/projects');
      if (r.ok) setProjects(await r.json());
      setLoading(false);
    } catch { setLoading(false); }
  };

  useEffect(() => { fetchProjects(); }, []);

  const handleDelete = async (id, name) => {
    if (!confirm(`¿Eliminar proyecto "${name}" del catálogo? Las reuniones que ya lo usan no se ven afectadas.`)) return;
    setDeleting(id);
    await apiFetch(`/admin/projects/${id}`, { method:'DELETE' });
    await fetchProjects();
    setDeleting(null);
  };

  const filtrados = projects.filter(p => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (p.name||'').toLowerCase().includes(q) || (p.cliente||'').toLowerCase().includes(q);
  });

  if (loading) return <div style={{ padding:40 }}>Cargando proyectos...</div>;

  return (
    <div>
      {modalOpen && (
        <ModalProject
          onSave={() => { setModalOpen(false); fetchProjects(); }}
          onClose={() => setModalOpen(false)}
        />
      )}

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20 }}>
        <div>
          <h1 style={{ margin:0 }}>📁 Proyectos</h1>
          <p style={{ margin:'6px 0 0', fontSize:13, color:'#666' }}>
            Catálogo de proyectos de la empresa. Se sugieren automáticamente al crear una reunión.
          </p>
        </div>
        <button onClick={() => setModalOpen(true)}
          style={{ padding:'10px 20px', backgroundColor:'#1565C0', color:'white', border:'none', borderRadius:8, fontSize:14, cursor:'pointer', fontWeight:600 }}>
          ➕ Nuevo proyecto
        </button>
      </div>

      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre o cliente..."
        style={{ width:'100%', padding:'9px 12px', border:'1px solid #dde1e7', borderRadius:6, fontSize:13, boxSizing:'border-box', marginBottom:16, backgroundColor:'white' }} />

      {filtrados.length === 0 ? (
        <div style={{ padding:40, textAlign:'center', backgroundColor:'#f9fafb', borderRadius:10, border:'2px dashed #e5e7eb' }}>
          <div style={{ fontSize:40, marginBottom:12 }}>📁</div>
          <p style={{ fontSize:15, color:'#666', marginBottom:16 }}>
            {projects.length === 0 ? 'No hay proyectos registrados aún.' : 'No hay proyectos con esa búsqueda.'}
          </p>
          {projects.length === 0 && (
            <button onClick={() => setModalOpen(true)}
              style={{ padding:'10px 24px', backgroundColor:'#1565C0', color:'white', border:'none', borderRadius:8, fontSize:14, cursor:'pointer', fontWeight:600 }}>
              ➕ Crear primer proyecto
            </button>
          )}
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {filtrados.map(p => (
            <div key={p.id} style={{ padding:14, backgroundColor:'white', borderRadius:10, border:'1px solid #e5e7eb', display:'flex', alignItems:'center', gap:14, boxShadow:'0 1px 3px rgba(0,0,0,0.04)' }}>
              <div style={{ width:40, height:40, borderRadius:10, backgroundColor:'#eff6ff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>
                📁
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:700, color:'#111' }}>{p.name}</div>
                {p.cliente && <div style={{ fontSize:12, color:'#666', marginTop:2 }}>Cliente: {p.cliente}</div>}
              </div>
              <button onClick={() => handleDelete(p.id, p.name)} disabled={deleting===p.id}
                style={{ padding:'7px 12px', backgroundColor:'#fff1f2', border:'1px solid #fecdd3', borderRadius:6, fontSize:12, cursor: deleting===p.id?'default':'pointer', color:'#dc2626', fontWeight:600, flexShrink:0 }}>
                {deleting===p.id ? '...' : '🗑️'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
