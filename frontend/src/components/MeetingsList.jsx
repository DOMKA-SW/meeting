import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../utils/api';

function MeetingsList() {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    fetchMeetings();
    const interval = setInterval(fetchMeetings, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchMeetings = async () => {
    try {
      const response = await apiFetch('/meetings?user_id=user1');
      const data     = await response.json();
      setMeetings(data);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching meetings:', error);
      setLoading(false);
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return '—';
    return new Date(dateString).toLocaleString('es-ES');
  };

  const statusBadge = (status) => {
    const map = {
      active:  { bg: '#4CAF50', label: '🔴 En curso' },
      ended:   { bg: '#757575', label: '✅ Finalizada' },
    };
    const s = map[status] || { bg: '#9e9e9e', label: status };
    return (
      <span style={{ padding:'4px 10px', borderRadius:6, backgroundColor:s.bg, color:'white', fontSize:12, fontWeight:600 }}>
        {s.label}
      </span>
    );
  };

  if (loading) return <div style={{ padding:40 }}>Cargando reuniones...</div>;

  return (
    <div>
      <h1>Reuniones</h1>
      {meetings.length === 0 ? (
        <div style={{ padding:30, backgroundColor:'#f9f9f9', borderRadius:8, textAlign:'center', color:'#666' }}>
          <p style={{ fontSize:16 }}>No hay reuniones grabadas aún.</p>
          <Link to="/" style={{ color:'#1565C0', fontSize:14 }}>→ Iniciar primera grabación</Link>
        </div>
      ) : (
        <table style={{ width:'100%', borderCollapse:'collapse', marginTop:8 }}>
          <thead>
            <tr style={{ backgroundColor:'#1565C0', color:'white' }}>
              <th style={{ padding:'11px 10px', textAlign:'left', fontSize:12, fontWeight:600 }}>Cliente · Proyecto</th>
              <th style={{ padding:'11px 10px', textAlign:'left', fontSize:12, fontWeight:600 }}>Responsable</th>
              <th style={{ padding:'11px 10px', textAlign:'left', fontSize:12, fontWeight:600 }}>Estado</th>
              <th style={{ padding:'11px 10px', textAlign:'left', fontSize:12, fontWeight:600 }}>Inicio</th>
              <th style={{ padding:'11px 10px', textAlign:'left', fontSize:12, fontWeight:600 }}>Fin</th>
              <th style={{ padding:'11px 10px', textAlign:'left', fontSize:12, fontWeight:600 }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {meetings.map((meeting, idx) => (
              <tr key={meeting.id} style={{ borderBottom:'1px solid #eee', backgroundColor:idx%2===0?'white':'#fafbfc' }}>
                <td style={{ padding:'10px' }}>
                  <div style={{ fontWeight:600, fontSize:13, color:'#333' }}>{meeting.cliente||'—'}</div>
                  {meeting.proyecto && <div style={{ fontSize:12, color:'#666' }}>{meeting.proyecto}</div>}
                </td>
                <td style={{ padding:'10px', fontSize:13, color:'#555' }}>{meeting.responsable||'—'}</td>
                <td style={{ padding:'10px' }}>{statusBadge(meeting.status)}</td>
                <td style={{ padding:'10px', fontSize:12, color:'#666' }}>{formatDate(meeting.started_at)}</td>
                <td style={{ padding:'10px', fontSize:12, color:'#666' }}>{formatDate(meeting.ended_at)}</td>
                <td style={{ padding:'10px' }}>
                  <Link
                    to={`/meetings/${meeting.id}`}
                    style={{ padding:'7px 14px', backgroundColor:'#1565C0', color:'white', textDecoration:'none', borderRadius:6, fontSize:13, fontWeight:600 }}
                  >
                    Ver detalles →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default MeetingsList;
