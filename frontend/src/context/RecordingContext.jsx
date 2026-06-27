import { createContext, useContext, useState, useRef, useCallback } from 'react';
import { apiFetch } from '../utils/api';

const RecordingContext = createContext(null);

// Intervalo entre chunks de audio en ms (90 segundos)
const CHUNK_INTERVAL_MS = 90000;

// Tipos MIME soportados para audio
const getSupportedMimeType = () => {
  const types = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || null;
};

// Tipos MIME soportados para video+audio
const getSupportedVideoMimeType = () => {
  const types = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || null;
};

export function RecordingProvider({ children }) {
  const [isRecording, setIsRecording]   = useState(false);
  const [meetingId, setMeetingId]       = useState(null);
  const [form, setForm]                 = useState({ cliente:'', proyecto:'', responsable:'', participantes:'', linked_meeting_id:'', terminology:'' });
  const [duration, setDuration]         = useState(0);
  const [chunkNumber, setChunkNumber]   = useState(0);
  const [progress, setProgress]         = useState({ chunksTotal:0, chunksProcessed:0, sectionsGenerated:0, transcriptionLines:0 });
  const [statusMsg, setStatusMsg]       = useState('');
  const [errorMsg, setErrorMsg]         = useState('');
  const [audioSource, setAudioSource]   = useState('');
  const [recordMode, setRecordMode]     = useState('audio'); // 'audio' | 'video'
  const [uploadingVideo, setUploadingVideo] = useState(false);

  const mediaRecorderRef    = useRef(null); // graba audio en chunks
  const videoRecorderRef    = useRef(null); // graba video completo en paralelo
  const videoChunksRef      = useRef([]);   // acumula chunks del video completo
  const streamRef           = useRef(null);
  const micStreamRef        = useRef(null);
  const chunksRef           = useRef([]);
  const intervalRef         = useRef(null);
  const durationIntervalRef = useRef(null);
  const progressIntervalRef = useRef(null);
  const currentMeetingIdRef = useRef(null);
  const mimeTypeRef         = useRef(null);
  const chunkNumberRef      = useRef(0);
  const stopMeetingRef      = useRef(null);

  const clearIntervals = useCallback(() => {
    [intervalRef, durationIntervalRef, progressIntervalRef].forEach(ref => {
      if (ref.current) { clearInterval(ref.current); ref.current = null; }
    });
  }, []);

  // Envia un chunk de AUDIO al backend para transcripcion en tiempo real
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

  const createAndStartRecorder = useCallback((stream, mimeType) => {
    const opts = mimeType ? { mimeType } : {};
    let recorder;
    try { recorder = new MediaRecorder(stream, opts); }
    catch (_) { recorder = new MediaRecorder(stream); }
    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunksRef.current.push(e.data); };
    recorder.onerror = (e) => console.error('MediaRecorder error:', e.error);
    recorder.start();
    return recorder;
  }, []);

  // Rota el chunk de audio cada CHUNK_INTERVAL_MS
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
            setStatusMsg(`${data.sectionsGenerated} seccion(es) procesada(s) · ${data.transcriptionLines} lineas`);
          else if (data.chunksProcessed > 0)
            setStatusMsg(`${data.chunksProcessed}/${data.chunksTotal} chunks · ${data.transcriptionLines} lineas`);
        }
      } catch (_) {}
    }, 8000);
  }, []);

  // Captura el stream de pantalla con audio del sistema + microfono mezclados.
  // En modo video tambien retiene las pistas de video para grabar la pantalla.
  const captureAudio = async (withVideo = false) => {
    let displayStream = null;
    let audioTracks   = [];
    let videoTracks   = [];

    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        // En modo video: resolución real. En modo solo audio: mínima (solo necesitamos el audio)
        video: withVideo
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 } }
          : { width: 1, height: 1, frameRate: 1 },
        audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 44100, channelCount: 2 }
      });
      audioTracks = displayStream.getAudioTracks();
      videoTracks = displayStream.getVideoTracks();
      if (audioTracks.length > 0) setAudioSource('system');
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') throw err;
    }

    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
      });
    } catch (_) {}

    let finalAudioStream;
    if (audioTracks.length > 0 && micStream) {
      try {
        const ctx       = new AudioContext();
        const dest      = ctx.createMediaStreamDestination();
        ctx.createMediaStreamSource(new MediaStream(audioTracks)).connect(dest);
        ctx.createMediaStreamSource(micStream).connect(dest);
        finalAudioStream = dest.stream;
        setAudioSource('mixed');
        micStreamRef.current = micStream;
      } catch (_) {
        finalAudioStream = new MediaStream(audioTracks);
        micStream?.getTracks().forEach(t => t.stop());
      }
    } else if (audioTracks.length > 0) {
      finalAudioStream = new MediaStream(audioTracks);
    } else if (micStream) {
      finalAudioStream = micStream;
      micStreamRef.current = micStream;
      setAudioSource('mic');
    } else {
      displayStream?.getTracks().forEach(t => t.stop());
      throw new Error('No hay fuente de audio disponible.');
    }

    streamRef.current = displayStream;

    // En modo video: devolver también las pistas de video para el videoRecorder
    return { audioStream: finalAudioStream, videoTracks };
  };

  // Inicia la grabacion del VIDEO COMPLETO en paralelo al audio por chunks.
  // El videoRecorder acumula todo el video en memoria hasta que se finaliza.
  const startVideoRecorder = useCallback((videoTracks, audioTracks) => {
    if (!videoTracks.length) return;
    const videoMime = getSupportedVideoMimeType();
    if (!videoMime) { console.warn('Video recording not supported'); return; }

    // Stream combinado: video de pantalla + audio mezclado
    const combinedStream = new MediaStream([...videoTracks, ...audioTracks]);
    let vr;
    try { vr = new MediaRecorder(combinedStream, { mimeType: videoMime, videoBitsPerSecond: 800000 }); }
    catch (_) { vr = new MediaRecorder(combinedStream); }

    videoChunksRef.current = [];
    vr.ondataavailable = (e) => { if (e.data?.size > 0) videoChunksRef.current.push(e.data); };
    vr.onerror = (e) => console.error('VideoRecorder error:', e.error);
    // Acumular en intervalos de 5s para no perder datos si el navegador se cierra
    vr.start(5000);
    videoRecorderRef.current = vr;
  }, []);

  const startMeeting = useCallback(async (mode = 'audio') => {
    setErrorMsg(''); setStatusMsg(''); setRecordMode(mode);
    try {
      try { await apiFetch('/health'); }
      catch (_) { setErrorMsg('No se puede conectar al servidor.'); return false; }

      const mimeType = getSupportedMimeType();
      if (!mimeType) { setErrorMsg('Tu navegador no soporta grabacion. Usa Chrome o Edge.'); return false; }

      let audioStream, videoTracks = [];
      try {
        const result = await captureAudio(mode === 'video');
        audioStream = result.audioStream;
        videoTracks = result.videoTracks;
      } catch (err) {
        if (err.name === 'NotAllowedError') setErrorMsg('Permiso denegado. Debes permitir compartir pantalla.');
        else if (err.name === 'AbortError') setErrorMsg('');
        else setErrorMsg(err.message || 'Error al acceder al audio');
        return false;
      }

      mimeTypeRef.current = mimeType;

      const participantesArr = form.participantes
        ? form.participantes.split(/[,;]/).map(p => p.trim()).filter(Boolean)
        : [];

      const res = await apiFetch('/startMeeting', {
        method: 'POST',
        body: JSON.stringify({
          cliente: form.cliente.trim(), proyecto: form.proyecto.trim(),
          responsable: form.responsable.trim(), participantes: participantesArr,
          linked_meeting_id: form.linked_meeting_id || null,
          terminology: form.terminology.trim()
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setErrorMsg(`Error del servidor: ${err.error || res.statusText}`);
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

      // Iniciar grabador de audio (chunks para transcripcion)
      mediaRecorderRef.current = createAndStartRecorder(audioStream, mimeType);
      intervalRef.current = setInterval(rotateChunk, CHUNK_INTERVAL_MS);

      // Si es modo video: iniciar grabador de video en paralelo
      if (mode === 'video' && videoTracks.length > 0) {
        const audioTracksForVideo = audioStream.getAudioTracks();
        startVideoRecorder(videoTracks, audioTracksForVideo);
      }

      durationIntervalRef.current = setInterval(() => {
        setDuration(prev => {
          if (prev >= 10 * 3600) { stopMeetingRef.current?.(); return prev; }
          return prev + 1;
        });
      }, 1000);

      startProgressPolling(mid);
      setIsRecording(true);
      window.dispatchEvent(new CustomEvent('recording:started'));
      return true;
    } catch (err) {
      setErrorMsg(err.message || 'Error desconocido');
      return false;
    }
  }, [form, createAndStartRecorder, rotateChunk, startProgressPolling, startVideoRecorder]);

  const resetMeetingForm = useCallback(() => {
    setForm({ cliente:'', proyecto:'', responsable:'', participantes:'', linked_meeting_id:'', terminology:'' });
    setMeetingId(null);
    setIsRecording(false);
    setRecordMode('audio');
  }, []);

  const stopMeeting = useCallback(async () => {
    clearIntervals();

    // Detener grabador de audio
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

    // Detener grabador de video y subir el archivo completo
    if (videoRecorderRef.current && mid) {
      const vr = videoRecorderRef.current;
      if (vr.state === 'recording') {
        await new Promise(resolve => {
          vr.onstop = resolve;
          vr.stop();
          setTimeout(resolve, 3000);
        });
      }
      const videoChunks = videoChunksRef.current;
      if (videoChunks.length > 0) {
        setUploadingVideo(true);
        setStatusMsg('Subiendo video de la reunion...');
        const videoBlob = new Blob(videoChunks, { type: 'video/webm' });
        const sizeMB    = (videoBlob.size / 1024 / 1024).toFixed(1);
        console.log(`Subiendo video: ${sizeMB}MB`);
        try {
          const fd = new FormData();
          fd.append('video', videoBlob, `recording_${mid}.webm`);
          const r = await apiFetch(`/meetings/${mid}/recording`, { method: 'POST', body: fd });
          if (r.ok) {
            const data = await r.json();
            console.log(`Video guardado: ${data.size_mb}MB`);
          }
        } catch (e) {
          console.error('Error subiendo video:', e);
        }
        setUploadingVideo(false);
      }
      videoRecorderRef.current = null;
      videoChunksRef.current   = [];
    }

    // Limpiar streams
    streamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null; micStreamRef.current = null;

    setIsRecording(false); setMeetingId(null);
    window.dispatchEvent(new CustomEvent('recording:stopped'));
    setChunkNumber(0); setDuration(0); setStatusMsg(''); setAudioSource('');
    setProgress({ chunksTotal:0, chunksProcessed:0, sectionsGenerated:0, transcriptionLines:0 });
    chunksRef.current = []; mediaRecorderRef.current = null;
    currentMeetingIdRef.current = null; mimeTypeRef.current = null;
    return mid;
  }, [clearIntervals, sendChunk]);

  stopMeetingRef.current = stopMeeting;

  return (
    <RecordingContext.Provider value={{
      isRecording, meetingId, form, setForm, duration, chunkNumber,
      progress, statusMsg, errorMsg, setErrorMsg, audioSource,
      recordMode, uploadingVideo,
      startMeeting, stopMeeting, resetMeetingForm,
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
