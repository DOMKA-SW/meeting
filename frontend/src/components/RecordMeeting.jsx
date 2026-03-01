import { useNavigate } from 'react-router-dom';
import { useRecording } from '../context/RecordingContext';

function RecordMeeting() {
  const navigate = useNavigate();
  const {
    isRecording,
    form, setForm,
    duration,
    chunkNumber,
    progress,
    statusMsg,
    errorMsg, setErrorMsg,
    startMeeting,
    stopMeeting
  } = useRecording();

  const formatDuration = (s) => {
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  };

  const handleStart = async () => {
    setErrorMsg('');
    await startMeeting();
  };

  const handleStop = async () => {
    const mid = await stopMeeting();
    if (mid) navigate('/meetings');
  };

  const sectionesEstimadas        = Math.floor(chunkNumber / 12);
  const porcentajeSiguienteSeccion = ((chunkNumber % 12) / 12) * 100;

  const inp = {
    width: '100%', padding: '8px 12px', borderRadius: '6px',
    border: '1px solid #ccc', fontSize: '14px', boxSizing: 'border-box'
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <h1 style={{ marginBottom: 4 }}>🎙️ Grabar Reunión</h1>

      {/* ── Formulario inicial ─────────────────────────────────────────────── */}
      {!isRecording && (
        <>
          <p style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>
            Captura el audio de tu reunión (Zoom, Teams, Meet...) y genera el acta automáticamente.
          </p>

          {errorMsg && (
            <div style={{
              padding: 12, backgroundColor: '#fdecea',
              border: '1px solid #f5c6cb', borderRadius: 8,
              marginBottom: 16, fontSize: 13, color: '#c62828'
            }}>
              {errorMsg}
            </div>
          )}

          <div style={{ padding: 20, backgroundColor: '#f9f9f9', borderRadius: 8, marginBottom: 16 }}>
            <p style={{ fontWeight: 'bold', marginBottom: 14 }}>Datos de la reunión</p>
            {[
              ['cliente',      'Cliente',      'Empresa o cliente'],
              ['proyecto',     'Proyecto',     'Nombre del proyecto'],
              ['responsable',  'Responsable',  'Quien modera la reunión'],
            ].map(([field, label, placeholder]) => (
              <div key={field} style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>{label}</label>
                <input
                  style={inp}
                  value={form[field]}
                  onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
                  placeholder={placeholder}
                />
              </div>
            ))}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
                Participantes <span style={{ color: '#2196F3', fontWeight: 'bold' }}>★ Importante para identificar speakers</span>
              </label>
              <input
                style={inp}
                value={form.participantes}
                onChange={e => setForm(f => ({ ...f, participantes: e.target.value }))}
                placeholder="Juan Pérez, María García, Carlos López"
              />
              <p style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                Los nombres ayudan a Whisper y al LLM a identificar quién habla con mayor precisión.
              </p>
            </div>
          </div>

          <div style={{
            padding: 14, backgroundColor: '#e3f2fd',
            borderRadius: 8, marginBottom: 20, fontSize: 13
          }}>
            <strong>💡 Tips para mejor transcripción:</strong>
            <ul style={{ marginTop: 6, marginBottom: 0, paddingLeft: 18 }}>
              <li>Usa <strong>Chrome o Edge</strong> (mejor soporte de audio)</li>
              <li>Al compartir pantalla, activa <strong>"Compartir audio del sistema"</strong></li>
              <li>Si no hay audio del sistema, el micrófono se usará automáticamente</li>
              <li>Ingresa los nombres de los participantes arriba para mejor identificación</li>
            </ul>
          </div>

          <button
            onClick={handleStart}
            style={{
              padding: '14px 28px', fontSize: 16, backgroundColor: '#4CAF50',
              color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer',
              fontWeight: 'bold', width: '100%'
            }}
          >
            ▶ Iniciar Grabación
          </button>
        </>
      )}

      {/* ── Panel de grabación activa ──────────────────────────────────────── */}
      {isRecording && (
        <div>
          <div style={{
            padding: 20, backgroundColor: '#1a1a2e',
            borderRadius: 12, color: 'white', marginBottom: 16
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{
                width: 14, height: 14, borderRadius: '50%',
                backgroundColor: '#f44336',
                animation: 'pulse 1.2s infinite',
                boxShadow: '0 0 8px #f44336'
              }} />
              <span style={{ fontSize: 24, fontWeight: 'bold', letterSpacing: 2, fontFamily: 'monospace' }}>
                {formatDuration(duration)}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
              {[
                ['Grabados',    chunkNumber,               '#64b5f6'],
                ['En servidor', progress.chunksTotal || 0, '#ff9800'],
                ['Transcritos', progress.chunksProcessed,  '#81c784'],
              ].map(([label, value, color]) => (
                <div key={label} style={{ textAlign: 'center', padding: '10px 8px', backgroundColor: '#2a2a4a', borderRadius: 8 }}>
                  <div style={{ fontSize: 22, fontWeight: 'bold', color }}>{value}</div>
                  <div style={{ fontSize: 10, color: '#aaa', marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Barra progreso hacia próxima sección */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
                <span>Progreso hacia sección {sectionesEstimadas + 1}</span>
                <span>{chunkNumber % 12}/12 chunks (~{Math.round(porcentajeSiguienteSeccion)}%)</span>
              </div>
              <div style={{ height: 6, backgroundColor: '#333', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 3,
                  backgroundColor: '#4CAF50',
                  width: `${porcentajeSiguienteSeccion}%`,
                  transition: 'width 0.5s ease'
                }} />
              </div>
            </div>

            {statusMsg && (
              <div style={{ fontSize: 12, color: '#aaa', textAlign: 'center', marginTop: 8 }}>
                {statusMsg}
              </div>
            )}
            {progress.transcriptionLines > 0 && (
              <div style={{ fontSize: 11, color: '#81c784', textAlign: 'center', marginTop: 4 }}>
                {progress.transcriptionLines} líneas de transcripción generadas
              </div>
            )}
          </div>

          {(form.cliente || form.proyecto) && (
            <div style={{ padding: 12, backgroundColor: '#f5f5f5', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
              {form.cliente  && <span><strong>Cliente:</strong> {form.cliente} · </span>}
              {form.proyecto && <span><strong>Proyecto:</strong> {form.proyecto}</span>}
            </div>
          )}

          <div style={{
            padding: 12, backgroundColor: '#e8f5e9',
            borderRadius: 8, marginBottom: 12, fontSize: 12, color: '#2e7d32'
          }}>
            ✅ Puedes navegar a otras secciones del sistema libremente — la grabación continuará.
            La barra inferior siempre muestra el estado. Solo "Finalizar" detendrá la grabación.
          </div>

          <div style={{ padding: 12, backgroundColor: '#fff8e1', borderRadius: 8, marginBottom: 16, fontSize: 12, color: '#666' }}>
            ⏱ Chunks de 90s — cada 12 chunks (~18 min) se genera un resumen de sección automáticamente.
          </div>

          <button
            onClick={handleStop}
            style={{
              padding: '14px 28px', fontSize: 16, backgroundColor: '#f44336',
              color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer',
              fontWeight: 'bold', width: '100%'
            }}
          >
            ⏹ Finalizar Reunión
          </button>

          <style>{`
            @keyframes pulse {
              0%, 100% { opacity: 1; transform: scale(1); }
              50% { opacity: 0.5; transform: scale(0.85); }
            }
          `}</style>
        </div>
      )}
    </div>
  );
}

export default RecordMeeting;
