import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

const API_URL = 'http://localhost:3000';

function safeJsonParseArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

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
    const isEditing = editingActa || Object.keys(editingRows).length > 0;
    if (isEditing) {
      return;
    }
    try {
      const [meetingRes, transcriptionRes, actaRes, tareasRes] = await Promise.all([
        fetch(`${API_URL}/meetings/${id}`),
        fetch(`${API_URL}/meetings/${id}/transcription`),
        fetch(`${API_URL}/meetings/${id}/acta`).catch(() => null),
        fetch(`${API_URL}/meetings/${id}/tareas`)
      ]);

      if (meetingRes.ok) {
        const meetingData = await meetingRes.json();
        setMeeting(meetingData);
      }
      if (transcriptionRes.ok) {
        setTranscription(await transcriptionRes.json());
      }
      if (actaRes && actaRes.ok) {
        const actaData = await actaRes.json();
        setActa(actaData);
        if (!actaDirty && !editingActa) {
          setActaDraft(actaData);
        }
      }
      if (tareasRes.ok) {
        const tareasData = await tareasRes.json();
        setTareas(tareasData);
        if (!tareasDirty && Object.keys(editingRows).length === 0) {
          setTareasDraft(tareasData.map(t => ({ ...t })));
        }
      }
      setLoading(false);
    } catch (e) {
      console.error(e);
      setLoading(false);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    alert('Copiado al portapapeles');
  };

  const downloadActa = () => {
    const dataStr = JSON.stringify(actaDraft || acta || {}, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `acta_${id}.json`;
    link.click();
  };

  const saveActa = async () => {
    if (!actaDraft) return;
    setSavingActa(true);
    try {
      const res = await fetch(`${API_URL}/meetings/${id}/acta`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(actaDraft)
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        alert(`Error al guardar el acta (${res.status}). ${txt}`);
        setSavingActa(false);
        return;
      }
      setActa(actaDraft);
      setActaDirty(false);
      setEditingActa(false);
      alert('Acta guardada correctamente');
    } catch (e) {
      console.error('Error saving acta:', e);
      alert('Error al guardar el acta: ' + e.message);
    }
    setSavingActa(false);
  };

  const saveTareas = async () => {
    setSavingTareas(true);
    try {
      const payload = tareasDraft.map(t => ({
        tarea_id: t.tarea_id || '',
        tipo: t.tipo || 'nueva',
        descripcion: t.descripcion || '',
        responsable: t.responsable || '',
        estado: t.estado || 'pendiente',
        fecha_compromiso: t.fecha_compromiso || ''
      }));
      const res = await fetch(`${API_URL}/meetings/${id}/tareas`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        alert(`Error al guardar tareas (${res.status}). ${txt}`);
        setSavingTareas(false);
        return;
      }
      setTareas(tareasDraft);
      setTareasDirty(false);
      setEditingRows({});
      alert('Tareas guardadas correctamente');
    } catch (e) {
      console.error('Error saving tareas:', e);
      alert('Error al guardar tareas: ' + e.message);
    }
    setSavingTareas(false);
  };

  if (loading) return <div>Cargando...</div>;
  if (!meeting) return <div>Reunión no encontrada</div>;

  const participantes = safeJsonParseArray(meeting.participantes || '[]');

  return (
    <div>
      <h1>Detalles de Reunión</h1>

      <div style={{ marginBottom: 20, padding: 15, backgroundColor: '#f5f5f5', borderRadius: 8 }}>
        <p><strong>ID:</strong> {meeting.id}</p>
        <p><strong>Estado:</strong> {meeting.status}</p>
        <p><strong>Inicio:</strong> {new Date(meeting.started_at).toLocaleString('es-ES')}</p>
        {meeting.ended_at && <p><strong>Fin:</strong> {new Date(meeting.ended_at).toLocaleString('es-ES')}</p>}
        {(meeting.cliente || meeting.proyecto || meeting.responsable || participantes.length > 0) && (
          <div style={{ marginTop: 10 }}>
            {meeting.cliente && <p><strong>Cliente:</strong> {meeting.cliente}</p>}
            {meeting.proyecto && <p><strong>Proyecto:</strong> {meeting.proyecto}</p>}
            {meeting.responsable && <p><strong>Responsable:</strong> {meeting.responsable}</p>}
            {participantes.length > 0 && <p><strong>Participantes:</strong> {participantes.join(', ')}</p>}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 20 }}>
        {['transcription', 'acta', 'tareas'].map(k => (
          <button
            key={k}
            onClick={() => setActiveTab(k)}
            style={{
              padding: '10px 20px',
              marginRight: k !== 'tareas' ? 10 : 0,
              backgroundColor: activeTab === k ? '#2196F3' : '#e0e0e0',
              color: activeTab === k ? 'white' : '#333',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer'
            }}
          >
            {k === 'transcription' ? 'Transcripción' : k === 'acta' ? 'Acta' : 'Tareas'}
          </button>
        ))}
      </div>

      {activeTab === 'transcription' && (
        <div>
          <h2>Transcripción</h2>
          {transcription.length === 0 ? (
            <div style={{ padding: 20, backgroundColor: '#fff3cd', borderRadius: 8, border: '1px solid #ffc107' }}>
              <p><strong>Transcripción no disponible todavía</strong></p>
              <p>Puede estar procesándose o no haber cuota disponible en el proveedor.</p>
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

      {activeTab === 'acta' && (
        <div>
          <h2>Acta</h2>
          {!actaDraft ? (
            <div style={{ padding: 20, backgroundColor: '#fff3cd', borderRadius: 8, border: '1px solid #ffc107' }}>
              <p><strong>Acta no disponible todavía</strong></p>
              <p>Se generará cuando haya suficiente transcripción.</p>
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 12 }}>
                <button
                  onClick={() => {
                    if (editingActa) {
                      setActaDraft(acta);
                      setActaDirty(false);
                    }
                    setEditingActa(v => !v);
                  }}
                  style={{ padding: '8px 16px', marginRight: 10, backgroundColor: '#333', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                >
                  {editingActa ? 'Cancelar edición' : 'Editar'}
                </button>
                <button
                  onClick={async () => {
                    if (!confirm('¿Reprocesar acta y mejorar tareas? Esto eliminará las tareas actuales y generará nuevas.')) return;
                    try {
                      const res = await fetch(`${API_URL}/meetings/${id}/reprocess-acta`, { method: 'POST' });
                      if (res.ok) {
                        alert('Acta reprocesada. Recargando...');
                        setTimeout(() => fetchMeetingData(), 2000);
                      } else {
                        alert('Error al reprocesar acta');
                      }
                    } catch (e) {
                      alert('Error: ' + e.message);
                    }
                  }}
                  style={{ padding: '8px 16px', marginRight: 10, backgroundColor: '#9C27B0', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                >
                  Reprocesar Acta
                </button>
                <button
                  onClick={saveActa}
                  disabled={!actaDirty || savingActa}
                  style={{ padding: '8px 16px', marginRight: 10, backgroundColor: actaDirty ? '#2196F3' : '#ccc', color: 'white', border: 'none', borderRadius: 4, cursor: actaDirty ? 'pointer' : 'default' }}
                >
                  {savingActa ? 'Guardando…' : 'Guardar'}
                </button>
                <button
                  onClick={() => copyToClipboard(JSON.stringify(actaDraft, null, 2))}
                  style={{ padding: '8px 16px', marginRight: 10, backgroundColor: '#4CAF50', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                >
                  Copiar JSON
                </button>
                <button
                  onClick={downloadActa}
                  style={{ padding: '8px 16px', backgroundColor: '#FF9800', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                >
                  Descargar JSON
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ padding: 16, border: '1px solid #eee', borderRadius: 8 }}>
                  <h3 style={{ marginBottom: 10 }}>Acta (vista)</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, marginBottom: 12 }}>
                    {['cliente', 'proyecto', 'fecha', 'hora_inicio', 'hora_fin', 'responsable'].map((k) => {
                      let displayValue = actaDraft.identificacion?.[k] ?? '';
                      if (k === 'hora_inicio' && (!displayValue || displayValue === '') && meeting?.started_at) {
                        const d = new Date(meeting.started_at);
                        displayValue = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                        if (!editingActa && actaDraft.identificacion) {
                          setActaDraft(a => ({
                            ...a,
                            identificacion: { ...(a.identificacion || {}), hora_inicio: displayValue }
                          }));
                        }
                      }
                      if (k === 'hora_fin' && (!displayValue || displayValue === '') && meeting?.ended_at) {
                        const d = new Date(meeting.ended_at);
                        displayValue = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                        if (!editingActa && actaDraft.identificacion) {
                          setActaDraft(a => ({
                            ...a,
                            identificacion: { ...(a.identificacion || {}), hora_fin: displayValue }
                          }));
                        }
                      }
                      if (k === 'fecha' && (!displayValue || displayValue === '') && meeting?.started_at) {
                        displayValue = new Date(meeting.started_at).toISOString().split('T')[0];
                        if (!editingActa && actaDraft.identificacion) {
                          setActaDraft(a => ({
                            ...a,
                            identificacion: { ...(a.identificacion || {}), fecha: displayValue }
                          }));
                        }
                      }
                      return (
                        <div key={k} style={{ display: 'contents' }}>
                          <div style={{ fontWeight: 'bold' }}>{k.replace('_', ' ')}</div>
                        {editingActa ? (
                          <input
                            key={`${k}-${actaDraft.identificacion?.[k]}`}
                            defaultValue={displayValue}
                            onBlur={(e) => {
                              const newValue = e.target.value;
                              if (newValue !== displayValue) {
                                setActaDraft(a => ({
                                  ...a,
                                  identificacion: { ...(a.identificacion || {}), [k]: newValue }
                                }));
                                setActaDirty(true);
                              }
                            }}
                            style={{ padding: 8, border: '1px solid #ddd', borderRadius: 4 }}
                            type={k.includes('hora') ? 'time' : k === 'fecha' ? 'date' : 'text'}
                          />
                        ) : (
                          <div>{displayValue || '-'}</div>
                        )}
                        </div>
                      );
                    })}
                    <div style={{ fontWeight: 'bold' }}>participantes</div>
                    {editingActa ? (
                      <input
                        key={`participantes-${(actaDraft.identificacion?.participantes || []).join(',')}`}
                        defaultValue={(actaDraft.identificacion?.participantes || []).join(', ')}
                        onBlur={(e) => {
                          const arr = e.target.value.split(/[,;]/).map(s => s.trim()).filter(Boolean);
                          setActaDraft(a => ({
                            ...a,
                            identificacion: { ...(a.identificacion || {}), participantes: arr }
                          }));
                          setActaDirty(true);
                        }}
                        style={{ padding: 8, border: '1px solid #ddd', borderRadius: 4 }}
                      />
                    ) : (
                      <div>{(actaDraft.identificacion?.participantes || []).join(', ')}</div>
                    )}
                  </div>

                  <h4>Resumen</h4>
                  {editingActa ? (
                    <textarea
                      key={`resumen-${actaDraft.resumen_reunion?.substring(0, 20)}`}
                      defaultValue={actaDraft.resumen_reunion || ''}
                      onBlur={(e) => {
                        if (e.target.value !== (actaDraft.resumen_reunion || '')) {
                          setActaDraft(a => ({ ...a, resumen_reunion: e.target.value }));
                          setActaDirty(true);
                        }
                      }}
                      style={{ width: '100%', minHeight: 90, padding: 10, border: '1px solid #ddd', borderRadius: 4 }}
                    />
                  ) : (
                    <p style={{ whiteSpace: 'pre-wrap' }}>{actaDraft.resumen_reunion || ''}</p>
                  )}

                  <h4 style={{ marginTop: 12 }}>Observaciones</h4>
                  {editingActa ? (
                    <textarea
                      key={`obs-${actaDraft.observaciones_generales?.substring(0, 20)}`}
                      defaultValue={actaDraft.observaciones_generales || ''}
                      onBlur={(e) => {
                        if (e.target.value !== (actaDraft.observaciones_generales || '')) {
                          setActaDraft(a => ({ ...a, observaciones_generales: e.target.value }));
                          setActaDirty(true);
                        }
                      }}
                      style={{ width: '100%', minHeight: 70, padding: 10, border: '1px solid #ddd', borderRadius: 4 }}
                    />
                  ) : (
                    <p style={{ whiteSpace: 'pre-wrap' }}>{actaDraft.observaciones_generales || ''}</p>
                  )}

                  <h4 style={{ marginTop: 16 }}>Tareas Nuevas</h4>
                  {Array.isArray(actaDraft.tareas_nuevas) && actaDraft.tareas_nuevas.length > 0 ? (
                    <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                      {actaDraft.tareas_nuevas.map((t, i) => (
                        <li key={i} style={{ marginBottom: 8 }}>
                          <strong>{t.id || `Tarea ${i + 1}`}:</strong> {t.descripcion || ''}
                          {t.responsable && <span> - Responsable: {t.responsable}</span>}
                          {t.fecha_compromiso && <span> - Fecha: {t.fecha_compromiso}</span>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ color: '#666', fontStyle: 'italic' }}>Sin tareas nuevas</p>
                  )}

                  <h4 style={{ marginTop: 16 }}>Tareas Anteriores</h4>
                  {Array.isArray(actaDraft.tareas_anteriores) && actaDraft.tareas_anteriores.length > 0 ? (
                    <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                      {actaDraft.tareas_anteriores.map((t, i) => (
                        <li key={i} style={{ marginBottom: 8 }}>
                          <strong>{t.id || `Tarea ${i + 1}`}:</strong> {t.descripcion || ''}
                          {t.responsable && <span> - Responsable: {t.responsable}</span>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ color: '#666', fontStyle: 'italic' }}>Sin tareas anteriores</p>
                  )}
                </div>

                <div style={{ padding: 16, border: '1px solid #eee', borderRadius: 8 }}>
                  <h3 style={{ marginBottom: 10 }}>JSON</h3>
                  <pre style={{ margin: 0, maxHeight: 520, overflow: 'auto', padding: 12, background: '#f9f9f9', borderRadius: 8 }}>
                    {JSON.stringify(actaDraft, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'tareas' && (
        <div>
          <h2>Tareas</h2>
          {tareasDraft.length === 0 ? (
            <p>No hay tareas registradas aún.</p>
          ) : (
            <div>
              <div style={{ marginBottom: 12 }}>
                <button
                  onClick={saveTareas}
                  disabled={!tareasDirty || savingTareas}
                  style={{ padding: '8px 16px', backgroundColor: tareasDirty ? '#2196F3' : '#ccc', color: 'white', border: 'none', borderRadius: 4, cursor: tareasDirty ? 'pointer' : 'default' }}
                >
                  {savingTareas ? 'Guardando…' : 'Guardar cambios'}
                </button>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f5f5f5' }}>
                    <th style={{ padding: 8, textAlign: 'left', borderBottom: '2px solid #ddd' }}>ID</th>
                    <th style={{ padding: 8, textAlign: 'left', borderBottom: '2px solid #ddd' }}>Descripción</th>
                    <th style={{ padding: 8, textAlign: 'left', borderBottom: '2px solid #ddd' }}>Responsable</th>
                    <th style={{ padding: 8, textAlign: 'left', borderBottom: '2px solid #ddd' }}>Estado</th>
                    <th style={{ padding: 8, textAlign: 'left', borderBottom: '2px solid #ddd' }}>Fecha</th>
                    <th style={{ padding: 8, textAlign: 'left', borderBottom: '2px solid #ddd' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {tareasDraft.map((t, idx) => {
                    const key = t.id ?? `tarea_${idx}`;
                    const isEdit = Boolean(editingRows[key]);
                    const setField = (field, value) => {
                      setTareasDraft(arr => {
                        const updated = arr.map((item, i) => 
                          i === idx ? { ...item, [field]: value } : item
                        );
                        return updated;
                      });
                      setTareasDirty(true);
                    };
                    const tareaValue = tareasDraft[idx];
                    return (
                      <tr key={key} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: 8 }}>
                          {isEdit ? (
                            <input
                              defaultValue={tareaValue?.tarea_id || ''}
                              onBlur={e => setField('tarea_id', e.target.value)}
                              style={{ width: '100%', padding: 6, border: '1px solid #ddd', borderRadius: 4 }}
                            />
                          ) : (
                            tareaValue?.tarea_id || ''
                          )}
                        </td>
                        <td style={{ padding: 8 }}>
                          {isEdit ? (
                            <input
                              defaultValue={tareaValue?.descripcion || ''}
                              onBlur={e => setField('descripcion', e.target.value)}
                              style={{ width: '100%', padding: 6, border: '1px solid #ddd', borderRadius: 4 }}
                            />
                          ) : (
                            tareaValue?.descripcion || ''
                          )}
                        </td>
                        <td style={{ padding: 8 }}>
                          {isEdit ? (
                            <input
                              defaultValue={tareaValue?.responsable || ''}
                              onBlur={e => setField('responsable', e.target.value)}
                              style={{ width: '100%', padding: 6, border: '1px solid #ddd', borderRadius: 4 }}
                            />
                          ) : (
                            tareaValue?.responsable || ''
                          )}
                        </td>
                        <td style={{ padding: 8 }}>
                          {isEdit ? (
                            <input
                              defaultValue={tareaValue?.estado || 'pendiente'}
                              onBlur={e => setField('estado', e.target.value)}
                              style={{ width: '100%', padding: 6, border: '1px solid #ddd', borderRadius: 4 }}
                            />
                          ) : (
                            tareaValue?.estado || 'pendiente'
                          )}
                        </td>
                        <td style={{ padding: 8 }}>
                          {isEdit ? (
                            <input
                              type="date"
                              defaultValue={tareaValue?.fecha_compromiso || ''}
                              onBlur={e => setField('fecha_compromiso', e.target.value)}
                              style={{ width: '100%', padding: 6, border: '1px solid #ddd', borderRadius: 4 }}
                            />
                          ) : (
                            tareaValue?.fecha_compromiso || ''
                          )}
                        </td>
                        <td style={{ padding: 8 }}>
                          <button
                            onClick={() => {
                              if (isEdit) {
                                setEditingRows(m => {
                                  const newM = { ...m };
                                  delete newM[key];
                                  return newM;
                                });
                              } else {
                                setEditingRows(m => ({ ...m, [key]: true }));
                              }
                            }}
                            style={{ padding: '6px 10px', backgroundColor: isEdit ? '#333' : '#2196F3', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
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
