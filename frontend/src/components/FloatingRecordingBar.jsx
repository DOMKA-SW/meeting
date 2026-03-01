import { useNavigate } from 'react-router-dom';
import { useRecording } from '../context/RecordingContext';

const formatDuration = (s) => {
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
};

export default function FloatingRecordingBar() {
  const { isRecording, duration, chunkNumber, progress, form, stopMeeting } = useRecording();
  const navigate = useNavigate();

  if (!isRecording) return null;

  const handleStop = async () => {
    if (!confirm('¿Finalizar la reunión? Se generará el acta automáticamente.')) return;
    const mid = await stopMeeting();
    if (mid) navigate('/meetings');
  };

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 9999,
      backgroundColor: '#0f172a',
      borderTop: '1px solid #1e3a5f',
      padding: '10px 20px',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      boxShadow: '0 -4px 20px rgba(0,0,0,0.4)'
    }}>
      {/* Indicador pulsante */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <div style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          backgroundColor: '#ef4444',
          boxShadow: '0 0 8px #ef4444',
          animation: 'recPulse 1.2s infinite'
        }} />
        <span style={{
          fontSize: 16,
          fontWeight: 700,
          color: '#f1f5f9',
          letterSpacing: 2,
          fontFamily: 'monospace'
        }}>
          {formatDuration(duration)}
        </span>
      </div>

      {/* Separador */}
      <div style={{ width: 1, height: 28, backgroundColor: '#1e3a5f' }} />

      {/* Info reunión */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 2 }}>Grabando reunión</div>
        <div style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {form.cliente && <span>{form.cliente}</span>}
          {form.cliente && form.proyecto && <span style={{ color: '#475569', margin: '0 6px' }}>·</span>}
          {form.proyecto && <span>{form.proyecto}</span>}
          {!form.cliente && !form.proyecto && <span style={{ color: '#475569' }}>Sin nombre</span>}
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#60a5fa' }}>{chunkNumber}</div>
          <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase' }}>grabados</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#34d399' }}>{progress.chunksProcessed}</div>
          <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase' }}>transcritos</div>
        </div>
        {progress.sectionsGenerated > 0 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#a78bfa' }}>{progress.sectionsGenerated}</div>
            <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase' }}>secciones</div>
          </div>
        )}
      </div>

      {/* Separador */}
      <div style={{ width: 1, height: 28, backgroundColor: '#1e3a5f' }} />

      {/* Botón finalizar */}
      <button
        onClick={handleStop}
        style={{
          padding: '8px 18px',
          backgroundColor: '#ef4444',
          color: 'white',
          border: 'none',
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 700,
          cursor: 'pointer',
          flexShrink: 0,
          letterSpacing: '0.3px',
          transition: 'background-color 0.15s'
        }}
        onMouseEnter={e => e.target.style.backgroundColor = '#dc2626'}
        onMouseLeave={e => e.target.style.backgroundColor = '#ef4444'}
      >
        ⏹ Finalizar
      </button>

      <style>{`
        @keyframes recPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
      `}</style>
    </div>
  );
}
