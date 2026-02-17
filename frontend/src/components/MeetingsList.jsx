import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

const API_URL = 'http://localhost:3000';

function MeetingsList() {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMeetings();
    const interval = setInterval(fetchMeetings, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchMeetings = async () => {
    try {
      const response = await fetch(`${API_URL}/meetings?user_id=user1`);
      const data = await response.json();
      setMeetings(data);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching meetings:', error);
      setLoading(false);
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleString('es-ES');
  };

  if (loading) {
    return <div>Cargando reuniones...</div>;
  }

  return (
    <div>
      <h1>Reuniones</h1>
      {meetings.length === 0 ? (
        <p>No hay reuniones grabadas aún.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
          <thead>
            <tr style={{ backgroundColor: '#f5f5f5' }}>
              <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>ID</th>
              <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Estado</th>
              <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Inicio</th>
              <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Fin</th>
              <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {meetings.map((meeting) => (
              <tr key={meeting.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '10px' }}>{meeting.id.substring(0, 8)}...</td>
                <td style={{ padding: '10px' }}>
                  <span style={{
                    padding: '4px 8px',
                    borderRadius: '4px',
                    backgroundColor: meeting.status === 'active' ? '#4CAF50' : '#757575',
                    color: 'white',
                    fontSize: '12px'
                  }}>
                    {meeting.status}
                  </span>
                </td>
                <td style={{ padding: '10px' }}>{formatDate(meeting.started_at)}</td>
                <td style={{ padding: '10px' }}>{formatDate(meeting.ended_at)}</td>
                <td style={{ padding: '10px' }}>
                  <Link
                    to={`/meetings/${meeting.id}`}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: '#2196F3',
                      color: 'white',
                      textDecoration: 'none',
                      borderRadius: '4px',
                      fontSize: '14px'
                    }}
                  >
                    Ver Detalles
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
