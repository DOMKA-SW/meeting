import { createContext, useContext, useState, useRef, useCallback } from 'react';
import { apiFetch } from '../utils/api';

const RecordingContext = createContext(null);
const CHUNK_INTERVAL_MS = 90000;

const getSupportedMimeType = () => {
  const types = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || null;
};

export function RecordingProvider({ children }) {
  const [isRecording, setIsRecording] = useState(false);
  const [meetingId, setMeetingId]     = useState(null);
  const [form, setForm]               = useState({ cliente:'', proyecto:'', responsable:'', participantes:'', linked_meeting_id:'', terminology:'' });
  const [duration, setDuration]       = useState(0);
  const [chunkNumber, setChunkNumber] = useState(0);
  const [progress, setProgress]       = useState({ chunksTotal:0, chunksProcessed:0, sectionsGenerated:0, transcriptionLines:0 });
  const [statusMsg, setStatusMsg]     = useState('');
  const [errorMsg, setErrorMsg]       = useState('');
  const [audioSource, setAudioSource] = useState(''); // 'system' | 'mic' | 'mixed'

  const mediaRecorderRef    = useRef(null);
  const streamRef           = useRef(null);
  const micStreamRef        = useRef(null);
  const chunksRef           = useRef([]);
  const intervalRef         = useRef(null);
  const durationIntervalRef = useRef(null);
  const progressIntervalRef = useRef(null);
  const currentMeetingIdRef = useRef(null);
  const mimeTypeRef         = useRef(null);
  const chunkNumberRef      = useRef(0);

  const clearIntervals = useCallback(() => {
    [intervalRef, durationIntervalRef, progressIntervalRef].forEach(ref => {
      if (ref.current) { clearInterval(ref.current); ref.current = null; }
    });
  }, []);

  const sendChunk = useCallback(async (mid, chunkNum) => {
    if (chunksRef.current.length === 0) return;
    const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current || 'audio/webm' });
    if (blob.size < 10000) { chunksRef.current = []; return; }
    const fd = new FormData();
    fd.append('audio', blob, `chunk_${chunkNum}.webm`);
    fd.append('meetingId', mid);
    fd.append('chunkNumber', chunkNum.toString());
    chunksRef.current = [];
    try { await apiFetch('/chunk', { method:'POST', body:fd }); }
    catch (e) { console.error(`Error chunk ${chunkNum}:`, e); }
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
          if (data.sectionsGenerated > 0)
            setStatusMsg(`✅ ${data.sectionsGenerated} sección(es) procesada(s) · ${data.transcriptionLines} líneas`);
          else if (data.chunksProcessed > 0)
            setStatusMsg(`🔄 ${data.chunksProcessed}/${data.chunksTotal} chunks · ${data.transcriptionLines} líneas`);
        }
      } catch (_) {}
    }, 8000);
  }, []);

  // ── Captura de audio mejorada ─────────────────────────────────────────────
  const captureAudio = async () => {
    // 1. Intentar pantalla + audio del sistema
    let displayStream = null;
    let audioTracks   = [];

    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1, height: 1, frameRate: 1 },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 44100,
          channelCount: 2
        }
      });
      audioTracks = displayStream.getAudioTracks();

      if (audioTracks.length > 0) {
        setAudioSource('system');
        setStatusMsg('🖥️ Capturando audio del sistema (Zoom/Teams/Meet...)');
      }
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') throw err;
      if (err.name === 'AbortError') throw err;
      // Continuar sin stream de pantalla
    }

    // 2. Obtener micrófono SIEMPRE (para mezclar o como fallback)
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
      });
    } catch (_) {
      // No hay micrófono disponible
    }

    // 3. Decidir qué usar
    let finalStream;

    if (audioTracks.length > 0 && micStream) {
      // Mezclar audio del sistema + micrófono via AudioContext
      try {
        const ctx        = new AudioContext();
        const dest       = ctx.createMediaStreamDestination();
        const sysSource  = ctx.createMediaStreamSource(new MediaStream(audioTracks));
        const micSource  = ctx.createMediaStreamSource(micStream);
        sysSource.connect(dest);
        micSource.connect(dest);
        finalStream = dest.stream;
        setAudioSource('mixed');
        setStatusMsg('🎙️ + 🖥️ Mezclando audio del sistema y micrófono');
        micStreamRef.current = micStream;
      } catch (_) {
        // Si falla AudioContext, usar solo sistema
        finalStream = new MediaStream(audioTracks);
        setAudioSource('system');
        micStream?.getTracks().forEach(t => t.stop());
      }
    } else if (audioTracks.length > 0) {
      // Solo sistema
      finalStream = new MediaStream(audioTracks);
      setAudioSource('system');
    } else if (micStream) {
      // Solo micrófono
      finalStream = micStream;
      micStreamRef.current = micStream;
      setAudioSource('mic');
      setStatusMsg('🎤 Usando micrófono (activa "Compartir audio del sistema" para capturar Zoom/Teams)');
    } else {
      displayStream?.getTracks().forEach(t => t.stop());
      throw new Error('No hay fuente de audio disponible. Permite el micrófono o compartir pantalla con audio.');
    }

    streamRef.current = displayStream; // guardar para detener video tracks
    return finalStream;
  };

  const startMeeting = useCallback(async () => {
    setErrorMsg(''); setStatusMsg('');
    try {
      try { await apiFetch('/health'); }
      catch (_) { setErrorMsg('❌ No se puede conectar al servidor.'); return false; }

      const mimeType = getSupportedMimeType();
      if (!mimeType) { setErrorMsg('❌ Tu navegador no soporta grabación. Usa Chrome o Edge.'); return false; }

      let audioStream;
      try { audioStream = await captureAudio(); }
      catch (err) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
          setErrorMsg('❌ Permiso denegado. Debes permitir compartir pantalla o el micrófono.');
        else if (err.name === 'AbortError')
          setErrorMsg('');
        else
          setErrorMsg('❌ ' + (err.message || 'Error al acceder al audio'));
        return false;
      }

      mimeTypeRef.current = mimeType;

      const participantesArr = form.participantes
        ? form.participantes.split(/[,;]/).map(p => p.trim()).filter(Boolean)
        : [];

      const res = await apiFetch('/startMeeting', {
        method: 'POST',
        body: JSON.stringify({
          cliente: form.cliente.trim(),
          proyecto: form.proyecto.trim(),
          responsable: form.responsable.trim(),
          participantes: participantesArr,
          linked_meeting_id: form.linked_meeting_id || null,
          terminology: form.terminology.trim()
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setErrorMsg(`❌ Error del servidor: ${err.error || res.statusText}`);
        audioStream.getTracks().forEach(t => t.stop());
        streamRef.current?.getTracks().forEach(t => t.stop());
        return false;
      }

      const data = await res.json();
      const mid  = data.meetingId;
      setMeetingId(mid);
      currentMeetingIdRef.current = mid;
      chunkNumberRef.current = 0;
      setChunkNumber(0); setDuration(0);

      await new Promise(r => setTimeout(r, 800));
      mediaRecorderRef.current = createAndStartRecorder(audioStream, mimeType);
      intervalRef.current = setInterval(rotateChunk, CHUNK_INTERVAL_MS);
      durationIntervalRef.current = setInterval(() => {
        setDuration(prev => {
          if (prev >= 10 * 3600) { stopMeeting(); return prev; }
          return prev + 1;
        });
      }, 1000);
      startProgressPolling(mid);
      setIsRecording(true);
      window.dispatchEvent(new CustomEvent('recording:started')); // pausa timer inactividad
      return true;
    } catch (err) {
      console.error('Error iniciando reunión:', err);
      setErrorMsg('❌ ' + (err.message || 'Error desconocido'));
      return false;
    }
  }, [form, createAndStartRecorder, rotateChunk, startProgressPolling]);

  const resetMeetingForm = useCallback(() => {
    setForm({ cliente:'', proyecto:'', responsable:'', participantes:'', linked_meeting_id:'', terminology:'' });
    setMeetingId(null);
    setStatus('idle');
    setRecording(false);
  }, []);

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
      try { await apiFetch('/endMeeting', { method:'POST', body:JSON.stringify({ meetingId: mid }) }); }
      catch (e) { console.error('Error endMeeting:', e); }
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null; micStreamRef.current = null;
    setIsRecording(false); setMeetingId(null);
    window.dispatchEvent(new CustomEvent('recording:stopped')); // reanuda timer inactividad
    setChunkNumber(0); setDuration(0); setStatusMsg(''); setAudioSource('');
    setProgress({ chunksTotal:0, chunksProcessed:0, sectionsGenerated:0, transcriptionLines:0 });
    chunksRef.current = []; mediaRecorderRef.current = null;
    currentMeetingIdRef.current = null; mimeTypeRef.current = null;
    return mid;
  }, [clearIntervals, sendChunk]);

  return (
    <RecordingContext.Provider value={{
      isRecording, meetingId, form, setForm, duration, chunkNumber,
      progress, statusMsg, errorMsg, setErrorMsg, audioSource,
      startMeeting, stopMeeting
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
