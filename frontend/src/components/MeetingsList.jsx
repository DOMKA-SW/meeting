import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../utils/api';
import { useAuth } from '../context/AuthContext';

// Tiempo en minutos a partir del cual una reunion activa se considera atascada
const ALERT_MINUTES = 60;

export default function MeetingsList() {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [closing, setClosing]   = useState(null); // ID de reunion cerrándose
  const { user } = useAuth();

  const canManage = user?.role === 'admin' || user?.role === 'superadmin';

  const fetchMeetings = useCallback(async () => {
    try {
      const r = await apiFetch('/meetings');
      if (r.ok) setMeetings(await r.json());
      setLoading(false);
    } catch { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchMeetings();
    const iv = setInterval(fetchMeetings, 10000);
    return () => clearInterval(iv);
  }, [fetchMeetings]);

  const fmt = d => d ? new Date(d).toLocaleString('es-ES') : '—';

  // Calcula cuánto tiempo lleva activa una reunión en minutos
  const minutesActive = startedAt => {
    if (!startedAt) return 0;
    return Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000);
  };

  // Cierra forzosamente una reunión atascada (solo admin/superadmin)
  const forceEnd = async (meeting) => {
    const mins = minutesActive(meeting.started_at);
    if (!confirm(`¿Cerrar la reunión de "${meeting.cliente} - ${meeting.proyecto}" que lleva ${mins} minutos activa?\n\nSe generará el acta con lo transcrito hasta ahora.`)) return;
    setClosing(meeting.id);
    try {
      const r = await apiFetch(`/admin/meetings/${meeting.id}/force-end`, { method: 'POST' });
      if (r.ok) {
        alert('Reunión cerrada. El acta se está generando, estará lista en unos minutos.');
        await fetchMeetings();
      } else {
        const err = await r.json().catch(() => ({}));
        alert('Error: ' + (err.error || 'No se pudo cerrar'));
      }
    } catch (e) { alert('Error: ' + e.message); }
    setClosing(null);
  };

  // Reuniones activas que llevan más de ALERT_MINUTES minutos
  const stuckMeetings = meetings.filter(m => m.status === 'active' && minutesActive(m.started_at) >= ALERT_MINUTES);

  if (loading) return <div style={{ padding: 40 }}>Cargando...</div>;

  return (
    <div>

      {/* Alerta de reuniones atascadas — solo visible para admin */}
      {canManage && stuckMeetings.length > 0 && (
        <div style={{ marginBottom: 20, padding: '14px 18px', backgroundColor: '#FFF3E0', border: '1px solid #FFB300', borderRadius: 8, borderLeft: '4px solid #F57C00' }}>
          <div style={{ fontWeight: 700, color: '#E65100', fontSize: 14, marginBottom: 6 }}>
            Reunion{stuckMeetings.length > 1 ? 'es' : ''} activa{stuckMeetings.length > 1 ? 's' : ''} por más de {ALERT_MINUTES} minutos
          </div>
          {stuckMeetings.map(m => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
              <span style={{ fontSize: 13, color: '#5D4037', flex: 1 }}>
                <strong>{m.cliente} — {m.proyecto}</strong> · {minutesActive(m.started_at)} min activa · Responsable: {m.responsable || '—'}
              </span>
              <button
                onClick={() => forceEnd(m)}
                disabled={closing === m.id}
                style={{ padding: '6px 14px', backgroundColor: closing === m.id ? '#ccc' : '#E53935', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: closing === m.id ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
              >
                {closing === m.id ? 'Cerrando...' : 'Cerrar y generar acta'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Reuniones</h1>
        <button onClick={async () => {
          const token = localStorage.getItem('auth_token');
          const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/tareas/excel`, { headers: { Authorization: `Bearer ${token}` } });
          if (!res.ok) { alert('Error al descargar'); return; }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `Tareas_Empresa_${new Date().toISOString().split('T')[0]}.csv`;
          a.click(); URL.revokeObjectURL(url);
        }} style={{ padding: '9px 18px', backgroundColor: '#2E7D32', color: 'white', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          Descargar todas las tareas
        </button>
      </div>

      {meetings.length === 0 ? (
        <div style={{ padding: 30, backgroundColor: '#f9fafb', borderRadius: 8, textAlign: 'center', color: '#666' }}>
          <p>No hay reuniones grabadas aún.</p>
          <Link to="/" style={{ color: '#1565C0' }}>Iniciar primera grabación</Link>
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
          <thead>
            <tr style={{ backgroundColor: '#1565C0', color: 'white' }}>
              {['Cliente · Proyecto', 'Responsable', 'Estado', 'Inicio', 'Fin', 'Acciones'].map((h, i) => (
                <th key={i} style={{ padding: '11px 10px', textAlign: 'left', fontSize: 12, fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {meetings.map((m, idx) => {
              const mins    = minutesActive(m.started_at);
              const isStuck = m.status === 'active' && mins >= ALERT_MINUTES;
              return (
                <tr key={m.id} style={{ borderBottom: '1px solid #eee', backgroundColor: isStuck ? '#FFF8E1' : idx % 2 === 0 ? 'white' : '#fafbfc' }}>
                  <td style={{ padding: '10px' }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{m.cliente || '—'}</div>
                    {m.proyecto && <div style={{ fontSize: 12, color: '#666' }}>{m.proyecto}</div>}
                  </td>
                  <td style={{ padding: '10px', fontSize: 13, color: '#555' }}>{m.responsable || '—'}</td>
                  <td style={{ padding: '10px' }}>
                    {m.status === 'active' ? (
                      <div>
                        <span style={{ padding: '4px 10px', borderRadius: 6, backgroundColor: isStuck ? '#F57C00' : '#16a34a', color: 'white', fontSize: 12, fontWeight: 600 }}>
                          {isStuck ? `Atascada (${mins}m)` : 'En curso'}
                        </span>
                      </div>
                    ) : (
                      <span style={{ padding: '4px 10px', borderRadius: 6, backgroundColor: '#475569', color: 'white', fontSize: 12, fontWeight: 600 }}>Finalizada</span>
                    )}
                  </td>
                  <td style={{ padding: '10px', fontSize: 12, color: '#666' }}>{fmt(m.started_at)}</td>
                  <td style={{ padding: '10px', fontSize: 12, color: '#666' }}>{fmt(m.ended_at)}</td>
                  <td style={{ padding: '10px' }}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Link to={`/meetings/${m.id}`} style={{ padding: '7px 14px', backgroundColor: '#1565C0', color: 'white', textDecoration: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600 }}>
                        Ver
                      </Link>
                      {/* Botón de cierre forzado — solo admin, solo en reuniones activas */}
                      {canManage && m.status === 'active' && (
                        <button
                          onClick={() => forceEnd(m)}
                          disabled={closing === m.id}
                          style={{ padding: '7px 12px', backgroundColor: closing === m.id ? '#ccc' : '#E53935', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: closing === m.id ? 'default' : 'pointer' }}
                        >
                          {closing === m.id ? '...' : 'Cerrar'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
