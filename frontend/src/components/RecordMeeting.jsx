import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

//const API_URL = 'http://localhost:3000';
const API_URL = import.meta.env.VITE_API_BASE_URL;

function RecordMeeting() {
  const navigate = useNavigate();
  const [step, setStep] = useState('form');
  const [form, setForm] = useState({
    cliente: '',
    proyecto: '',
    responsable: '',
    participantes: ''
  });
  const [isRecording, setIsRecording] = useState(false);
  const [meetingId, setMeetingId] = useState(null);
  const [chunkNumber, setChunkNumber] = useState(0);
  const [duration, setDuration] = useState(0);

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const intervalRef = useRef(null);
  const durationIntervalRef = useRef(null);
  const currentMeetingIdRef = useRef(null);
  const mimeTypeRef = useRef(null);

  const getSupportedMimeType = () => {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/wav'
    ];
    
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return null;
  };

  const startMeeting = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true
      });

      if (!stream) {
        alert('No se pudo obtener el audio de la pantalla. Permite compartir audio.');
        return;
      }

      const audioTracks = stream.getAudioTracks();
      const videoTracks = stream.getVideoTracks();
      
      if (audioTracks.length === 0) {
        alert('No se detectó audio en la pantalla compartida. Asegúrate de habilitar "Compartir audio" al compartir pantalla.');
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      if (videoTracks.length > 0) {
        const videoTrack = videoTracks[0];
        const settings = videoTrack.getSettings();
        const constraints = {
          width: { ideal: 1 },
          height: { ideal: 1 },
          frameRate: { ideal: 1 }
        };
        try {
          await videoTrack.applyConstraints(constraints);
        } catch (e) {
          console.warn('No se pudieron aplicar constraints al video:', e);
        }
      }

      streamRef.current = stream;

      const participantesArr = form.participantes
        ? form.participantes.split(/[,;]/).map(p => p.trim()).filter(Boolean)
        : [];
      const response = await fetch(`${API_URL}/startMeeting`, {
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

      const data = await response.json();
      const newMeetingId = data.meetingId;
      setMeetingId(newMeetingId);
      currentMeetingIdRef.current = newMeetingId;
      setChunkNumber(0);
      setDuration(0);

      const mimeType = getSupportedMimeType();
      if (!mimeType) {
        alert('Tu navegador no soporta grabación de audio. Por favor usa Chrome o Edge.');
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      mimeTypeRef.current = mimeType;

      const audioTracksCheck = stream.getAudioTracks();
      if (audioTracksCheck.length === 0) {
        alert('No se detectó audio. Asegúrate de habilitar "Compartir audio" al compartir pantalla.');
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      for (const track of audioTracksCheck) {
        if (!track.enabled) {
          track.enabled = true;
        }
      }

      const audioOnlyStream = new MediaStream(audioTracksCheck);
      streamRef.current = stream;

      await new Promise(resolve => setTimeout(resolve, 1000));

      let mediaRecorder;
      const recorderOptions = mimeType ? { mimeType } : undefined;
      
      try {
        mediaRecorder = recorderOptions 
          ? new MediaRecorder(audioOnlyStream, recorderOptions)
          : new MediaRecorder(audioOnlyStream);
      } catch (error) {
        console.error('Error creating MediaRecorder with audio-only stream:', error);
        try {
          mediaRecorder = recorderOptions 
            ? new MediaRecorder(stream, recorderOptions)
            : new MediaRecorder(stream);
        } catch (error2) {
          console.error('Error creating MediaRecorder with full stream:', error2);
          try {
            mediaRecorder = new MediaRecorder(audioOnlyStream);
          } catch (error3) {
            console.error('Error creating MediaRecorder without options:', error3);
            alert('No se pudo crear el grabador de audio. Tu navegador puede no soportar esta funcionalidad.');
            stream.getTracks().forEach(track => track.stop());
            return;
          }
        }
      }

      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error('MediaRecorder error:', event.error);
      };

      mediaRecorder.onstop = () => {
        console.log('MediaRecorder stopped');
      };

      await new Promise(resolve => setTimeout(resolve, 500));

      if (mediaRecorder.state !== 'inactive') {
        console.warn('MediaRecorder not in inactive state:', mediaRecorder.state);
        return;
      }

      try {
        mediaRecorder.start();
        console.log('MediaRecorder started successfully, state:', mediaRecorder.state);
      } catch (error) {
        console.error('Error starting MediaRecorder:', error);
        console.error('Details:', {
          state: mediaRecorder.state,
          streamActive: audioOnlyStream.active,
          originalStreamActive: stream.active,
          audioTracks: audioTracksCheck.map(t => ({
            id: t.id,
            readyState: t.readyState,
            enabled: t.enabled,
            muted: t.muted
          })),
          mimeType: mimeType
        });
        alert('Error al iniciar la grabación. Por favor:\n1. Asegúrate de usar Chrome o Edge\n2. Verifica que el audio esté habilitado\n3. Intenta recargar la página');
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      intervalRef.current = setInterval(async () => {
        if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== 'recording') {
          return;
        }

        try {
          mediaRecorderRef.current.stop();
        } catch (error) {
          console.error('Error stopping MediaRecorder:', error);
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 300));

        if (chunksRef.current.length > 0 && currentMeetingIdRef.current) {
          const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current || 'audio/webm' });
          const formData = new FormData();
          formData.append('audio', blob, `chunk_${chunkNumber}.webm`);
          formData.append('meetingId', currentMeetingIdRef.current);
          formData.append('chunkNumber', chunkNumber.toString());

          try {
            await fetch(`${API_URL}/chunk`, { method: 'POST', body: formData });
            console.log(`Chunk ${chunkNumber} enviado`);
          } catch (error) {
            console.error('Error sending chunk:', error);
          }
        }

        chunksRef.current = [];
        setChunkNumber(prev => prev + 1);

        if (streamRef.current && streamRef.current.active) {
          try {
            const audioTracks = streamRef.current.getAudioTracks();
            if (audioTracks.length > 0) {
              const audioOnlyStream = new MediaStream(audioTracks);
              const newOptions = mimeTypeRef.current ? { mimeType: mimeTypeRef.current } : {};
              const newRecorder = new MediaRecorder(audioOnlyStream, newOptions);
              
              newRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                  chunksRef.current.push(event.data);
                }
              };
              
              newRecorder.onerror = (event) => {
                console.error('MediaRecorder error:', event);
              };
              
              newRecorder.start();
              mediaRecorderRef.current = newRecorder;
            }
          } catch (error) {
            console.error('Error creating new MediaRecorder:', error);
          }
        }
      }, 60000);

      durationIntervalRef.current = setInterval(() => {
        setDuration(prev => {
          if (prev >= 18000) {
            stopMeeting();
            return 18000;
          }
          return prev + 1;
        });
      }, 1000);

      setStep('recording');
      setIsRecording(true);
    } catch (error) {
      console.error('Error starting meeting:', error);
      alert('No se pudo iniciar la grabación: ' + error.message);
    }
  };

  const stopMeeting = async () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.error('Error stopping MediaRecorder:', error);
      }
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (chunksRef.current.length > 0 && currentMeetingIdRef.current) {
      const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current || 'audio/webm' });
      const formData = new FormData();
      formData.append('audio', blob, `chunk_${chunkNumber}.webm`);
      formData.append('meetingId', currentMeetingIdRef.current);
      formData.append('chunkNumber', chunkNumber.toString());

      try {
        await fetch(`${API_URL}/chunk`, { method: 'POST', body: formData });
      } catch (error) {
        console.error('Error sending final chunk:', error);
      }
    }

    if (currentMeetingIdRef.current) {
      try {
        await fetch(`${API_URL}/endMeeting`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meetingId: currentMeetingIdRef.current })
        });
      } catch (error) {
        console.error('Error ending meeting:', error);
      }
    }

    setStep('form');
    setIsRecording(false);
    setMeetingId(null);
    setChunkNumber(0);
    setDuration(0);
    chunksRef.current = [];
    mediaRecorderRef.current = null;
    currentMeetingIdRef.current = null;
    mimeTypeRef.current = null;

    navigate('/meetings');
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const formatDuration = (seconds) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  return (
    <div>
      <h1>Grabar Reunión</h1>

      {step === 'form' && (
        <div style={{ maxWidth: '480px', marginBottom: '24px', padding: '20px', backgroundColor: '#f9f9f9', borderRadius: '8px' }}>
          <p style={{ marginBottom: '16px', fontWeight: 'bold' }}>Datos de la reunión (opcional)</p>
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px' }}>Cliente</label>
            <input
              type="text"
              value={form.cliente}
              onChange={e => setForm(f => ({ ...f, cliente: e.target.value }))}
              placeholder="Nombre del cliente"
              style={{ width: '100%', padding: '8px 12px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px' }}>Proyecto</label>
            <input
              type="text"
              value={form.proyecto}
              onChange={e => setForm(f => ({ ...f, proyecto: e.target.value }))}
              placeholder="Nombre del proyecto"
              style={{ width: '100%', padding: '8px 12px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px' }}>Responsable</label>
            <input
              type="text"
              value={form.responsable}
              onChange={e => setForm(f => ({ ...f, responsable: e.target.value }))}
              placeholder="Responsable de la reunión"
              style={{ width: '100%', padding: '8px 12px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '4px', fontSize: '14px' }}>Participantes</label>
            <input
              type="text"
              value={form.participantes}
              onChange={e => setForm(f => ({ ...f, participantes: e.target.value }))}
              placeholder="Nombre1, Nombre2, Nombre3"
              style={{ width: '100%', padding: '8px 12px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>
          <button
            onClick={startMeeting}
            style={{
              padding: '12px 24px',
              fontSize: '16px',
              backgroundColor: '#4CAF50',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 'bold'
            }}
          >
            Iniciar Reunión (compartir pantalla)
          </button>
        </div>
      )}

      {isRecording && (
        <div style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
          <p><strong>Meeting ID:</strong> {meetingId}</p>
          <p><strong>Duración:</strong> {formatDuration(duration)}</p>
          <p><strong>Chunks enviados:</strong> {chunkNumber}</p>
        </div>
      )}
      {isRecording && (
        <button
          onClick={stopMeeting}
          style={{
            padding: '12px 24px',
            fontSize: '16px',
            backgroundColor: '#f44336',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}
        >
          Finalizar Reunión
        </button>
      )}
    </div>
  );
}

export default RecordMeeting;
