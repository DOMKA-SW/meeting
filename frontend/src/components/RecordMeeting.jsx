import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_BASE_URL;

// Chunk cada 90 segundos: balance óptimo entre contexto de Whisper y latencia
const CHUNK_INTERVAL_MS = 90000;

function RecordMeeting() {
  const navigate = useNavigate();
  const [step, setStep] = useState('form');
  const [form, setForm] = useState({ cliente: '', proyecto: '', responsable: '', participantes: '' });
  const [isRecording, setIsRecording] = useState(false);
  const [meetingId, setMeetingId] = useState(null);
  const [chunkNumber, setChunkNumber] = useState(0);
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState({ chunksTotal: 0, chunksProcessed: 0, sectionsGenerated: 0, transcriptionLines: 0 });
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const intervalRef = useRef(null);
  const durationIntervalRef = useRef(null);
  const progressIntervalRef = useRef(null);
  const currentMeetingIdRef = useRef(null);
  const mimeTypeRef = useRef(null);
  const chunkNumberRef = useRef(0);

  const getSupportedMimeType = () => {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return types.find(t => MediaRecorder.isTypeSupported(t)) || null;
  };

  // Polling de progreso mientras graba
  const startProgressPolling = (mid) => {
    progressIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/meetings/${mid}/progress`);
        if (res.ok) {
          const data = await res.json();
          setProgress(data);
          if (data.sectionsGenerated > 0) {
            setStatusMsg(`✅ ${data.sectionsGenerated} sección(es) procesada(s) · ${data.transcriptionLines} líneas transcritas`);
          } else if (data.chunksProcessed > 0) {
            setStatusMsg(`🔄 ${data.chunksProcessed}/${data.chunksTotal} chunks transcritos · ${data.transcriptionLines} líneas`);
          }
        }
      } catch (_) {}
    }, 8000);
  };

  const sendChunk = useCallback(async (meetingIdToUse, chunkNum) => {
    if (chunksRef.current.length === 0) return;
    const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current || 'audio/webm' });
    if (blob.size < 500) return; // Umbral reducido de 1000 a 500 bytes
    const formData = new FormData();
    formData.append('audio', blob, `chunk_${chunkNum}.webm`);
    formData.append('meetingId', meetingIdToUse);
    formData.append('chunkNumber', chunkNum.toString());
    chunksRef.current = [];
    try {
      await fetch(`${API_URL}/chunk`, { method: 'POST', body: formData });
      console.log(`✓ Chunk ${chunkNum} enviado (${(blob.size/1024).toFixed(0)}KB)`);
    } catch (e) {
      console.error(`Error enviando chunk ${chunkNum}:`, e);
    }
  }, []);

  const createAndStartRecorder = useCallback((audioStream, mimeType) => {
    const opts = mimeType ? { mimeType } : {};
    let recorder;
    try {
      recorder = new MediaRecorder(audioStream, opts);
    } catch (_) {
      recorder = new MediaRecorder(audioStream);
    }

    recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onerror = (e) => console.error('MediaRecorder error:', e.error);

    recorder.start();
    return recorder;
  }, []);

  const rotateChunk = useCallback(async () => {
    const mid = currentMeetingIdRef.current;
    if (!mid || !mediaRecorderRef.current) return;

    const recorder = mediaRecorderRef.current;
    if (recorder.state === 'recording') {
      // FIX: esperar el evento onstop en vez de timeouts fijos
      await new Promise(resolve => {
        recorder.onstop = resolve;
        recorder.requestData();
        recorder.stop();
        setTimeout(resolve, 2000); // safety timeout
      });
    }

    // Enviar chunk actual
    const currentChunk = chunkNumberRef.current;
    await sendChunk(mid, currentChunk);
    const nextChunk = currentChunk + 1;
    chunkNumberRef.current = nextChunk;
    setChunkNumber(nextChunk);

    // Iniciar nuevo recorder si el stream sigue activo
    if (streamRef.current?.active) {
      const audioTracks = streamRef.current.getAudioTracks();
      if (audioTracks.length > 0) {
        const newStream = new MediaStream(audioTracks);
        mediaRecorderRef.current = createAndStartRecorder(newStream, mimeTypeRef.current);
      }
    }
  }, [sendChunk, createAndStartRecorder]);

  const startMeeting = async () => {
    setErrorMsg('');
    setStatusMsg('');
    try {
      // Verificar que el backend esté disponible
      try {
        await fetch(`${API_URL}/health`);
      } catch (_) {
        setErrorMsg('❌ No se puede conectar al servidor. Verifica que el backend esté activo en Railway.');
        return;
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

      // Minimizar video para ahorrar recursos
      const videoTracks = stream.getVideoTracks();
      for (const vt of videoTracks) {
        try { await vt.applyConstraints({ width: 1, height: 1, frameRate: 1 }); } catch (_) {}
      }

      let audioTracks = stream.getAudioTracks();

      // FIX: Fallback a micrófono si no hay audio del sistema
      if (audioTracks.length === 0) {
        setStatusMsg('⚠️ No se detectó audio del sistema. Intentando micrófono...');
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          audioTracks = micStream.getAudioTracks();
          setStatusMsg('🎤 Usando micrófono (para mejor calidad, activa "Compartir audio del sistema")');
        } catch (micErr) {
          stream.getTracks().forEach(t => t.stop());
          setErrorMsg('❌ Sin fuente de audio. Habilita el micrófono o "Compartir audio del sistema".');
          return;
        }
      }

      const mimeType = getSupportedMimeType();
      if (!mimeType) {
        stream.getTracks().forEach(t => t.stop());
        setErrorMsg('❌ Tu navegador no soporta grabación. Usa Chrome o Edge.');
        return;
      }

      streamRef.current = stream;
      mimeTypeRef.current = mimeType;

      const participantesArr = form.participantes
        ? form.participantes.split(/[,;]/).map(p => p.trim()).filter(Boolean)
        : [];

      const res = await fetch(`${API_URL}/startMeeting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'user1',
          cliente: form.cliente.trim(),
          proyecto: form.proyecto.trim(),
          responsable: form.responsable.trim(),
          participantes: participantesArr
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setErrorMsg(`❌ Error del servidor: ${err.error || res.statusText}`);
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      const data = await res.json();
      const mid = data.meetingId;
      setMeetingId(mid);
      currentMeetingIdRef.current = mid;
      chunkNumberRef.current = 0;
      setChunkNumber(0);
      setDuration(0);
      setStatusMsg('🎙️ Grabando...');

      // Esperar un momento antes de iniciar grabación
      await new Promise(r => setTimeout(r, 800));

      const audioOnlyStream = new MediaStream(audioTracks);
      mediaRecorderRef.current = createAndStartRecorder(audioOnlyStream, mimeType);

      // Rotar chunk cada 90 segundos
      intervalRef.current = setInterval(rotateChunk, CHUNK_INTERVAL_MS);

      // Timer de duración
      durationIntervalRef.current = setInterval(() => {
        setDuration(prev => {
          if (prev >= 3 * 3600) { stopMeeting(); return prev; } // máx 3h
          return prev + 1;
        });
      }, 1000);

      // Polling de progreso
      startProgressPolling(mid);

      setStep('recording');
      setIsRecording(true);
    } catch (err) {
      console.error('Error iniciando reunión:', err);
      // FIX: mensajes de error específicos por tipo
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setErrorMsg('❌ Permiso denegado. Debes permitir compartir pantalla para grabar.');
      } else if (err.name === 'NotFoundError') {
        setErrorMsg('❌ No se encontró dispositivo de audio o pantalla.');
      } else if (err.name === 'AbortError') {
        setErrorMsg(''); // El usuario canceló el diálogo, no es un error real
      } else {
        setErrorMsg('❌ ' + (err.message || 'Error desconocido al iniciar'));
      }
    }
  };

  const stopMeeting = async () => {
    // Detener timers
    [intervalRef, durationIntervalRef, progressIntervalRef].forEach(ref => {
      if (ref.current) { clearInterval(ref.current); ref.current = null; }
    });

    // Parar recorder y enviar último chunk
    if (mediaRecorderRef.current?.state === 'recording') {
      await new Promise(resolve => {
        mediaRecorderRef.current.onstop = resolve;
        mediaRecorderRef.current.requestData();
        mediaRecorderRef.current.stop();
        setTimeout(resolve, 2000);
      });
    }

    const mid = currentMeetingIdRef.current;
    if (mid) {
      await sendChunk(mid, chunkNumberRef.current);
      try {
        await fetch(`${API_URL}/endMeeting`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meetingId: mid })
        });
      } catch (e) { console.error('Error endMeeting:', e); }
    }

    // Detener stream
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    // Reset
    setStep('form'); setIsRecording(false); setMeetingId(null);
    setChunkNumber(0); setDuration(0); setStatusMsg('');
    setProgress({ chunksTotal: 0, chunksProcessed: 0, sectionsGenerated: 0, transcriptionLines: 0 });
    chunksRef.current = []; mediaRecorderRef.current = null;
    currentMeetingIdRef.current = null; mimeTypeRef.current = null;

    navigate('/meetings');
  };

  useEffect(() => {
    return () => {
      [intervalRef, durationIntervalRef, progressIntervalRef].forEach(ref => {
        if (ref.current) clearInterval(ref.current);
      });
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const formatDuration = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  };

  const sectionesEstimadas = Math.floor(chunkNumber / 12);
  const porcentajeSiguienteSeccion = ((chunkNumber % 12) / 12) * 100;

  const inp = { width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #ccc', fontSize: '14px', boxSizing: 'border-box' };

  return (
    <div style={{ maxWidth: 600 }}>
      <h1 style={{ marginBottom: 4 }}>🎙️ Grabar Reunión</h1>

      {step === 'form' && (
        <>
          <p style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>
            Captura el audio de tu reunión (Zoom, Teams, Meet...) y genera el acta automáticamente.
          </p>

          {/* FIX: Mostrar errores en UI en vez de alert() */}
          {errorMsg && (
            <div style={{ padding: 12, backgroundColor: '#fdecea', border: '1px solid #f5c6cb', borderRadius: 8, marginBottom: 16, fontSize: 13, color: '#c62828' }}>
              {errorMsg}
            </div>
          )}

          <div style={{ padding: 20, backgroundColor: '#f9f9f9', borderRadius: 8, marginBottom: 16 }}>
            <p style={{ fontWeight: 'bold', marginBottom: 14 }}>Datos de la reunión</p>
            {[
              ['cliente', 'Cliente', 'Empresa o cliente'],
              ['proyecto', 'Proyecto', 'Nombre del proyecto'],
              ['responsable', 'Responsable', 'Quien modera la reunión'],
            ].map(([field, label, placeholder]) => (
              <div key={field} style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>{label}</label>
                <input style={inp} value={form[field]}
                  onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
                  placeholder={placeholder} />
              </div>
            ))}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 500 }}>
                Participantes <span style={{ color: '#2196F3', fontWeight: 'bold' }}>★ Importante para identificar speakers</span>
              </label>
              <input style={inp} value={form.participantes}
                onChange={e => setForm(f => ({ ...f, participantes: e.target.value }))}
                placeholder="Juan Pérez, María García, Carlos López" />
              <p style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                Los nombres ayudan a Whisper y al LLM a identificar quién habla con mayor precisión.
              </p>
            </div>
          </div>

          <div style={{ padding: 14, backgroundColor: '#e3f2fd', borderRadius: 8, marginBottom: 20, fontSize: 13 }}>
            <strong>💡 Tips para mejor transcripción:</strong>
            <ul style={{ marginTop: 6, marginBottom: 0, paddingLeft: 18 }}>
              <li>Usa <strong>Chrome o Edge</strong> (mejor soporte de audio)</li>
              <li>Al compartir pantalla, activa <strong>"Compartir audio del sistema"</strong></li>
              <li>Si no hay audio del sistema, el micrófono se usará automáticamente</li>
              <li>Ingresa los nombres de los participantes arriba para mejor identificación</li>
            </ul>
          </div>

          <button onClick={startMeeting} style={{
            padding: '14px 28px', fontSize: 16, backgroundColor: '#4CAF50',
            color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer',
            fontWeight: 'bold', width: '100%'
          }}>
            ▶ Iniciar Grabación
          </button>
        </>
      )}

      {isRecording && (
        <div>
          {/* Panel principal de grabación */}
          <div style={{
            padding: 20, backgroundColor: '#1a1a2e', borderRadius: 12,
            color: 'white', marginBottom: 16
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{
                width: 14, height: 14, borderRadius: '50%', backgroundColor: '#f44336',
                animation: 'pulse 1.2s infinite', boxShadow: '0 0 8px #f44336'
              }} />
              <span style={{ fontSize: 18, fontWeight: 'bold', letterSpacing: 2 }}>
                {formatDuration(duration)}
              </span>
              <span style={{ fontSize: 12, color: '#aaa', marginLeft: 'auto' }}>
                Máx. 3:00:00
              </span>
            </div>

            {/* FIX: 3 métricas diferenciadas: local / servidor / transcritos */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
              {[
                ['Grabados', chunkNumber, '#64b5f6'],
                ['En servidor', progress.chunksTotal || 0, '#ff9800'],
                ['Transcritos', progress.chunksProcessed, '#81c784'],
              ].map(([label, value, color]) => (
                <div key={label} style={{ textAlign: 'center', padding: '10px 8px', backgroundColor: '#2a2a4a', borderRadius: 8 }}>
                  <div style={{ fontSize: 22, fontWeight: 'bold', color }}>{value}</div>
                  <div style={{ fontSize: 10, color: '#aaa', marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Barra de progreso hacia próxima sección */}
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

          {/* Info de la reunión */}
          {(form.cliente || form.proyecto) && (
            <div style={{ padding: 12, backgroundColor: '#f5f5f5', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
              {form.cliente && <span><strong>Cliente:</strong> {form.cliente} · </span>}
              {form.proyecto && <span><strong>Proyecto:</strong> {form.proyecto}</span>}
            </div>
          )}

          <div style={{ padding: 12, backgroundColor: '#fff8e1', borderRadius: 8, marginBottom: 16, fontSize: 12, color: '#666' }}>
            ⏱ Chunks de 90s — cada 12 chunks (~18 min) se genera un resumen de sección automáticamente.
            El acta completa se genera al finalizar.
          </div>

          <button onClick={stopMeeting} style={{
            padding: '14px 28px', fontSize: 16, backgroundColor: '#f44336',
            color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer',
            fontWeight: 'bold', width: '100%'
          }}>
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
