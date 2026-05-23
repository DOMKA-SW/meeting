import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../utils/api';

export default function MeetingsList() {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    fetchMeetings();
    const iv = setInterval(fetchMeetings, 5000);
    return () => clearInterval(iv);
  }, []);

  const fetchMeetings = async () => {
    try {
      const r = await apiFetch('/meetings');
      if (r.ok) setMeetings(await r.json());
      setLoading(false);
    } catch { setLoading(false); }
  };

  const fmt = (d) => d ? new Date(d).toLocaleString('es-ES') : '—';

  const statusBadge = (s) => ({
    active: { bg:'#16a34a', label:'🔴 En curso' },
    ended:  { bg:'#475569', label:'✅ Finalizada' }
  }[s] || { bg:'#9e9e9e', label:s });

  if (loading) return <div style={{ padding:40 }}>Cargando...</div>;

  return (
    <div>
      <h1>Reuniones</h1>
      {meetings.length === 0 ? (
        <div style={{ padding:30, backgroundColor:'#f9fafb', borderRadius:8, textAlign:'center', color:'#666' }}>
          <p>No hay reuniones grabadas aún.</p>
          <Link to="/" style={{ color:'#1565C0' }}>→ Iniciar primera grabación</Link>
        </div>
      ) : (
        <table style={{ width:'100%', borderCollapse:'collapse', marginTop:8 }}>
          <thead>
            <tr style={{ backgroundColor:'#1565C0', color:'white' }}>
              {['Cliente · Proyecto','Responsable','Estado','Inicio','Fin','Acciones'].map((h,i) => (
                <th key={i} style={{ padding:'11px 10px', textAlign:'left', fontSize:12, fontWeight:600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {meetings.map((m, idx) => {
              const sb = statusBadge(m.status);
              return (
                <tr key={m.id} style={{ borderBottom:'1px solid #eee', backgroundColor:idx%2===0?'white':'#fafbfc' }}>
                  <td style={{ padding:'10px' }}>
                    <div style={{ fontWeight:600, fontSize:13 }}>{m.cliente||'—'}</div>
                    {m.proyecto && <div style={{ fontSize:12, color:'#666' }}>{m.proyecto}</div>}
                  </td>
                  <td style={{ padding:'10px', fontSize:13, color:'#555' }}>{m.responsable||'—'}</td>
                  <td style={{ padding:'10px' }}>
                    <span style={{ padding:'4px 10px', borderRadius:6, backgroundColor:sb.bg, color:'white', fontSize:12, fontWeight:600 }}>{sb.label}</span>
                  </td>
                  <td style={{ padding:'10px', fontSize:12, color:'#666' }}>{fmt(m.started_at)}</td>
                  <td style={{ padding:'10px', fontSize:12, color:'#666' }}>{fmt(m.ended_at)}</td>
                  <td style={{ padding:'10px' }}>
                    <Link to={`/meetings/${m.id}`} style={{ padding:'7px 14px', backgroundColor:'#1565C0', color:'white', textDecoration:'none', borderRadius:6, fontSize:13, fontWeight:600 }}>
                      Ver →
                    </Link>
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
