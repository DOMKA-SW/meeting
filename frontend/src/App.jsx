import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { useState } from 'react';
import RecordMeeting from './components/RecordMeeting';
import MeetingsList from './components/MeetingsList';
import MeetingDetail from './components/MeetingDetail';
import ManualMeeting from './components/ManualMeeting';
import './App.css';
import defaultAvatar from './assets/images/avatar-default.svg';

function SidebarNav() {
  const location = useLocation();

  const menuItems = [
    { id: 'grabar', icon: '🎙️', label: 'Grabar Reunión', path: '/' },
    { id: 'manual', icon: '✍️', label: 'Ingresar Texto', path: '/manual' },
    { id: 'reuniones', icon: '📋', label: 'Reuniones', path: '/meetings' },
  ];

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  return (
    <nav className="sidebar-nav">
      {menuItems.map(item => (
        <Link
          key={item.id}
          to={item.path}
          className={`menu-item ${isActive(item.path) ? 'active' : ''}`}
        >
          <span className="menu-icon">{item.icon}</span>
          <span>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}

function App() {
  const [avatar, setAvatar] = useState(defaultAvatar);

  const handleAvatarClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => setAvatar(event.target.result);
        reader.readAsDataURL(file);
      }
    };
    input.click();
  };

  return (
    <BrowserRouter>
      <div className="lobby-container">
        <aside className="sidebar">
          <div className="sidebar-header">
            <h2>Sistema de Actas</h2>
          </div>
          <SidebarNav />
        </aside>

        <main className="main-content">
          <header className="content-header">
            <div className="user-profile">
              <div className="greeting">
                <span className="hello">¡Hola, User!</span>
              </div>
              <div className="avatar-container" onClick={handleAvatarClick}>
                <img src={avatar} alt="Avatar" className="avatar-image" />
              </div>
            </div>
          </header>

          <div className="content-area">
            <Routes>
              <Route path="/" element={<RecordMeeting />} />
              <Route path="/manual" element={<ManualMeeting />} />
              <Route path="/meetings" element={<MeetingsList />} />
              <Route path="/meetings/:id" element={<MeetingDetail />} />
            </Routes>
          </div>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
