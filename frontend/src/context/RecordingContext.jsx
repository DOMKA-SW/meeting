import { createContext, useContext, useState, useRef, useCallback } from 'react';
import { apiFetch, API_URL } from '../utils/api';

const RecordingContext = createContext(null);

const CHUNK_INTERVAL_MS = 90000; // 90 segundos

const getSupportedMimeType = () => {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || null;
};

export function RecordingProvider({ children }) {
  // ── Estado visible ──────────────────────────────────────────────────────────
  const [isRecording, setIsRecording]   = useState(false);
  const [meetingId, setMeetingId]       = useState(null);
  const [form, setForm]                 = useState({ cliente: '', proyecto: '', responsable: '', participantes: '' });
  const [duration, setDuration]         = useState(0);
  const [chunkNumber, setChunkNumber]   = useState(0);
  const [progress, setProgress]         = useState({ chunksTotal: 0, chunksProcessed: 0, sectionsGenerated: 0, transcriptionLines: 0 });
  const [statusMsg, setStatusMsg]       = useState('');
  const [errorMsg, setErrorMsg]         = useState('');

  // ── Refs (persisten entre renders y navegaciones) ───────────────────────────
  const mediaRecorderRef       = useRef(null);
  const streamRef              = useRef(null);
  const chunksRef              = useRef([]);
  const intervalRef            = useRef(null);
  const durationIntervalRef    = useRef(null);
  const progressIntervalRef    = useRef(null);
  const currentMeetingIdRef    = useRef(null);
  const mimeTypeRef            = useRef(null);
  const chunkNumberRef         = useRef(0);

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const clearIntervals = useCallback(() => {
    [intervalRef, durationIntervalRef, progressIntervalRef].forEach(ref => {
      if (ref.current) { clearInterval(ref.current); ref.current = null; }
    });
  }, []);

  const sendChunk = useCallback(async (meetingIdToUse, chunkNum) => {
    if (chunksRef.current.length === 0) return;
    const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current || 'audio/webm' });
    if (blob.size < 10000) {
      console.warn(`Chunk ${chunkNum} descartado: muy pequeño (${(blob.size/1024).toFixed(1)}KB)`);
      chunksRef.current = [];
      return;
    }
    const formData = new FormData();
    formData.append('audio', blob, `chunk_${chunkNum}.webm`);
    formData.append('meetingId', meetingIdToUse);
    formData.append('chunkNumber', chunkNum.toString());
    chunksRef.current = [];
    try {
      await apiFetch('/chunk', { method: 'POST', body: formData });
      console.log(`✓ Chunk ${chunkNum} enviado (${(blob.size/1024).toFixed(0)}KB)`);
    } catch (e) {
      console.error(`Error enviando chunk ${chunkNum}:`, e);
    }
  }, []);

  const createAndStartRecorder = useCallback((audioStream, mimeType) => {
    const opts = mimeType ? { mimeType } : {};
    let recorder;
    try { recorder = new MediaRecorder(audioStream, opts); }
    catch (_) { recorder = new MediaRecorder(audioStream); }

    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunksRef.current.push(e.data); };
    recorder.onerror = (e) => console.error('MediaRecorder error:', e.error);
    recorder.start();
    return recorder;
  }, []);

  const rotateChunk = useCallback(async () => {
    const mid = currentMeetingIdRef.current;
    if (!mid || !mediaRecorderRef.current) return;

    const recorder = mediaRecorderRef.current;
    if (recorder.state === 'recording') {
      await new Promise(resolve => {
        recorder.onstop = resolve;
        recorder.requestData();
        recorder.stop();
        setTimeout(resolve, 2000);
      });
    }

    const currentChunk = chunkNumberRef.current;
    await sendChunk(mid, currentChunk);
    const nextChunk = currentChunk + 1;
    chunkNumberRef.current = nextChunk;
    setChunkNumber(nextChunk);

    if (streamRef.current?.active) {
      const audioTracks = streamRef.current.getAudioTracks();
      if (audioTracks.length > 0) {
        const newStream = new MediaStream(audioTracks);
        mediaRecorderRef.current = createAndStartRecorder(newStream, mimeTypeRef.current);
      }
    }
  }, [sendChunk, createAndStartRecorder]);

  const startProgressPolling = useCallback((mid) => {
    progressIntervalRef.current = setInterval(async () => {
      try {
        const res = await apiFetch(`/meetings/${mid}/progress`);
        if (res.ok) {
          const data = await res.json();
          setProgress(data);
          if (data.sectionsGenerated > 0) {
            setStatusMsg(`✅ ${data.sectionsGenerated} sección(es) procesada(s) · ${data.transcriptionLines} líneas`);
          } else if (data.chunksProcessed > 0) {
            setStatusMsg(`🔄 ${data.chunksProcessed}/${data.chunksTotal} chunks · ${data.transcriptionLines} líneas`);
          }
        }
      } catch (_) {}
    }, 8000);
  }, []);

  // ── startMeeting ─────────────────────────────────────────────────────────────
  const startMeeting = useCallback(async () => {
    setErrorMsg('');
    setStatusMsg('');
    try {
      try { await apiFetch('/health'); } catch (_) {
        setErrorMsg('❌ No se puede conectar al servidor.');
        return false;
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

      const videoTracks = stream.getVideoTracks();
      for (const vt of videoTracks) {
        try { await vt.applyConstraints({ width: 1, height: 1, frameRate: 1 }); } catch (_) {}
      }

      let audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        setStatusMsg('⚠️ Sin audio del sistema. Intentando micrófono...');
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          audioTracks = micStream.getAudioTracks();
          setStatusMsg('🎤 Usando micrófono');
        } catch (_) {
          stream.getTracks().forEach(t => t.stop());
          setErrorMsg('❌ Sin fuente de audio. Habilita el micrófono o "Compartir audio del sistema".');
          return false;
        }
      }

      const mimeType = getSupportedMimeType();
      if (!mimeType) {
        stream.getTracks().forEach(t => t.stop());
        setErrorMsg('❌ Tu navegador no soporta grabación. Usa Chrome o Edge.');
        return false;
      }

      streamRef.current  = stream;
      mimeTypeRef.current = mimeType;

      const participantesArr = form.participantes
        ? form.participantes.split(/[,;]/).map(p => p.trim()).filter(Boolean)
        : [];

      const res = await apiFetch('/startMeeting', {
        method: 'POST',
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
        return false;
      }

      const data = await res.json();
      const mid = data.meetingId;
      setMeetingId(mid);
      currentMeetingIdRef.current = mid;
      chunkNumberRef.current = 0;
      setChunkNumber(0);
      setDuration(0);
      setStatusMsg('🎙️ Grabando...');

      await new Promise(r => setTimeout(r, 800));

      const audioOnlyStream = new MediaStream(audioTracks);
      mediaRecorderRef.current = createAndStartRecorder(audioOnlyStream, mimeType);

      intervalRef.current = setInterval(rotateChunk, CHUNK_INTERVAL_MS);

      durationIntervalRef.current = setInterval(() => {
        setDuration(prev => {
          if (prev >= 10 * 3600) { stopMeeting(); return prev; } // máx 10h
          return prev + 1;
        });
      }, 1000);

      startProgressPolling(mid);
      setIsRecording(true);
      return true;
    } catch (err) {
      console.error('Error iniciando reunión:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setErrorMsg('❌ Permiso denegado. Debes permitir compartir pantalla para grabar.');
      } else if (err.name === 'NotFoundError') {
        setErrorMsg('❌ No se encontró dispositivo de audio o pantalla.');
      } else if (err.name === 'AbortError') {
        setErrorMsg('');
      } else {
        setErrorMsg('❌ ' + (err.message || 'Error desconocido al iniciar'));
      }
      return false;
    }
  }, [form, createAndStartRecorder, rotateChunk, startProgressPolling]);

  // ── stopMeeting ──────────────────────────────────────────────────────────────
  const stopMeeting = useCallback(async () => {
    clearIntervals();

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
        await apiFetch('/endMeeting', {
          method: 'POST',
          body: JSON.stringify({ meetingId: mid })
        });
      } catch (e) { console.error('Error endMeeting:', e); }
    }

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    // Reset state
    setIsRecording(false);
    setMeetingId(null);
    setChunkNumber(0);
    setDuration(0);
    setStatusMsg('');
    setProgress({ chunksTotal: 0, chunksProcessed: 0, sectionsGenerated: 0, transcriptionLines: 0 });
    chunksRef.current = [];
    mediaRecorderRef.current = null;
    currentMeetingIdRef.current = null;
    mimeTypeRef.current = null;

    return mid; // retorna el meetingId para que el componente pueda navegar
  }, [clearIntervals, sendChunk]);

  return (
    <RecordingContext.Provider value={{
      isRecording,
      meetingId,
      form, setForm,
      duration,
      chunkNumber,
      progress,
      statusMsg,
      errorMsg, setErrorMsg,
      startMeeting,
      stopMeeting
    }}>
      {children}
    </RecordingContext.Provider>
  );
}

export const useRecording = () => {
  const ctx = useContext(RecordingContext);
  if (!ctx) throw new Error('useRecording must be used within RecordingProvider');
  return ctx;
};
