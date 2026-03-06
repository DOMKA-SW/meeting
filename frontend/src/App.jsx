import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth }           from './context/AuthContext';
import { RecordingProvider, useRecording } from './context/RecordingContext';
import RecordMeeting     from './components/RecordMeeting';
import MeetingsList      from './components/MeetingsList';
import MeetingDetail     from './components/MeetingDetail';
import ManualMeeting     from './components/ManualMeeting';
import Login             from './components/Login';
import FloatingRecordingBar from './components/FloatingRecordingBar';
import ClientsAdmin      from './components/ClientsAdmin';
import UsersAdmin        from './components/UsersAdmin';
import ClientPortal      from './components/ClientPortal';
import './App.css';

function SidebarNav() {
  const location = useLocation();
  const { isRecording } = useRecording();
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'superadmin';

  const items = [
    { icon:'🎙️', label:'Grabar Reunión',    path:'/'         },
    { icon:'✍️',  label:'Ingresar Texto',    path:'/manual'   },
    { icon:'📋',  label:'Reuniones',          path:'/meetings' },
    ...(canManage ? [
      { icon:'👥', label:'Equipo',             path:'/users'   },
      { icon:'🏢', label:'Clientes / Portal',  path:'/clients' },
    ] : []),
  ];

  const isActive = p => p==='/'?location.pathname==='/':location.pathname.startsWith(p);

  return (
    <nav className="sidebar-nav">
      {items.map(item => (
        <Link key={item.path} to={item.path} className={`menu-item ${isActive(item.path)?'active':''}`}>
          <span className="menu-icon">{item.icon}</span>
          <span>{item.label}</span>
          {item.path==='/'&&isRecording&&(
            <span style={{ marginLeft:'auto', width:8, height:8, borderRadius:'50%', backgroundColor:'#ef4444', boxShadow:'0 0 6px #ef4444', animation:'recPulse 1.2s infinite', flexShrink:0 }} />
          )}
        </Link>
      ))}
      <style>{`@keyframes recPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.8)}}`}</style>
    </nav>
  );
}

function TopBar() {
  const { user, logout } = useAuth();
  const { isRecording }  = useRecording();
  const roleColor = { superadmin:'#7c3aed', admin:'#1565C0', member:'#475569' };
  return (
    <header className="content-header">
      <div className="user-profile" style={{ display:'flex', alignItems:'center', gap:12 }}>
        <div style={{ flex:1 }}>
          {user && (
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontSize:14, fontWeight:600, color:'#f1f5f9' }}>{user.name}</span>
              <span style={{ fontSize:11, backgroundColor:(roleColor[user.role]||'#475569')+'22', color:roleColor[user.role]||'#475569', padding:'1px 8px', borderRadius:20, border:`1px solid ${(roleColor[user.role]||'#475569')}44`, fontWeight:600 }}>
                {user.role}
              </span>
              {user.company_name && <span style={{ fontSize:11, color:'#64748b' }}>{user.company_name}</span>}
            </div>
          )}
        </div>
        {!isRecording && (
          <button onClick={()=>{ if(confirm('¿Cerrar sesión?')) logout(false); }}
            style={{ background:'none', border:'1px solid #334155', borderRadius:6, padding:'6px 12px', fontSize:12, color:'#64748b', cursor:'pointer' }}>
            Salir
          </button>
        )}
      </div>
    </header>
  );
}

function AppLayout() {
  const { isRecording } = useRecording();
  return (
    <div className="lobby-container" style={{ paddingBottom:isRecording?60:0 }}>
      <aside className="sidebar">
        <div className="sidebar-header"><h2>Sistema de Actas</h2></div>
        <SidebarNav />
      </aside>
      <main className="main-content">
        <TopBar />
        <div className="content-area">
          <Routes>
            <Route path="/"             element={<RecordMeeting />} />
            <Route path="/manual"       element={<ManualMeeting />} />
            <Route path="/meetings"     element={<MeetingsList />} />
            <Route path="/meetings/:id" element={<MeetingDetail />} />
            <Route path="/users"        element={<UsersAdmin />} />
            <Route path="/clients"      element={<ClientsAdmin />} />
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
        <Route path="/portal" element={<ClientPortal />} />
        <Route path="/*" element={
          <AuthProvider>
            <ProtectedApp />
          </AuthProvider>
        } />
      </Routes>
    </BrowserRouter>
  );
}
