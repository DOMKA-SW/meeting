// =============================================================================
// App.jsx — Componente raiz de la aplicacion
// =============================================================================
// Define la estructura global: rutas, layout principal, sidebar, topbar
// y proteccion de rutas por autenticacion y rol.
//
// Arbol de componentes:
//   App
//   ├── /portal  → ClientPortal  (acceso publico para clientes externos)
//   └── /*       → AuthProvider
//                  └── ProtectedApp
//                       ├── Login  (si no esta autenticado)
//                       └── RecordingProvider
//                            └── AppLayout
//                                 ├── SidebarNav
//                                 ├── TopBar
//                                 └── Routes (paginas internas)
// =============================================================================

import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth }           from './context/AuthContext';
import { RecordingProvider, useRecording } from './context/RecordingContext';
import RecordMeeting       from './components/RecordMeeting';
import MeetingsList        from './components/MeetingsList';
import MeetingDetail       from './components/MeetingDetail';
import ManualMeeting       from './components/ManualMeeting';
import Login               from './components/Login';
import FloatingRecordingBar from './components/FloatingRecordingBar';
import ClientsAdmin        from './components/ClientsAdmin';
import UsersAdmin          from './components/UsersAdmin';
import ClientPortal        from './components/ClientPortal';
import Settings             from './components/Settings';
import TareasGlobal         from './components/TareasGlobal';
import './App.css';

// -----------------------------------------------------------------------------
// SidebarNav — Menu de navegacion lateral
// Muestra los items de navegacion segun el rol del usuario.
// Los items de Equipo y Clientes solo aparecen para admin y superadmin.
// Cuando hay una grabacion activa muestra un indicador rojo parpadeante
// en el item "Grabar Reunion".
// -----------------------------------------------------------------------------
function SidebarNav() {
  const location    = useLocation();
  const { isRecording } = useRecording();
  const { user }    = useAuth();

  // Solo admin y superadmin ven las secciones de gestion de equipo y clientes
  const canManage = user?.role === 'admin' || user?.role === 'superadmin';

  const items = [
    { icon: '🎙️', label: 'Grabar Reunion',   path: '/'        },
    { icon: '✍️',  label: 'Ingresar Texto',   path: '/manual'  },
    { icon: '📋',  label: 'Reuniones',         path: '/meetings'},
    { icon: '✅',  label: 'Tareas',             path: '/tareas'  },
    ...(canManage ? [
      { icon: '👥', label: 'Equipo',            path: '/users'    },
      { icon: '🏢', label: 'Clientes / Portal', path: '/clients'  },
    ] : []),
    ...(user?.role === 'superadmin' ? [
      { icon: '⚙️', label: 'Configuracion',     path: '/settings' },
    ] : []),
  ];

  // La ruta raiz "/" es activa solo si el pathname es exactamente "/",
  // el resto se activa si el pathname empieza con el path del item
  const isActive = p => p === '/' ? location.pathname === '/' : location.pathname.startsWith(p);

  return (
    <nav className="sidebar-nav">
      {items.map(item => (
        <Link
          key={item.path}
          to={item.path}
          className={`menu-item ${isActive(item.path) ? 'active' : ''}`}
        >
          <span className="menu-icon">{item.icon}</span>
          <span>{item.label}</span>

          {/* Indicador de grabacion activa — solo en el item "Grabar Reunion" */}
          {item.path === '/' && isRecording && (
            <span style={{
              marginLeft: 'auto', width: 8, height: 8, borderRadius: '50%',
              backgroundColor: '#ef4444', boxShadow: '0 0 6px #ef4444',
              animation: 'recPulse 1.2s infinite', flexShrink: 0,
            }} />
          )}
        </Link>
      ))}

      {/* Animacion del indicador de grabacion */}
      <style>{`@keyframes recPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.8)}}`}</style>
    </nav>
  );
}

// -----------------------------------------------------------------------------
// TopBar — Barra superior con datos del usuario y boton de cierre de sesion
// Muestra nombre, rol (con color segun nivel) y empresa del usuario autenticado.
// El boton de salir se oculta cuando hay una grabacion activa para evitar
// que el usuario cierre sesion accidentalmente y pierda la grabacion.
// -----------------------------------------------------------------------------
function TopBar() {
  const { user, logout } = useAuth();
  const { isRecording }  = useRecording();

  // Color del badge de rol: purpura=superadmin, azul=admin, gris=member
  const roleColor = { superadmin: '#7c3aed', admin: '#1565C0', member: '#475569' };

  return (
    <header className="content-header">
      <div className="user-profile" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          {user && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9' }}>
                {user.name}
              </span>
              <span style={{
                fontSize: 11,
                backgroundColor: (roleColor[user.role] || '#475569') + '22',
                color: roleColor[user.role] || '#475569',
                padding: '1px 8px', borderRadius: 20,
                border: `1px solid ${(roleColor[user.role] || '#475569')}44`,
                fontWeight: 600,
              }}>
                {user.role}
              </span>
              {user.company_name && (
                <span style={{ fontSize: 11, color: '#64748b' }}>{user.company_name}</span>
              )}
            </div>
          )}
        </div>

        {/* No mostrar el boton Salir mientras hay una grabacion activa */}
        {!isRecording && (
          <button
            onClick={() => { if (confirm('¿Cerrar sesion?')) logout(false); }}
            style={{ background: 'none', border: '1px solid #334155', borderRadius: 6, padding: '6px 12px', fontSize: 12, color: '#64748b', cursor: 'pointer' }}
          >
            Salir
          </button>
        )}
      </div>
    </header>
  );
}

// -----------------------------------------------------------------------------
// AdminRoute — Guard de ruta para paginas exclusivas de administradores
// Cualquier usuario autenticado puede escribir /users o /clients en la URL.
// Este componente verifica el rol antes de renderizar el contenido.
// Si el usuario no tiene permiso, muestra un mensaje de acceso restringido.
// -----------------------------------------------------------------------------
function AdminRoute({ children }) {
  const { user } = useAuth();
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    return (
      <div style={{ padding: 40, color: '#c62828' }}>
        Acceso restringido a administradores.
      </div>
    );
  }
  return children;
}

// -----------------------------------------------------------------------------
// AppLayout — Estructura principal de la aplicacion autenticada
// Compone el sidebar, la topbar y el area de contenido con las rutas.
// Agrega padding inferior cuando hay grabacion activa para que la
// FloatingRecordingBar no tape el contenido de la pagina.
// -----------------------------------------------------------------------------
function AppLayout() {
  const { isRecording } = useRecording();

  return (
    <div className="lobby-container" style={{ paddingBottom: isRecording ? 60 : 0 }}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>Sistema de Actas</h2>
        </div>
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
            {/* Rutas protegidas por rol — solo admin y superadmin */}
            <Route path="/tareas"   element={<TareasGlobal />} />
            <Route path="/users"    element={<AdminRoute><UsersAdmin /></AdminRoute>} />
            <Route path="/clients"  element={<AdminRoute><ClientsAdmin /></AdminRoute>} />
            {/* Configuracion — solo superadmin */}
            <Route path="/settings" element={<AdminRoute><Settings /></AdminRoute>} />
          </Routes>
        </div>
      </main>

      {/* Barra flotante de grabacion — visible en todas las paginas mientras graba */}
      <FloatingRecordingBar />
    </div>
  );
}

// -----------------------------------------------------------------------------
// ProtectedApp — Decide si mostrar Login o la app completa
// Si el usuario no esta autenticado muestra el formulario de login.
// Una vez autenticado, envuelve el layout en RecordingProvider para que
// el contexto de grabacion este disponible en todos los componentes.
// -----------------------------------------------------------------------------
function ProtectedApp() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Login />;
  return (
    <RecordingProvider>
      <AppLayout />
    </RecordingProvider>
  );
}

// -----------------------------------------------------------------------------
// App — Componente raiz exportado
// Define dos ramas principales de rutas:
//   /portal  → Portal del cliente (acceso publico, sin autenticacion interna)
//   /*       → Aplicacion principal envuelta en AuthProvider
// AuthProvider debe estar fuera de AppLayout para que Login pueda acceder
// al contexto de autenticacion.
// -----------------------------------------------------------------------------
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Portal externo para clientes — no requiere autenticacion interna */}
        <Route path="/portal" element={<ClientPortal />} />

        {/* Aplicacion principal — AuthProvider gestiona la sesion */}
        <Route path="/*" element={
          <AuthProvider>
            <ProtectedApp />
          </AuthProvider>
        } />
      </Routes>
    </BrowserRouter>
  );
}
