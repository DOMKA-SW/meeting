import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const API_URL = import.meta.env.VITE_API_BASE_URL;

function safeJsonParseArray(s) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

// ─── Generador de PDF ─────────────────────────────────────────────────────────
function generarPDF(acta, meeting) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 20;
  const contentW = pageW - margin * 2;
  let y = 20;

  const colors = {
    black: [0, 0, 0],
    darkGray: [80, 80, 80],
    gray: [130, 130, 130],
    lightGray: [245, 245, 245],
    border: [180, 180, 180],
    white: [255, 255, 255],
  };

  const checkPage = (needed = 10) => {
    if (y + needed > pageH - 20) {
      doc.addPage();
      y = 20;
    }
  };

  const sectionTitle = (text) => {
    checkPage(14);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...colors.black);
    doc.text(text.toUpperCase(), margin, y);
    y += 2;
    doc.setDrawColor(...colors.black);
    doc.line(margin, y, margin + contentW, y);
    y += 8;
  };

  const textBlock = (text) => {
    if (!text) return;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...colors.darkGray);
    const lines = doc.splitTextToSize(String(text), contentW);
    lines.forEach(line => {
      checkPage(6);
      doc.text(line, margin, y);
      y += 5;
    });
    y += 4;
  };

  // ── ENCABEZADO ───────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...colors.black);
  doc.text('ACTA DE REUNIÓN', pageW / 2, y, { align: 'center' });
  y += 10;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Generado el ${new Date().toLocaleDateString('es-ES')}`, pageW / 2, y, { align: 'center' });
  y += 12;

  // ── IDENTIFICACIÓN ───────────────────────────────────────────
  sectionTitle('Identificación');

  const id = acta.identificacion || {};
  const startedDate = meeting?.started_at ? new Date(meeting.started_at) : null;
  const endedDate = meeting?.ended_at ? new Date(meeting.ended_at) : null;

  const rows = [
    ['Cliente', id.cliente],
    ['Proyecto', id.proyecto],
    ['Responsable', id.responsable],
    ['Fecha', id.fecha || (startedDate ? startedDate.toISOString().split('T')[0] : '')],
    ['Hora inicio', id.hora_inicio || (startedDate ? startedDate.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '')],
    ['Hora fin', id.hora_fin || (endedDate ? endedDate.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '')],
    ['Participantes', Array.isArray(id.participantes) ? id.participantes.join(', ') : id.participantes],
  ];

  rows.forEach(([label, value]) => {
    checkPage(6);
    doc.setFont('helvetica', 'bold');
    doc.text(label + ':', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(value || '—'), margin + 40, y);
    y += 6;
  });

  y += 6;

  // ── TAREAS ANTERIORES ─────────────────────────────────────────
  sectionTitle('Tareas Anteriores');

  const tareasAnt = acta.tareas_anteriores || [];

  if (tareasAnt.length === 0) {
    doc.setFontSize(9);
    doc.setTextColor(...colors.gray);
    doc.text('No hay tareas anteriores registradas.', margin, y);
    y += 8;
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['ID', 'Descripción', 'Responsable', 'Estado', 'Proyecto']],
      body: tareasAnt.map((t, i) => [
        t.id || i + 1,
        t.descripcion || '',
        t.responsable || '',
        t.estado || '',
        t.proyecto || id.proyecto || ''
      ]),
      styles: {
        fontSize: 8.5,
        cellPadding: 3,
        textColor: colors.black,
        lineColor: colors.border,
        lineWidth: 0.1
      },
      headStyles: {
        fillColor: colors.lightGray,
        textColor: colors.black,
        fontStyle: 'bold'
      }
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // ── TAREAS NUEVAS ────────────────────────────────────────────
  sectionTitle('Tareas Nuevas');

  const tareasNuevas = acta.tareas_nuevas || [];

  if (tareasNuevas.length === 0) {
    doc.setFontSize(9);
    doc.setTextColor(...colors.gray);
    doc.text('No hay tareas nuevas.', margin, y);
    y += 8;
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['ID', 'Descripción', 'Responsable', 'Fecha fin', 'Proyecto']],
      body: tareasNuevas.map((t, i) => [
        t.id || `T-${i + 1}`,
        t.descripcion || '',
        t.responsable || '',
        t.fecha_compromiso || '',
        t.proyecto || id.proyecto || ''
      ]),
      styles: {
        fontSize: 8.5,
        cellPadding: 3,
        textColor: colors.black,
        lineColor: colors.border,
        lineWidth: 0.1
      },
      headStyles: {
        fillColor: colors.lightGray,
        textColor: colors.black,
        fontStyle: 'bold'
      }
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // ── RESUMEN ───────────────────────────────────────────────────
  sectionTitle('Resumen de la Reunión');
  textBlock(acta.resumen_reunion);

  // ── OBSERVACIONES ────────────────────────────────────────────
  if (acta.observaciones_generales) {
    sectionTitle('Observaciones Generales');
    textBlock(acta.observaciones_generales);
  }

  // ── PIE DE PÁGINA ────────────────────────────────────────────
  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(7.5);
    doc.setTextColor(...colors.gray);
    doc.text(`Página ${i} de ${totalPages}`, pageW - margin, pageH - 10, { align: 'right' });
    doc.text('Documento generado automáticamente', margin, pageH - 10);
  }

  const clienteFile = id.cliente ? id.cliente.replace(/[^a-z0-9]/gi, '_') : 'acta';
  const fechaFile = id.fecha ? id.fecha.replace(/-/g, '') : 'sin_fecha';

  doc.save(`Acta_${clienteFile}_${fechaFile}.pdf`);
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
  const [editingRows, setEditingRows] = useState({});
  const [savingTareas, setSavingTareas] = useState(false);
  const [tareasDirty, setTareasDirty] = useState(false);
  const [activeTab, setActiveTab] = useState('transcription');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMeetingData();
    const isEditing = editingActa || Object.keys(editingRows).length > 0;
    if (!isEditing) {
      const interval = setInterval(fetchMeetingData, 5000);
      return () => clearInterval(interval);
    }
  }, [id, editingActa, editingRows]);

  const fetchMeetingData = async () => {
    if (editingActa || Object.keys(editingRows).length > 0) return;
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
        setActa(actaData);
        if (!actaDirty && !editingActa) setActaDraft(actaData);
      }
      if (tareasRes.ok) {
        const tareasData = await tareasRes.json();
        setTareas(tareasData);
        if (!tareasDirty && Object.keys(editingRows).length === 0)
          setTareasDraft(tareasData.map(t => ({ ...t })));
      }
      setLoading(false);
    } catch (e) { console.error(e); setLoading(false); }
  };

  const saveActa = async () => {
    if (!actaDraft) return;
    setSavingActa(true);
    try {
      const res = await fetch(`${API_URL}/meetings/${id}/acta`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(actaDraft)
      });
      if (!res.ok) { alert(`Error al guardar (${res.status})`); setSavingActa(false); return; }
      setActa(actaDraft); setActaDirty(false); setEditingActa(false);
      alert('Acta guardada correctamente');
    } catch (e) { alert('Error: ' + e.message); }
    setSavingActa(false);
  };

  const saveTareas = async () => {
    setSavingTareas(true);
    try {
      const payload = tareasDraft.map(t => ({
        tarea_id: t.tarea_id || '', tipo: t.tipo || 'nueva',
        descripcion: t.descripcion || '', responsable: t.responsable || '',
        estado: t.estado || 'pendiente', fecha_compromiso: t.fecha_compromiso || ''
      }));
      const res = await fetch(`${API_URL}/meetings/${id}/tareas`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (!res.ok) { alert(`Error al guardar tareas (${res.status})`); setSavingTareas(false); return; }
      setTareas(tareasDraft); setTareasDirty(false); setEditingRows({});
      alert('Tareas guardadas correctamente');
    } catch (e) { alert('Error: ' + e.message); }
    setSavingTareas(false);
  };

  if (loading) return <div style={{ padding: 40 }}>Cargando...</div>;
  if (!meeting) return <div style={{ padding: 40 }}>Reunión no encontrada</div>;

  const participantes = safeJsonParseArray(meeting.participantes || '[]');

  const btnStyle = (color, disabled = false) => ({
    padding: '8px 16px', marginRight: 8, marginBottom: 4,
    backgroundColor: disabled ? '#ccc' : color,
    color: 'white', border: 'none', borderRadius: 4,
    cursor: disabled ? 'default' : 'pointer', fontSize: 13, fontWeight: 500
  });

  const tabStyle = (active) => ({
    padding: '10px 20px', marginRight: 8,
    backgroundColor: active ? '#2196F3' : '#e0e0e0',
    color: active ? 'white' : '#333',
    border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: active ? 'bold' : 'normal'
  });

  return (
    <div>
      <h1 style={{ marginBottom: 4 }}>Detalles de Reunión</h1>

      {/* Info resumen */}
      <div style={{ marginBottom: 20, padding: 15, backgroundColor: '#f5f5f5', borderRadius: 8, fontSize: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 6 }}>
          <div><strong>Estado:</strong> {meeting.status}</div>
          <div><strong>Inicio:</strong> {new Date(meeting.started_at).toLocaleString('es-ES')}</div>
          {meeting.ended_at && <div><strong>Fin:</strong> {new Date(meeting.ended_at).toLocaleString('es-ES')}</div>}
          {meeting.cliente && <div><strong>Cliente:</strong> {meeting.cliente}</div>}
          {meeting.proyecto && <div><strong>Proyecto:</strong> {meeting.proyecto}</div>}
          {meeting.responsable && <div><strong>Responsable:</strong> {meeting.responsable}</div>}
          {participantes.length > 0 && <div><strong>Participantes:</strong> {participantes.join(', ')}</div>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ marginBottom: 20 }}>
        {[['transcription', 'Transcripción'], ['acta', 'Acta'], ['tareas', 'Tareas']].map(([k, label]) => (
          <button key={k} onClick={() => setActiveTab(k)} style={tabStyle(activeTab === k)}>{label}</button>
        ))}
      </div>

      {/* ── TRANSCRIPCIÓN ── */}
      {activeTab === 'transcription' && (
        <div>
          <h2>Transcripción</h2>
          {transcription.length === 0 ? (
            <div style={{ padding: 20, backgroundColor: '#fff3cd', borderRadius: 8, border: '1px solid #ffc107' }}>
              <p><strong>Transcripción no disponible todavía</strong></p>
              <p>Puede estar procesándose o no hay cuota disponible en Groq.</p>
            </div>
          ) : (
            <div style={{ maxHeight: 500, overflowY: 'auto', padding: 15, backgroundColor: '#f9f9f9', borderRadius: 8 }}>
              {transcription.map((item, index) => (
                <div key={index} style={{ marginBottom: 10, padding: 10, backgroundColor: 'white', borderRadius: 4 }}>
                  <strong style={{ color: '#2196F3' }}>{item.speaker}:</strong> {item.text}
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
            <div style={{ padding: 20, backgroundColor: '#fff3cd', borderRadius: 8, border: '1px solid #ffc107' }}>
              <p><strong>Acta no disponible todavía.</strong> Se genera al finalizar la reunión.</p>
              {meeting.status === 'ended' && (
                <button onClick={async () => {
                  const res = await fetch(`${API_URL}/meetings/${id}/reprocess-acta`, { method: 'POST' });
                  if (res.ok) alert('Procesando... recarga en 30 segundos.');
                }} style={{ ...btnStyle('#9C27B0'), marginTop: 10 }}>
                  Generar Acta Ahora
                </button>
              )}
            </div>
          ) : (
            <div>
              {/* Barra de acciones */}
              <div style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                <button
                  onClick={() => { if (editingActa) { setActaDraft(acta); setActaDirty(false); } setEditingActa(v => !v); }}
                  style={btnStyle('#555')}
                >
                  {editingActa ? '✕ Cancelar' : '✏️ Editar'}
                </button>
                <button onClick={saveActa} disabled={!actaDirty || savingActa} style={btnStyle('#2196F3', !actaDirty || savingActa)}>
                  {savingActa ? 'Guardando…' : '💾 Guardar'}
                </button>
                <button
                  onClick={() => generarPDF(actaDraft || acta, meeting)}
                  style={btnStyle('#E53935')}
                >
                  📄 Descargar PDF
                </button>
                <button onClick={async () => {
                  if (!confirm('¿Reprocesar acta? Se regenerarán las tareas.')) return;
                  const res = await fetch(`${API_URL}/meetings/${id}/reprocess-acta`, { method: 'POST' });
                  if (res.ok) { alert('Reprocesando...'); setTimeout(fetchMeetingData, 5000); }
                }} style={btnStyle('#9C27B0')}>
                  🔄 Reprocesar
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {/* Vista */}
                <div style={{ padding: 16, border: '1px solid #eee', borderRadius: 8 }}>
                  <h3 style={{ marginBottom: 14, color: '#1565C0' }}>Vista del Acta</h3>

                  {/* Identificación */}
                  <div style={{ marginBottom: 16, padding: 12, backgroundColor: '#f5f5f5', borderRadius: 6 }}>
                    <h4 style={{ marginBottom: 10, color: '#333' }}>Identificación</h4>
                    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 6, fontSize: 13 }}>
                      {['cliente', 'proyecto', 'fecha', 'hora_inicio', 'hora_fin', 'responsable'].map(k => {
                        const val = actaDraft.identificacion?.[k] ?? '';
                        return (
                          <div key={k} style={{ display: 'contents' }}>
                            <div style={{ fontWeight: 'bold', color: '#555' }}>{k.replace('_', ' ')}</div>
                            {editingActa ? (
                              <input
                                defaultValue={val}
                                onBlur={e => {
                                  if (e.target.value !== val) {
                                    setActaDraft(a => ({ ...a, identificacion: { ...(a.identificacion || {}), [k]: e.target.value } }));
                                    setActaDirty(true);
                                  }
                                }}
                                style={{ padding: '4px 8px', border: '1px solid #ddd', borderRadius: 3, fontSize: 13 }}
                                type={k.includes('hora') ? 'time' : k === 'fecha' ? 'date' : 'text'}
                              />
                            ) : <div>{val || '—'}</div>}
                          </div>
                        );
                      })}
                      <div style={{ fontWeight: 'bold', color: '#555' }}>participantes</div>
                      {editingActa ? (
                        <input
                          defaultValue={(actaDraft.identificacion?.participantes || []).join(', ')}
                          onBlur={e => {
                            const arr = e.target.value.split(/[,;]/).map(s => s.trim()).filter(Boolean);
                            setActaDraft(a => ({ ...a, identificacion: { ...(a.identificacion || {}), participantes: arr } }));
                            setActaDirty(true);
                          }}
                          style={{ padding: '4px 8px', border: '1px solid #ddd', borderRadius: 3, fontSize: 13 }}
                        />
                      ) : <div>{(actaDraft.identificacion?.participantes || []).join(', ') || '—'}</div>}
                    </div>
                  </div>

                  {/* Tareas anteriores */}
                  <h4 style={{ marginBottom: 6, color: '#333' }}>Tareas Anteriores</h4>
                  {(actaDraft.tareas_anteriores || []).length === 0
                    ? <p style={{ color: '#999', fontSize: 13, fontStyle: 'italic' }}>Sin tareas anteriores</p>
                    : <ul style={{ paddingLeft: 18, fontSize: 13 }}>
                        {actaDraft.tareas_anteriores.map((t, i) => (
                          <li key={i} style={{ marginBottom: 5 }}>
                            <strong>{t.id || `${i + 1}`}:</strong> {t.descripcion}
                            {t.responsable && ` — ${t.responsable}`}
                          </li>
                        ))}
                      </ul>}

                  {/* Tareas nuevas */}
                  <h4 style={{ marginTop: 12, marginBottom: 6, color: '#333' }}>Tareas Nuevas</h4>
                  {(actaDraft.tareas_nuevas || []).length === 0
                    ? <p style={{ color: '#999', fontSize: 13, fontStyle: 'italic' }}>Sin tareas nuevas</p>
                    : <ul style={{ paddingLeft: 18, fontSize: 13 }}>
                        {actaDraft.tareas_nuevas.map((t, i) => (
                          <li key={i} style={{ marginBottom: 5 }}>
                            <strong>{t.id || `tarea_${i + 1}`}:</strong> {t.descripcion}
                            {t.responsable && <span style={{ color: '#1565C0' }}> — {t.responsable}</span>}
                            {t.fecha_compromiso && <span style={{ color: '#777' }}> · {t.fecha_compromiso}</span>}
                          </li>
                        ))}
                      </ul>}

                  {/* Resumen */}
                  <h4 style={{ marginTop: 12, marginBottom: 6, color: '#333' }}>Resumen</h4>
                  {editingActa
                    ? <textarea
                        defaultValue={actaDraft.resumen_reunion || ''}
                        onBlur={e => { if (e.target.value !== (actaDraft.resumen_reunion || '')) { setActaDraft(a => ({ ...a, resumen_reunion: e.target.value })); setActaDirty(true); } }}
                        style={{ width: '100%', minHeight: 80, padding: 8, border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }}
                      />
                    : <p style={{ fontSize: 13, lineHeight: 1.6, color: '#333' }}>{actaDraft.resumen_reunion || '—'}</p>}

                  {/* Observaciones */}
                  <h4 style={{ marginTop: 12, marginBottom: 6, color: '#333' }}>Observaciones</h4>
                  {editingActa
                    ? <textarea
                        defaultValue={actaDraft.observaciones_generales || ''}
                        onBlur={e => { if (e.target.value !== (actaDraft.observaciones_generales || '')) { setActaDraft(a => ({ ...a, observaciones_generales: e.target.value })); setActaDirty(true); } }}
                        style={{ width: '100%', minHeight: 60, padding: 8, border: '1px solid #ddd', borderRadius: 4, fontSize: 13 }}
                      />
                    : <p style={{ fontSize: 13, lineHeight: 1.6, color: '#333' }}>{actaDraft.observaciones_generales || '—'}</p>}
                </div>

                {/* JSON */}
                <div style={{ padding: 16, border: '1px solid #eee', borderRadius: 8 }}>
                  <h3 style={{ marginBottom: 10 }}>JSON Raw</h3>
                  <pre style={{ margin: 0, maxHeight: 580, overflow: 'auto', padding: 12, background: '#f9f9f9', borderRadius: 6, fontSize: 11 }}>
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
          {tareasDraft.length === 0 ? (
            <p style={{ color: '#666' }}>No hay tareas registradas.</p>
          ) : (
            <div>
              <div style={{ marginBottom: 12 }}>
                <button onClick={saveTareas} disabled={!tareasDirty || savingTareas} style={btnStyle('#2196F3', !tareasDirty || savingTareas)}>
                  {savingTareas ? 'Guardando…' : '💾 Guardar cambios'}
                </button>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ backgroundColor: '#1565C0', color: 'white' }}>
                    {['ID', 'Descripción', 'Responsable', 'Estado', 'Fecha', ''].map((h, i) => (
                      <th key={i} style={{ padding: '10px 8px', textAlign: 'left' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tareasDraft.map((t, idx) => {
                    const key = t.id ?? `tarea_${idx}`;
                    const isEdit = Boolean(editingRows[key]);
                    const setField = (field, value) => {
                      setTareasDraft(arr => arr.map((item, i) => i === idx ? { ...item, [field]: value } : item));
                      setTareasDirty(true);
                    };
                    return (
                      <tr key={key} style={{ borderBottom: '1px solid #eee', backgroundColor: idx % 2 === 0 ? 'white' : '#f9f9f9' }}>
                        <td style={{ padding: '8px' }}>
                          {isEdit
                            ? <input defaultValue={t.tarea_id || ''} onBlur={e => setField('tarea_id', e.target.value)} style={{ width: 70, padding: 4, border: '1px solid #ddd', borderRadius: 3 }} />
                            : t.tarea_id}
                        </td>
                        <td style={{ padding: '8px' }}>
                          {isEdit
                            ? <input defaultValue={t.descripcion || ''} onBlur={e => setField('descripcion', e.target.value)} style={{ width: '100%', padding: 4, border: '1px solid #ddd', borderRadius: 3 }} />
                            : t.descripcion}
                        </td>
                        <td style={{ padding: '8px' }}>
                          {isEdit
                            ? <input defaultValue={t.responsable || ''} onBlur={e => setField('responsable', e.target.value)} style={{ width: 120, padding: 4, border: '1px solid #ddd', borderRadius: 3 }} />
                            : t.responsable}
                        </td>
                        <td style={{ padding: '8px' }}>
                          {isEdit ? (
                            <select defaultValue={t.estado || 'pendiente'} onChange={e => setField('estado', e.target.value)} style={{ padding: 4, border: '1px solid #ddd', borderRadius: 3 }}>
                              {['pendiente', 'en progreso', 'completada', 'cancelada'].map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          ) : (
                            <span style={{
                              padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 'bold',
                              backgroundColor: t.estado === 'completada' ? '#c8e6c9' : t.estado === 'en progreso' ? '#fff9c4' : '#ffecb3',
                              color: t.estado === 'completada' ? '#2e7d32' : t.estado === 'en progreso' ? '#f57f17' : '#e65100'
                            }}>
                              {t.estado || 'pendiente'}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '8px' }}>
                          {isEdit
                            ? <input type="date" defaultValue={t.fecha_compromiso || ''} onBlur={e => setField('fecha_compromiso', e.target.value)} style={{ padding: 4, border: '1px solid #ddd', borderRadius: 3 }} />
                            : t.fecha_compromiso}
                        </td>
                        <td style={{ padding: '8px' }}>
                          <button
                            onClick={() => setEditingRows(m => isEdit ? (({ [key]: _, ...rest }) => rest)(m) : { ...m, [key]: true })}
                            style={{ padding: '5px 10px', backgroundColor: isEdit ? '#555' : '#2196F3', color: 'white', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
                          >
                            {isEdit ? 'Listo' : 'Editar'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
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
