import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_BASE_URL;
const CHUNK_INTERVAL_MS = 90_000; // 90s

function RecordMeeting() {
  const navigate = useNavigate();

  /* =========================
     STATE
  ========================= */
  const [step, setStep] = useState('form');
  const [isRecording, setIsRecording] = useState(false);
  const [meetingId, setMeetingId] = useState(null);
  const [chunkNumber, setChunkNumber] = useState(0);
  const [duration, setDuration] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [progress, setProgress] = useState({
    chunksProcessed: 0,
    sectionsGenerated: 0,
    transcriptionLines: 0
  });

  const [form, setForm] = useState({
    cliente: '',
    proyecto: '',
    responsable: '',
    participantes: ''
  });

  /* =========================
     REFS
  ========================= */
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const intervalRef = useRef(null);
  const durationIntervalRef = useRef(null);
  const progressIntervalRef = useRef(null);
  const currentMeetingIdRef = useRef(null);
  const mimeTypeRef = useRef(null);
  const chunkNumberRef = useRef(0);

  /* =========================
     HELPERS (NIVEL COMPONENTE)
  ========================= */

  const getSupportedMimeType = () => {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];
    return types.find(t => MediaRecorder.isTypeSupported(t)) || null;
  };

  // ✅ CLAVE: evita el 404 del acta
  const waitForActa = async (mid, maxAttempts = 20) => {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`${API_URL}/meetings/${mid}/acta`);
        if (res.ok) return true;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 3000));
    }
    return false;
  };

  const formatDuration = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  };

  /* =========================
     PROGRESS POLLING
  ========================= */
  const startProgressPolling = (mid) => {
    progressIntervalRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/meetings/${mid}/progress`);
        if (res.ok) {
          const data = await res.json();
          setProgress(data);

          if (data.sectionsGenerated > 0) {
            setStatusMsg(`✅ ${data.sectionsGenerated} secciones generadas`);
          } else if (data.chunksProcessed > 0) {
            setStatusMsg(`🔄 ${data.chunksProcessed} chunks transcritos`);
          }
        }
      } catch (_) {}
    }, 8000);
  };

  /* =========================
     AUDIO
  ========================= */
  const sendChunk = useCallback(async (mid, chunkNum) => {
    if (!chunksRef.current.length) return;

    const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current });
    if (blob.size < 1000) return;

    const fd = new FormData();
    fd.append('audio', blob, `chunk_${chunkNum}.webm`);
    fd.append('meetingId', mid);
    fd.append('chunkNumber', chunkNum.toString());

    chunksRef.current = [];

    await fetch(`${API_URL}/chunk`, { method: 'POST', body: fd });
  }, []);

  const createRecorder = useCallback((stream) => {
    const recorder = new MediaRecorder(stream, { mimeType: mimeTypeRef.current });
    recorder.ondataavailable = e => e.data.size && chunksRef.current.push(e.data);
    recorder.start();
    return recorder;
  }, []);

  const rotateChunk = useCallback(async () => {
    const mid = currentMeetingIdRef.current;
    const recorder = mediaRecorderRef.current;
    if (!mid || !recorder) return;

    recorder.requestData();
    await new Promise(r => setTimeout(r, 200));
    recorder.stop();
    await new Promise(r => setTimeout(r, 300));

    await sendChunk(mid, chunkNumberRef.current);

    chunkNumberRef.current += 1;
    setChunkNumber(chunkNumberRef.current);

    if (streamRef.current?.active) {
      mediaRecorderRef.current = createRecorder(streamRef.current);
    }
  }, [sendChunk, createRecorder]);

  /* =========================
     START MEETING
  ========================= */
  const startMeeting = async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return alert('Activa "Compartir audio del sistema"');

    const mimeType = getSupportedMimeType();
    if (!mimeType) return alert('Navegador no compatible');

    mimeTypeRef.current = mimeType;
    streamRef.current = new MediaStream(audioTracks);

    const participantes = form.participantes
      .split(/[,;]/)
      .map(p => p.trim())
      .filter(Boolean);

    const res = await fetch(`${API_URL}/startMeeting`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, participantes })
    });

    const { meetingId } = await res.json();

    setMeetingId(meetingId);
    currentMeetingIdRef.current = meetingId;
    chunkNumberRef.current = 0;

    mediaRecorderRef.current = createRecorder(streamRef.current);
    intervalRef.current = setInterval(rotateChunk, CHUNK_INTERVAL_MS);
    durationIntervalRef.current = setInterval(() => setDuration(d => d + 1), 1000);

    startProgressPolling(meetingId);

    setStep('recording');
    setIsRecording(true);
  };

  /* =========================
     STOP MEETING
  ========================= */
  const stopMeeting = async () => {
    [intervalRef, durationIntervalRef, progressIntervalRef].forEach(r => r.current && clearInterval(r.current));

    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.requestData();
      await new Promise(r => setTimeout(r, 300));
      mediaRecorderRef.current.stop();
    }

    const mid = currentMeetingIdRef.current;
    if (mid) {
      await sendChunk(mid, chunkNumberRef.current);
      await fetch(`${API_URL}/endMeeting`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId: mid })
      });
    }

    setStatusMsg('⏳ Generando acta…');
    await waitForActa(mid);

    navigate(`/meetings/${mid}`);
  };

  /* =========================
     CLEANUP
  ========================= */
  useEffect(() => {
    return () => {
      [intervalRef, durationIntervalRef, progressIntervalRef].forEach(r => r.current && clearInterval(r.current));
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  /* =========================
     UI
  ========================= */
  return (
    <div style={{ maxWidth: 600 }}>
      <h1>🎙️ Grabar reunión</h1>

      {step === 'form' && (
        <>
          {['cliente','proyecto','responsable','participantes'].map(k => (
            <input
              key={k}
              placeholder={k}
              value={form[k]}
              onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
              style={{ width:'100%', marginBottom:10, padding:10 }}
            />
          ))}
          <button onClick={startMeeting} style={{ width:'100%', padding:14 }}>▶ Iniciar</button>
        </>
      )}

      {isRecording && (
        <>
          <h2>{formatDuration(duration)}</h2>
          <p>{statusMsg}</p>
          <button onClick={stopMeeting} style={{ width:'100%', padding:14, background:'#f44336', color:'#fff' }}>
            ⏹ Finalizar
          </button>
        </>
      )}
    </div>
  );
}

export default RecordMeeting;
