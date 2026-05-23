import { apiFetch } from '../utils/api';
import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

function safeJsonParseArray(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

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

// ─── PDF ─────────────────────────────────────────────────────────────────────
function generarPDF(acta, meeting) {
  const doc   = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 18; const contentW = pageW - margin * 2;
  let y = 0;
  // — Cabecera azul corporativa —
  doc.setFillColor(30, 58, 95);
  doc.rect(0, 0, pageW, 28, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(14);
  doc.setTextColor(255, 255, 255);
  doc.text('ACTA DE REUNIÓN', margin, 12);
  doc.setFontSize(9); doc.setFont('helvetica','normal');
  doc.text('dataella.tech', pageW - margin, 12, { align: 'right' });
  doc.setFontSize(8);
  doc.text(`Generado: ${new Date().toLocaleDateString('es-ES')}`, pageW - margin, 20, { align: 'right' });
  y = 36;
  const colors = { black:[15,23,42], dark:[55,65,81], gray:[107,114,128],
    light:[248,250,252], border:[199,212,232], accent:[37,99,235] };
  const checkPage = (n=10) => {
    if (y + n > pageH - 18) {
      doc.addPage();
      doc.setFillColor(30, 58, 95);
      doc.rect(0, 0, pageW, 8, 'F');
      y = 16;
    }
  };
  const sectionTitle = (text) => {
    checkPage(14);
    doc.setFillColor(...colors.accent);
    doc.rect(margin, y, contentW, 7, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(9);
    doc.setTextColor(255,255,255);
    doc.text(text.toUpperCase(), margin + 3, y + 5);
    y += 11;
    doc.setTextColor(...colors.black);
  };
  const textBlock = (text) => {
    if (!text) return;
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.setTextColor(...colors.dark);
    doc.splitTextToSize(String(text), contentW).forEach(l => {
      checkPage(6); doc.text(l, margin, y); y += 5;
    }); y += 3;
  };
  // — Identificación —
  sectionTitle('Identificación de la reunión');
  const id = acta.identificacion || {};
  const startedDate = meeting?.started_at ? new Date(meeting.started_at) : null;
  const endedDate   = meeting?.ended_at   ? new Date(meeting.ended_at)   : null;
  const fields = [
    ['Cliente', id.cliente],
    ['Proyecto', id.proyecto],
    ['Responsable', id.responsable],
    ['Fecha', id.fecha||(startedDate?startedDate.toISOString().split('T')[0]:'')],
    ['Hora inicio', id.hora_inicio||(startedDate?startedDate.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}):'' )],
    ['Hora fin', id.hora_fin||(endedDate?endedDate.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}):'' )],
    ['Participantes', Array.isArray(id.participantes)?id.participantes.join(', '):id.participantes],
  ];
  fields.forEach(([lbl, val], i) => {
    checkPage(7);
    if (i % 2 === 0) { doc.setFillColor(...colors.light); doc.rect(margin, y-3, contentW, 7, 'F'); }
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...colors.gray);
    doc.text(lbl.toUpperCase(), margin + 2, y + 1);
    doc.setFont('helvetica','normal'); doc.setTextColor(...colors.black);
    doc.text(String(val||'—'), margin + 38, y + 1);
    y += 7;
  });
  y += 4;
  const tableOpts = (head, body) => ({
    margin: { left: margin, right: margin }, startY: y, head, body,
    styles: { fontSize:8.5, cellPadding:3, textColor:colors.black, lineColor:colors.border, lineWidth:0.15 },
    headStyles: { fillColor:[30,58,95], textColor:[255,255,255], fontStyle:'bold', fontSize:8.5 },
    alternateRowStyles: { fillColor: colors.light },
    didDrawPage: () => { y = doc.lastAutoTable?.finalY + 6 || y; }
  });
  // — Tareas anteriores —
  sectionTitle('Tareas anteriores');
  const tareasAnt = acta.tareas_anteriores || [];
  if (!tareasAnt.length) { doc.setFontSize(9); doc.setTextColor(...colors.gray); doc.text('Sin tareas anteriores.', margin, y); y+=8; }
  else { autoTable(doc, tableOpts([['ID','Descripción','Responsable','Estado']], tareasAnt.map(t=>[t.id||'',t.descripcion||'',t.responsable||'',t.estado||'']))); y=doc.lastAutoTable.finalY+8; }
  // — Tareas nuevas —
  checkPage(20); sectionTitle('Tareas nuevas con fecha de compromiso');
  const tareasNuevas = acta.tareas_nuevas || [];
  if (!tareasNuevas.length) { doc.setFontSize(9); doc.setTextColor(...colors.gray); doc.text('Sin tareas nuevas.', margin, y); y+=8; }
  else { autoTable(doc, tableOpts([['ID','Descripción','Responsable','Fecha compromiso']], tareasNuevas.map(t=>[t.id||'',t.descripcion||'',t.responsable||'',t.fecha_compromiso||'']))); y=doc.lastAutoTable.finalY+8; }
  // — Resumen —
  checkPage(20); sectionTitle('Resumen ejecutivo de la reunión');
  textBlock(acta.resumen_reunion);
  if (acta.observaciones_generales) { checkPage(20); sectionTitle('Observaciones generales'); textBlock(acta.observaciones_generales); }
  // — Footer con numeración —
  const total = doc.internal.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFillColor(30, 58, 95); doc.rect(0, pageH-10, pageW, 10, 'F');
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(255,255,255);
    doc.text(`Sistema de Actas · dataella.tech`, margin, pageH-4);
    doc.text(`Página ${i} de ${total}`, pageW-margin, pageH-4, { align:'right' });
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

// ─── Modal edición de tarea ───────────────────────────────────────────────────
function ModalEditarTarea({ tarea, onSave, onClose, mostrarFecha = true }) {
  const [form, setForm] = useState({ ...tarea });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const labelStyle = { display:'block', marginBottom:4, fontSize:12, fontWeight:600, color:'#555' };
  const inputStyle = { width:'100%', padding:'9px 12px', border:'1px solid #dde1e7', borderRadius:6, fontSize:14, boxSizing:'border-box', outline:'none', backgroundColor:'#fff' };
  return (
    <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ backgroundColor:'white', borderRadius:12, width:'100%', maxWidth:520, boxShadow:'0 20px 60px rgba(0,0,0,0.25)', overflow:'hidden' }}>
        <div style={{ padding:'18px 24px', borderBottom:'1px solid #eee', display:'flex', justifyContent:'space-between', alignItems:'center', backgroundColor:'#1565C0' }}>
          <div>
            <div style={{ fontSize:11, color:'rgba(255,255,255,0.7)', fontWeight:500, marginBottom:2 }}>Editando tarea</div>
            <div style={{ fontSize:15, fontWeight:700, color:'white' }}>{form.id || form.tarea_id || 'Sin ID'}</div>
          </div>
          <button onClick={onClose} style={{ background:'rgba(255,255,255,0.15)', border:'none', borderRadius:6, color:'white', fontSize:18, width:32, height:32, cursor:'pointer' }}>×</button>
        </div>
        <div style={{ padding:24, display:'flex', flexDirection:'column', gap:16 }}>
          {tarea.id !== undefined && (
            <div><label style={labelStyle}>ID de tarea</label><input value={form.id||''} onChange={e=>set('id',e.target.value)} style={inputStyle} /></div>
          )}
          <div>
            <label style={labelStyle}>Descripción</label>
            <textarea value={form.descripcion||''} onChange={e=>set('descripcion',e.target.value)} rows={4} style={{...inputStyle, resize:'vertical', lineHeight:1.5}} placeholder="Describe la tarea..." />
          </div>
          <div>
            <div><label style={labelStyle}>Responsable</label><input value={form.responsable||''} onChange={e=>set('responsable',e.target.value)} style={inputStyle} /></div>
            <div>
              <label style={labelStyle}>Estado</label>
              <select value={form.estado||'pendiente'} onChange={e=>set('estado',e.target.value)} style={{...inputStyle, cursor:'pointer'}}>
                {['pendiente','en progreso','completada','cancelada'].map(s=><option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          {mostrarFecha && (
            <div><label style={labelStyle}>Fecha compromiso</label><input type="date" value={form.fecha_compromiso||''} onChange={e=>set('fecha_compromiso',e.target.value)} style={inputStyle} /></div>
          )}
        </div>
        <div style={{ padding:'16px 24px', borderTop:'1px solid #eee', display:'flex', justifyContent:'flex-end', gap:10, backgroundColor:'#fafafa' }}>
          <button onClick={onClose} style={{ padding:'9px 20px', border:'1px solid #ddd', borderRadius:6, background:'white', fontSize:13, cursor:'pointer', color:'#555' }}>Cancelar</button>
          <button onClick={() => { onSave(form); onClose(); }} style={{ padding:'9px 22px', border:'none', borderRadius:6, background:'#1565C0', color:'white', fontSize:13, cursor:'pointer', fontWeight:600 }}>✓ Aplicar</button>
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
    // Polling para actualizar estado de transcripción de audios
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
      if (res.ok) {
        setNewNote('');
        setNewNoteAuthor('');
        await fetchData();
      }
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
    return (
      <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, backgroundColor: s.bg, color: s.color }}>
        {s.label}
      </span>
    );
  };

  if (loading) return <div style={{ padding: 20, color: '#666' }}>Cargando adjuntos...</div>;

  const sectionTitle = { fontSize: 14, fontWeight: 700, color: '#1565C0', marginBottom: 12, marginTop: 0 };
  const cardStyle = { padding: '12px 14px', borderRadius: 8, border: '1px solid #e8ecf0', backgroundColor: '#fafbfc', marginBottom: 8 };

  return (
    <div>
      <div style={{
        padding: '12px 16px', backgroundColor: '#e8f5e9', borderRadius: 8,
        border: '1px solid #c8e6c9', marginBottom: 20, fontSize: 13, color: '#2e7d32'
      }}>
        📌 <strong>Las notas y audios aquí agregados se incluirán automáticamente en el acta final.</strong>
        {' '}Úsalos para complementar la grabación con aportes de otros participantes.
      </div>

      {/* ── NOTAS DE TEXTO ──────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 28 }}>
        <h3 style={sectionTitle}>📝 Notas de texto ({notes.length})</h3>

        {/* Agregar nota */}
        <div style={{ padding: 16, backgroundColor: '#f8f9fa', borderRadius: 8, border: '1px solid #dee2e6', marginBottom: 14 }}>
          <div style={{ marginBottom: 10 }}>
            <input
              value={newNoteAuthor}
              onChange={e => setNewNoteAuthor(e.target.value)}
              placeholder="Autor (opcional) — ej: Juan Pérez"
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }}
            />
          </div>
          <textarea
            value={newNote}
            onChange={e => setNewNote(e.target.value)}
            placeholder="Escribe aquí las notas del participante... Puedes pegar texto, bullets, decisiones, etc."
            rows={4}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13, resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.5 }}
          />
          <button
            onClick={handleAddNote}
            disabled={!newNote.trim() || addingNote}
            style={{
              marginTop: 8, padding: '8px 18px', backgroundColor: !newNote.trim() || addingNote ? '#ccc' : '#1565C0',
              color: 'white', border: 'none', borderRadius: 6, fontSize: 13, cursor: !newNote.trim() || addingNote ? 'default' : 'pointer', fontWeight: 600
            }}
          >
            {addingNote ? '⏳ Guardando...' : '➕ Agregar nota'}
          </button>
        </div>

        {/* Lista de notas */}
        {notes.length === 0 ? (
          <p style={{ color: '#999', fontSize: 13, fontStyle: 'italic' }}>No hay notas agregadas aún.</p>
        ) : (
          notes.map(note => (
            <div key={note.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  {note.author && (
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#1565C0', marginBottom: 4 }}>
                      👤 {note.author}
                    </div>
                  )}
                  <div style={{ fontSize: 13, color: '#333', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                    {note.content}
                  </div>
                  <div style={{ fontSize: 11, color: '#999', marginTop: 6 }}>
                    {new Date(note.created_at).toLocaleString('es-ES')}
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteNote(note.id)}
                  style={{ background: 'none', border: 'none', color: '#dc3545', cursor: 'pointer', fontSize: 16, padding: '2px 6px', flexShrink: 0 }}
                  title="Eliminar nota"
                >
                  🗑️
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── ARCHIVOS ADJUNTOS ────────────────────────────────────────────────── */}
      <div>
        <h3 style={sectionTitle}>📎 Archivos adjuntos ({attachments.length})</h3>

        {/* Subir archivo */}
        <div style={{ marginBottom: 14 }}>
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '10px 18px', backgroundColor: uploadingFile ? '#6c757d' : '#495057',
            color: 'white', borderRadius: 6, fontSize: 13, fontWeight: 600,
            cursor: uploadingFile ? 'default' : 'pointer'
          }}>
            {uploadingFile ? '⏳ Subiendo...' : '⬆️ Subir archivo'}
            <input
              type="file"
              accept="audio/*,.mp3,.wav,.m4a,.ogg,.pdf,.doc,.docx,.txt,.jpg,.jpeg,.png"
              onChange={handleUploadFile}
              disabled={uploadingFile}
              style={{ display: 'none' }}
            />
          </label>
          <p style={{ marginTop: 8, fontSize: 12, color: '#777' }}>
            <strong>Audios (MP3, WAV, M4A, OGG):</strong> se transcriben automáticamente con Whisper y se incluyen en el acta.<br/>
            <strong>Documentos (PDF, Word, imágenes):</strong> se guardan como adjunto de referencia.
          </p>
        </div>

        {/* Lista de adjuntos */}
        {attachments.length === 0 ? (
          <p style={{ color: '#999', fontSize: 13, fontStyle: 'italic' }}>No hay archivos adjuntos.</p>
        ) : (
          attachments.map(att => (
            <div key={att.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 16 }}>{att.file_type === 'audio' ? '🎵' : '📄'}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {att.file_name}
                    </span>
                    {transcriptionStatusBadge(att.transcription_status)}
                  </div>
                  <div style={{ fontSize: 11, color: '#999' }}>
                    {att.file_type === 'audio' ? 'Audio' : 'Documento'} · {new Date(att.uploaded_at).toLocaleString('es-ES')}
                  </div>
                  {att.transcription_status === 'processing' && (
                    <div style={{ fontSize: 12, color: '#084298', marginTop: 4 }}>
                      Transcribiendo con Whisper... puede tomar un momento.
                    </div>
                  )}
                  {att.transcription_status === 'done' && (
                    <div style={{ fontSize: 12, color: '#0a3622', marginTop: 4 }}>
                      ✅ Transcripción lista — será incluida en el acta al finalizar o reprocesar.
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {att.file_type === 'document' && (
                    <button
  onClick={async () => {
    const token = localStorage.getItem('auth_token');
    const res = await fetch(
      `${import.meta.env.VITE_API_BASE_URL}/meetings/${meetingId}/attachments/${att.id}/download`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) { alert('Error al descargar'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = att.file_name; a.click();
    URL.revokeObjectURL(url);
  }}
  style={{ padding:'6px 10px', backgroundColor:'#e3f2fd', color:'#1565C0',
    border:'1px solid #90CAF9', borderRadius:5, fontSize:12, cursor:'pointer', fontWeight:600 }}
>
  ⬇️ Descargar
</button>

                  )}
                  <button
                    onClick={() => handleDeleteAttachment(att.id)}
                    style={{ padding: '6px 10px', backgroundColor: '#fff8f8', color: '#c62828', border: '1px solid #ffcdd2', borderRadius: 5, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
                    title="Eliminar adjunto"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
function MeetingDetail() {
  const { id } = useParams();
  const [meeting, setMeeting]         = useState(null);
  const [transcription, setTranscription] = useState([]);
  const [acta, setActa]               = useState(null);
  const [actaDraft, setActaDraft]     = useState(null);
  const [editingActa, setEditingActa] = useState(false);
  const [savingActa, setSavingActa]   = useState(false);
  const [actaDirty, setActaDirty]     = useState(false);
  const [tareas, setTareas]           = useState([]);
  const [tareasDraft, setTareasDraft] = useState([]);
  const [savingTareas, setSavingTareas] = useState(false);
  const [tareasDirty, setTareasDirty] = useState(false);
  const [activeTab, setActiveTab]     = useState('transcription');
  const [loading, setLoading]         = useState(true);
  const [modal, setModal]             = useState(null);
  const [approvedAt, setApprovedAt]   = useState(null);
  const [approvedBy, setApprovedBy]   = useState(null);

  const isEditingAny = editingActa || modal !== null;

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
        apiFetch(`/meetings/${id}/acta`).catch(() => null),
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
        if (!tareasDirty) setTareasDraft(tareasData.map(t => ({ ...t })));
      }
      setLoading(false);
    } catch (e) { console.error(e); setLoading(false); }
  }, [id, isEditingAny, actaDirty, tareasDirty, editingActa]);

  const saveActa = async () => {
    if (!actaDraft) return;
    setSavingActa(true);
    try {
      const resActa = await apiFetch(`/meetings/${id}/acta`, {
        method:'PUT', body:JSON.stringify(actaDraft)
      });
      if (!resActa.ok) { alert(`Error al guardar acta (${resActa.status})`); setSavingActa(false); return; }
      const tareasSync = syncActaToTareas(tareasDraft, actaDraft);
      const payload = tareasSync.map(t => ({ tarea_id:t.tarea_id||'', tipo:t.tipo||'nueva', descripcion:t.descripcion||'', responsable:t.responsable||'', estado:t.estado||'pendiente', fecha_compromiso:t.fecha_compromiso||'' }));
      await apiFetch(`/meetings/${id}/tareas`, { method:'PUT', body:JSON.stringify(payload) });
      setActa(actaDraft); setActaDirty(false); setEditingActa(false);
      setTareasDraft(tareasSync); setTareas(tareasSync); setTareasDirty(false);
      alert('Acta guardada y tareas sincronizadas');
    } catch (e) { alert('Error: ' + e.message); }
    setSavingActa(false);
  };

  const saveTareas = async () => {
    setSavingTareas(true);
    try {
      const payload = tareasDraft.map(t => ({ tarea_id:t.tarea_id||'', tipo:t.tipo||'nueva', descripcion:t.descripcion||'', responsable:t.responsable||'', estado:t.estado||'pendiente', fecha_compromiso:t.fecha_compromiso||'' }));
      const resTareas = await apiFetch(`/meetings/${id}/tareas`, { method:'PUT', body:JSON.stringify(payload) });
      if (!resTareas.ok) { alert(`Error (${resTareas.status})`); setSavingTareas(false); return; }
      if (actaDraft) {
        const actaSync = syncTareasToActa(actaDraft, tareasDraft);
        await apiFetch(`/meetings/${id}/acta`, { method:'PUT', body:JSON.stringify(actaSync) });
        setActaDraft(actaSync); setActa(actaSync); setActaDirty(false);
      }
      setTareas(tareasDraft); setTareasDirty(false);
      alert('Tareas guardadas y acta sincronizada');
    } catch (e) { alert('Error: ' + e.message); }
    setSavingTareas(false);
  };

  const abrirModalActa   = (tipo, idx)  => setModal({ origen:'acta', tipo, idx, tarea: actaDraft[tipo][idx] });
  const abrirModalTareas = (idx)        => setModal({ origen:'tareas', idx, tarea: { ...tareasDraft[idx] } });

  const aplicarModal = (formData) => {
    if (!modal) return;
    if (modal.origen === 'acta') {
      setActaDraft(a => { const arr=[...(a[modal.tipo]||[])]; arr[modal.idx]={...arr[modal.idx],...formData}; return {...a,[modal.tipo]:arr}; });
      setActaDirty(true);
    } else {
      setTareasDraft(arr => arr.map((item,i) => i===modal.idx ? {...item,...formData} : item));
      setTareasDirty(true);
    }
  };

  const generarIdTarea = (tipo) => {
    const prefix = tipo==='tareas_anteriores'?'ant_':'tarea_';
    const existentes = [...(actaDraft?.tareas_nuevas||[]).map(t=>t.id||''), ...(actaDraft?.tareas_anteriores||[]).map(t=>t.id||''), ...tareasDraft.map(t=>t.tarea_id||'')];
    let n=existentes.length+1;
    let c=`${prefix}${String(n).padStart(3,'0')}`;
    while(existentes.includes(c)){n++;c=`${prefix}${String(n).padStart(3,'0')}`;}
    return c;
  };

  const agregarTareaActa = (tipo) => {
    const newId = generarIdTarea(tipo);
    const ta = { id:newId, descripcion:'', responsable:'', estado:'pendiente', ...(tipo==='tareas_nuevas'?{fecha_compromiso:''}:{}) };
    const tt = { tarea_id:newId, tipo:tipo==='tareas_nuevas'?'nueva':'anterior', descripcion:'', responsable:'', estado:'pendiente', fecha_compromiso:'' };
    setActaDraft(a=>({...a,[tipo]:[...(a[tipo]||[]),ta]}));
    setTareasDraft(arr=>[...arr,tt]);
    setActaDirty(true); setTareasDirty(true);
    setModal({ origen:'acta', tipo, idx:(actaDraft?.[tipo]||[]).length, tarea:ta });
  };

  const eliminarTareaActa = (tipo, idx) => {
    const tId = actaDraft?.[tipo]?.[idx]?.id;
    setActaDraft(a=>({...a,[tipo]:(a[tipo]||[]).filter((_,i)=>i!==idx)}));
    if(tId) setTareasDraft(arr=>arr.filter(t=>t.tarea_id!==tId));
    setActaDirty(true); setTareasDirty(true);
  };

  const agregarTareaTab = () => {
    const newId = generarIdTarea('tareas_nuevas');
    const tt = { tarea_id:newId, tipo:'nueva', descripcion:'', responsable:'', estado:'pendiente', fecha_compromiso:'' };
    const ta = { id:newId, descripcion:'', responsable:'', estado:'pendiente', fecha_compromiso:'' };
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
  const btnStyle = (color, disabled=false) => ({
    padding:'8px 16px', marginRight:8, marginBottom:4,
    backgroundColor: disabled?'#ccc':color, color:'white', border:'none',
    borderRadius:6, cursor:disabled?'default':'pointer', fontSize:13, fontWeight:500
  });
  const tabStyle = (active) => ({
    padding:'10px 22px', marginRight:8,
    backgroundColor: active?'#1565C0':'#e8eaf6',
    color: active?'white':'#3c4280',
    border:'none', borderRadius:6, cursor:'pointer', fontWeight:active?700:500, fontSize:13
  });
  const fieldStyle = (editing) => ({
    width:'100%', padding:'7px 10px',
    border: editing?'1px solid #90CAF9':'1px solid #e0e0e0',
    borderRadius:5, fontSize:13, boxSizing:'border-box',
    backgroundColor: editing?'#fff':'#fafafa', outline:'none'
  });

  const renderTareasActa = (tipo, label) => {
    const items = actaDraft?.[tipo]||[];
    const esTipoNueva = tipo==='tareas_nuevas';
    return (
      <div style={{ marginBottom:18 }}>
        <div style={{ display:'flex', alignItems:'center', marginBottom:8, gap:8 }}>
          <h4 style={{ margin:0, color:'#333', fontSize:13 }}>{label}</h4>
          <span style={{ fontSize:11, color:'#999', backgroundColor:'#f0f0f0', borderRadius:10, padding:'1px 8px' }}>{items.length}</span>
          {editingActa && (
            <button onClick={()=>agregarTareaActa(tipo)} style={{ marginLeft:'auto', padding:'4px 12px', backgroundColor:'#E8F5E9', color:'#2E7D32', border:'1px solid #A5D6A7', borderRadius:5, cursor:'pointer', fontSize:12, fontWeight:600 }}>➕ Agregar</button>
          )}
        </div>
        {items.length===0 ? (
          <p style={{ color:'#bbb', fontSize:13, fontStyle:'italic', margin:0 }}>Sin {label.toLowerCase()}</p>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {items.map((t,i) => (
              <div key={i} style={{ padding:'10px 12px', borderRadius:7, border:'1px solid #e8ecf0', backgroundColor:'#fafbfc', display:'flex', alignItems:'flex-start', gap:10 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap', marginBottom:3 }}>
                    <span style={{ fontSize:11, fontWeight:700, color:'#1565C0', backgroundColor:'#E3F2FD', padding:'1px 7px', borderRadius:4 }}>{t.id||`#${i+1}`}</span>
                    <span style={estadoBadge(t.estado||'pendiente')}>{t.estado||'pendiente'}</span>
                    {esTipoNueva&&t.fecha_compromiso&&<span style={{ fontSize:11, color:'#777' }}>📅 {t.fecha_compromiso}</span>}
                  </div>
                  <div style={{ fontSize:13, color:'#333', lineHeight:1.4, marginBottom:t.responsable?2:0 }}>{t.descripcion||<em style={{color:'#bbb'}}>Sin descripción</em>}</div>
                  {t.responsable&&<div style={{ fontSize:12, color:'#666' }}>👤 {t.responsable}</div>}
                </div>
                {editingActa&&(
                  <div style={{ display:'flex', gap:4, flexShrink:0 }}>
                    <button onClick={()=>abrirModalActa(tipo,i)} style={{ width:30, height:30, border:'1px solid #ddd', borderRadius:6, backgroundColor:'white', cursor:'pointer', fontSize:14 }}>✏️</button>
                    <button onClick={()=>{if(confirm(`¿Eliminar tarea ${t.id||`#${i+1}`}?`))eliminarTareaActa(tipo,i);}} style={{ width:30, height:30, border:'1px solid #ffcdd2', borderRadius:6, backgroundColor:'#fff8f8', cursor:'pointer', fontSize:14, color:'#c62828' }}>🗑️</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // Determinar si la reunión está activa (grabando o procesando)
  const isActive = meeting.status === 'active';

  return (
    <div>
      {modal && (
        <ModalEditarTarea
          tarea={modal.tarea}
          mostrarFecha={modal.origen==='tareas'||modal.tipo==='tareas_nuevas'}
          onSave={aplicarModal}
          onClose={()=>setModal(null)}
        />
      )}

      <h1 style={{ marginBottom:4 }}>Detalles de Reunión</h1>

      <div style={{ marginBottom:20, padding:15, backgroundColor:'#f5f5f5', borderRadius:8, fontSize:14 }}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:6 }}>
          <div>
            <strong>Estado:</strong>{' '}
            <span style={{ color: isActive ? '#2e7d32' : '#666' }}>
              {isActive ? '🔴 En curso' : meeting.status}
            </span>
          </div>
          <div><strong>Inicio:</strong> {new Date(meeting.started_at).toLocaleString('es-ES')}</div>
          {meeting.ended_at&&<div><strong>Fin:</strong> {new Date(meeting.ended_at).toLocaleString('es-ES')}</div>}
          {meeting.cliente    &&<div><strong>Cliente:</strong> {meeting.cliente}</div>}
          {meeting.proyecto   &&<div><strong>Proyecto:</strong> {meeting.proyecto}</div>}
          {meeting.responsable&&<div><strong>Responsable:</strong> {meeting.responsable}</div>}
          {participantes.length>0&&<div><strong>Participantes:</strong> {participantes.join(', ')}</div>}
        </div>
      </div>

      {/* Approval banner */}
      {approvedAt && (
        <div style={{ padding:'12px 16px', backgroundColor:'#f0fdf4', border:'1px solid #86efac', borderRadius:8, marginBottom:16, display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:20 }}>✅</span>
          <div>
            <div style={{ fontWeight:700, color:'#15803d', fontSize:14 }}>Acta aprobada por el cliente</div>
            <div style={{ fontSize:12, color:'#4ade80' }}>
              Aprobada el {new Date(approvedAt).toLocaleDateString('es-ES', { day:'2-digit', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' })}
              {approvedBy && ` · por ${approvedBy}`} — <strong>No puede modificarse</strong>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ marginBottom:20, display:'flex', flexWrap:'wrap', gap:4 }}>
        {[['transcription','📄 Transcripción'],['acta','📋 Acta'],['tareas','✅ Tareas'],['adjuntos','📎 Adjuntos']].map(([k,label]) => (
          <button key={k} onClick={()=>setActiveTab(k)} style={tabStyle(activeTab===k)}>{label}</button>
        ))}
      </div>

      {/* ── TRANSCRIPCIÓN ── */}
      {activeTab==='transcription'&&(
        <div>
          <h2>Transcripción</h2>
          {transcription.length===0 ? (
            <div style={{ padding:20, backgroundColor:'#fff3cd', borderRadius:8, border:'1px solid #ffc107' }}>
              <p><strong>Transcripción no disponible todavía</strong></p>
              <p>Puede estar procesándose o no hay cuota disponible en Groq.</p>
            </div>
          ) : (
            <div style={{ maxHeight:500, overflowY:'auto', padding:15, backgroundColor:'#f9f9f9', borderRadius:8 }}>
              {transcription.map((item,index) => (
                <div key={index} style={{ marginBottom:10, padding:10, backgroundColor:'white', borderRadius:4 }}>
                  <strong style={{ color:'#2196F3' }}>{item.speaker}:</strong> {item.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── ACTA ── */}
      {activeTab==='acta'&&(
        <div>
          <h2>Acta</h2>
          {!actaDraft ? (
            <div style={{ padding:20, backgroundColor:'#fff3cd', borderRadius:8, border:'1px solid #ffc107' }}>
              <p><strong>Acta no disponible todavía.</strong> Se genera al finalizar la reunión.</p>
              {meeting.status==='ended'&&(
                <button onClick={async()=>{const r=await apiFetch(`/meetings/${id}/reprocess-acta`,{method:'POST'});if(r.ok)alert('Procesando... recarga en 30 segundos.');}} style={{...btnStyle('#9C27B0'),marginTop:10}}>Generar Acta Ahora</button>
              )}
            </div>
          ) : (
            <div>
              <div style={{ marginBottom:16, display:'flex', flexWrap:'wrap', gap:4 }}>
                <button onClick={()=>{if(editingActa){setActaDraft(acta);setActaDirty(false);}setEditingActa(v=>!v);}} style={btnStyle(editingActa?'#757575':'#455a64')}>
                  {editingActa?'✕ Cancelar':'✏️ Editar acta'}
                </button>
                <button onClick={saveActa} disabled={!actaDirty||savingActa} style={btnStyle('#1565C0',!actaDirty||savingActa)}>
                  {savingActa?'Guardando…':'💾 Guardar'}
                </button>
                <button onClick={()=>generarPDF(actaDraft||acta,meeting)} style={btnStyle('#E53935')}>📄 PDF</button>
                <button onClick={async()=>{if(!confirm('¿Reprocesar acta?'))return;const r=await apiFetch(`/meetings/${id}/reprocess-acta`,{method:'POST'});if(r.ok){alert('Reprocesando...');setTimeout(fetchMeetingData,5000);}}} style={btnStyle('#9C27B0')}>🔄 Reprocesar</button>
              </div>

              {editingActa&&(
                <div style={{ marginBottom:14, padding:'10px 16px', backgroundColor:'#E3F2FD', borderRadius:8, fontSize:13, color:'#1565C0', borderLeft:'4px solid #2196F3' }}>
                  ✏️ Modo edición — haz clic en ✏️ junto a cada tarea para editarla.
                </div>
              )}

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
                <div style={{ padding:20, border:'1px solid #e8ecf0', borderRadius:10, backgroundColor:'white' }}>
                  <h3 style={{ marginBottom:18, color:'#1565C0', borderBottom:'2px solid #E3F2FD', paddingBottom:8 }}>Vista del Acta</h3>

                  <div style={{ marginBottom:20, padding:14, backgroundColor:'#f8f9fa', borderRadius:8, border:'1px solid #e9ecef' }}>
                    <h4 style={{ marginBottom:12, color:'#444', fontSize:13, textTransform:'uppercase', letterSpacing:'.5px' }}>📋 Identificación</h4>
                    <div style={{ display:'grid', gridTemplateColumns:'110px 1fr', gap:'8px 10px', fontSize:13 }}>
                      {['cliente','proyecto','fecha','hora_inicio','hora_fin','responsable'].map(k=>{
                        const val=actaDraft.identificacion?.[k]??'';
                        return (
                          <div key={k} style={{ display:'contents' }}>
                            <div style={{ fontWeight:600, color:'#666', alignSelf:'center' }}>{k.replace('_',' ')}</div>
                            {editingActa ? (
                              <input value={val} onChange={e=>{setActaDraft(a=>({...a,identificacion:{...(a.identificacion||{}),[k]:e.target.value}}));setActaDirty(true);}} style={fieldStyle(true)} type={k.includes('hora')?'time':k==='fecha'?'date':'text'} />
                            ) : <div style={{ color:'#333', padding:'2px 0' }}>{val||'—'}</div>}
                          </div>
                        );
                      })}
                      <div style={{ fontWeight:600, color:'#666', alignSelf:'center' }}>participantes</div>
                      {editingActa ? (
                        <input value={(actaDraft.identificacion?.participantes||[]).join(', ')} onChange={e=>{const arr=e.target.value.split(/[,;]/).map(s=>s.trim()).filter(Boolean);setActaDraft(a=>({...a,identificacion:{...(a.identificacion||{}),participantes:arr}}));setActaDirty(true);}} style={fieldStyle(true)} placeholder="Nombre 1, Nombre 2..." />
                      ) : <div style={{ color:'#333', padding:'2px 0' }}>{(actaDraft.identificacion?.participantes||[]).join(', ')||'—'}</div>}
                    </div>
                  </div>

                  {renderTareasActa('tareas_anteriores','Tareas Anteriores')}
                  {renderTareasActa('tareas_nuevas','Tareas Nuevas')}

                  <div style={{ marginBottom:16 }}>
                    <h4 style={{ marginBottom:8, color:'#333', fontSize:13 }}>Resumen de la reunión</h4>
                    {editingActa ? (
                      <textarea value={actaDraft.resumen_reunion||''} onChange={e=>{setActaDraft(a=>({...a,resumen_reunion:e.target.value}));setActaDirty(true);}} rows={5} style={{...fieldStyle(true),resize:'vertical',lineHeight:1.6}} />
                    ) : (
                      <p style={{ fontSize:13, lineHeight:1.7, color:'#333', margin:0, padding:'8px 12px', backgroundColor:'#fafafa', borderRadius:6, border:'1px solid #eee' }}>
                        {actaDraft.resumen_reunion||'—'}
                      </p>
                    )}
                  </div>

                  <div>
                    <h4 style={{ marginBottom:8, color:'#333', fontSize:13 }}>Observaciones generales</h4>
                    {editingActa ? (
                      <textarea value={actaDraft.observaciones_generales||''} onChange={e=>{setActaDraft(a=>({...a,observaciones_generales:e.target.value}));setActaDirty(true);}} rows={3} style={{...fieldStyle(true),resize:'vertical',lineHeight:1.6}} />
                    ) : (
                      <p style={{ fontSize:13, lineHeight:1.7, color:'#333', margin:0, padding:'8px 12px', backgroundColor:'#fafafa', borderRadius:6, border:'1px solid #eee' }}>
                        {actaDraft.observaciones_generales||'—'}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAREAS ── */}
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
              <div style={{ marginBottom:12, display:'flex', flexWrap:'wrap', gap:6, alignItems:'center' }}>
                <button onClick={saveTareas} disabled={!tareasDirty||savingTareas} style={btnStyle('#1565C0',!tareasDirty||savingTareas)}>
                  {savingTareas?'Guardando…':'💾 Guardar cambios'}
                </button>
                <button onClick={agregarTareaTab} style={btnStyle('#2E7D32')}>➕ Agregar</button>
                {tareasDirty&&<span style={{ fontSize:12, color:'#e65100' }}>● Cambios sin guardar</span>}
              </div>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead>
                  <tr style={{ backgroundColor:'#1565C0', color:'white' }}>
                    {['ID','Descripción','Responsable','Estado','Fecha','Acciones'].map((h,i)=>(
                      <th key={i} style={{ padding:'11px 10px', textAlign:'left', fontWeight:600, fontSize:12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tareasDraft.map((t,idx)=>(
                    <tr key={t.id??`t_${idx}`} style={{ borderBottom:'1px solid #eee', backgroundColor:idx%2===0?'white':'#fafbfc' }}>
                      <td style={{ padding:'10px', fontSize:12, color:'#1565C0', fontWeight:600 }}>{t.tarea_id||'—'}</td>
                      <td style={{ padding:'10px', maxWidth:260 }}>
                        <div style={{ fontSize:13, color:'#333', lineHeight:1.4 }}>{t.descripcion||<em style={{color:'#bbb'}}>Sin descripción</em>}</div>
                      </td>
                      <td style={{ padding:'10px', fontSize:13, color:'#555' }}>{t.responsable||'—'}</td>
                      <td style={{ padding:'10px' }}><span style={estadoBadge(t.estado||'pendiente')}>{t.estado||'pendiente'}</span></td>
                      <td style={{ padding:'10px', fontSize:13, color:'#666' }}>{t.fecha_compromiso||'—'}</td>
                      <td style={{ padding:'10px' }}>
                        <div style={{ display:'flex', gap:6 }}>
                          <button onClick={()=>abrirModalTareas(idx)} style={{ padding:'6px 12px', backgroundColor:'#E3F2FD', color:'#1565C0', border:'1px solid #90CAF9', borderRadius:5, cursor:'pointer', fontSize:12, fontWeight:600 }}>✏️</button>
                          <button onClick={()=>{if(confirm(`¿Eliminar ${t.tarea_id||`#${idx+1}`}?`))eliminarTareaTab(idx);}} style={{ padding:'6px 12px', backgroundColor:'#fff8f8', color:'#c62828', border:'1px solid #ffcdd2', borderRadius:5, cursor:'pointer', fontSize:12, fontWeight:600 }}>🗑️</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── ADJUNTOS ── */}
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
