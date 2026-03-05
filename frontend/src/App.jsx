import { BrowserRouter, Routes, Route, Link, useLocation, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth }           from './context/AuthContext';
import { RecordingProvider, useRecording } from './context/RecordingContext';
import RecordMeeting      from './components/RecordMeeting';
import MeetingsList       from './components/MeetingsList';
import MeetingDetail      from './components/MeetingDetail';
import ManualMeeting      from './components/ManualMeeting';
import Login              from './components/Login';
import FloatingRecordingBar from './components/FloatingRecordingBar';
import ClientsAdmin       from './components/ClientsAdmin';
import ClientPortal       from './components/ClientPortal';
import './App.css';

function SidebarNav() {
  const location   = useLocation();
  const { isRecording } = useRecording();

  const items = [
    { icon:'🎙️', label:'Grabar Reunión',   path:'/'         },
    { icon:'✍️',  label:'Ingresar Texto',   path:'/manual'   },
    { icon:'📋',  label:'Reuniones',         path:'/meetings' },
    { icon:'👥',  label:'Clientes / Portal', path:'/clients'  },
  ];

  const isActive = (path) => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);

  return (
    <nav className="sidebar-nav">
      {items.map(item => (
        <Link key={item.path} to={item.path} className={`menu-item ${isActive(item.path) ? 'active' : ''}`}>
          <span className="menu-icon">{item.icon}</span>
          <span>{item.label}</span>
          {item.path === '/' && isRecording && (
            <span style={{ marginLeft:'auto', width:8, height:8, borderRadius:'50%', backgroundColor:'#ef4444', boxShadow:'0 0 6px #ef4444', animation:'recPulse 1.2s infinite', flexShrink:0 }} />
          )}
        </Link>
      ))}
      <style>{`@keyframes recPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.8)}}`}</style>
    </nav>
  );
}

function LogoutButton() {
  const { logout } = useAuth();
  const { isRecording } = useRecording();
  if (isRecording) return null;
  return (
    <button onClick={() => { if (confirm('¿Cerrar sesión?')) logout(false); }}
      style={{ background:'none', border:'1px solid #e2e8f0', borderRadius:6, padding:'6px 12px', fontSize:12, color:'#64748b', cursor:'pointer' }}>
      Salir
    </button>
  );
}

function AppLayout() {
  const { isRecording } = useRecording();
  return (
    <div className="lobby-container" style={{ paddingBottom: isRecording ? 60 : 0 }}>
      <aside className="sidebar">
        <div className="sidebar-header"><h2>Sistema de Actas</h2></div>
        <SidebarNav />
      </aside>
      <main className="main-content">
        <header className="content-header">
          <div className="user-profile">
            <div className="greeting"><span className="hello">¡Hola, equipo!</span></div>
            <LogoutButton />
          </div>
        </header>
        <div className="content-area">
          <Routes>
            <Route path="/"              element={<RecordMeeting />} />
            <Route path="/manual"        element={<ManualMeeting />} />
            <Route path="/meetings"      element={<MeetingsList />} />
            <Route path="/meetings/:id"  element={<MeetingDetail />} />
            <Route path="/clients"       element={<ClientsAdmin />} />
          </Routes>
        </div>
      </main>
      <FloatingRecordingBar />
    </div>
  );
}

function ProtectedApp() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Login />;
  return (
    <RecordingProvider>
      <AppLayout />
    </RecordingProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Ruta pública del portal de clientes — no necesita auth admin */}
        <Route path="/portal" element={<ClientPortal />} />
        {/* Todo lo demás requiere auth admin */}
        <Route path="/*" element={
          <AuthProvider>
            <ProtectedApp />
          </AuthProvider>
        } />
      </Routes>
    </BrowserRouter>
  );
}
