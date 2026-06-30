import { apiFetch } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

function safeJsonParseArray(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

const ESTADOS_TAREA = [
  {v:1,l:'Sin iniciar'},{v:2,l:'En progreso'},{v:3,l:'En revisión'},
  {v:4,l:'Finalizada'},{v:5,l:'Planeación'},{v:7,l:'Respuesta Cliente'},{v:8,l:'Pend otros procesos'}
];
const PRIORIDADES = [{v:1,l:'🟢 Baja'},{v:2,l:'🟡 Media'},{v:3,l:'🔴 Alta'}];
const ESTADOS_LABEL = {1:'Sin iniciar',2:'En progreso',3:'En revisión',4:'Finalizada',5:'Planeación',7:'Resp. Cliente',8:'Pend. otros'};
const PRIO_ICON = {1:'🟢',2:'🟡',3:'🔴'};

const estadoBadge = (estadoTarea, estadoTexto) => {
  const label = ESTADOS_LABEL[estadoTarea] || estadoTexto || 'pendiente';
  const bg = estadoTarea===4?'#d4edda':estadoTarea===2?'#fff3cd':estadoTarea===3?'#cfe2ff':'#e2e3e5';
  const color = estadoTarea===4?'#155724':estadoTarea===2?'#856404':estadoTarea===3?'#084298':'#383d41';
  return { padding:'3px 10px', borderRadius:12, fontSize:11, fontWeight:600, backgroundColor:bg, color, border:`1px solid ${bg}`, display:'inline-block' };
};

// ─── PDF ──────────────────────────────────────────────────────────────────────
function generarPDF(acta, meeting) {
  const doc   = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 20; const contentW = pageW - margin * 2;
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
   ['Hora fin', id.hora_fin||(endedDate?endedDate.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}):''  )],
   ['Participantes', Array.isArray(id.participantes)?id.participantes.join(', '):id.participantes]
  ].forEach(([label,value]) => {
    checkPage(6); doc.setFont('helvetica','bold'); doc.text(label+':', margin, y);
    doc.setFont('helvetica','normal'); doc.text(String(value||'—'), margin+40, y); y+=6;
  }); y+=6;
  const tableOpts = (head,body) => ({ margin:{left:margin,right:margin}, head, body, styles:{fontSize:8.5,cellPadding:3,textColor:colors.black,lineColor:colors.border,lineWidth:0.1}, headStyles:{fillColor:colors.lightGray,textColor:colors.black,fontStyle:'bold'} });
  sectionTitle('Tareas Nuevas');
  const tareasNuevas = acta.tareas_nuevas||[];
  if (!tareasNuevas.length) { doc.setFontSize(9); doc.setTextColor(...colors.gray); doc.text('Sin tareas nuevas.', margin, y); y+=8; }
  else { autoTable(doc,{startY:y,...tableOpts([['ID','Descripción','Responsable','Fecha compromiso']], tareasNuevas.map(t=>[t.id||'',t.descripcion||'',t.responsable||'',t.fecha_compromiso||'']))}); y=doc.lastAutoTable.finalY+8; }
  sectionTitle('Resumen'); textBlock(acta.resumen_reunion);
  if (acta.observaciones_generales) { sectionTitle('Observaciones'); textBlock(acta.observaciones_generales); }
  for (let i=1; i<=doc.internal.getNumberOfPages(); i++) {
    doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(...colors.gray);
    doc.text(`Página ${i} de ${doc.internal.getNumberOfPages()}`, pageW-margin, pageH-10, {align:'right'});
    doc.text('Generado automáticamente', margin, pageH-10);
  }
  const cf = (id.cliente||'acta').replace(/[^a-z0-9]/gi,'_');
  const ff = (id.fecha||'sin_fecha').replace(/-/g,'');
  doc.save(`Acta_${cf}_${ff}.pdf`);
}

// ─── Sync bidireccional ───────────────────────────────────────────────────────
function syncTareasToActa(actaDraft, tareasDraft) {
  if (!actaDraft) return actaDraft;
  const mapT = t => {
    const m = tareasDraft.find(td => td.tarea_id && td.tarea_id === t.id);
    return m ? { ...t, descripcion:m.descripcion??t.descripcion, responsable:m.responsable??t.responsable, estado:m.estado??t.estado, fecha_compromiso:m.fecha_compromiso??t.fecha_compromiso } : t;
  };
  return { ...actaDraft, tareas_nuevas:(actaDraft.tareas_nuevas||[]).map(mapT), tareas_anteriores:(actaDraft.tareas_anteriores||[]).map(mapT) };
}
function syncActaToTareas(tareasDraft, actaDraft) {
  if (!actaDraft) return tareasDraft;
  const todas = [...(actaDraft.tareas_nuevas||[]),...(actaDraft.tareas_anteriores||[])];
  return tareasDraft.map(t => {
    const m = todas.find(ta => ta.id && ta.id === t.tarea_id);
    return m ? { ...t, descripcion:m.descripcion??t.descripcion, responsable:m.responsable??t.responsable, estado:m.estado??t.estado, fecha_compromiso:m.fecha_compromiso??t.fecha_compromiso } : t;
  });
}

// ─── Modal edición de tarea — COMPLETO ───────────────────────────────────────
function ModalEditarTarea({ tarea, onSave, onClose, companyUsers=[], mostrarFecha=true }) {
  const [form, setForm] = useState({ ...tarea });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const lbl = { display:'block', marginBottom:4, fontSize:12, fontWeight:600, color:'#555' };
  const inp = { width:'100%', padding:'9px 12px', border:'1px solid #dde1e7', borderRadius:6, fontSize:13, boxSizing:'border-box', backgroundColor:'#fff' };

  return (
    <div style={{ position:'fixed',inset:0,backgroundColor:'rgba(0,0,0,0.5)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:16,overflowY:'auto' }}
      onClick={e => { if (e.target===e.currentTarget) onClose(); }}>
      <div style={{ backgroundColor:'white',borderRadius:12,width:'100%',maxWidth:600,boxShadow:'0 20px 60px rgba(0,0,0,0.25)',overflow:'hidden',maxHeight:'92vh',display:'flex',flexDirection:'column' }}>
        <div style={{ padding:'16px 24px',borderBottom:'1px solid #eee',backgroundColor:'#1565C0',display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0 }}>
          <div>
            <div style={{ fontSize:11,color:'rgba(255,255,255,0.7)',fontWeight:500 }}>Editando tarea</div>
            <div style={{ fontSize:15,fontWeight:700,color:'white' }}>{form.tarea_id||form.id||'Nueva'}</div>
          </div>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)',border:'none',borderRadius:6,color:'white',fontSize:18,width:32,height:32,cursor:'pointer' }}>×</button>
        </div>

        <div style={{ padding:20,overflowY:'auto',display:'flex',flexDirection:'column',gap:14 }}>
          {/* Asunto */}
          <div>
            <label style={lbl}>Asunto <span style={{color:'#c62828'}}>*</span></label>
            <input value={form.asunto||''} onChange={e=>set('asunto',e.target.value)} style={inp} placeholder="Título corto de la tarea..." maxLength={100} />
          </div>
          {/* Descripción */}
          <div>
            <label style={lbl}>Descripción</label>
            <textarea value={form.descripcion||''} onChange={e=>set('descripcion',e.target.value)} rows={3} style={{...inp,resize:'vertical'}} placeholder="Descripción de la tarea..." />
          </div>
          {/* Detalle */}
          <div>
            <label style={lbl}>Detalle / Contexto</label>
            <textarea value={form.detalle||''} onChange={e=>set('detalle',e.target.value)} rows={3} style={{...inp,resize:'vertical'}} placeholder="Contexto adicional, detalles técnicos, comentarios..." />
          </div>
          {/* Responsable + Asignado */}
          <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:12 }}>
            <div>
              <label style={lbl}>Responsable</label>
              {companyUsers.length > 0 ? (
                <select value={form.responsable||''} onChange={e=>set('responsable',e.target.value)} style={{...inp,cursor:'pointer'}}>
                  <option value=''>— Sin asignar —</option>
                  {companyUsers.map(u=><option key={u.id} value={u.email}>{u.name}</option>)}
                </select>
              ) : (
                <input value={form.responsable||''} onChange={e=>set('responsable',e.target.value)} style={inp} placeholder="Nombre o email..." />
              )}
            </div>
            <div>
              <label style={lbl}>Asignado a</label>
              {companyUsers.length > 0 ? (
                <select value={form.asignado_a||''} onChange={e=>set('asignado_a',e.target.value)} style={{...inp,cursor:'pointer'}}>
                  <option value=''>— Sin asignar —</option>
                  {companyUsers.map(u=><option key={u.id} value={u.email}>{u.name}</option>)}
                </select>
              ) : (
                <input value={form.asignado_a||''} onChange={e=>set('asignado_a',e.target.value)} style={inp} placeholder="Nombre o email..." />
              )}
            </div>
          </div>
          {/* Estado + Prioridad */}
          <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:12 }}>
            <div>
              <label style={lbl}>Estado</label>
              <select value={form.estado_tarea||1} onChange={e=>set('estado_tarea',Number(e.target.value))} style={{...inp,cursor:'pointer'}}>
                {ESTADOS_TAREA.map(s=><option key={s.v} value={s.v}>{s.l}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Prioridad</label>
              <select value={form.prioridad||2} onChange={e=>set('prioridad',Number(e.target.value))} style={{...inp,cursor:'pointer'}}>
                {PRIORIDADES.map(p=><option key={p.v} value={p.v}>{p.l}</option>)}
              </select>
            </div>
          </div>
          {/* Tipo + Req ID */}
          <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:12 }}>
            <div>
              <label style={lbl}>Tipo de tarea</label>
              <select value={form.tipo_tarea||'i'} onChange={e=>set('tipo_tarea',e.target.value)} style={{...inp,cursor:'pointer'}}>
                <option value='i'>🏠 Interna</option>
                <option value='e'>🌐 Externa (cliente)</option>
              </select>
            </div>
            <div>
              <label style={lbl}>ID Requerimiento</label>
              <input value={form.requerimiento_id||''} onChange={e=>set('requerimiento_id',e.target.value)} style={inp} placeholder="REQ-001 (opcional)" />
            </div>
          </div>
          {/* Fechas */}
          {mostrarFecha && (
            <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12 }}>
              <div>
                <label style={lbl}>Fecha compromiso</label>
                <input type='date' value={form.fecha_compromiso||''} onChange={e=>set('fecha_compromiso',e.target.value)} style={inp} />
              </div>
              <div>
                <label style={lbl}>Fecha inicio</label>
                <input type='date' value={form.date_init||''} onChange={e=>set('date_init',e.target.value)} style={inp} />
              </div>
              <div>
                <label style={lbl}>Fecha fin</label>
                <input type='date' value={form.date_end||''} onChange={e=>set('date_end',e.target.value)} style={inp} />
              </div>
            </div>
          )}
        </div>

        <div style={{ padding:'14px 24px',borderTop:'1px solid #eee',display:'flex',justifyContent:'flex-end',gap:10,backgroundColor:'#fafafa',flexShrink:0 }}>
          <button onClick={onClose} style={{ padding:'9px 20px',border:'1px solid #ddd',borderRadius:6,background:'white',fontSize:13,cursor:'pointer',color:'#555' }}>Cancelar</button>
          <button onClick={() => {
            if (!(form.asunto||form.descripcion||'').trim()) { alert('El asunto o descripción es requerido'); return; }
            onSave(form); onClose();
          }} style={{ padding:'9px 22px',border:'none',borderRadius:6,background:'#1565C0',color:'white',fontSize:13,cursor:'pointer',fontWeight:600 }}>✓ Aplicar</button>
        </div>
      </div>
    </div>
  );
}

// ─── Panel de Adjuntos y Notas ────────────────────────────────────────────────
function AttachmentsPanel({ meetingId }) {
  const [notes, setNotes]               = useState([]);
  const [attachments, setAttachments]   = useState([]);
  const [newNote, setNewNote]           = useState('');
  const [newNoteAuthor, setNewNoteAuthor] = useState('');
  const [addingNote, setAddingNote]     = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [loading, setLoading]           = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [nRes, aRes] = await Promise.all([
        apiFetch(`/meetings/${meetingId}/notes`),
        apiFetch(`/meetings/${meetingId}/attachments`)
      ]);
      if (nRes.ok) setNotes(await nRes.json());
      if (aRes.ok) setAttachments(await aRes.json());
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [meetingId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleAddNote = async () => {
    if (!newNote.trim()) return;
    setAddingNote(true);
    try {
      const res = await apiFetch(`/meetings/${meetingId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ content: newNote.trim(), author: newNoteAuthor.trim() })
      });
      if (res.ok) { setNewNote(''); setNewNoteAuthor(''); await fetchData(); }
    } catch (e) { console.error(e); }
    setAddingNote(false);
  };

  const handleDeleteNote = async (noteId) => {
    if (!confirm('¿Eliminar esta nota?')) return;
    await apiFetch(`/meetings/${meetingId}/notes/${noteId}`, { method: 'DELETE' });
    setNotes(n => n.filter(x => x.id !== noteId));
  };

  const handleUploadFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFile(true);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await apiFetch(`/meetings/${meetingId}/attachments`, { method: 'POST', body: formData });
      if (res.ok) await fetchData();
      else { const err = await res.json().catch(()=>{}); alert(err?.error || 'Error al subir archivo'); }
    } catch (e) { console.error(e); }
    setUploadingFile(false);
    e.target.value = '';
  };

  const handleDeleteAttachment = async (attachId) => {
    if (!confirm('¿Eliminar este adjunto?')) return;
    await apiFetch(`/meetings/${meetingId}/attachments/${attachId}`, { method: 'DELETE' });
    setAttachments(a => a.filter(x => x.id !== attachId));
  };

  const transcriptionStatusBadge = (status) => {
    const map = {
      pending:    { bg: '#fff3cd', color: '#856404', label: '⏳ En cola' },
      processing: { bg: '#cfe2ff', color: '#084298', label: '🔄 Transcribiendo' },
      done:       { bg: '#d1e7dd', color: '#0a3622', label: '✅ Transcrito' },
      error:      { bg: '#f8d7da', color: '#842029', label: '❌ Error' },
      'n/a':      { bg: '#e2e3e5', color: '#383d41', label: '📎 Adjunto' },
    };
    const s = map[status] || map['n/a'];
    return <span style={{ padding:'2px 8px',borderRadius:10,fontSize:11,fontWeight:600,backgroundColor:s.bg,color:s.color }}>{s.label}</span>;
  };

  if (loading) return <div style={{ padding:20,color:'#666' }}>Cargando adjuntos...</div>;
  const sectionTitle = { fontSize:14,fontWeight:700,color:'#1565C0',marginBottom:12,marginTop:0 };
  const cardStyle = { padding:'12px 14px',borderRadius:8,border:'1px solid #e8ecf0',backgroundColor:'#fafbfc',marginBottom:8 };

  return (
    <div>
      <div style={{ padding:'12px 16px',backgroundColor:'#e8f5e9',borderRadius:8,border:'1px solid #c8e6c9',marginBottom:20,fontSize:13,color:'#2e7d32' }}>
        📌 <strong>Las notas y audios aquí agregados se incluirán automáticamente en el acta final.</strong>
      </div>
      <div style={{ marginBottom:28 }}>
        <h3 style={sectionTitle}>📝 Notas de texto ({notes.length})</h3>
        <div style={{ padding:16,backgroundColor:'#f8f9fa',borderRadius:8,border:'1px solid #dee2e6',marginBottom:14 }}>
          <div style={{ marginBottom:10 }}>
            <input value={newNoteAuthor} onChange={e=>setNewNoteAuthor(e.target.value)} placeholder="Autor (opcional)"
              style={{ width:'100%',padding:'8px 10px',border:'1px solid #ccc',borderRadius:6,fontSize:13,boxSizing:'border-box' }} />
          </div>
          <textarea value={newNote} onChange={e=>setNewNote(e.target.value)} placeholder="Escribe aquí las notas..." rows={4}
            style={{ width:'100%',padding:'8px 10px',border:'1px solid #ccc',borderRadius:6,fontSize:13,resize:'vertical',boxSizing:'border-box',lineHeight:1.5 }} />
          <button onClick={handleAddNote} disabled={!newNote.trim()||addingNote}
            style={{ marginTop:8,padding:'8px 18px',backgroundColor:!newNote.trim()||addingNote?'#ccc':'#1565C0',color:'white',border:'none',borderRadius:6,fontSize:13,cursor:'pointer',fontWeight:600 }}>
            {addingNote?'⏳ Guardando...':'➕ Agregar nota'}
          </button>
        </div>
        {notes.length===0 ? <p style={{ color:'#999',fontSize:13,fontStyle:'italic' }}>No hay notas agregadas aún.</p> :
          notes.map(note=>(
            <div key={note.id} style={cardStyle}>
              <div style={{ display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:10 }}>
                <div style={{ flex:1 }}>
                  {note.author&&<div style={{ fontSize:12,fontWeight:700,color:'#1565C0',marginBottom:4 }}>👤 {note.author}</div>}
                  <div style={{ fontSize:13,color:'#333',lineHeight:1.6,whiteSpace:'pre-wrap' }}>{note.content}</div>
                  <div style={{ fontSize:11,color:'#999',marginTop:6 }}>{new Date(note.created_at).toLocaleString('es-ES')}</div>
                </div>
                <button onClick={()=>handleDeleteNote(note.id)} style={{ background:'none',border:'none',color:'#dc3545',cursor:'pointer',fontSize:16,padding:'2px 6px',flexShrink:0 }}>🗑️</button>
              </div>
            </div>
          ))
        }
      </div>
      <div>
        <h3 style={sectionTitle}>📎 Archivos adjuntos ({attachments.length})</h3>
        <div style={{ marginBottom:14 }}>
          <label style={{ display:'inline-flex',alignItems:'center',gap:8,padding:'10px 18px',backgroundColor:uploadingFile?'#6c757d':'#495057',color:'white',borderRadius:6,fontSize:13,fontWeight:600,cursor:uploadingFile?'default':'pointer' }}>
            {uploadingFile?'⏳ Subiendo...':'⬆️ Subir archivo'}
            <input type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.pdf,.doc,.docx,.txt,.jpg,.jpeg,.png" onChange={handleUploadFile} disabled={uploadingFile} style={{ display:'none' }} />
          </label>
          <p style={{ marginTop:8,fontSize:12,color:'#777' }}>
            <strong>Audios:</strong> se transcriben con Whisper y se incluyen en el acta.<br/>
            <strong>Documentos:</strong> se guardan como adjunto de referencia.
          </p>
        </div>
        {attachments.length===0 ? <p style={{ color:'#999',fontSize:13,fontStyle:'italic' }}>No hay archivos adjuntos.</p> :
          attachments.map(att=>(
            <div key={att.id} style={cardStyle}>
              <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',gap:10 }}>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ display:'flex',alignItems:'center',gap:8,marginBottom:4,flexWrap:'wrap' }}>
                    <span style={{ fontSize:16 }}>{att.file_type==='audio'?'🎵':'📄'}</span>
                    <span style={{ fontSize:13,fontWeight:600,color:'#333',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{att.file_name}</span>
                    {transcriptionStatusBadge(att.transcription_status)}
                  </div>
                  <div style={{ fontSize:11,color:'#999' }}>{att.file_type==='audio'?'Audio':'Documento'} · {new Date(att.uploaded_at).toLocaleString('es-ES')}</div>
                </div>
                <div style={{ display:'flex',gap:6,flexShrink:0 }}>
                  <button onClick={async()=>{
                    const token=localStorage.getItem('auth_token');
                    const res=await fetch(`${import.meta.env.VITE_API_BASE_URL}/meetings/${meetingId}/attachments/${att.id}/download`,{headers:{Authorization:`Bearer ${token}`}});
                    if(!res.ok){alert('Error al descargar');return;}
                    const blob=await res.blob(); const url=URL.createObjectURL(blob);
                    const a=document.createElement('a'); a.href=url; a.download=att.file_name; a.click(); URL.revokeObjectURL(url);
                  }} style={{ padding:'6px 10px',backgroundColor:'#e3f2fd',color:'#1565C0',border:'1px solid #90CAF9',borderRadius:5,fontSize:12,cursor:'pointer',fontWeight:600 }}>⬇️ Descargar</button>
                  <button onClick={()=>handleDeleteAttachment(att.id)} style={{ padding:'6px 10px',backgroundColor:'#fff8f8',color:'#c62828',border:'1px solid #ffcdd2',borderRadius:5,fontSize:12,cursor:'pointer',fontWeight:600 }}>🗑️</button>
                </div>
              </div>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
function MeetingDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [meeting, setMeeting]           = useState(null);
  const [transcription, setTranscription] = useState([]);
  const [acta, setActa]                 = useState(null);
  const [actaDraft, setActaDraft]       = useState(null);
  const [editingActa, setEditingActa]   = useState(false);
  const [savingActa, setSavingActa]     = useState(false);
  const [actaDirty, setActaDirty]       = useState(false);
  const [tareas, setTareas]             = useState([]);
  const [tareasDraft, setTareasDraft]   = useState([]);
  const [savingTareas, setSavingTareas] = useState(false);
  const [tareasDirty, setTareasDirty]   = useState(false);
  const [activeTab, setActiveTab]       = useState('transcription');
  const [loading, setLoading]           = useState(true);
  const [modal, setModal]               = useState(null);
  const [approvedAt, setApprovedAt]     = useState(null);
  const [approvedBy, setApprovedBy]     = useState(null);
  const [companyUsers, setCompanyUsers] = useState([]);
  const [recording, setRecording]       = useState(null);   // { exists, size_mb, created_at }
  const [videoUrl, setVideoUrl]         = useState(null);   // blob URL temporal para el reproductor

  const isEditingAny = editingActa || modal !== null;

  useEffect(() => {
    apiFetch('/admin/users/company').then(r=>r.ok&&r.json()).then(d=>d&&setCompanyUsers(d)).catch(()=>{});
    // Verificar si la reunion tiene video grabado
    apiFetch(`/meetings/${id}/recording/info`).then(r=>r.ok&&r.json()).then(d=>d&&setRecording(d)).catch(()=>{});
  }, []);

  useEffect(() => {
    fetchMeetingData();
    if (!isEditingAny) {
      const interval = setInterval(fetchMeetingData, 5000);
      return () => clearInterval(interval);
    }
  }, [id, isEditingAny]);

  const fetchMeetingData = useCallback(async () => {
    if (isEditingAny) return;
    try {
      const [meetingRes, transcriptionRes, actaRes, tareasRes] = await Promise.all([
        apiFetch(`/meetings/${id}`),
        apiFetch(`/meetings/${id}/transcription`),
        apiFetch(`/meetings/${id}/acta`).catch(()=>null),
        apiFetch(`/meetings/${id}/tareas`)
      ]);
      if (meetingRes.ok) setMeeting(await meetingRes.json());
      if (transcriptionRes.ok) setTranscription(await transcriptionRes.json());
      if (actaRes && actaRes.ok) {
        const actaData = await actaRes.json();
        const actaObj  = actaData?.acta || actaData;
        setActa(actaObj);
        if (actaData?.approved_at) { setApprovedAt(actaData.approved_at); setApprovedBy(actaData.approved_by_client); }
        if (!actaDirty && !editingActa) setActaDraft(actaObj);
      }
      if (tareasRes.ok) {
        const tareasData = await tareasRes.json();
        setTareas(tareasData);
        if (!tareasDirty) setTareasDraft(tareasData.map(t=>({...t})));
      }
      setLoading(false);
    } catch (e) { console.error(e); setLoading(false); }
  }, [id, isEditingAny, actaDirty, tareasDirty, editingActa]);

  const saveActa = async () => {
    if (!actaDraft) return;
    setSavingActa(true);
    try {
      const resActa = await apiFetch(`/meetings/${id}/acta`, { method:'PUT', body:JSON.stringify(actaDraft) });
      if (!resActa.ok) { alert(`Error al guardar acta (${resActa.status})`); setSavingActa(false); return; }
      const tareasSync = syncActaToTareas(tareasDraft, actaDraft);
      const payload = tareasSync.map(t=>({...t, tarea_id:t.tarea_id||'', tipo:t.tipo||'nueva'}));
      await apiFetch(`/meetings/${id}/tareas`, { method:'PUT', body:JSON.stringify(payload) });
      setActa(actaDraft); setActaDirty(false); setEditingActa(false);
      setTareasDraft(tareasSync); setTareas(tareasSync); setTareasDirty(false);
      alert('Acta guardada y tareas sincronizadas');
    } catch (e) { alert('Error: '+e.message); }
    setSavingActa(false);
  };

  const saveTareas = async () => {
    setSavingTareas(true);
    try {
      const payload = tareasDraft.map(t=>({...t, tarea_id:t.tarea_id||'', tipo:t.tipo||'nueva'}));
      const resTareas = await apiFetch(`/meetings/${id}/tareas`, { method:'PUT', body:JSON.stringify(payload) });
      if (!resTareas.ok) { alert(`Error (${resTareas.status})`); setSavingTareas(false); return; }
      if (actaDraft) {
        const actaSync = syncTareasToActa(actaDraft, tareasDraft);
        await apiFetch(`/meetings/${id}/acta`, { method:'PUT', body:JSON.stringify(actaSync) });
        setActaDraft(actaSync); setActa(actaSync); setActaDirty(false);
      }
      setTareas(tareasDraft); setTareasDirty(false);
      alert('Tareas guardadas y acta sincronizada');
    } catch (e) { alert('Error: '+e.message); }
    setSavingTareas(false);
  };

  const descargarExcel = async () => {
    const token = localStorage.getItem('auth_token');
    const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/meetings/${id}/tareas/excel`, { headers:{Authorization:`Bearer ${token}`} });
    if (!res.ok) { alert('Error al descargar'); return; }
    const blob = await res.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `Tareas_${meeting?.cliente||'reunion'}_${meeting?.proyecto||''}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const abrirModalActa   = (tipo,idx) => setModal({ origen:'acta', tipo, idx, tarea:actaDraft[tipo][idx] });
  const abrirModalTareas = (idx)      => setModal({ origen:'tareas', idx, tarea:{...tareasDraft[idx]} });

  const aplicarModal = (formData) => {
    if (!modal) return;
    if (modal.origen==='acta') {
      setActaDraft(a=>{ const arr=[...(a[modal.tipo]||[])]; arr[modal.idx]={...arr[modal.idx],...formData}; return {...a,[modal.tipo]:arr}; });
      setActaDirty(true);
    } else {
      setTareasDraft(arr=>arr.map((item,i)=>i===modal.idx?{...item,...formData}:item));
      setTareasDirty(true);
    }
  };

  const generarIdTarea = (tipo) => {
    const prefix = tipo==='tareas_anteriores'?'ant_':'tarea_';
    const existentes = [...(actaDraft?.tareas_nuevas||[]).map(t=>t.id||''),...(actaDraft?.tareas_anteriores||[]).map(t=>t.id||''),...tareasDraft.map(t=>t.tarea_id||'')];
    let n=existentes.length+1; let c=`${prefix}${String(n).padStart(3,'0')}`;
    while(existentes.includes(c)){n++;c=`${prefix}${String(n).padStart(3,'0')}`;}
    return c;
  };

  const agregarTareaActa = (tipo) => {
    const newId = generarIdTarea(tipo);
    const ta = { id:newId, descripcion:'', asunto:'', responsable:'', estado:'pendiente', ...(tipo==='tareas_nuevas'?{fecha_compromiso:''}:{}) };
    const tt = { tarea_id:newId, tipo:tipo==='tareas_nuevas'?'nueva':'anterior', descripcion:'', asunto:'', responsable:'', estado:'pendiente', fecha_compromiso:'', estado_tarea:1, prioridad:2, tipo_tarea:'i', asignado_a:'', detalle:'', requerimiento_id:'', date_init:'', date_end:'' };
    setActaDraft(a=>({...a,[tipo]:[...(a[tipo]||[]),ta]}));
    setTareasDraft(arr=>[...arr,tt]);
    setActaDirty(true); setTareasDirty(true);
    setModal({ origen:'acta', tipo, idx:(actaDraft?.[tipo]||[]).length, tarea:ta });
  };

  const eliminarTareaActa = (tipo,idx) => {
    const tId = actaDraft?.[tipo]?.[idx]?.id;
    setActaDraft(a=>({...a,[tipo]:(a[tipo]||[]).filter((_,i)=>i!==idx)}));
    if(tId) setTareasDraft(arr=>arr.filter(t=>t.tarea_id!==tId));
    setActaDirty(true); setTareasDirty(true);
  };

  const agregarTareaTab = () => {
    const newId = generarIdTarea('tareas_nuevas');
    const tt = { tarea_id:newId, tipo:'nueva', descripcion:'', asunto:'', responsable:'', estado:'pendiente', fecha_compromiso:'', estado_tarea:1, prioridad:2, tipo_tarea:'i', asignado_a:'', detalle:'', requerimiento_id:'', date_init:'', date_end:'' };
    const ta = { id:newId, descripcion:'', asunto:'', responsable:'', estado:'pendiente', fecha_compromiso:'' };
    setTareasDraft(arr=>[...arr,tt]);
    setActaDraft(a=>a?({...a,tareas_nuevas:[...(a.tareas_nuevas||[]),ta]}):a);
    setTareasDirty(true); setActaDirty(true);
    setModal({ origen:'tareas', idx:tareasDraft.length, tarea:tt });
  };

  const eliminarTareaTab = (idx) => {
    const tId = tareasDraft[idx]?.tarea_id;
    const tipoActa = tareasDraft[idx]?.tipo==='anterior'?'tareas_anteriores':'tareas_nuevas';
    setTareasDraft(arr=>arr.filter((_,i)=>i!==idx));
    if(tId&&actaDraft) setActaDraft(a=>({...a,[tipoActa]:(a[tipoActa]||[]).filter(t=>t.id!==tId)}));
    setTareasDirty(true); setActaDirty(true);
  };

  if (loading) return <div style={{ padding:40 }}>Cargando...</div>;
  if (!meeting) return <div style={{ padding:40 }}>Reunión no encontrada</div>;

  const participantes = safeJsonParseArray(meeting.participantes||'[]');
  const btnStyle = (color,disabled=false) => ({ padding:'8px 16px',marginRight:8,marginBottom:4,backgroundColor:disabled?'#ccc':color,color:'white',border:'none',borderRadius:6,cursor:disabled?'default':'pointer',fontSize:13,fontWeight:500 });
  const tabStyle = (active) => ({ padding:'10px 22px',marginRight:8,backgroundColor:active?'#1565C0':'#e8eaf6',color:active?'white':'#3c4280',border:'none',borderRadius:6,cursor:'pointer',fontWeight:active?700:500,fontSize:13 });
  const fieldStyle = (editing) => ({ width:'100%',padding:'7px 10px',border:editing?'1px solid #90CAF9':'1px solid #e0e0e0',borderRadius:5,fontSize:13,boxSizing:'border-box',backgroundColor:editing?'#fff':'#fafafa',outline:'none' });
  const isActive   = meeting.status==='active';
  // Detectar si el usuario es el creador o solo un invitado observador
  const isOwner    = !meeting.created_by || meeting.created_by === user?.id;
  const isObserver = !isOwner; // invitado — puede ver y anotar, pero no cerrar ni editar durante grabación

  const renderTareasActa = (tipo, label) => {
    const items = actaDraft?.[tipo]||[];
    const esTipoNueva = tipo==='tareas_nuevas';
    return (
      <div style={{ marginBottom:18 }}>
        <div style={{ display:'flex',alignItems:'center',marginBottom:8,gap:8 }}>
          <h4 style={{ margin:0,color:'#333',fontSize:13 }}>{label}</h4>
          <span style={{ fontSize:11,color:'#999',backgroundColor:'#f0f0f0',borderRadius:10,padding:'1px 8px' }}>{items.length}</span>
          {editingActa&&<button onClick={()=>agregarTareaActa(tipo)} style={{ marginLeft:'auto',padding:'4px 12px',backgroundColor:'#E8F5E9',color:'#2E7D32',border:'1px solid #A5D6A7',borderRadius:5,cursor:'pointer',fontSize:12,fontWeight:600 }}>➕ Agregar</button>}
        </div>
        {items.length===0 ? <p style={{ color:'#bbb',fontSize:13,fontStyle:'italic',margin:0 }}>Sin {label.toLowerCase()}</p> : (
          <div style={{ display:'flex',flexDirection:'column',gap:6 }}>
            {items.map((t,i)=>(
              <div key={i} style={{ padding:'10px 12px',borderRadius:7,border:'1px solid #e8ecf0',backgroundColor:'#fafbfc',display:'flex',alignItems:'flex-start',gap:10 }}>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ display:'flex',alignItems:'center',gap:6,flexWrap:'wrap',marginBottom:3 }}>
                    <span style={{ fontSize:11,fontWeight:700,color:'#1565C0',backgroundColor:'#E3F2FD',padding:'1px 7px',borderRadius:4 }}>{t.id||`#${i+1}`}</span>
                    <span style={estadoBadge(1, t.estado||'pendiente')}>{t.estado||'pendiente'}</span>
                    {esTipoNueva&&t.fecha_compromiso&&<span style={{ fontSize:11,color:'#777' }}>📅 {t.fecha_compromiso}</span>}
                  </div>
                  <div style={{ fontSize:13,color:'#333',lineHeight:1.4,marginBottom:t.responsable?2:0 }}>{t.descripcion||<em style={{color:'#bbb'}}>Sin descripción</em>}</div>
                  {t.responsable&&<div style={{ fontSize:12,color:'#666' }}>👤 {t.responsable}</div>}
                </div>
                {editingActa&&(
                  <div style={{ display:'flex',gap:4,flexShrink:0 }}>
                    <button onClick={()=>abrirModalActa(tipo,i)} style={{ width:30,height:30,border:'1px solid #ddd',borderRadius:6,backgroundColor:'white',cursor:'pointer',fontSize:14 }}>✏️</button>
                    <button onClick={()=>{if(confirm(`¿Eliminar tarea ${t.id||`#${i+1}`}?`))eliminarTareaActa(tipo,i);}} style={{ width:30,height:30,border:'1px solid #ffcdd2',borderRadius:6,backgroundColor:'#fff8f8',cursor:'pointer',fontSize:14,color:'#c62828' }}>🗑️</button>
                  </div>
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
      {modal&&<ModalEditarTarea tarea={modal.tarea} mostrarFecha={modal.origen==='tareas'||modal.tipo==='tareas_nuevas'} onSave={aplicarModal} onClose={()=>setModal(null)} companyUsers={companyUsers} />}

      <h1 style={{ marginBottom:4 }}>Detalles de Reunión</h1>
      <div style={{ marginBottom:20,padding:15,backgroundColor:'#f5f5f5',borderRadius:8,fontSize:14 }}>
        <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))',gap:6 }}>
          <div><strong>Estado:</strong> <span style={{ color:isActive?'#2e7d32':'#666' }}>{isActive?'🔴 En curso':meeting.status}</span></div>
          <div><strong>Inicio:</strong> {new Date(meeting.started_at).toLocaleString('es-ES')}</div>
          {meeting.ended_at&&<div><strong>Fin:</strong> {new Date(meeting.ended_at).toLocaleString('es-ES')}</div>}
          {meeting.cliente&&<div><strong>Cliente:</strong> {meeting.cliente}</div>}
          {meeting.proyecto&&<div><strong>Proyecto:</strong> {meeting.proyecto}</div>}
          {meeting.responsable&&<div><strong>Responsable:</strong> {meeting.responsable}</div>}
          {participantes.length>0&&<div><strong>Participantes:</strong> {participantes.join(', ')}</div>}
        </div>
      </div>

      {approvedAt&&(
        <div style={{ padding:'12px 16px',backgroundColor:'#f0fdf4',border:'1px solid #86efac',borderRadius:8,marginBottom:16,display:'flex',alignItems:'center',gap:10 }}>
          <span style={{ fontSize:20 }}>✅</span>
          <div>
            <div style={{ fontWeight:700,color:'#15803d',fontSize:14 }}>Acta aprobada por el cliente</div>
            <div style={{ fontSize:12,color:'#4ade80' }}>Aprobada el {new Date(approvedAt).toLocaleDateString('es-ES',{day:'2-digit',month:'long',year:'numeric'})}{approvedBy&&` · por ${approvedBy}`} — <strong>No puede modificarse</strong></div>
          </div>
        </div>
      )}

      {/* Banner observador — reunión activa */}
      {isActive && isObserver && (
        <div style={{ marginBottom:16, padding:'12px 18px', backgroundColor:'#EFF6FF', border:'1px solid #BFDBFE', borderRadius:8, display:'flex', alignItems:'center', gap:12 }}>
          <span style={{ fontSize:20 }}>👁️</span>
          <div>
            <div style={{ fontWeight:700, color:'#1565C0', fontSize:14 }}>Estás viendo esta reunión en tiempo real</div>
            <div style={{ fontSize:12, color:'#3b82f6', marginTop:2 }}>La transcripción se actualiza cada 5 segundos. Puedes agregar notas pero no puedes cerrar la reunión.</div>
          </div>
        </div>
      )}

      {/* Banner creador — reunión activa */}
      {isActive && isOwner && (
        <div style={{ marginBottom:16, padding:'10px 16px', backgroundColor:'#FEF2F2', border:'1px solid #FECACA', borderRadius:8, fontSize:13, color:'#dc2626', display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ width:10, height:10, borderRadius:'50%', backgroundColor:'#dc2626', display:'inline-block', animation:'livepulse 1.5s infinite' }} />
          Reunión en curso — la transcripción se actualiza automáticamente
          <style>{`@keyframes livepulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
        </div>
      )}

      <div style={{ marginBottom:20,display:'flex',flexWrap:'wrap',gap:4 }}>
        {[['transcription','📄 Transcripción'],['acta','📋 Acta'],['tareas','✅ Tareas'],['adjuntos','📎 Adjuntos'],['video','🎬 Video']].map(([k,label])=>(
          <button key={k} onClick={()=>setActiveTab(k)} style={tabStyle(activeTab===k)}>{label}</button>
        ))}
      </div>

      {/* TRANSCRIPCIÓN */}
      {activeTab==='transcription'&&(
        <div>
          <h2>Transcripción</h2>
          {transcription.length===0 ? (
            <div style={{ padding:20,backgroundColor:'#fff3cd',borderRadius:8,border:'1px solid #ffc107' }}>
              <p><strong>Transcripción no disponible todavía</strong></p>
              <p>Puede estar procesándose o no hay cuota disponible en Groq.</p>
            </div>
          ) : (
            <>
              <div style={{ maxHeight:500,overflowY:'auto',padding:15,backgroundColor:'#f9f9f9',borderRadius:8 }}>
                {transcription.map((item,index)=>(
                  <div key={index} style={{ marginBottom:10,padding:10,backgroundColor:'white',borderRadius:4 }}>
                    <strong style={{ color:'#2196F3' }}>{item.speaker}:</strong> {item.text}
                  </div>
                ))}
              </div>
              <div style={{ marginTop:12 }}>
                <button onClick={()=>{
                  const text=transcription.map(t=>`[${t.speaker}]: ${t.text}`).join('\n');
                  const blob=new Blob([text],{type:'text/plain;charset=utf-8'});
                  const url=URL.createObjectURL(blob); const a=document.createElement('a');
                  a.href=url; a.download=`Transcripcion_${meeting?.cliente||'reunion'}.txt`; a.click(); URL.revokeObjectURL(url);
                }} style={{ padding:'8px 18px',backgroundColor:'#f0fdf4',color:'#15803d',border:'1px solid #86efac',borderRadius:6,fontSize:13,cursor:'pointer',fontWeight:600 }}>
                  ⬇️ Descargar transcripción .txt
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ACTA */}
      {activeTab==='acta'&&(
        <div>
          <h2>Acta</h2>
          {!actaDraft ? (
            <div style={{ padding:20,backgroundColor:'#fff3cd',borderRadius:8,border:'1px solid #ffc107' }}>
              <p><strong>Acta no disponible todavía.</strong> Se genera al finalizar la reunión.</p>
              {meeting.status==='ended'&&<button onClick={async()=>{const r=await apiFetch(`/meetings/${id}/reprocess-acta`,{method:'POST'});if(r.ok)alert('Procesando...');}} style={{...btnStyle('#9C27B0'),marginTop:10}}>Generar Acta Ahora</button>}
            </div>
          ) : (
            <div>
              <div style={{ marginBottom:16,display:'flex',flexWrap:'wrap',gap:4 }}>
                {/* Solo el creador puede editar durante reunión activa; invitado puede editar después */}
                {(!isActive || isOwner) && (
                  <button onClick={()=>{if(editingActa){setActaDraft(acta);setActaDirty(false);}setEditingActa(v=>!v);}} style={btnStyle(editingActa?'#757575':'#455a64')}>{editingActa?'✕ Cancelar':'✏️ Editar acta'}</button>
                )}
                {(!isActive || isOwner) && (
                  <button onClick={saveActa} disabled={!actaDirty||savingActa} style={btnStyle('#1565C0',!actaDirty||savingActa)}>{savingActa?'Guardando…':'💾 Guardar'}</button>
                )}
                <button onClick={()=>generarPDF(actaDraft||acta,meeting)} style={btnStyle('#E53935')}>📄 PDF</button>
                {(!isActive || isOwner) && (
                  <button onClick={async()=>{if(!confirm('¿Reprocesar acta?'))return;const r=await apiFetch(`/meetings/${id}/reprocess-acta`,{method:'POST'});if(r.ok){alert('Reprocesando...');setTimeout(fetchMeetingData,5000);}}} style={btnStyle('#9C27B0')}>🔄 Reprocesar</button>
                )}
              </div>
              {editingActa&&<div style={{ marginBottom:14,padding:'10px 16px',backgroundColor:'#E3F2FD',borderRadius:8,fontSize:13,color:'#1565C0',borderLeft:'4px solid #2196F3' }}>✏️ Modo edición activo</div>}
              <div>
                <div style={{ padding:20,border:'1px solid #e8ecf0',borderRadius:10,backgroundColor:'white' }}>
                  <h3 style={{ marginBottom:18,color:'#1565C0',borderBottom:'2px solid #E3F2FD',paddingBottom:8 }}>Vista del Acta</h3>
                  <div style={{ marginBottom:20,padding:14,backgroundColor:'#f8f9fa',borderRadius:8,border:'1px solid #e9ecef' }}>
                    <h4 style={{ marginBottom:12,color:'#444',fontSize:13,textTransform:'uppercase',letterSpacing:'.5px' }}>📋 Identificación</h4>
                    <div style={{ display:'grid',gridTemplateColumns:'110px 1fr',gap:'8px 10px',fontSize:13 }}>
                      {['cliente','proyecto','fecha','hora_inicio','hora_fin','responsable'].map(k=>{
                        const val=actaDraft.identificacion?.[k]??'';
                        return (
                          <div key={k} style={{ display:'contents' }}>
                            <div style={{ fontWeight:600,color:'#666',alignSelf:'center' }}>{k.replace('_',' ')}</div>
                            {editingActa ? (
                              <input value={val} onChange={e=>{setActaDraft(a=>({...a,identificacion:{...(a.identificacion||{}),[k]:e.target.value}}));setActaDirty(true);}} style={fieldStyle(true)} type={k.includes('hora')?'time':k==='fecha'?'date':'text'} />
                            ) : <div style={{ color:'#333',padding:'2px 0' }}>{val||'—'}</div>}
                          </div>
                        );
                      })}
                      <div style={{ fontWeight:600,color:'#666',alignSelf:'center' }}>participantes</div>
                      {editingActa ? (
                        <input value={(actaDraft.identificacion?.participantes||[]).join(', ')} onChange={e=>{const arr=e.target.value.split(/[,;]/).map(s=>s.trim()).filter(Boolean);setActaDraft(a=>({...a,identificacion:{...(a.identificacion||{}),participantes:arr}}));setActaDirty(true);}} style={fieldStyle(true)} placeholder="Nombre 1, Nombre 2..." />
                      ) : <div style={{ color:'#333',padding:'2px 0' }}>{(actaDraft.identificacion?.participantes||[]).join(', ')||'—'}</div>}
                    </div>
                  </div>
                  {renderTareasActa('tareas_anteriores','Tareas Anteriores')}
                  {renderTareasActa('tareas_nuevas','Tareas Nuevas')}
                  <div style={{ marginBottom:16 }}>
                    <h4 style={{ marginBottom:8,color:'#333',fontSize:13 }}>Resumen de la reunión</h4>
                    {editingActa ? (
                      <textarea value={actaDraft.resumen_reunion||''} onChange={e=>{setActaDraft(a=>({...a,resumen_reunion:e.target.value}));setActaDirty(true);}} rows={5} style={{...fieldStyle(true),resize:'vertical',lineHeight:1.6}} />
                    ) : <p style={{ fontSize:13,lineHeight:1.7,color:'#333',margin:0,padding:'8px 12px',backgroundColor:'#fafafa',borderRadius:6,border:'1px solid #eee' }}>{actaDraft.resumen_reunion||'—'}</p>}
                  </div>
                  <div>
                    <h4 style={{ marginBottom:8,color:'#333',fontSize:13 }}>Observaciones generales</h4>
                    {editingActa ? (
                      <textarea value={actaDraft.observaciones_generales||''} onChange={e=>{setActaDraft(a=>({...a,observaciones_generales:e.target.value}));setActaDirty(true);}} rows={3} style={{...fieldStyle(true),resize:'vertical',lineHeight:1.6}} />
                    ) : <p style={{ fontSize:13,lineHeight:1.7,color:'#333',margin:0,padding:'8px 12px',backgroundColor:'#fafafa',borderRadius:6,border:'1px solid #eee' }}>{actaDraft.observaciones_generales||'—'}</p>}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAREAS */}
      {activeTab==='tareas'&&(
        <div>
          <h2>Tareas</h2>
          {tareasDraft.length===0 ? (
            <div>
              <p style={{ color:'#666' }}>No hay tareas registradas.</p>
              <button onClick={agregarTareaTab} style={btnStyle('#2E7D32')}>➕ Agregar tarea</button>
            </div>
          ) : (
            <div>
              <div style={{ marginBottom:12,display:'flex',flexWrap:'wrap',gap:6,alignItems:'center' }}>
                {(!isActive || isOwner) && (
                  <button onClick={saveTareas} disabled={!tareasDirty||savingTareas} style={btnStyle('#1565C0',!tareasDirty||savingTareas)}>{savingTareas?'Guardando…':'💾 Guardar cambios'}</button>
                )}
                {(!isActive || isOwner) && (
                  <button onClick={agregarTareaTab} style={btnStyle('#2E7D32')}>➕ Agregar</button>
                )}
                <button onClick={descargarExcel} style={btnStyle('#388E3C')}>📥 Excel</button>
                {tareasDirty&&<span style={{ fontSize:12,color:'#e65100' }}>● Cambios sin guardar</span>}
              </div>
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%',borderCollapse:'collapse',fontSize:13,minWidth:700 }}>
                  <thead>
                    <tr style={{ backgroundColor:'#1565C0',color:'white' }}>
                      {['ID','Asunto / Descripción','Responsable','Estado','Prioridad','Fecha','Acciones'].map((h,i)=>(
                        <th key={i} style={{ padding:'11px 10px',textAlign:'left',fontWeight:600,fontSize:12 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tareasDraft.map((t,idx)=>(
                      <tr key={t.id??`t_${idx}`} style={{ borderBottom:'1px solid #eee',backgroundColor:idx%2===0?'white':'#fafbfc' }}>
                        <td style={{ padding:'10px',fontSize:12,color:'#1565C0',fontWeight:600 }}>{t.tarea_id||'—'}</td>
                        <td style={{ padding:'10px',maxWidth:240 }}>
                          {t.asunto&&<div style={{ fontSize:12,fontWeight:600,color:'#333',marginBottom:2 }}>{t.asunto}</div>}
                          <div style={{ fontSize:12,color:'#666',lineHeight:1.4 }}>{t.descripcion||<em style={{color:'#bbb'}}>Sin descripción</em>}</div>
                        </td>
                        <td style={{ padding:'10px',fontSize:13,color:'#555' }}>{t.responsable||'—'}</td>
                        <td style={{ padding:'10px' }}><span style={estadoBadge(t.estado_tarea,t.estado)}>{ESTADOS_LABEL[t.estado_tarea]||t.estado||'pendiente'}</span></td>
                        <td style={{ padding:'10px',fontSize:13 }}>{PRIO_ICON[t.prioridad]||'🟡'}</td>
                        <td style={{ padding:'10px',fontSize:12,color:'#666' }}>{t.fecha_compromiso||'—'}</td>
                        <td style={{ padding:'10px' }}>
                          <div style={{ display:'flex',gap:6 }}>
                            <button onClick={()=>abrirModalTareas(idx)} style={{ padding:'6px 12px',backgroundColor:'#E3F2FD',color:'#1565C0',border:'1px solid #90CAF9',borderRadius:5,cursor:'pointer',fontSize:12,fontWeight:600 }}>✏️</button>
                            <button onClick={()=>{if(confirm(`¿Eliminar ${t.tarea_id||`#${idx+1}`}?`))eliminarTareaTab(idx);}} style={{ padding:'6px 12px',backgroundColor:'#fff8f8',color:'#c62828',border:'1px solid #ffcdd2',borderRadius:5,cursor:'pointer',fontSize:12,fontWeight:600 }}>🗑️</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VIDEO */}
      {activeTab==='video'&&(
        <div>
          <h2>Video de la reunión</h2>
          <p style={{ fontSize:13, color:'#666', marginBottom:16 }}>
            Solo visible para usuarios internos con acceso a esta reunión. Los clientes no ven este video.
          </p>
          {!recording?.exists ? (
            <div style={{ padding:30, backgroundColor:'#f9fafb', borderRadius:8, textAlign:'center', color:'#888', border:'1px dashed #ddd' }}>
              <div style={{ fontSize:40, marginBottom:10 }}>🎬</div>
              <p style={{ margin:0, fontSize:14 }}>No hay video grabado para esta reunión.</p>
              <p style={{ margin:'6px 0 0', fontSize:12 }}>Las reuniones deben grabarse en modo "Video + Audio" para tener grabación disponible.</p>
            </div>
          ) : (
            <div>
              <div style={{ marginBottom:12, padding:'8px 14px', backgroundColor:'#F0FDF4', borderRadius:6, fontSize:12, color:'#15803d', display:'flex', alignItems:'center', gap:8 }}>
                Video disponible · {recording.size_mb} MB ·
                Grabado el {new Date(recording.created_at).toLocaleString('es-ES')}
              </div>
              {!videoUrl ? (
                <div style={{ textAlign:'center', padding:20 }}>
                  <button onClick={async () => {
                    const token = localStorage.getItem('auth_token');
                    const res   = await fetch(`${import.meta.env.VITE_API_BASE_URL}/meetings/${id}/recording/stream`, {
                      headers: { Authorization: `Bearer ${token}` }
                    });
                    if (!res.ok) { alert('Error al cargar el video'); return; }
                    const blob = await res.blob();
                    setVideoUrl(URL.createObjectURL(blob));
                  }} style={{ padding:'12px 28px', backgroundColor:'#7c3aed', color:'white', border:'none', borderRadius:8, fontSize:14, fontWeight:600, cursor:'pointer' }}>
                    Cargar video
                  </button>
                  <p style={{ fontSize:12, color:'#888', marginTop:8 }}>El video se carga bajo demanda para ahorrar ancho de banda.</p>
                </div>
              ) : (
                <div>
                  <video
                    src={videoUrl}
                    controls
                    style={{ width:'100%', borderRadius:8, backgroundColor:'#000', maxHeight:500 }}
                    onError={() => alert('Error reproduciendo el video')}
                  />
                  <div style={{ marginTop:8, display:'flex', gap:8 }}>
                    <button onClick={() => {
                      // Se descarga como .mp4 para compatibilidad con reproductores externos.
                      // El contenido sigue siendo webm pero la mayoría de reproductores lo abren igual.
                      const a = document.createElement('a');
                      a.href = videoUrl;
                      a.download = `Reunion_${(meeting?.cliente||'').replace(/[^a-z0-9]/gi,'_')}_${(meeting?.proyecto||'').replace(/[^a-z0-9]/gi,'_')}.mp4`;
                      a.click();
                    }} style={{ padding:'8px 16px', backgroundColor:'#1565C0', color:'white', border:'none', borderRadius:6, fontSize:13, cursor:'pointer', fontWeight:600 }}>
                      Descargar video (.mp4)
                    </button>
                    <button onClick={() => { URL.revokeObjectURL(videoUrl); setVideoUrl(null); }}
                      style={{ padding:'8px 16px', backgroundColor:'#f1f5f9', color:'#475569', border:'1px solid #e2e8f0', borderRadius:6, fontSize:13, cursor:'pointer' }}>
                      Cerrar reproductor
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ADJUNTOS */}
      {activeTab==='adjuntos'&&(
        <div>
          <h2>Adjuntos y Notas</h2>
          <AttachmentsPanel meetingId={id} />
        </div>
      )}
    </div>
  );
}

export default MeetingDetail;
