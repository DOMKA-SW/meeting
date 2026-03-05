import { useState, useEffect } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { clientFetch } from '../utils/api';

// ─── PDF (mismo que admin) ────────────────────────────────────────────────────
function generarPDF(acta, meeting) {
  const doc   = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 20; const contentW = pageW - margin * 2;
  let y = 20;
  const colors = { black:[0,0,0], darkGray:[80,80,80], gray:[130,130,130], lightGray:[245,245,245], border:[180,180,180] };
  const checkPage = (n=10) => { if (y+n > pageH-20) { doc.addPage(); y=20; } };
  const sectionTitle = (text) => {
    checkPage(14); doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(...colors.black);
    doc.text(text.toUpperCase(), margin, y); y+=2; doc.setDrawColor(...colors.black);
    doc.line(margin, y, margin+contentW, y); y+=8;
  };
  const textBlock = (text) => {
    if (!text) return; doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...colors.darkGray);
    doc.splitTextToSize(String(text), contentW).forEach(l => { checkPage(6); doc.text(l, margin, y); y+=5; }); y+=4;
  };
  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...colors.black);
  doc.text('ACTA DE REUNIÓN', pageW/2, y, {align:'center'}); y+=10;
  doc.setFontSize(9); doc.setFont('helvetica','normal');
  doc.text(`Generado el ${new Date().toLocaleDateString('es-ES')}`, pageW/2, y, {align:'center'}); y+=12;
  sectionTitle('Identificación');
  const id = acta.identificacion || {};
  const startedDate = meeting?.started_at ? new Date(meeting.started_at) : null;
  const endedDate   = meeting?.ended_at   ? new Date(meeting.ended_at)   : null;
  [['Cliente',id.cliente],['Proyecto',id.proyecto],['Responsable',id.responsable],
   ['Fecha', id.fecha||(startedDate?startedDate.toISOString().split('T')[0]:'')],
   ['Hora inicio', id.hora_inicio||(startedDate?startedDate.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}):'')],
   ['Hora fin', id.hora_fin||(endedDate?endedDate.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}):''  )],
   ['Participantes', Array.isArray(id.participantes)?id.participantes.join(', '):id.participantes]
  ].forEach(([label,value]) => {
    checkPage(6); doc.setFont('helvetica','bold'); doc.text(label+':', margin, y);
    doc.setFont('helvetica','normal'); doc.text(String(value||'—'), margin+40, y); y+=6;
  }); y+=6;
  const tableOpts = (head,body) => ({ margin:{left:margin,right:margin}, head, body, styles:{fontSize:8.5,cellPadding:3,textColor:colors.black,lineColor:colors.border,lineWidth:0.1}, headStyles:{fillColor:colors.lightGray,textColor:colors.black,fontStyle:'bold'} });
  sectionTitle('Tareas Nuevas');
  const tareasNuevas = acta.tareas_nuevas||[];
  if (!tareasNuevas.length) { doc.setFontSize(9); doc.setTextColor(...colors.gray); doc.text('Sin tareas nuevas.', margin, y); y+=8; }
  else { autoTable(doc,{startY:y,...tableOpts([['ID','Descripción','Responsable','Fecha compromiso']], tareasNuevas.map(t=>[t.id||'',t.descripcion||'',t.responsable||'',t.fecha_compromiso||'']))}); y=doc.lastAutoTable.finalY+8; }
  sectionTitle('Resumen'); textBlock(acta.resumen_reunion);
  if (acta.observaciones_generales) { sectionTitle('Observaciones'); textBlock(acta.observaciones_generales); }
  for (let i=1; i<=doc.internal.getNumberOfPages(); i++) {
    doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(...colors.gray);
    doc.text(`Página ${i} de ${doc.internal.getNumberOfPages()}`, pageW-margin, pageH-10, {align:'right'});
    doc.text('Generado automáticamente', margin, pageH-10);
  }
  const cf = (id.cliente||'acta').replace(/[^a-z0-9]/gi,'_');
  const ff = (id.fecha||'sin_fecha').replace(/-/g,'');
  doc.save(`Acta_${cf}_${ff}.pdf`);
}

// ─── Login del portal ─────────────────────────────────────────────────────────
function PortalLogin({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res  = await fetch(`${import.meta.env.VITE_API_BASE_URL}/client-login`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ username: username.trim().toLowerCase(), password })
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Usuario o contraseña incorrectos'); setLoading(false); return; }
      localStorage.setItem('client_token', data.token);
      onLogin({ client_name: data.client_name, username: username.toLowerCase() });
    } catch { setError('No se pudo conectar al servidor'); }
    setLoading(false);
  };

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', backgroundColor:'#f8fafc', padding:16 }}>
      <div style={{ width:'100%', maxWidth:380, backgroundColor:'white', borderRadius:16, padding:'40px 36px', boxShadow:'0 8px 40px rgba(0,0,0,0.1)', border:'1px solid #e5e7eb' }}>
        <div style={{ textAlign:'center', marginBottom:28 }}>
          <div style={{ fontSize:48, marginBottom:12 }}>📄</div>
          <h1 style={{ margin:0, fontSize:22, fontWeight:700, color:'#111827' }}>Portal de Actas</h1>
          <p style={{ margin:'8px 0 0', fontSize:13, color:'#6b7280' }}>Ingresa tus credenciales para ver tus actas</p>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', marginBottom:5, fontSize:13, fontWeight:600, color:'#374151' }}>Usuario</label>
            <input value={username} onChange={e=>setUsername(e.target.value)} placeholder="tu-empresa"
              style={{ width:'100%', padding:'11px 14px', border:'1px solid #d1d5db', borderRadius:8, fontSize:14, color:'#111', outline:'none', boxSizing:'border-box' }} />
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={{ display:'block', marginBottom:5, fontSize:13, fontWeight:600, color:'#374151' }}>Contraseña</label>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••"
              style={{ width:'100%', padding:'11px 14px', border:'1px solid #d1d5db', borderRadius:8, fontSize:14, color:'#111', outline:'none', boxSizing:'border-box', letterSpacing:3 }} />
          </div>
          {error && (
            <div style={{ padding:'9px 12px', backgroundColor:'#fef2f2', border:'1px solid #fecaca', borderRadius:7, fontSize:13, color:'#dc2626', marginBottom:14 }}>
              ⚠️ {error}
            </div>
          )}
          <button type="submit" disabled={loading||!username||!password}
            style={{ width:'100%', padding:13, background: loading||!username||!password?'#9ca3af':'#1565C0', color:'white', border:'none', borderRadius:8, fontSize:15, fontWeight:600, cursor: loading||!username||!password?'default':'pointer' }}>
            {loading ? '⏳ Verificando...' : '→ Ver mis actas'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Vista de acta individual ─────────────────────────────────────────────────
function ActaView({ meeting, onBack }) {
  const { acta } = meeting;
  if (!acta) return null;

  const id            = acta.identificacion || {};
  const tareasNuevas  = acta.tareas_nuevas || [];
  const tareasAnt     = acta.tareas_anteriores || [];
  const fmt           = (d) => d ? new Date(d).toLocaleDateString('es-ES', { day:'2-digit', month:'long', year:'numeric' }) : '—';

  const estadoColor = { completada:'#16a34a', 'en progreso':'#ca8a04', cancelada:'#dc2626', pendiente:'#6b7280' };
  const estadoBg    = { completada:'#f0fdf4', 'en progreso':'#fefce8', cancelada:'#fef2f2', pendiente:'#f9fafb' };

  return (
    <div style={{ maxWidth:800, margin:'0 auto', padding:'20px 16px' }}>
      <button onClick={onBack} style={{ background:'none', border:'none', color:'#1565C0', fontSize:14, cursor:'pointer', marginBottom:16, padding:'0 0 0 0' }}>
        ← Volver a la lista
      </button>

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20, flexWrap:'wrap', gap:10 }}>
        <div>
          <h2 style={{ margin:0, fontSize:20, color:'#111' }}>{id.proyecto || 'Reunión'}</h2>
          <p style={{ margin:'4px 0 0', fontSize:14, color:'#666' }}>{fmt(id.fecha || meeting.started_at)}</p>
        </div>
        <button onClick={() => generarPDF(acta, meeting)}
          style={{ padding:'9px 18px', backgroundColor:'#dc2626', color:'white', border:'none', borderRadius:7, fontSize:13, cursor:'pointer', fontWeight:600 }}>
          📄 Descargar PDF
        </button>
      </div>

      {/* Identificación */}
      <div style={{ padding:16, backgroundColor:'#f8fafc', borderRadius:10, border:'1px solid #e5e7eb', marginBottom:20 }}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))', gap:10 }}>
          {[['Responsable', id.responsable],['Hora inicio', id.hora_inicio],['Hora fin', id.hora_fin],
            ['Participantes', Array.isArray(id.participantes)?id.participantes.join(', '):id.participantes]
          ].filter(([,v])=>v).map(([l,v]) => (
            <div key={l}>
              <div style={{ fontSize:11, color:'#9ca3af', textTransform:'uppercase', fontWeight:600, marginBottom:2 }}>{l}</div>
              <div style={{ fontSize:13, color:'#374151', fontWeight:500 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Resumen */}
      {acta.resumen_reunion && (
        <div style={{ marginBottom:20 }}>
          <h3 style={{ fontSize:15, color:'#111', marginBottom:10, fontWeight:700 }}>📝 Resumen</h3>
          <p style={{ fontSize:14, lineHeight:1.8, color:'#374151', margin:0, padding:'14px 16px', backgroundColor:'#f8fafc', borderRadius:8, border:'1px solid #e5e7eb' }}>
            {acta.resumen_reunion}
          </p>
        </div>
      )}

      {/* Tareas nuevas */}
      {tareasNuevas.length > 0 && (
        <div style={{ marginBottom:20 }}>
          <h3 style={{ fontSize:15, color:'#111', marginBottom:10, fontWeight:700 }}>✅ Tareas Nuevas ({tareasNuevas.length})</h3>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {tareasNuevas.map((t,i) => {
              const est = t.estado || 'pendiente';
              return (
                <div key={i} style={{ padding:'12px 14px', borderRadius:8, border:`1px solid ${estadoColor[est]}33`, backgroundColor: estadoBg[est]||'#f9fafb' }}>
                  <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:10 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap' }}>
                        <span style={{ fontSize:11, fontWeight:700, color:'#1565C0', backgroundColor:'#dbeafe', padding:'1px 7px', borderRadius:4 }}>{t.id}</span>
                        <span style={{ fontSize:11, fontWeight:600, color: estadoColor[est] }}>{est}</span>
                      </div>
                      <div style={{ fontSize:14, color:'#111', lineHeight:1.5 }}>{t.descripcion}</div>
                      <div style={{ fontSize:12, color:'#6b7280', marginTop:4, display:'flex', gap:12, flexWrap:'wrap' }}>
                        {t.responsable && <span>👤 {t.responsable}</span>}
                        {t.fecha_compromiso && <span>📅 {t.fecha_compromiso}</span>}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tareas anteriores */}
      {tareasAnt.length > 0 && (
        <div style={{ marginBottom:20 }}>
          <h3 style={{ fontSize:15, color:'#111', marginBottom:10, fontWeight:700 }}>📋 Seguimiento Tareas Anteriores ({tareasAnt.length})</h3>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {tareasAnt.map((t,i) => {
              const est = t.estado || 'pendiente';
              return (
                <div key={i} style={{ padding:'10px 14px', borderRadius:7, border:'1px solid #e5e7eb', backgroundColor:'#fafafa', display:'flex', alignItems:'center', gap:12 }}>
                  <span style={{ fontSize:11, fontWeight:600, color: estadoColor[est], backgroundColor: estadoBg[est]||'#f9fafb', padding:'2px 9px', borderRadius:20, border:`1px solid ${estadoColor[est]}44`, flexShrink:0 }}>{est}</span>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, color:'#374151' }}>{t.descripcion}</div>
                    {t.responsable && <div style={{ fontSize:12, color:'#9ca3af' }}>👤 {t.responsable}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Observaciones */}
      {acta.observaciones_generales && (
        <div>
          <h3 style={{ fontSize:15, color:'#111', marginBottom:10, fontWeight:700 }}>⚠️ Observaciones</h3>
          <p style={{ fontSize:14, lineHeight:1.8, color:'#374151', margin:0, padding:'14px 16px', backgroundColor:'#fffbeb', borderRadius:8, border:'1px solid #fcd34d' }}>
            {acta.observaciones_generales}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Lista de actas del cliente ───────────────────────────────────────────────
function ActasList({ session, onLogout }) {
  const [actas, setActas]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState(null);
  const [search, setSearch]     = useState('');

  useEffect(() => {
    clientFetch('/client/actas')
      .then(r => r.ok ? r.json() : [])
      .then(data => { setActas(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (selected) return <ActaView meeting={selected} onBack={() => setSelected(null)} />;

  const fmt = (d) => d ? new Date(d).toLocaleDateString('es-ES', { day:'2-digit', month:'short', year:'numeric' }) : '—';

  const filtered = actas.filter(a => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (a.proyecto||'').toLowerCase().includes(q) || (a.responsable||'').toLowerCase().includes(q);
  });

  return (
    <div style={{ minHeight:'100vh', backgroundColor:'#f8fafc' }}>
      {/* Header */}
      <div style={{ backgroundColor:'#1565C0', color:'white', padding:'16px 24px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div>
          <div style={{ fontSize:18, fontWeight:700 }}>📄 Portal de Actas</div>
          <div style={{ fontSize:13, opacity:0.8 }}>{session.client_name}</div>
        </div>
        <button onClick={onLogout}
          style={{ background:'rgba(255,255,255,0.2)', border:'none', color:'white', borderRadius:6, padding:'7px 14px', fontSize:13, cursor:'pointer' }}>
          Salir
        </button>
      </div>

      <div style={{ maxWidth:800, margin:'0 auto', padding:'24px 16px' }}>
        {loading ? (
          <div style={{ textAlign:'center', padding:60, color:'#666' }}>Cargando actas...</div>
        ) : actas.length === 0 ? (
          <div style={{ textAlign:'center', padding:60, backgroundColor:'white', borderRadius:12, border:'1px solid #e5e7eb' }}>
            <div style={{ fontSize:48, marginBottom:16 }}>📭</div>
            <p style={{ fontSize:15, color:'#666' }}>No hay actas disponibles aún.</p>
          </div>
        ) : (
          <>
            <div style={{ marginBottom:16 }}>
              <input
                value={search} onChange={e=>setSearch(e.target.value)}
                placeholder="Buscar por proyecto o responsable..."
                style={{ width:'100%', padding:'10px 14px', border:'1px solid #d1d5db', borderRadius:8, fontSize:14, outline:'none', boxSizing:'border-box' }}
              />
            </div>
            <p style={{ fontSize:13, color:'#6b7280', marginBottom:12 }}>{filtered.length} acta{filtered.length!==1?'s':''}</p>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {filtered.map(m => (
                <div key={m.id}
                  onClick={() => setSelected(m)}
                  style={{ padding:16, backgroundColor:'white', borderRadius:10, border:'1px solid #e5e7eb', cursor:'pointer', transition:'box-shadow 0.15s', display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}
                  onMouseEnter={e=>e.currentTarget.style.boxShadow='0 4px 12px rgba(0,0,0,0.08)'}
                  onMouseLeave={e=>e.currentTarget.style.boxShadow='none'}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:15, fontWeight:700, color:'#111', marginBottom:3 }}>{m.proyecto || 'Reunión sin nombre'}</div>
                    <div style={{ fontSize:13, color:'#6b7280', display:'flex', gap:14, flexWrap:'wrap' }}>
                      <span>📅 {fmt(m.started_at)}</span>
                      {m.responsable && <span>👤 {m.responsable}</span>}
                      {m.acta?.tareas_nuevas?.length > 0 && (
                        <span>✅ {m.acta.tareas_nuevas.length} tarea{m.acta.tareas_nuevas.length!==1?'s':''}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ color:'#9ca3af', fontSize:18, flexShrink:0 }}>›</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Portal principal ─────────────────────────────────────────────────────────
export default function ClientPortal() {
  const [session, setSession] = useState(() => {
    const token = localStorage.getItem('client_token');
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp * 1000 < Date.now()) { localStorage.removeItem('client_token'); return null; }
      return { client_name: payload.client_name, username: payload.username };
    } catch { return null; }
  });

  const handleLogin = (sessionData) => setSession(sessionData);
  const handleLogout = () => {
    localStorage.removeItem('client_token');
    setSession(null);
  };

  if (!session) return <PortalLogin onLogin={handleLogin} />;
  return <ActasList session={session} onLogout={handleLogout} />;
}
