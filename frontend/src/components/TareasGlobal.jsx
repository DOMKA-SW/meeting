// =============================================================================
// TareasGlobal.jsx — Vista general de todas las tareas
// Visible para todos los roles. Cada usuario ve solo las tareas de
// las reuniones a las que tiene acceso (según su rol).
// Filtros: estado, prioridad, tipo, reunión, búsqueda libre.
// =============================================================================
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../utils/api';

const ESTADOS  = { 1:'Sin iniciar', 2:'En progreso', 3:'En revisión', 4:'Finalizada', 5:'Planeación', 7:'Resp. Cliente', 8:'Pend. otros' };
const PRIO     = { 1:'🟢 Baja', 2:'🟡 Media', 3:'🔴 Alta' };
const PRIO_COL = { 1:'#16a34a', 2:'#d97706', 3:'#dc2626' };
const EST_BG   = { 1:'#e2e3e5', 2:'#fff3cd', 3:'#cfe2ff', 4:'#d1e7dd', 5:'#e8d5f5', 7:'#fde8d8', 8:'#f8d7da' };
const EST_COL  = { 1:'#383d41', 2:'#856404', 3:'#084298', 4:'#0a3622', 5:'#6f42c1', 7:'#842029', 8:'#721c24' };

export default function TareasGlobal() {
  const [tareas, setTareas]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [filtroEstado, setFiltroEstado]   = useState('');
  const [filtroPrio, setFiltroPrio]       = useState('');
  const [filtroTipo, setFiltroTipo]       = useState('');
  const [filtroReunion, setFiltroReunion] = useState('');
  const [filtroDesde, setFiltroDesde]     = useState('');
  const [filtroHasta, setFiltroHasta]     = useState('');
  const [editando, setEditando]   = useState(null); // { idx, field, value }
  const [saving, setSaving]       = useState(false);

  const fetchTareas = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filtroDesde) params.set('desde', filtroDesde);
      if (filtroHasta) params.set('hasta', filtroHasta);
      const r = await apiFetch(`/tareas${params.toString() ? '?' + params.toString() : ''}`);
      if (r.ok) setTareas(await r.json());
      setLoading(false);
    } catch { setLoading(false); }
  }, []);

  useEffect(() => { fetchTareas(); }, [fetchTareas, filtroDesde, filtroHasta]);

  // Lista única de reuniones para el filtro
  const reuniones = [...new Map(tareas.map(t => [t.meeting_uuid, { id: t.meeting_uuid, label: `${t.cliente || '—'} · ${t.proyecto || '—'}` }])).values()];

  // Aplicar filtros
  const filtradas = tareas.filter(t => {
    if (filtroEstado  && String(t.estado_tarea) !== filtroEstado) return false;
    if (filtroPrio    && String(t.prioridad)    !== filtroPrio)   return false;
    if (filtroTipo    && t.tipo_tarea           !== filtroTipo)   return false;
    if (filtroReunion && t.meeting_uuid         !== filtroReunion) return false;
    if (filtroDesde || filtroHasta) {
      const fechaTarea = t.fecha_compromiso || t.started_at;
      if (!fechaTarea) return false;
      const f = fechaTarea.slice(0, 10); // normaliza a 'YYYY-MM-DD'
      if (filtroDesde && f < filtroDesde) return false;
      if (filtroHasta && f > filtroHasta) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      return (t.asunto||'').toLowerCase().includes(q) ||
             (t.descripcion||'').toLowerCase().includes(q) ||
             (t.responsable||'').toLowerCase().includes(q) ||
             (t.cliente||'').toLowerCase().includes(q);
    }
    return true;
  });

  // Cambiar estado de una tarea inline
  const cambiarEstado = async (t, nuevoEstado) => {
    setSaving(true);
    // Obtener todas las tareas de esa reunión, actualizar solo esta
    const r = await apiFetch(`/meetings/${t.meeting_uuid}/tareas`);
    if (!r.ok) { setSaving(false); return; }
    const todas = await r.json();
    const actualizadas = todas.map(item =>
      item.tarea_id === t.tarea_id ? { ...item, estado_tarea: nuevoEstado } : item
    );
    await apiFetch(`/meetings/${t.meeting_uuid}/tareas`, { method: 'PUT', body: JSON.stringify(actualizadas) });
    setTareas(prev => prev.map(item =>
      item.tarea_id === t.tarea_id && item.meeting_uuid === t.meeting_uuid
        ? { ...item, estado_tarea: nuevoEstado } : item
    ));
    setSaving(false);
  };

  // Descargar CSV (separado por ";", se abre directo en Excel) con filtros actuales
  const descargarExcel = async () => {
    const token = localStorage.getItem('auth_token');
    const params = new URLSearchParams();
    if (filtroDesde) params.set('desde', filtroDesde);
    if (filtroHasta) params.set('hasta', filtroHasta);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/tareas/excel${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { alert('Error al descargar'); return; }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `Tareas_${new Date().toISOString().split('T')[0]}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const limpiarFiltros = () => { setSearch(''); setFiltroEstado(''); setFiltroPrio(''); setFiltroTipo(''); setFiltroReunion(''); setFiltroDesde(''); setFiltroHasta(''); };

  const hayFiltros = search || filtroEstado || filtroPrio || filtroTipo || filtroReunion || filtroDesde || filtroHasta;

  if (loading) return <div style={{ padding: 40 }}>Cargando tareas...</div>;

  const selStyle = { padding: '7px 10px', border: '1px solid #dde1e7', borderRadius: 6, fontSize: 13, backgroundColor: 'white', cursor: 'pointer' };

  return (
    <div>
      {/* Cabecera */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>Tareas</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#666' }}>
            {filtradas.length} de {tareas.length} tareas
            {hayFiltros && <button onClick={limpiarFiltros} style={{ marginLeft: 10, fontSize: 12, color: '#1565C0', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Limpiar filtros</button>}
          </p>
        </div>
        <button onClick={descargarExcel}
          style={{ padding: '9px 16px', backgroundColor: '#2E7D32', color: 'white', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          Descargar Excel
        </button>
      </div>

      {/* Filtros */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, padding: '14px 16px', backgroundColor: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por asunto, responsable, cliente..."
          style={{ ...selStyle, minWidth: 240, flex: 1 }} />
        <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)} style={selStyle}>
          <option value=''>Todos los estados</option>
          {Object.entries(ESTADOS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={filtroPrio} onChange={e => setFiltroPrio(e.target.value)} style={selStyle}>
          <option value=''>Toda prioridad</option>
          <option value='3'>Alta</option>
          <option value='2'>Media</option>
          <option value='1'>Baja</option>
        </select>
        <select value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)} style={selStyle}>
          <option value=''>Interno y externo</option>
          <option value='i'>Interna</option>
          <option value='e'>Externa</option>
        </select>
        <select value={filtroReunion} onChange={e => setFiltroReunion(e.target.value)} style={{ ...selStyle, maxWidth: 280 }}>
          <option value=''>Todas las reuniones</option>
          {reuniones.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <label style={{ fontSize:12, color:'#666', whiteSpace:'nowrap' }}>Desde:</label>
          <input type='date' value={filtroDesde} onChange={e=>setFiltroDesde(e.target.value)} style={selStyle} />
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <label style={{ fontSize:12, color:'#666', whiteSpace:'nowrap' }}>Hasta:</label>
          <input type='date' value={filtroHasta} onChange={e=>setFiltroHasta(e.target.value)} style={selStyle} />
        </div>
      </div>

      {/* Tabla */}
      {filtradas.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#888', backgroundColor: '#f9fafb', borderRadius: 8, border: '1px dashed #ddd' }}>
          {hayFiltros ? 'No hay tareas con los filtros seleccionados.' : 'No hay tareas registradas.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ backgroundColor: '#1E3A5F', color: 'white' }}>
                {['Prioridad', 'Asunto / Descripción', 'Responsable', 'Reunión', 'Estado', 'Fecha', 'Acciones'].map((h, i) => (
                  <th key={i} style={{ padding: '10px 10px', textAlign: 'left', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtradas.map((t, idx) => (
                <tr key={`${t.meeting_uuid}_${t.tarea_id}_${idx}`}
                  style={{ borderBottom: '1px solid #eee', backgroundColor: idx % 2 === 0 ? 'white' : '#fafbfc' }}>

                  {/* Prioridad */}
                  <td style={{ padding: '10px', textAlign: 'center', fontSize: 16 }}>
                    <span title={PRIO[t.prioridad]||'Media'}>{(PRIO[t.prioridad]||'🟡 Media').split(' ')[0]}</span>
                  </td>

                  {/* Asunto + descripción */}
                  <td style={{ padding: '10px', maxWidth: 260 }}>
                    {t.asunto && <div style={{ fontWeight: 600, color: '#1e293b', marginBottom: 2 }}>{t.asunto}</div>}
                    <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.4 }}>
                      {(t.descripcion||'').length > 80 ? t.descripcion.slice(0, 80) + '…' : t.descripcion || <em style={{ color: '#bbb' }}>Sin descripción</em>}
                    </div>
                    {t.tipo_tarea === 'e' && <span style={{ fontSize: 10, color: '#7c3aed', backgroundColor: '#f5f3ff', padding: '1px 6px', borderRadius: 10, marginTop: 3, display: 'inline-block' }}>Externa</span>}
                    {t.requerimiento_id && <span style={{ fontSize: 10, color: '#0369a1', backgroundColor: '#f0f9ff', padding: '1px 6px', borderRadius: 10, marginTop: 3, marginLeft: 4, display: 'inline-block' }}>REQ: {t.requerimiento_id}</span>}
                  </td>

                  {/* Responsable */}
                  <td style={{ padding: '10px', fontSize: 12, color: '#475569', whiteSpace: 'nowrap' }}>
                    {t.responsable || '—'}
                    {t.asignado_a && t.asignado_a !== t.responsable && (
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>→ {t.asignado_a}</div>
                    )}
                  </td>

                  {/* Reunión */}
                  <td style={{ padding: '10px', fontSize: 12 }}>
                    <Link to={`/meetings/${t.meeting_uuid}`} style={{ color: '#1565C0', textDecoration: 'none', fontWeight: 600 }}>
                      {t.cliente || '—'}
                    </Link>
                    {t.proyecto && <div style={{ color: '#64748b', fontSize: 11 }}>{t.proyecto}</div>}
                    {t.started_at && <div style={{ color: '#94a3b8', fontSize: 11 }}>{new Date(t.started_at).toLocaleDateString('es-ES')}</div>}
                  </td>

                  {/* Estado — editable inline */}
                  <td style={{ padding: '10px' }}>
                    <select
                      value={t.estado_tarea || 1}
                      onChange={e => cambiarEstado(t, Number(e.target.value))}
                      disabled={saving}
                      style={{ padding: '4px 8px', borderRadius: 12, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        backgroundColor: EST_BG[t.estado_tarea] || '#e2e3e5',
                        color: EST_COL[t.estado_tarea] || '#383d41' }}
                    >
                      {Object.entries(ESTADOS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>

                  {/* Fecha */}
                  <td style={{ padding: '10px', fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>
                    {t.fecha_compromiso || '—'}
                    {t.date_end && t.date_end !== t.fecha_compromiso && (
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>Fin: {t.date_end}</div>
                    )}
                  </td>

                  {/* Acciones */}
                  <td style={{ padding: '10px' }}>
                    <Link to={`/meetings/${t.meeting_uuid}`}
                      style={{ padding: '6px 12px', backgroundColor: '#EFF6FF', color: '#1565C0', textDecoration: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, border: '1px solid #BFDBFE', whiteSpace: 'nowrap' }}>
                      Ver reunión
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
