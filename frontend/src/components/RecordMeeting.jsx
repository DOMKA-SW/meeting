import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRecording,
} from '../context/RecordingContext';
import { apiFetch } from '../utils/api';

const fmt = (s) => `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

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

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('es-ES', { day:'2-digit', month:'short', year:'numeric' }) : '';

  return (
    <div>
      <label style={labelStyle}>
        📎 Reunión anterior (traer sus tareas como "Tareas Anteriores")
        <span style={{ fontWeight:400, color:'#888', marginLeft:6 }}>— opcional</span>
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ ...inputStyle, color: value ? '#333' : '#999' }}
        disabled={loading}
      >
        <option value="">— Ninguna (es la primera reunión) —</option>
        {meetings.map(m => (
          <option key={m.id} value={m.id}>
            {[m.cliente, m.proyecto].filter(Boolean).join(' / ')} — {formatDate(m.started_at)}
            {m.tareas_pendientes > 0 ? ` (${m.tareas_pendientes} tarea${m.tareas_pendientes>1?'s':''} pendiente${m.tareas_pendientes>1?'s':''})` : ' (sin pendientes)'}
          </option>
        ))}
      </select>
      {loading && <p style={{ fontSize:11, color:'#888', marginTop:3 }}>Cargando reuniones...</p>}
      {!loading && meetings.length === 0 && (
        <p style={{ fontSize:11, color:'#aaa', marginTop:3 }}>No hay reuniones anteriores{cliente ? ` de "${cliente}"` : ''}.</p>
      )}
    </div>
  );
}

const labelStyle = { display:'block', marginBottom:4, fontSize:13, fontWeight:600, color:'#444' };
const inputStyle = { width:'100%', padding:'8px 12px', borderRadius:6, border:'1px solid #d0d5dd', fontSize:14, boxSizing:'border-box', backgroundColor:'#fff', outline:'none' };

export default function RecordMeeting() {
  const navigate = useNavigate();
  const {
    isRecording, form, setForm, duration, chunkNumber, progress,
    statusMsg, errorMsg, setErrorMsg, audioSource, startMeeting, stopMeeting, resetMeetingForm
  } = useRecording();

  const handleStart = async () => { setErrorMsg(''); await startMeeting(); };
  const handleStop  = async () => { const mid = await stopMeeting(); if (mid) { resetMeetingForm(); navigate('/meetings'); } };

  const seccPct = ((chunkNumber % 12) / 12) * 100;
  const seccNum = Math.floor(chunkNumber / 12);

  return (
    <div style={{ maxWidth:620 }}>
      <h1 style={{ marginBottom:4 }}>🎙️ Grabar Reunión</h1>

      {!isRecording && (
        <>
          <p style={{ color:'#555', fontSize:13, marginBottom:20 }}>
            Captura audio de Zoom, Teams, Meet… y genera el acta automáticamente.
          </p>

          {errorMsg && (
            <div style={{ padding:12, backgroundColor:'#fdecea', border:'1px solid #f5c6cb', borderRadius:8, marginBottom:16, fontSize:13, color:'#c62828' }}>
              {errorMsg}
            </div>
          )}

          <div style={{ padding:20, backgroundColor:'#f9fafb', borderRadius:10, border:'1px solid #e5e7eb', marginBottom:16 }}>
            <p style={{ fontWeight:700, fontSize:14, marginBottom:16, color:'#111' }}>Datos de la reunión</p>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
              {[['cliente','Cliente','Empresa / cliente'],['proyecto','Proyecto','Nombre del proyecto']].map(([f,l,p]) => (
                <div key={f}>
                  <label style={labelStyle}>{l}</label>
                  <input style={inputStyle} value={form[f]} onChange={e => setForm(frm=>({...frm,[f]:e.target.value}))} placeholder={p} />
                </div>
              ))}
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={labelStyle}>Responsable / moderador</label>
              <input style={inputStyle} value={form.responsable} onChange={e => setForm(f=>({...f,responsable:e.target.value}))} placeholder="Quien modera" />
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={labelStyle}>
                Participantes <span style={{ color:'#2196F3', fontSize:12 }}>★ Mejora la identificación de speakers</span>
              </label>
              <input style={inputStyle} value={form.participantes} onChange={e => setForm(f=>({...f,participantes:e.target.value}))} placeholder="Juan Pérez, María García, Carlos López" />
              <p style={{ fontSize:11, color:'#888', margin:'3px 0 0' }}>Separa con comas. Los nombres se envían a Whisper para mejor transcripción.</p>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={labelStyle}>
                Vocabulario técnico <span style={{ fontWeight:400, color:'#888' }}>— opcional pero recomendado</span>
              </label>
              <input style={inputStyle} value={form.terminology} onChange={e => setForm(f=>({...f,terminology:e.target.value}))} placeholder="LEVAPAN, CRM v2, sprint, módulo de pagos, SAP..." />
              <p style={{ fontSize:11, color:'#888', margin:'3px 0 0' }}>Nombres de empresa, productos y términos técnicos que usa tu equipo.</p>
            </div>
            <LinkedMeetingSelector
              value={form.linked_meeting_id}
              onChange={v => setForm(f=>({...f, linked_meeting_id:v}))}
              cliente={form.cliente}
            />
          </div>

          <div style={{ padding:14, backgroundColor:'#eff6ff', borderRadius:8, marginBottom:20, fontSize:13, border:'1px solid #bfdbfe' }}>
            <strong>💡 Para capturar audio de Zoom/Teams/Meet:</strong>
            <ol style={{ marginTop:6, marginBottom:0, paddingLeft:20, lineHeight:1.8 }}>
              <li>Haz clic en <strong>"Iniciar Grabación"</strong></li>
              <li>Selecciona <strong>"Compartir pantalla"</strong> en el diálogo</li>
              <li>Marca la casilla <strong>"Compartir audio del sistema"</strong> (esquina inferior)</li>
              <li>El sistema mezclará automáticamente el audio del sistema + tu micrófono</li>
            </ol>
          </div>

          <button onClick={handleStart}
            style={{ padding:'14px 28px', fontSize:16, backgroundColor:'#16a34a', color:'white', border:'none', borderRadius:8, cursor:'pointer', fontWeight:700, width:'100%' }}>
            ▶ Iniciar Grabación
          </button>
        </>
      )}

      {isRecording && (
        <div>
          <div style={{ padding:20, backgroundColor:'#0f172a', borderRadius:12, color:'white', marginBottom:16 }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
              <div style={{ width:14, height:14, borderRadius:'50%', backgroundColor:'#ef4444', boxShadow:'0 0 10px #ef4444', animation:'pulse 1.2s infinite' }} />
              <span style={{ fontSize:28, fontWeight:700, letterSpacing:3, fontFamily:'monospace' }}>{fmt(duration)}</span>
              <span style={{ fontSize:13, color:'#64748b', backgroundColor:'#1e293b', padding:'3px 10px', borderRadius:20 }}>
                {audioSource === 'mixed' ? '🎙️+🖥️ sistema+mic' : audioSource === 'system' ? '🖥️ sistema' : '🎤 micrófono'}
              </span>
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:14 }}>
              {[['Chunks grabados', chunkNumber,'#60a5fa'],['Transcritos', progress.chunksProcessed,'#34d399'],['Secciones', progress.sectionsGenerated,'#a78bfa']].map(([l,v,c]) => (
                <div key={l} style={{ textAlign:'center', padding:'10px 8px', backgroundColor:'#1e293b', borderRadius:8 }}>
                  <div style={{ fontSize:22, fontWeight:700, color:c }}>{v}</div>
                  <div style={{ fontSize:10, color:'#64748b', marginTop:2 }}>{l}</div>
                </div>
              ))}
            </div>

            <div style={{ marginBottom:8 }}>
              <div style={{ fontSize:11, color:'#64748b', marginBottom:4, display:'flex', justifyContent:'space-between' }}>
                <span>Próxima sección {seccNum+1}</span>
                <span>{chunkNumber%12}/12 chunks</span>
              </div>
              <div style={{ height:5, backgroundColor:'#1e293b', borderRadius:3, overflow:'hidden' }}>
                <div style={{ height:'100%', backgroundColor:'#22c55e', width:`${seccPct}%`, borderRadius:3, transition:'width 0.5s' }} />
              </div>
            </div>

            {statusMsg && <div style={{ fontSize:12, color:'#94a3b8', textAlign:'center', marginTop:8 }}>{statusMsg}</div>}
          </div>

          <div style={{ padding:12, backgroundColor:'#f0fdf4', borderRadius:8, marginBottom:12, fontSize:13, color:'#15803d', border:'1px solid #bbf7d0' }}>
            ✅ Puedes navegar libremente. La grabación continúa. Solo "Finalizar" la detiene.
          </div>

          <button onClick={handleStop}
            style={{ padding:'14px 28px', fontSize:16, backgroundColor:'#dc2626', color:'white', border:'none', borderRadius:8, cursor:'pointer', fontWeight:700, width:'100%' }}>
            ⏹ Finalizar Reunión
          </button>

          <style>{`@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.85)}}`}</style>
        </div>
      )}
    </div>
  );
}
