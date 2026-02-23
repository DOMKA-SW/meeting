import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_BASE_URL;

function ManualMeeting() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    cliente: '',
    proyecto: '',
    responsable: '',
    participantes: '',
    fecha: new Date().toISOString().split('T')[0],
    hora_inicio: '',
    hora_fin: '',
  });
  const [texto, setTexto] = useState('');
  const [loading, setLoading] = useState(false);
  const [inputMode, setInputMode] = useState('notas'); // 'notas' | 'transcripcion'

  const ejemploNotas = `Hablamos sobre el avance del módulo de pagos, está al 70%.
Carlos mencionó que necesita los accesos al servidor de producción.
Se decidió lanzar la versión beta el próximo viernes.
María va a preparar el documento de pruebas antes del miércoles.
Pendiente: revisar los logs de errores del día anterior.
Juan quedó de enviar el presupuesto actualizado a más tardar el jueves.`;

  const ejemploTranscripcion = `[Juan]: Buenos días a todos, empecemos con el avance del proyecto.
[María]: El módulo de pagos está al 70%, esperamos terminarlo esta semana.
[Carlos]: Necesito los accesos al servidor de producción para continuar.
[Juan]: Perfecto, te los envío hoy. ¿Cuándo podemos hacer el lanzamiento beta?
[María]: Si todo sale bien, el viernes podría ser.
[Juan]: De acuerdo. María, ¿puedes tener el documento de pruebas listo el miércoles?
[María]: Sí, sin problema.
[Juan]: Carlos, necesito el presupuesto actualizado antes del jueves.
[Carlos]: Listo, lo tendrás el miércoles en la tarde.`;

  const handleSubmit = async () => {
    if (!texto.trim()) {
      alert('Por favor ingresa el texto de la reunión.');
      return;
    }
    setLoading(true);
    try {
      const participantesArr = form.participantes
        ? form.participantes.split(/[,;]/).map(p => p.trim()).filter(Boolean)
        : [];

      const response = await fetch(`${API_URL}/meetings/from-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'user1',
          cliente: form.cliente.trim(),
          proyecto: form.proyecto.trim(),
          responsable: form.responsable.trim(),
          participantes: participantesArr,
          texto: texto.trim(),
          fecha: form.fecha,
          hora_inicio: form.hora_inicio,
          hora_fin: form.hora_fin,
        })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        alert('Error: ' + (err.error || response.statusText));
        setLoading(false);
        return;
      }

      const data = await response.json();
      navigate(`/meetings/${data.meetingId}`);
    } catch (error) {
      alert('Error al procesar: ' + error.message);
    }
    setLoading(false);
  };

  const inputStyle = {
    width: '100%',
    padding: '8px 12px',
    borderRadius: '4px',
    border: '1px solid #ccc',
    fontSize: '14px',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 style={{ marginBottom: 4 }}>✍️ Reunión desde Texto</h1>
      <p style={{ color: '#666', marginBottom: 24, fontSize: 14 }}>
        Ingresa notas o transcripción de una reunión y el sistema generará el acta y tareas automáticamente.
      </p>

      {/* Tipo de entrada */}
      <div style={{ marginBottom: 20, display: 'flex', gap: 10 }}>
        {[
          { id: 'notas', label: '📝 Notas libres', desc: 'Texto sin formato, bullet points, párrafos' },
          { id: 'transcripcion', label: '🎙️ Transcripción', desc: 'Formato [Speaker]: texto' },
        ].map(m => (
          <div
            key={m.id}
            onClick={() => setInputMode(m.id)}
            style={{
              flex: 1, padding: '12px 16px', borderRadius: 8, cursor: 'pointer',
              border: inputMode === m.id ? '2px solid #2196F3' : '2px solid #e0e0e0',
              backgroundColor: inputMode === m.id ? '#e3f2fd' : 'white',
            }}
          >
            <div style={{ fontWeight: 'bold', marginBottom: 2 }}>{m.label}</div>
            <div style={{ fontSize: 12, color: '#666' }}>{m.desc}</div>
          </div>
        ))}
      </div>

      {/* Datos de reunión */}
      <div style={{ padding: 20, backgroundColor: '#f9f9f9', borderRadius: 8, marginBottom: 20 }}>
        <p style={{ fontWeight: 'bold', marginBottom: 14 }}>Datos de la reunión</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Cliente</label>
            <input style={inputStyle} value={form.cliente} onChange={e => setForm(f => ({ ...f, cliente: e.target.value }))} placeholder="Nombre del cliente" />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Proyecto</label>
            <input style={inputStyle} value={form.proyecto} onChange={e => setForm(f => ({ ...f, proyecto: e.target.value }))} placeholder="Nombre del proyecto" />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Responsable</label>
            <input style={inputStyle} value={form.responsable} onChange={e => setForm(f => ({ ...f, responsable: e.target.value }))} placeholder="Responsable de la reunión" />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Participantes (separados por coma)</label>
            <input style={inputStyle} value={form.participantes} onChange={e => setForm(f => ({ ...f, participantes: e.target.value }))} placeholder="Juan, María, Carlos" />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Fecha</label>
            <input style={inputStyle} type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Hora inicio</label>
              <input style={inputStyle} type="time" value={form.hora_inicio} onChange={e => setForm(f => ({ ...f, hora_inicio: e.target.value }))} />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Hora fin</label>
              <input style={inputStyle} type="time" value={form.hora_fin} onChange={e => setForm(f => ({ ...f, hora_fin: e.target.value }))} />
            </div>
          </div>
        </div>
      </div>

      {/* Área de texto */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <label style={{ fontWeight: 'bold', fontSize: 14 }}>
            {inputMode === 'notas' ? '📝 Notas de la reunión' : '🎙️ Transcripción'}
          </label>
          <button
            onClick={() => setTexto(inputMode === 'notas' ? ejemploNotas : ejemploTranscripcion)}
            style={{ padding: '4px 10px', fontSize: 12, backgroundColor: '#eee', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer' }}
          >
            Ver ejemplo
          </button>
        </div>
        <textarea
          value={texto}
          onChange={e => setTexto(e.target.value)}
          placeholder={inputMode === 'notas'
            ? 'Escribe aquí tus notas de la reunión. Pueden ser bullet points, párrafos, o cualquier formato libre...\n\nEjemplo:\n- Se revisó el avance del proyecto X, está al 80%\n- Juan quedó de enviar el informe el viernes\n- Se decidió posponer el lanzamiento 2 semanas'
            : 'Pega aquí la transcripción en formato:\n\n[Nombre]: texto del participante\n[Nombre2]: respuesta\n\nEl sistema detectará los speakers automáticamente.'}
          style={{
            width: '100%', minHeight: 260, padding: '12px',
            borderRadius: 6, border: '1px solid #ccc', fontSize: 14,
            fontFamily: 'monospace', lineHeight: '1.5', resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ fontSize: 12, color: '#999', marginTop: 4, textAlign: 'right' }}>
          {texto.split(/\s+/).filter(Boolean).length} palabras
        </div>
      </div>

      {inputMode === 'transcripcion' && (
        <div style={{ padding: '10px 14px', backgroundColor: '#e8f5e9', borderRadius: 6, marginBottom: 16, fontSize: 13 }}>
          💡 <strong>Tip:</strong> Si tu transcripción ya tiene formato "[Speaker]: texto", el sistema respetará los speakers. Si no tiene formato, el LLM intentará identificarlos automáticamente.
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={loading || !texto.trim()}
        style={{
          padding: '14px 32px', fontSize: 16,
          backgroundColor: loading || !texto.trim() ? '#ccc' : '#2196F3',
          color: 'white', border: 'none', borderRadius: 6,
          cursor: loading || !texto.trim() ? 'default' : 'pointer',
          fontWeight: 'bold', width: '100%',
        }}
      >
        {loading ? '⏳ Procesando... (puede tomar 1-2 minutos)' : '🚀 Generar Acta y Tareas'}
      </button>

      {loading && (
        <div style={{ marginTop: 16, padding: 14, backgroundColor: '#fff3cd', borderRadius: 6, fontSize: 13 }}>
          <strong>Procesando tu reunión:</strong><br />
          1. Analizando texto y asignando speakers<br />
          2. Generando acta estructurada<br />
          3. Extrayendo tareas y responsables<br />
          Serás redirigido automáticamente cuando esté listo.
        </div>
      )}
    </div>
  );
}

export default ManualMeeting;
