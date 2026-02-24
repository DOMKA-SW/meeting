import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const API_URL = import.meta.env.VITE_API_BASE_URL;

function safeJsonParseArray(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

// ─── Colores de estado ────────────────────────────────────────────────────────
const estadoColors = {
  completada:    { bg: '#d4edda', color: '#155724', border: '#c3e6cb' },
  'en progreso': { bg: '#fff3cd', color: '#856404', border: '#ffeeba' },
  cancelada:     { bg: '#f8d7da', color: '#721c24', border: '#f5c6cb' },
  pendiente:     { bg: '#e2e3e5', color: '#383d41', border: '#d6d8db' },
};
const estadoBadge = (estado) => {
  const c = estadoColors[estado] || estadoColors.pendiente;
  return { padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
    backgroundColor: c.bg, color: c.color, border: `1px solid ${c.border}`, display: 'inline-block' };
};

// ─── Generador de PDF ─────────────────────────────────────────────────────────
function generarPDF(acta, meeting) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 20;
  const contentW = pageW - margin * 2;
  let y = 20;

  const colors = { black:[0,0,0], darkGray:[80,80,80], gray:[130,130,130], lightGray:[245,245,245], border:[180,180,180] };
  const checkPage = (n=10) => { if (y+n > pageH-20) { doc.addPage(); y=20; } };
  const sectionTitle = (text) => {
    checkPage(14); doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(...colors.black);
    doc.text(text.toUpperCase(), margin, y); y+=2; doc.setDrawColor(...colors.black);
    doc.line(margin, y, margin+contentW, y); y+=8;
  };
  const textBlock = (text) => {
    if (!text) return; doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...colors.darkGray);
    doc.splitTextToSize(String(text), contentW).forEach(l => { checkPage(6); doc.text(l, margin, y); y+=5; }); y+=4;
  };

  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...colors.black);
  doc.text('ACTA DE REUNIÓN', pageW/2, y, {align:'center'}); y+=10;
  doc.setFontSize(9); doc.setFont('helvetica','normal');
  doc.text(`Generado el ${new Date().toLocaleDateString('es-ES')}`, pageW/2, y, {align:'center'}); y+=12;

  sectionTitle('Identificación');
  const id = acta.identificacion || {};
  const startedDate = meeting?.started_at ? new Date(meeting.started_at) : null;
  const endedDate   = meeting?.ended_at   ? new Date(meeting.ended_at)   : null;
  [['Cliente',id.cliente],['Proyecto',id.proyecto],['Responsable',id.responsable],
   ['Fecha', id.fecha||(startedDate?startedDate.toISOString().split('T')[0]:'')],
   ['Hora inicio', id.hora_inicio||(startedDate?startedDate.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}):'')],
   ['Hora fin',    id.hora_fin   ||(endedDate  ?endedDate.toLocaleTimeString(  'es-ES',{hour:'2-digit',minute:'2-digit'}):'')],
   ['Participantes', Array.isArray(id.participantes)?id.participantes.join(', '):id.participantes]
  ].forEach(([label,value]) => {
    checkPage(6); doc.setFont('helvetica','bold'); doc.text(label+':', margin, y);
    doc.setFont('helvetica','normal'); doc.text(String(value||'—'), margin+40, y); y+=6;
  }); y+=6;

  const tableOpts = (head, body) => ({
    margin:{left:margin,right:margin}, head, body,
    styles:{fontSize:8.5,cellPadding:3,textColor:colors.black,lineColor:colors.border,lineWidth:0.1},
    headStyles:{fillColor:colors.lightGray,textColor:colors.black,fontStyle:'bold'}
  });

  sectionTitle('Tareas Anteriores');
  const tareasAnt = acta.tareas_anteriores||[];
  if (!tareasAnt.length) { doc.setFontSize(9); doc.setTextColor(...colors.gray); doc.text('No hay tareas anteriores registradas.', margin, y); y+=8; }
  else { autoTable(doc,{startY:y,...tableOpts([['ID','Descripción','Responsable','Estado','Proyecto']], tareasAnt.map((t,i)=>[t.id||i+1,t.descripcion||'',t.responsable||'',t.estado||'',t.proyecto||id.proyecto||'']))}); y=doc.lastAutoTable.finalY+8; }

  sectionTitle('Tareas Nuevas');
  const tareasNuevas = acta.tareas_nuevas||[];
  if (!tareasNuevas.length) { doc.setFontSize(9); doc.setTextColor(...colors.gray); doc.text('No hay tareas nuevas.', margin, y); y+=8; }
  else { autoTable(doc,{startY:y,...tableOpts([['ID','Descripción','Responsable','Fecha fin','Proyecto']], tareasNuevas.map((t,i)=>[t.id||`T-${i+1}`,t.descripcion||'',t.responsable||'',t.fecha_compromiso||'',t.proyecto||id.proyecto||'']))}); y=doc.lastAutoTable.finalY+8; }

  sectionTitle('Resumen de la Reunión'); textBlock(acta.resumen_reunion);
  if (acta.observaciones_generales) { sectionTitle('Observaciones Generales'); textBlock(acta.observaciones_generales); }

  for (let i=1; i<=doc.internal.getNumberOfPages(); i++) {
    doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(...colors.gray);
    doc.text(`Página ${i} de ${doc.internal.getNumberOfPages()}`, pageW-margin, pageH-10, {align:'right'});
    doc.text('Documento generado automáticamente', margin, pageH-10);
  }
  const cf = id.cliente?id.cliente.replace(/[^a-z0-9]/gi,'_'):'acta';
  const ff = id.fecha?id.fecha.replace(/-/g,''):'sin_fecha';
  doc.save(`Acta_${cf}_${ff}.pdf`);
}

// ─── Sincronización bidireccional ─────────────────────────────────────────────
// Tareas backend → JSON acta  (match por tarea_id === t.id)
function syncTareasToActa(actaDraft, tareasDraft) {
  if (!actaDraft) return actaDraft;
  const mapT = t => {
    const m = tareasDraft.find(td => td.tarea_id && td.tarea_id === t.id);
    return m ? { ...t, descripcion:m.descripcion??t.descripcion, responsable:m.responsable??t.responsable, estado:m.estado??t.estado, fecha_compromiso:m.fecha_compromiso??t.fecha_compromiso } : t;
  };
  return { ...actaDraft, tareas_nuevas:(actaDraft.tareas_nuevas||[]).map(mapT), tareas_anteriores:(actaDraft.tareas_anteriores||[]).map(mapT) };
}
// JSON acta → tareas backend  (match por t.id === tarea_id)
function syncActaToTareas(tareasDraft, actaDraft) {
  if (!actaDraft) return tareasDraft;
  const todas = [...(actaDraft.tareas_nuevas||[]),...(actaDraft.tareas_anteriores||[])];
  return tareasDraft.map(t => {
    const m = todas.find(ta => ta.id && ta.id === t.tarea_id);
    return m ? { ...t, descripcion:m.descripcion??t.descripcion, responsable:m.responsable??t.responsable, estado:m.estado??t.estado, fecha_compromiso:m.fecha_compromiso??t.fecha_compromiso } : t;
  });
}

// ─── Modal de edición de tarea ────────────────────────────────────────────────
function ModalEditarTarea({ tarea, onSave, onClose, mostrarFecha = true }) {
  const [form, setForm] = useState({ ...tarea });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const labelStyle = { display: 'block', marginBottom: 4, fontSize: 12, fontWeight: 600, color: '#555' };
  const inputStyle = {
    width: '100%', padding: '9px 12px', border: '1px solid #dde1e7', borderRadius: 6,
    fontSize: 14, boxSizing: 'border-box', outline: 'none', transition: 'border-color .15s',
    backgroundColor: '#fff'
  };

  return (
    <div style={{
      position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.45)', zIndex:1000,
      display:'flex', alignItems:'center', justifyContent:'center', padding: 16
    }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        backgroundColor:'white', borderRadius:12, width:'100%', maxWidth:520,
        boxShadow:'0 20px 60px rgba(0,0,0,0.25)', overflow:'hidden'
      }}>
        {/* Header */}
        <div style={{ padding:'18px 24px', borderBottom:'1px solid #eee', display:'flex', justifyContent:'space-between', alignItems:'center', backgroundColor:'#1565C0' }}>
          <div>
            <div style={{ fontSize:11, color:'rgba(255,255,255,0.7)', fontWeight:500, marginBottom:2 }}>Editando tarea</div>
            <div style={{ fontSize:15, fontWeight:700, color:'white' }}>{form.id || form.tarea_id || 'Sin ID'}</div>
          </div>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', borderRadius:6, color:'white', fontSize:18, width:32, height:32, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: 24, display:'flex', flexDirection:'column', gap: 16 }}>
          {/* ID — solo si viene del acta */}
          {tarea.id !== undefined && (
            <div>
              <label style={labelStyle}>ID de tarea</label>
              <input value={form.id||''} onChange={e => set('id', e.target.value)} style={inputStyle} placeholder="Ej: T-001" />
            </div>
          )}

          {/* Descripción */}
          <div>
            <label style={labelStyle}>Descripción</label>
            <textarea
              value={form.descripcion||''}
              onChange={e => set('descripcion', e.target.value)}
              rows={4}
              style={{ ...inputStyle, resize:'vertical', lineHeight:1.5 }}
              placeholder="Describe la tarea..."
            />
          </div>

          {/* Responsable + Estado en fila */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <label style={labelStyle}>Responsable</label>
              <input value={form.responsable||''} onChange={e => set('responsable', e.target.value)} style={inputStyle} placeholder="Nombre" />
            </div>
            <div>
              <label style={labelStyle}>Estado</label>
              <select value={form.estado||'pendiente'} onChange={e => set('estado', e.target.value)} style={{ ...inputStyle, cursor:'pointer' }}>
                {['pendiente','en progreso','completada','cancelada'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {/* Fecha */}
          {mostrarFecha && (
            <div>
              <label style={labelStyle}>Fecha compromiso</label>
              <input type="date" value={form.fecha_compromiso||''} onChange={e => set('fecha_compromiso', e.target.value)} style={inputStyle} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding:'16px 24px', borderTop:'1px solid #eee', display:'flex', justifyContent:'flex-end', gap:10, backgroundColor:'#fafafa' }}>
          <button onClick={onClose} style={{ padding:'9px 20px', border:'1px solid #ddd', borderRadius:6, background:'white', fontSize:13, cursor:'pointer', fontWeight:500, color:'#555' }}>
            Cancelar
          </button>
          <button onClick={() => { onSave(form); onClose(); }} style={{ padding:'9px 22px', border:'none', borderRadius:6, background:'#1565C0', color:'white', fontSize:13, cursor:'pointer', fontWeight:600 }}>
            ✓ Aplicar cambios
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Componente principal ──────────────────────────────────────────────────────
function MeetingDetail() {
  const { id } = useParams();
  const [meeting, setMeeting] = useState(null);
  const [transcription, setTranscription] = useState([]);
  const [acta, setActa] = useState(null);
  const [actaDraft, setActaDraft] = useState(null);
  const [editingActa, setEditingActa] = useState(false);
  const [savingActa, setSavingActa] = useState(false);
  const [actaDirty, setActaDirty] = useState(false);
  const [tareas, setTareas] = useState([]);
  const [tareasDraft, setTareasDraft] = useState([]);
  const [savingTareas, setSavingTareas] = useState(false);
  const [tareasDirty, setTareasDirty] = useState(false);
  const [activeTab, setActiveTab] = useState('transcription');
  const [loading, setLoading] = useState(true);
  // Modal de edición de tarea
  const [modal, setModal] = useState(null); // { origen:'acta'|'tareas', tipo?:'tareas_nuevas'|'tareas_anteriores', idx, tarea }

  const isEditingAny = editingActa || modal !== null;

  useEffect(() => {
    fetchMeetingData();
    const isCompleted = meeting?.status === 'completed';
    if (!isEditingAny && !isCompleted) {
      const interval = setInterval(fetchMeetingData, 5000);
      return () => clearInterval(interval);
    }
  }, [id, isEditingAny, meeting?.status]);

  const fetchMeetingData = useCallback(async () => {
    if (isEditingAny) return;
    try {
      const [meetingRes, transcriptionRes, actaRes, tareasRes] = await Promise.all([
        fetch(`${API_URL}/meetings/${id}`),
        fetch(`${API_URL}/meetings/${id}/transcription`),
        fetch(`${API_URL}/meetings/${id}/acta`).catch(() => null),
        fetch(`${API_URL}/meetings/${id}/tareas`)
      ]);
      if (meetingRes.ok) setMeeting(await meetingRes.json());
      if (transcriptionRes.ok) setTranscription(await transcriptionRes.json());
      if (actaRes && actaRes.ok) {
        const actaData = await actaRes.json();
        const actaObj = actaData?.acta || actaData;
        setActa(actaObj);
        if (!actaDirty && !editingActa) setActaDraft(actaObj);
      }
      if (tareasRes.ok) {
        const tareasData = await tareasRes.json();
        setTareas(tareasData);
        if (!tareasDirty) setTareasDraft(tareasData.map(t => ({ ...t })));
      }
      setLoading(false);
    } catch (e) { console.error(e); setLoading(false); }
  }, [id, isEditingAny, actaDirty, tareasDirty, editingActa]);

  // ── Guardar acta + sincronizar tareas al backend ───────────────────────────
  const saveActa = async () => {
    if (!actaDraft) return;
    setSavingActa(true);
    try {
      // 1. Guardar acta
      const resActa = await fetch(`${API_URL}/meetings/${id}/acta`, {
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(actaDraft)
      });
      if (!resActa.ok) { alert(`Error al guardar acta (${resActa.status})`); setSavingActa(false); return; }

      // 2. Sincronizar cambios del acta → tareas y persistir en backend
      const tareasSync = syncActaToTareas(tareasDraft, actaDraft);
      const payload = tareasSync.map(t => ({
        tarea_id: t.tarea_id||'', tipo: t.tipo||'nueva',
        descripcion: t.descripcion||'', responsable: t.responsable||'',
        estado: t.estado||'pendiente', fecha_compromiso: t.fecha_compromiso||''
      }));
      await fetch(`${API_URL}/meetings/${id}/tareas`, {
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
      });

      setActa(actaDraft);
      setActaDirty(false);
      setEditingActa(false);
      setTareasDraft(tareasSync);
      setTareas(tareasSync);
      setTareasDirty(false);
      alert('Acta guardada y tareas sincronizadas correctamente');
    } catch (e) { alert('Error: ' + e.message); }
    setSavingActa(false);
  };

  // ── Guardar tareas + sincronizar acta al backend ───────────────────────────
  const saveTareas = async () => {
    setSavingTareas(true);
    try {
      // 1. Guardar tareas
      const payload = tareasDraft.map(t => ({
        tarea_id: t.tarea_id||'', tipo: t.tipo||'nueva',
        descripcion: t.descripcion||'', responsable: t.responsable||'',
        estado: t.estado||'pendiente', fecha_compromiso: t.fecha_compromiso||''
      }));
      const resTareas = await fetch(`${API_URL}/meetings/${id}/tareas`, {
        method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)
      });
      if (!resTareas.ok) { alert(`Error al guardar tareas (${resTareas.status})`); setSavingTareas(false); return; }

      // 2. Sincronizar cambios de tareas → acta y persistir en backend
      if (actaDraft) {
        const actaSync = syncTareasToActa(actaDraft, tareasDraft);
        await fetch(`${API_URL}/meetings/${id}/acta`, {
          method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(actaSync)
        });
        setActaDraft(actaSync);
        setActa(actaSync);
        setActaDirty(false);
      }

      setTareas(tareasDraft);
      setTareasDirty(false);
      alert('Tareas guardadas y acta sincronizada correctamente');
    } catch (e) { alert('Error: ' + e.message); }
    setSavingTareas(false);
  };

  // ── Abrir modal desde Acta ─────────────────────────────────────────────────
  const abrirModalActa = (tipo, idx) => {
    const tarea = actaDraft[tipo][idx];
    setModal({ origen:'acta', tipo, idx, tarea });
  };

  // ── Abrir modal desde Tareas ───────────────────────────────────────────────
  const abrirModalTareas = (idx) => {
    setModal({ origen:'tareas', idx, tarea: { ...tareasDraft[idx] } });
  };

  // ── Aplicar cambios del modal ──────────────────────────────────────────────
  const aplicarModal = (formData) => {
    if (!modal) return;
    if (modal.origen === 'acta') {
      setActaDraft(a => {
        const arr = [...(a[modal.tipo]||[])];
        arr[modal.idx] = { ...arr[modal.idx], ...formData };
        return { ...a, [modal.tipo]: arr };
      });
      setActaDirty(true);
    } else {
      setTareasDraft(arr => arr.map((item, i) => i === modal.idx ? { ...item, ...formData } : item));
      setTareasDirty(true);
    }
  };

  if (loading) return <div style={{ padding:40 }}>Cargando...</div>;
  if (!meeting) return <div style={{ padding:40 }}>Reunión no encontrada</div>;

  const participantes = safeJsonParseArray(meeting.participantes||'[]');

  const btnStyle = (color, disabled=false) => ({
    padding:'8px 16px', marginRight:8, marginBottom:4,
    backgroundColor: disabled?'#ccc':color,
    color:'white', border:'none', borderRadius:6,
    cursor: disabled?'default':'pointer', fontSize:13, fontWeight:500
  });

  const tabStyle = (active) => ({
    padding:'10px 22px', marginRight:8,
    backgroundColor: active?'#1565C0':'#e8eaf6',
    color: active?'white':'#3c4280',
    border:'none', borderRadius:6, cursor:'pointer', fontWeight: active?700:500, fontSize:13
  });

  const fieldStyle = (editing) => ({
    width:'100%', padding:'7px 10px',
    border: editing?'1px solid #90CAF9':'1px solid #e0e0e0',
    borderRadius:5, fontSize:13, boxSizing:'border-box',
    backgroundColor: editing?'#fff':'#fafafa', outline:'none'
  });

  // ── Render sección de tareas en el Acta ───────────────────────────────────
  const renderTareasActa = (tipo, label) => {
    const items = actaDraft?.[tipo]||[];
    const esTipoNueva = tipo === 'tareas_nuevas';
    return (
      <div style={{ marginBottom:18 }}>
        <div style={{ display:'flex', alignItems:'center', marginBottom:8, gap:8 }}>
          <h4 style={{ margin:0, color:'#333', fontSize:13 }}>{label}</h4>
          <span style={{ fontSize:11, color:'#999', backgroundColor:'#f0f0f0', borderRadius:10, padding:'1px 8px' }}>{items.length}</span>
        </div>
        {items.length === 0 ? (
          <p style={{ color:'#bbb', fontSize:13, fontStyle:'italic', margin:0 }}>Sin {label.toLowerCase()}</p>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {items.map((t, i) => (
              <div key={i} style={{
                padding:'10px 12px', borderRadius:7, border:'1px solid #e8ecf0',
                backgroundColor:'#fafbfc', display:'flex', alignItems:'flex-start', gap:10
              }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap', marginBottom:3 }}>
                    <span style={{ fontSize:11, fontWeight:700, color:'#1565C0', backgroundColor:'#E3F2FD', padding:'1px 7px', borderRadius:4 }}>
                      {t.id||`#${i+1}`}
                    </span>
                    <span style={estadoBadge(t.estado||'pendiente')}>{t.estado||'pendiente'}</span>
                    {esTipoNueva && t.fecha_compromiso && (
                      <span style={{ fontSize:11, color:'#777' }}>📅 {t.fecha_compromiso}</span>
                    )}
                  </div>
                  <div style={{ fontSize:13, color:'#333', lineHeight:1.4, marginBottom: t.responsable?2:0 }}>{t.descripcion}</div>
                  {t.responsable && <div style={{ fontSize:12, color:'#666' }}>👤 {t.responsable}</div>}
                </div>
                {editingActa && (
                  <button
                    onClick={() => abrirModalActa(tipo, i)}
                    title="Editar tarea"
                    style={{
                      flexShrink:0, width:30, height:30, border:'1px solid #ddd',
                      borderRadius:6, backgroundColor:'white', cursor:'pointer',
                      fontSize:14, display:'flex', alignItems:'center', justifyContent:'center',
                      color:'#555', transition:'background .15s'
                    }}
                  >✏️</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* Modal de edición de tarea */}
      {modal && (
        <ModalEditarTarea
          tarea={modal.tarea}
          mostrarFecha={modal.origen === 'tareas' || modal.tipo === 'tareas_nuevas'}
          onSave={aplicarModal}
          onClose={() => setModal(null)}
        />
      )}

      <h1 style={{ marginBottom:4 }}>Detalles de Reunión</h1>

      <div style={{ marginBottom:20, padding:15, backgroundColor:'#f5f5f5', borderRadius:8, fontSize:14 }}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:6 }}>
          <div><strong>Estado:</strong> {meeting.status}</div>
          <div><strong>Inicio:</strong> {new Date(meeting.started_at).toLocaleString('es-ES')}</div>
          {meeting.ended_at && <div><strong>Fin:</strong> {new Date(meeting.ended_at).toLocaleString('es-ES')}</div>}
          {meeting.cliente    && <div><strong>Cliente:</strong> {meeting.cliente}</div>}
          {meeting.proyecto   && <div><strong>Proyecto:</strong> {meeting.proyecto}</div>}
          {meeting.responsable&& <div><strong>Responsable:</strong> {meeting.responsable}</div>}
          {participantes.length>0 && <div><strong>Participantes:</strong> {participantes.join(', ')}</div>}
        </div>
      </div>

      <div style={{ marginBottom:20 }}>
        {[['transcription','Transcripción'],['acta','Acta'],['tareas','Tareas']].map(([k,label]) => (
          <button key={k} onClick={() => setActiveTab(k)} style={tabStyle(activeTab===k)}>{label}</button>
        ))}
      </div>

      {/* ── TRANSCRIPCIÓN ── */}
      {activeTab === 'transcription' && (
        <div>
          <h2>Transcripción</h2>
          {transcription.length===0 ? (
            <div style={{ padding:20, backgroundColor:'#fff3cd', borderRadius:8, border:'1px solid #ffc107' }}>
              <p><strong>Transcripción no disponible todavía</strong></p>
              <p>Puede estar procesándose o no hay cuota disponible en Groq.</p>
            </div>
          ) : (
            <div style={{ maxHeight:500, overflowY:'auto', padding:15, backgroundColor:'#f9f9f9', borderRadius:8 }}>
              {transcription.map((item, index) => (
                <div key={index} style={{ marginBottom:10, padding:10, backgroundColor:'white', borderRadius:4 }}>
                  <strong style={{ color:'#2196F3' }}>{item.speaker}:</strong> {item.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── ACTA ── */}
      {activeTab === 'acta' && (
        <div>
          <h2>Acta</h2>
          {!actaDraft ? (
            <div style={{ padding:20, backgroundColor:'#fff3cd', borderRadius:8, border:'1px solid #ffc107' }}>
              <p><strong>Acta no disponible todavía.</strong> Se genera al finalizar la reunión.</p>
              {meeting.status==='ended' && (
                <button onClick={async () => {
                  const res = await fetch(`${API_URL}/meetings/${id}/reprocess-acta`, {method:'POST'});
                  if (res.ok) alert('Procesando... recarga en 30 segundos.');
                }} style={{ ...btnStyle('#9C27B0'), marginTop:10 }}>Generar Acta Ahora</button>
              )}
            </div>
          ) : (
            <div>
              {/* Barra de acciones */}
              <div style={{ marginBottom:16, display:'flex', flexWrap:'wrap', gap:4 }}>
                <button
                  onClick={() => { if (editingActa) { setActaDraft(acta); setActaDirty(false); } setEditingActa(v=>!v); }}
                  style={btnStyle(editingActa?'#757575':'#455a64')}
                >
                  {editingActa ? '✕ Cancelar edición' : '✏️ Editar acta'}
                </button>
                <button onClick={saveActa} disabled={!actaDirty||savingActa} style={btnStyle('#1565C0', !actaDirty||savingActa)}>
                  {savingActa ? 'Guardando…' : '💾 Guardar'}
                </button>
                <button onClick={() => generarPDF(actaDraft||acta, meeting)} style={btnStyle('#E53935')}>
                  📄 Descargar PDF
                </button>
                <button onClick={async () => {
                  if (!confirm('¿Reprocesar acta? Se regenerarán las tareas.')) return;
                  const res = await fetch(`${API_URL}/meetings/${id}/reprocess-acta`, {method:'POST'});
                  if (res.ok) { alert('Reprocesando...'); setTimeout(fetchMeetingData, 5000); }
                }} style={btnStyle('#9C27B0')}>🔄 Reprocesar</button>
              </div>

              {editingActa && (
                <div style={{ marginBottom:14, padding:'10px 16px', backgroundColor:'#E3F2FD', borderRadius:8, fontSize:13, color:'#1565C0', borderLeft:'4px solid #2196F3', display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontSize:16 }}>✏️</span>
                  <span>Modo edición activo — haz clic en <strong>✏️</strong> junto a cada tarea para editarla. Al guardar, los cambios se sincronizarán automáticamente en la pestaña <strong>Tareas</strong>.</span>
                </div>
              )}

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
                {/* Vista principal del acta */}
                <div style={{ padding:20, border:'1px solid #e8ecf0', borderRadius:10, backgroundColor:'white' }}>
                  <h3 style={{ marginBottom:18, color:'#1565C0', borderBottom:'2px solid #E3F2FD', paddingBottom:8 }}>Vista del Acta</h3>

                  {/* Identificación */}
                  <div style={{ marginBottom:20, padding:14, backgroundColor:'#f8f9fa', borderRadius:8, border:'1px solid #e9ecef' }}>
                    <h4 style={{ marginBottom:12, color:'#444', fontSize:13, textTransform:'uppercase', letterSpacing:'.5px' }}>📋 Identificación</h4>
                    <div style={{ display:'grid', gridTemplateColumns:'110px 1fr', gap:'8px 10px', fontSize:13 }}>
                      {['cliente','proyecto','fecha','hora_inicio','hora_fin','responsable'].map(k => {
                        const val = actaDraft.identificacion?.[k]??'';
                        return (
                          <div key={k} style={{ display:'contents' }}>
                            <div style={{ fontWeight:600, color:'#666', alignSelf:'center' }}>{k.replace('_',' ')}</div>
                            {editingActa ? (
                              <input
                                value={val}
                                onChange={e => { setActaDraft(a=>({...a,identificacion:{...(a.identificacion||{}),[k]:e.target.value}})); setActaDirty(true); }}
                                style={fieldStyle(true)}
                                type={k.includes('hora')?'time':k==='fecha'?'date':'text'}
                              />
                            ) : <div style={{ color:'#333', padding:'2px 0' }}>{val||'—'}</div>}
                          </div>
                        );
                      })}
                      <div style={{ fontWeight:600, color:'#666', alignSelf:'center' }}>participantes</div>
                      {editingActa ? (
                        <input
                          value={(actaDraft.identificacion?.participantes||[]).join(', ')}
                          onChange={e => {
                            const arr = e.target.value.split(/[,;]/).map(s=>s.trim()).filter(Boolean);
                            setActaDraft(a=>({...a,identificacion:{...(a.identificacion||{}),participantes:arr}}));
                            setActaDirty(true);
                          }}
                          style={fieldStyle(true)}
                          placeholder="Nombre 1, Nombre 2..."
                        />
                      ) : <div style={{ color:'#333', padding:'2px 0' }}>{(actaDraft.identificacion?.participantes||[]).join(', ')||'—'}</div>}
                    </div>
                  </div>

                  {/* Tareas — cards con botón editar */}
                  {renderTareasActa('tareas_anteriores', 'Tareas Anteriores')}
                  {renderTareasActa('tareas_nuevas', 'Tareas Nuevas')}

                  {/* Resumen */}
                  <div style={{ marginBottom:16 }}>
                    <h4 style={{ marginBottom:8, color:'#333', fontSize:13 }}>Resumen de la reunión</h4>
                    {editingActa ? (
                      <textarea
                        value={actaDraft.resumen_reunion||''}
                        onChange={e => { setActaDraft(a=>({...a,resumen_reunion:e.target.value})); setActaDirty(true); }}
                        rows={5}
                        style={{ ...fieldStyle(true), resize:'vertical', lineHeight:1.6 }}
                        placeholder="Escribe el resumen de la reunión..."
                      />
                    ) : (
                      <p style={{ fontSize:13, lineHeight:1.7, color:'#333', margin:0, padding:'8px 12px', backgroundColor:'#fafafa', borderRadius:6, border:'1px solid #eee' }}>
                        {actaDraft.resumen_reunion||'—'}
                      </p>
                    )}
                  </div>

                  {/* Observaciones */}
                  <div>
                    <h4 style={{ marginBottom:8, color:'#333', fontSize:13 }}>Observaciones generales</h4>
                    {editingActa ? (
                      <textarea
                        value={actaDraft.observaciones_generales||''}
                        onChange={e => { setActaDraft(a=>({...a,observaciones_generales:e.target.value})); setActaDirty(true); }}
                        rows={3}
                        style={{ ...fieldStyle(true), resize:'vertical', lineHeight:1.6 }}
                        placeholder="Observaciones adicionales..."
                      />
                    ) : (
                      <p style={{ fontSize:13, lineHeight:1.7, color:'#333', margin:0, padding:'8px 12px', backgroundColor:'#fafafa', borderRadius:6, border:'1px solid #eee' }}>
                        {actaDraft.observaciones_generales||'—'}
                      </p>
                    )}
                  </div>
                </div>

                {/* JSON Raw */}
                <div style={{ padding:16, border:'1px solid #e8ecf0', borderRadius:10 }}>
                  <h3 style={{ marginBottom:10 }}>JSON Raw</h3>
                  <pre style={{ margin:0, maxHeight:600, overflow:'auto', padding:12, background:'#f8f9fa', borderRadius:6, fontSize:11, lineHeight:1.5 }}>
                    {JSON.stringify(actaDraft, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAREAS ── */}
      {activeTab === 'tareas' && (
        <div>
          <h2>Tareas</h2>
          {tareasDraft.length===0 ? (
            <p style={{ color:'#666' }}>No hay tareas registradas.</p>
          ) : (
            <div>
              <div style={{ marginBottom:12 }}>
                <button onClick={saveTareas} disabled={!tareasDirty||savingTareas} style={btnStyle('#1565C0', !tareasDirty||savingTareas)}>
                  {savingTareas ? 'Guardando…' : '💾 Guardar cambios'}
                </button>
                {tareasDirty && <span style={{ fontSize:12, color:'#e65100', marginLeft:4 }}>● Cambios sin guardar</span>}
              </div>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead>
                  <tr style={{ backgroundColor:'#1565C0', color:'white' }}>
                    {['ID','Descripción','Responsable','Estado','Fecha comproms.','Acciones'].map((h,i) => (
                      <th key={i} style={{ padding:'11px 10px', textAlign:'left', fontWeight:600, fontSize:12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tareasDraft.map((t, idx) => (
                    <tr key={t.id??`t_${idx}`} style={{ borderBottom:'1px solid #eee', backgroundColor: idx%2===0?'white':'#fafbfc' }}>
                      <td style={{ padding:'10px', fontSize:12, color:'#1565C0', fontWeight:600 }}>{t.tarea_id||'—'}</td>
                      <td style={{ padding:'10px', maxWidth:260 }}>
                        <div style={{ fontSize:13, color:'#333', lineHeight:1.4 }}>{t.descripcion}</div>
                      </td>
                      <td style={{ padding:'10px', fontSize:13, color:'#555' }}>{t.responsable||'—'}</td>
                      <td style={{ padding:'10px' }}>
                        <span style={estadoBadge(t.estado||'pendiente')}>{t.estado||'pendiente'}</span>
                      </td>
                      <td style={{ padding:'10px', fontSize:13, color:'#666' }}>{t.fecha_compromiso||'—'}</td>
                      <td style={{ padding:'10px' }}>
                        <button
                          onClick={() => abrirModalTareas(idx)}
                          style={{ padding:'6px 14px', backgroundColor:'#E3F2FD', color:'#1565C0', border:'1px solid #90CAF9', borderRadius:5, cursor:'pointer', fontSize:12, fontWeight:600 }}
                        >
                          ✏️ Editar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default MeetingDetail;
