import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../utils/api';

const EJEMPLOS = {
  notas: `Reunión de seguimiento proyecto  - 23 Feb 2026

Asistentes: A, B, C, D

TEMAS TRATADOS:
- Tema 1
- Tema 2
- Tema 3

COMPROMISOS:
- Compromiso 1 
- Compromiso 2
- Compromiso 3,
  transcripcion: `[A]
[B]
[C]
[D]
`,
  email: `Asunto: Resumen reunión App Móvil - 23 Feb

Hola,
Les comparto el resumen de la reunión de hoy:
Revisamos ....
  
Aaprobados.

Compromisos:
- Compromiso 1 
- Compromiso 2
- Compromiso 3

Saludos,`
};

const labelStyle = { display:'block', marginBottom:5, fontSize:13, fontWeight:600, color:'#444' };
const inputStyle = { width:'100%', padding:'9px 12px', border:'1px solid #d0d5dd', borderRadius:7, fontSize:14, boxSizing:'border-box', outline:'none', backgroundColor:'white' };

function LinkedMeetingSelector({ value, onChange, cliente }) {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading]   = useState(false);

  useEffect(() => {
    setLoading(true);
    const url = cliente ? `/meetings-for-link?cliente=${encodeURIComponent(cliente)}` : '/meetings-for-link';
    apiFetch(url)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setMeetings(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [cliente]);

  const fmt = (d) => d ? new Date(d).toLocaleDateString('es-ES', { day:'2-digit', month:'short', year:'numeric' }) : '';
  return (
    <div>
      <label style={labelStyle}>
        📎 Reunión anterior (traer sus tareas como "Tareas Anteriores")
        <span style={{ fontWeight:400, color:'#888', marginLeft:6 }}>— opcional</span>
      </label>
      <select value={value} onChange={e=>onChange(e.target.value)} style={{ ...inputStyle, color:value?'#333':'#999' }} disabled={loading}>
        <option value="">— Ninguna (primera reunión) —</option>
        {meetings.map(m => (
          <option key={m.id} value={m.id}>
            {[m.cliente, m.proyecto].filter(Boolean).join(' / ')} — {fmt(m.started_at)}
            {m.tareas_pendientes > 0 ? ` (${m.tareas_pendientes} pendiente${m.tareas_pendientes>1?'s':''})` : ' (sin pendientes)'}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function ManualMeeting() {
  const navigate = useNavigate();
  const textareaRef = useRef(null);
  const [modo, setModo]                   = useState('notas');
  const [texto, setTexto]                 = useState('');
  const [form, setForm]                   = useState({ cliente:'', proyecto:'', responsable:'', participantes:'', linked_meeting_id:'', terminology:'' });
  const [fecha, setFecha]                 = useState('');
  const [horaInicio, setHoraInicio]       = useState('');
  const [horaFin, setHoraFin]             = useState('');
  const [processing, setProcessing]       = useState(false);
  const [error, setError]                 = useState('');
  const [charCount, setCharCount]         = useState(0);

  const set = (k,v) => setForm(f=>({...f,[k]:v}));

  const handleTextoChange = (e) => {
    setTexto(e.target.value);
    setCharCount(e.target.value.length);
  };

  const loadEjemplo = () => {
    const t = EJEMPLOS[modo] || '';
    setTexto(t);
    setCharCount(t.length);
    textareaRef.current?.focus();
  };

  const handleSubmit = async () => {
    if (!texto.trim() || texto.trim().split(/\s+/).length < 10)
      return setError('Necesitas al menos 10 palabras de contenido.');
    setError(''); setProcessing(true);
    try {
      const participantesArr = form.participantes
        ? form.participantes.split(/[,;]/).map(p=>p.trim()).filter(Boolean)
        : [];
      const res = await apiFetch('/meetings/from-text', {
        method:'POST',
        body: JSON.stringify({
          cliente:form.cliente.trim(), proyecto:form.proyecto.trim(),
          responsable:form.responsable.trim(), participantes:participantesArr,
          texto:texto.trim(), modo, fecha:fecha||null, hora_inicio:horaInicio,
          hora_fin:horaFin, linked_meeting_id:form.linked_meeting_id||null,
          terminology:form.terminology.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error||'Error del servidor'); setProcessing(false); return; }
      navigate(`/meetings/${data.meetingId}`);
    } catch (e) { setError(e.message); setProcessing(false); }
  };

  const modoTabs = [['notas','📝 Notas libres'],['transcripcion','💬 Transcripción'],['email','📧 Email / resumen']];

  return (
    <div style={{ maxWidth:700 }}>
      <h1 style={{ marginBottom:4 }}>✍️ Ingresar texto</h1>
      <p style={{ color:'#555', fontSize:13, marginBottom:20 }}>
        Pega notas, una transcripción o un email de resumen y genera el acta automáticamente.
      </p>

      {/* Tipo de contenido */}
      <div style={{ marginBottom:18 }}>
        <p style={{ fontSize:13, fontWeight:600, color:'#333', marginBottom:8 }}>Tipo de contenido:</p>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {modoTabs.map(([k,l]) => (
            <button key={k} onClick={()=>setModo(k)}
              style={{ padding:'8px 18px', borderRadius:7, border: modo===k?'2px solid #1565C0':'1px solid #d0d5dd',
                backgroundColor: modo===k?'#eff6ff':'white', color: modo===k?'#1565C0':'#555',
                fontSize:13, fontWeight: modo===k?700:500, cursor:'pointer' }}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Datos de la reunión */}
      <div style={{ padding:18, backgroundColor:'#f9fafb', borderRadius:10, border:'1px solid #e5e7eb', marginBottom:16 }}>
        <p style={{ fontWeight:700, fontSize:14, marginBottom:14, color:'#111' }}>Datos de identificación</p>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
          {[['cliente','Cliente'],['proyecto','Proyecto']].map(([f,l]) => (
            <div key={f}>
              <label style={labelStyle}>{l}</label>
              <input style={inputStyle} value={form[f]} onChange={e=>set(f,e.target.value)} placeholder={l} />
            </div>
          ))}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
          <div>
            <label style={labelStyle}>Responsable</label>
            <input style={inputStyle} value={form.responsable} onChange={e=>set('responsable',e.target.value)} placeholder="Quien modera" />
          </div>
          <div>
            <label style={labelStyle}>Fecha</label>
            <input type="date" style={inputStyle} value={fecha} onChange={e=>setFecha(e.target.value)} />
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
          <div>
            <label style={labelStyle}>Hora inicio</label>
            <input type="time" style={inputStyle} value={horaInicio} onChange={e=>setHoraInicio(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Hora fin</label>
            <input type="time" style={inputStyle} value={horaFin} onChange={e=>setHoraFin(e.target.value)} />
          </div>
        </div>
        <div style={{ marginBottom:12 }}>
          <label style={labelStyle}>Participantes</label>
          <input style={inputStyle} value={form.participantes} onChange={e=>set('participantes',e.target.value)} placeholder="Juan Pérez, María García (separa con comas)" />
        </div>
        <div style={{ marginBottom:12 }}>
          <label style={labelStyle}>
            Vocabulario técnico
            <span style={{ fontWeight:400, color:'#888', marginLeft:6 }}>— opcional</span>
          </label>
          <input style={inputStyle} value={form.terminology} onChange={e=>set('terminology',e.target.value)} placeholder="Nombres de empresa, productos, términos técnicos..." />
        </div>
        <LinkedMeetingSelector value={form.linked_meeting_id} onChange={v=>set('linked_meeting_id',v)} cliente={form.cliente} />
      </div>

      {/* Textarea */}
      <div style={{ marginBottom:16 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
          <label style={labelStyle}>Contenido</label>
          <button onClick={loadEjemplo}
            style={{ background:'none', border:'1px solid #d0d5dd', borderRadius:5, padding:'4px 10px', fontSize:12, color:'#666', cursor:'pointer' }}>
            Ver ejemplo
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={texto}
          onChange={handleTextoChange}
          rows={14}
          placeholder={`Pega aquí tu ${modo === 'notas' ? 'texto de notas' : modo === 'transcripcion' ? 'transcripción' : 'email o resumen'}...`}
          style={{ ...inputStyle, resize:'vertical', lineHeight:1.6, fontFamily:'inherit', minHeight:200 }}
        />
        <div style={{ fontSize:11, color:charCount>0?'#888':'#bbb', textAlign:'right', marginTop:3 }}>
          {charCount.toLocaleString()} caracteres · {texto.trim().split(/\s+/).filter(Boolean).length} palabras
        </div>
      </div>

      {error && (
        <div style={{ padding:12, backgroundColor:'#fef2f2', border:'1px solid #fecaca', borderRadius:8, fontSize:13, color:'#dc2626', marginBottom:16 }}>
          ⚠️ {error}
        </div>
      )}

      <button onClick={handleSubmit} disabled={processing || !texto.trim()}
        style={{ width:'100%', padding:'14px 28px', fontSize:16, backgroundColor: processing||!texto.trim()?'#9ca3af':'#1565C0', color:'white', border:'none', borderRadius:8, cursor: processing||!texto.trim()?'default':'pointer', fontWeight:700 }}>
        {processing ? '⏳ Procesando...' : '✨ Generar Acta'}
      </button>
    </div>
  );
}
