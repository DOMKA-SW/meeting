import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { useState } from 'react';
import RecordMeeting from './components/RecordMeeting';
import MeetingsList from './components/MeetingsList';
import MeetingDetail from './components/MeetingDetail';
import './App.css';
import defaultAvatar from './assets/images/avatar-default.svg';

function App() {
  const [activeMenu, setActiveMenu] = useState('grabar');
  const [avatar, setAvatar] = useState(defaultAvatar);
  const [username] = useState('User');

  const handleAvatarClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          setAvatar(event.target.result);
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  };

  const menuItems = [
    { id: 'grabar', icon: '🎙️', label: 'Grabar Reunión', path: '/' },
    { id: 'reuniones', icon: '📋', label: 'Reuniones', path: '/meetings' },
  ];

  return (
    <BrowserRouter>
      <div className="lobby-container">
        {/* Sidebar izquierdo */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <h2>Sistema de Actas</h2>
          </div>
          
          <nav className="sidebar-nav">
            {menuItems.map(item => (
              <Link
                key={item.id}
                to={item.path}
                className={`menu-item ${activeMenu === item.id ? 'active' : ''}`}
                onClick={() => setActiveMenu(item.id)}
              >
                <span className="menu-icon">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
        </aside>

        {/* Contenido principal */}
        <main className="main-content">
          {/* Header con avatar y saludo */}
          <header className="content-header">
            <div className="user-profile">
              <div className="greeting">
                <span className="hello">¡Hola, {username}!</span>
              </div>
              <div className="avatar-container" onClick={handleAvatarClick}>
                <img src={avatar} alt="Avatar" className="avatar-image" />
              </div>
            </div>
          </header>

          {/* Área de contenido */}
          <div className="content-area">
            <Routes>
              <Route path="/" element={<RecordMeeting />} />
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