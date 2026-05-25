import { useState, useEffect } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { clientFetch } from '../utils/api';
import logoGerenteNegocios from '../assets/images/logo_gerentedenegocios.png';

// ─── PDF idéntico al admin ────────────────────────────────────────────────────
function generarPDF(acta, meeting, logoDataUrl) {
  const doc    = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW  = doc.internal.pageSize.getWidth();
  const pageH  = doc.internal.pageSize.getHeight();
  const margin = 22;
  const contentW = pageW - margin * 2;
  let y = 0;

  const CREAM   = [250, 247, 242];
  const DARK    = [60,  40,  30];
  const HEADING = [90,  55,  45];
  const MUTED   = [140, 120, 110];
  const RULE    = [200, 185, 175];

  const fillBackground = () => {
    doc.setFillColor(...CREAM);
    doc.rect(0, 0, pageW, pageH, 'F');
  };

  const addWatermark = () => {
    if (!logoDataUrl) return;
    doc.saveGraphicsState();
    doc.setGState(new doc.GState({ opacity: 0.04 }));
    const s = 100;
    doc.addImage(logoDataUrl, 'PNG', (pageW - s) / 2, (pageH - s) / 2, s, s);
    doc.restoreGraphicsState();
  };

  const hrule = (yPos) => {
    doc.setDrawColor(...RULE); doc.setLineWidth(0.3);
    doc.line(margin, yPos, pageW - margin, yPos);
  };

  const checkPage = (needed = 12) => {
    if (y + needed > pageH - 20) {
      doc.addPage(); fillBackground(); addWatermark();
      y = margin + 6;
    }
  };

  const sectionTitle = (text) => {
    checkPage(18); y += 6;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.setTextColor(...HEADING); doc.setCharSpace(1.5);
    doc.text(text.toUpperCase(), margin, y);
    doc.setCharSpace(0); y += 3; hrule(y); y += 7;
  };

  const textBlock = (text) => {
    if (!text) return;
    doc.setFont('times', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...DARK);
    const lines = doc.splitTextToSize(String(text), contentW);
    lines.forEach(l => { checkPage(6); doc.text(l, margin, y); y += 5.8; }); y += 3;
  };

  const fieldRow = (label, value) => {
    checkPage(9);
    doc.setDrawColor(...RULE); doc.setLineWidth(0.2);
    doc.line(margin, y - 2, pageW - margin, y - 2);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.setTextColor(...HEADING); doc.setCharSpace(1);
    doc.text(label.toUpperCase(), margin, y + 3); doc.setCharSpace(0);
    doc.setFont('times', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...DARK);
    const wrapped = doc.splitTextToSize(String(value || ''), contentW - 52);
    doc.text(wrapped[0] || '', margin + 52, y + 3); y += 9;
  };

  const bulletItem = (t, showFecha = false) => {
    checkPage(14);
    doc.setFillColor(...HEADING); doc.circle(margin + 2, y + 1.5, 1, 'F');
    doc.setFont('times', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...DARK);
    const lines = doc.splitTextToSize(String(t.descripcion || ''), contentW - 10);
    lines.forEach((l, li) => { checkPage(6); doc.text(l, margin + 7, y + (li === 0 ? 0 : 5.5 * li)); });
    y += 5.5 * lines.length;
    const meta = [t.responsable||null, showFecha&&t.fecha_compromiso?t.fecha_compromiso:null, t.estado&&t.estado!=='pendiente'?t.estado.toUpperCase():null].filter(Boolean).join('  ·  ');
    if (meta) { doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...MUTED); doc.text(meta, margin+7, y); y += 5; }
    y += 3;
  };

  // — Página 1 —
  fillBackground(); addWatermark();
  const logoSize = 38;
  if (logoDataUrl) doc.addImage(logoDataUrl, 'PNG', margin, 14, logoSize, logoSize);

  doc.setFont('times','italic'); doc.setFontSize(36); doc.setTextColor(...HEADING);
  doc.text('Actas', margin + (logoDataUrl ? logoSize + 8 : 0), 38);

  const idData = acta.identificacion || {};
  const startedDate = meeting?.started_at ? new Date(meeting.started_at) : null;
  const endedDate   = meeting?.ended_at   ? new Date(meeting.ended_at)   : null;
  const subtitulo   = idData.proyecto || 'Reunión de trabajo';
  doc.setFont('times','normal'); doc.setFontSize(12); doc.setTextColor(...MUTED);
  doc.text(subtitulo, margin + (logoDataUrl ? logoSize + 8 : 0), 47);

  y = 60; hrule(y); y += 10;

  [
    ['Fecha',               idData.fecha || (startedDate ? startedDate.toLocaleDateString('es-ES',{day:'2-digit',month:'long',year:'numeric'}) : '')],
    ['Hora',                [idData.hora_inicio||(startedDate?startedDate.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}):''), idData.hora_fin||(endedDate?endedDate.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}):'' )].filter(Boolean).join(' – ')],
    ['Reunión convocada por', idData.responsable],
  ].forEach(([l,v]) => fieldRow(l,v));
  doc.setDrawColor(...RULE); doc.setLineWidth(0.2); doc.line(margin, y - 2, pageW - margin, y - 2);
  y += 6;

  if (idData.participantes?.length) {
    sectionTitle('Asistentes');
    const lista = Array.isArray(idData.participantes) ? idData.participantes.join(', ') : String(idData.participantes);
    doc.setFont('times','normal'); doc.setFontSize(10.5); doc.setTextColor(...DARK);
    doc.splitTextToSize(lista, contentW).forEach(l => { checkPage(6); doc.text(l, margin, y); y += 5.8; }); y += 4;
  }

  const tareasAnt = acta.tareas_anteriores || [];
  if (tareasAnt.length) { sectionTitle('Seguimiento de tareas anteriores'); tareasAnt.forEach(t => bulletItem(t, false)); }

  if (acta.resumen_reunion) { sectionTitle('Resumen de la reunión'); textBlock(acta.resumen_reunion); }

  const tareasNuevas = acta.tareas_nuevas || [];
  if (tareasNuevas.length) { sectionTitle('Tareas con fecha de compromiso'); tareasNuevas.forEach(t => bulletItem(t, true)); }

  if (acta.observaciones_generales) { sectionTitle('Observaciones generales'); textBlock(acta.observaciones_generales); }

  checkPage(30); y += 8; hrule(y); y += 10;
  const col1 = margin; const col2 = margin + contentW / 2 + 10; const lw = contentW / 2 - 10;
  doc.setDrawColor(...MUTED); doc.setLineWidth(0.3);
  doc.line(col1, y, col1 + lw, y); doc.line(col2, y, col2 + lw, y);
  doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  doc.text('Elaborado por', col1, y + 5); doc.text('Aprobado por el cliente', col2, y + 5);
  doc.setFont('times','italic'); doc.setFontSize(10); doc.setTextColor(...DARK);
  doc.text(idData.responsable||'_______________', col1, y + 11);
  doc.text(idData.cliente    ||'_______________', col2, y + 11);

  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTED);
    doc.text('GerentedeNegocios · Sistema de Actas', margin, pageH - 8);
    doc.text(`${i} / ${totalPages}`, pageW - margin, pageH - 8, { align:'right' });
  }

  const cf = (idData.cliente||'acta').replace(/[^a-z0-9]/gi,'_');
  const ff = (idData.fecha||'sin_fecha').replace(/-/g,'');
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
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', backgroundColor:'#f4f4f4', padding:16 }}>
      <div style={{ width:'100%', maxWidth:380, backgroundColor:'white', border:'1px solid #d4d4d4', padding:'44px 40px', boxShadow:'0 2px 16px rgba(0,0,0,0.07)' }}>

        {/* Logo + marca */}
        <div style={{ textAlign:'center', marginBottom:32 }}>
          <img src={logoGerenteNegocios} alt="GerentedeNegocios" style={{ height:44, objectFit:'contain', marginBottom:16 }} />
          <div style={{ width:40, height:2, backgroundColor:'#000', margin:'0 auto 16px' }}></div>
          <h1 style={{ margin:0, fontSize:18, fontWeight:700, color:'#000', fontFamily:'helvetica, Arial, sans-serif', textTransform:'uppercase', letterSpacing:1 }}>Portal de Actas</h1>
          <p style={{ margin:'8px 0 0', fontSize:12, color:'#888', fontFamily:'helvetica, Arial, sans-serif', letterSpacing:.3 }}>Ingresa tus credenciales para continuar</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', marginBottom:5, fontSize:11, fontWeight:700, color:'#555', textTransform:'uppercase', letterSpacing:.8, fontFamily:'helvetica, Arial, sans-serif' }}>Usuario</label>
            <input value={username} onChange={e=>setUsername(e.target.value)} placeholder="tu-empresa"
              style={{ width:'100%', padding:'11px 12px', border:'1px solid #ccc', borderRadius:0, fontSize:13, color:'#111', outline:'none', boxSizing:'border-box', fontFamily:'Georgia, serif', backgroundColor:'#fafafa' }} />
          </div>
          <div style={{ marginBottom:20 }}>
            <label style={{ display:'block', marginBottom:5, fontSize:11, fontWeight:700, color:'#555', textTransform:'uppercase', letterSpacing:.8, fontFamily:'helvetica, Arial, sans-serif' }}>Contraseña</label>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••"
              style={{ width:'100%', padding:'11px 12px', border:'1px solid #ccc', borderRadius:0, fontSize:13, color:'#111', outline:'none', boxSizing:'border-box', letterSpacing:3, backgroundColor:'#fafafa' }} />
          </div>
          {error && (
            <div style={{ padding:'9px 12px', backgroundColor:'#f7f7f7', border:'1px solid #ccc', fontSize:12, color:'#555', marginBottom:14, fontFamily:'helvetica, Arial, sans-serif' }}>
              {error}
            </div>
          )}
          <button type="submit" disabled={loading||!username||!password}
            style={{ width:'100%', padding:13, background: loading||!username||!password?'#999':'#000', color:'white', border:'none', fontSize:13, fontWeight:700, cursor: loading||!username||!password?'default':'pointer', letterSpacing:1, textTransform:'uppercase', fontFamily:'helvetica, Arial, sans-serif' }}>
            {loading ? 'Verificando...' : 'Ingresar'}
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

  const idData       = acta.identificacion || {};
  const tareasNuevas = acta.tareas_nuevas || [];
  const tareasAnt    = acta.tareas_anteriores || [];
  const fmt          = (d) => d ? new Date(d).toLocaleDateString('es-ES', { day:'2-digit', month:'long', year:'numeric' }) : '—';

  const estadoBW = (estado) => {
    const s = (estado || 'pendiente').toLowerCase();
    return {
      padding:'2px 9px', borderRadius:2, fontSize:10, fontWeight:700,
      fontFamily:'helvetica, Arial, sans-serif', textTransform:'uppercase', letterSpacing:.5,
      display:'inline-block',
      backgroundColor: s==='completada'?'#f0f0f0': s==='en progreso'?'#e8e8e8':'#fafafa',
      color: s==='completada'?'#111': s==='en progreso'?'#333':'#666',
      border:'1px solid #ccc',
    };
  };

  const handlePDF = () => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      generarPDF(acta, meeting, canvas.toDataURL('image/png'));
    };
    img.onerror = () => generarPDF(acta, meeting, null);
    img.src = logoGerenteNegocios;
  };

  return (
    <div style={{ maxWidth:820, margin:'0 auto', padding:'24px 16px' }}>

      {/* Nav superior */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:28, flexWrap:'wrap', gap:10 }}>
        <button onClick={onBack} style={{ background:'none', border:'none', color:'#000', fontSize:13, cursor:'pointer', fontFamily:'helvetica, Arial, sans-serif', fontWeight:600, letterSpacing:.3, padding:0 }}>
          ← Volver
        </button>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {!meeting.approved_at && (
            <button onClick={async () => {
              if (!confirm('¿Aprobar esta acta? Una vez aprobada no se podrá modificar.')) return;
              try {
                const res = await clientFetch(`/client/actas/${meeting.id}/approve`, { method:'POST' });
                if (res.ok) { alert('Acta aprobada exitosamente.'); onBack(); }
                else { const d=await res.json(); alert('Error: '+d.error); }
              } catch(e) { alert('Error: '+e.message); }
            }}
              style={{ padding:'8px 18px', backgroundColor:'#000', color:'white', border:'none', fontSize:12, cursor:'pointer', fontWeight:700, textTransform:'uppercase', letterSpacing:.8, fontFamily:'helvetica, Arial, sans-serif' }}>
              Aprobar acta
            </button>
          )}
          {meeting.approved_at && (
            <span style={{ padding:'8px 14px', backgroundColor:'#f0f0f0', color:'#333', border:'1px solid #ccc', fontSize:12, fontWeight:600, fontFamily:'helvetica, Arial, sans-serif', textTransform:'uppercase', letterSpacing:.5 }}>
              Aprobada
            </span>
          )}
          <button onClick={handlePDF}
            style={{ padding:'8px 18px', backgroundColor:'white', color:'#000', border:'1px solid #000', fontSize:12, cursor:'pointer', fontWeight:700, textTransform:'uppercase', letterSpacing:.8, fontFamily:'helvetica, Arial, sans-serif' }}>
            Exportar PDF
          </button>
        </div>
      </div>

      {/* Documento */}
      <div style={{ backgroundColor:'white', border:'1px solid #d4d4d4', padding:32, fontFamily:'Georgia, serif' }}>

        {/* Cabecera */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:'2px solid #000', paddingBottom:16, marginBottom:28 }}>
          <img src={logoGerenteNegocios} alt="GerentedeNegocios" style={{ height:40, objectFit:'contain' }} />
          <div style={{ textAlign:'right' }}>
            <div style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:18, fontWeight:700, color:'#000', textTransform:'uppercase', letterSpacing:1 }}>Acta de Reunión</div>
            <div style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:11, color:'#777', marginTop:3 }}>
              {idData.fecha || fmt(meeting.started_at)}
            </div>
          </div>
        </div>

        {/* Identificación */}
        <div style={{ marginBottom:28 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
            <div style={{ width:3, height:16, backgroundColor:'#000', flexShrink:0 }}></div>
            <h4 style={{ margin:0, fontFamily:'helvetica, Arial, sans-serif', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:1.5, color:'#000' }}>Identificación de la reunión</h4>
          </div>
          <div style={{ border:'1px solid #d4d4d4' }}>
            {[
              ['Cliente', idData.cliente],
              ['Proyecto', idData.proyecto],
              ['Responsable', idData.responsable],
              ['Fecha', idData.fecha || fmt(meeting.started_at)],
              ['Hora inicio', idData.hora_inicio],
              ['Hora fin', idData.hora_fin],
              ['Participantes', Array.isArray(idData.participantes) ? idData.participantes.join(', ') : idData.participantes],
            ].map(([label, valor], i) => (
              <div key={label} style={{ display:'grid', gridTemplateColumns:'130px 1fr', borderBottom: i < 6 ? '1px solid #e8e8e8':'none' }}>
                <div style={{ padding:'9px 12px', backgroundColor: i%2===0?'#f7f7f7':'#fafafa', fontFamily:'helvetica, Arial, sans-serif', fontSize:11, fontWeight:600, color:'#555', textTransform:'uppercase', letterSpacing:.5 }}>
                  {label}
                </div>
                <div style={{ padding:'9px 12px', borderLeft:'1px solid #d4d4d4', fontFamily:'Georgia, serif', fontSize:12, color:'#111' }}>
                  {valor || '—'}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Tareas nuevas */}
        {tareasNuevas.length > 0 && (
          <div style={{ marginBottom:28 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
              <div style={{ width:3, height:16, backgroundColor:'#000', flexShrink:0 }}></div>
              <h4 style={{ margin:0, fontFamily:'helvetica, Arial, sans-serif', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:1.5, color:'#000' }}>Tareas nuevas con fecha de compromiso</h4>
              <span style={{ fontSize:10, color:'#888', fontFamily:'helvetica, Arial, sans-serif', backgroundColor:'#efefef', borderRadius:2, padding:'1px 7px', border:'1px solid #ddd' }}>{tareasNuevas.length}</span>
            </div>
            <div style={{ border:'1px solid #d4d4d4' }}>
              {tareasNuevas.map((t, i) => (
                <div key={i} style={{ padding:'12px 14px', borderBottom: i<tareasNuevas.length-1?'1px solid #e8e8e8':'none', backgroundColor: i%2===0?'#fff':'#fafafa' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:5, flexWrap:'wrap' }}>
                    <span style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:10, fontWeight:700, color:'#111', backgroundColor:'#efefef', padding:'1px 7px', border:'1px solid #ddd' }}>{t.id||`#${i+1}`}</span>
                    <span style={estadoBW(t.estado)}>{t.estado||'pendiente'}</span>
                    {t.fecha_compromiso && (
                      <span style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:10, color:'#666', border:'1px solid #e0e0e0', padding:'1px 7px', backgroundColor:'#fafafa' }}>{t.fecha_compromiso}</span>
                    )}
                  </div>
                  <div style={{ fontFamily:'Georgia, serif', fontSize:13, color:'#111', lineHeight:1.55, marginBottom: t.responsable?4:0 }}>{t.descripcion}</div>
                  {t.responsable && <div style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:11, color:'#777' }}>{t.responsable}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tareas anteriores */}
        {tareasAnt.length > 0 && (
          <div style={{ marginBottom:28 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
              <div style={{ width:3, height:16, backgroundColor:'#000', flexShrink:0 }}></div>
              <h4 style={{ margin:0, fontFamily:'helvetica, Arial, sans-serif', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:1.5, color:'#000' }}>Seguimiento de tareas anteriores</h4>
              <span style={{ fontSize:10, color:'#888', fontFamily:'helvetica, Arial, sans-serif', backgroundColor:'#efefef', borderRadius:2, padding:'1px 7px', border:'1px solid #ddd' }}>{tareasAnt.length}</span>
            </div>
            <div style={{ border:'1px solid #d4d4d4' }}>
              {tareasAnt.map((t, i) => (
                <div key={i} style={{ padding:'11px 14px', borderBottom: i<tareasAnt.length-1?'1px solid #e8e8e8':'none', backgroundColor: i%2===0?'#fff':'#fafafa', display:'flex', alignItems:'center', gap:12 }}>
                  <span style={estadoBW(t.estado)}>{t.estado||'pendiente'}</span>
                  <div style={{ flex:1 }}>
                    <div style={{ fontFamily:'Georgia, serif', fontSize:13, color:'#111', lineHeight:1.5 }}>{t.descripcion}</div>
                    {t.responsable && <div style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:11, color:'#888', marginTop:2 }}>{t.responsable}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Resumen */}
        {acta.resumen_reunion && (
          <div style={{ marginBottom:28 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
              <div style={{ width:3, height:16, backgroundColor:'#000', flexShrink:0 }}></div>
              <h4 style={{ margin:0, fontFamily:'helvetica, Arial, sans-serif', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:1.5, color:'#000' }}>Resumen ejecutivo de la reunión</h4>
            </div>
            <p style={{ fontFamily:'Georgia, serif', fontSize:13, lineHeight:1.85, color:'#222', margin:0, padding:'14px 16px', backgroundColor:'#fafafa', border:'1px solid #e8e8e8' }}>
              {acta.resumen_reunion}
            </p>
          </div>
        )}

        {/* Observaciones */}
        {acta.observaciones_generales && (
          <div style={{ marginBottom:28 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
              <div style={{ width:3, height:16, backgroundColor:'#000', flexShrink:0 }}></div>
              <h4 style={{ margin:0, fontFamily:'helvetica, Arial, sans-serif', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:1.5, color:'#000' }}>Observaciones generales</h4>
            </div>
            <p style={{ fontFamily:'Georgia, serif', fontSize:13, lineHeight:1.85, color:'#222', margin:0, padding:'14px 16px', backgroundColor:'#fafafa', border:'1px solid #e8e8e8' }}>
              {acta.observaciones_generales}
            </p>
          </div>
        )}

        {/* Bloque de aprobación / firma */}
        {meeting.approved_at ? (
          <div style={{ marginTop:32, paddingTop:16, borderTop:'1px solid #d4d4d4' }}>
            <div style={{ display:'inline-flex', alignItems:'center', gap:10, padding:'10px 16px', border:'1px solid #ccc', backgroundColor:'#f7f7f7' }}>
              <div style={{ width:8, height:8, backgroundColor:'#000', borderRadius:'50%' }}></div>
              <div>
                <div style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:11, fontWeight:700, color:'#000', textTransform:'uppercase', letterSpacing:.5 }}>Acta aprobada por el cliente</div>
                <div style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:11, color:'#666', marginTop:2 }}>
                  {new Date(meeting.approved_at).toLocaleDateString('es-ES',{day:'2-digit',month:'long',year:'numeric'})}
                  {meeting.approved_by_client && ` · ${meeting.approved_by_client}`}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ marginTop:32, paddingTop:16, borderTop:'1px solid #d4d4d4', display:'flex', justifyContent:'space-between' }}>
            <div>
              <div style={{ width:120, borderTop:'1px solid #000', paddingTop:6, fontFamily:'helvetica, Arial, sans-serif', fontSize:10, color:'#666' }}>Elaborado por</div>
              <div style={{ fontFamily:'Georgia, serif', fontSize:11, color:'#111', marginTop:2 }}>{idData.responsable||'___________'}</div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ width:140, borderTop:'1px solid #000', paddingTop:6, fontFamily:'helvetica, Arial, sans-serif', fontSize:10, color:'#666', marginLeft:'auto' }}>Aprobado por el cliente</div>
              <div style={{ fontFamily:'Georgia, serif', fontSize:11, color:'#111', marginTop:2 }}>{idData.cliente||'___________'}</div>
            </div>
          </div>
        )}

      </div>
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
    <div style={{ minHeight:'100vh', backgroundColor:'#f4f4f4' }}>

      {/* Header */}
      <div style={{ backgroundColor:'#000', color:'white', padding:'0 24px', display:'flex', justifyContent:'space-between', alignItems:'center', height:56 }}>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <img src={logoGerenteNegocios} alt="GerentedeNegocios" style={{ height:28, objectFit:'contain', filter:'brightness(0) invert(1)' }} />
          <div style={{ width:1, height:24, backgroundColor:'rgba(255,255,255,0.3)' }}></div>
          <div style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:12, letterSpacing:1, textTransform:'uppercase', color:'rgba(255,255,255,0.85)' }}>Portal de Actas</div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <span style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:12, color:'rgba(255,255,255,0.7)' }}>{session.client_name}</span>
          <button onClick={onLogout}
            style={{ background:'none', border:'1px solid rgba(255,255,255,0.4)', color:'white', padding:'5px 14px', fontSize:11, cursor:'pointer', fontFamily:'helvetica, Arial, sans-serif', letterSpacing:.5, textTransform:'uppercase' }}>
            Salir
          </button>
        </div>
      </div>

      <div style={{ maxWidth:800, margin:'0 auto', padding:'32px 16px' }}>
        {loading ? (
          <div style={{ textAlign:'center', padding:80, fontFamily:'helvetica, Arial, sans-serif', fontSize:13, color:'#888' }}>Cargando actas...</div>
        ) : actas.length === 0 ? (
          <div style={{ textAlign:'center', padding:60, backgroundColor:'white', border:'1px solid #d4d4d4' }}>
            <div style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:13, color:'#888' }}>No hay actas disponibles aún.</div>
          </div>
        ) : (
          <>
            <div style={{ marginBottom:20 }}>
              <input
                value={search} onChange={e=>setSearch(e.target.value)}
                placeholder="Buscar por proyecto o responsable..."
                style={{ width:'100%', padding:'10px 14px', border:'1px solid #ccc', borderRadius:0, fontSize:13, outline:'none', boxSizing:'border-box', fontFamily:'Georgia, serif', backgroundColor:'white' }}
              />
            </div>
            <p style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:11, color:'#999', marginBottom:14, textTransform:'uppercase', letterSpacing:.5 }}>
              {filtered.length} acta{filtered.length!==1?'s':''}
            </p>
            <div style={{ display:'flex', flexDirection:'column', gap:1 }}>
              {filtered.map(m => (
                <div key={m.id}
                  onClick={() => setSelected(m)}
                  style={{ padding:'16px 20px', backgroundColor:'white', border:'1px solid #d4d4d4', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, transition:'background 0.1s' }}
                  onMouseEnter={e=>e.currentTarget.style.backgroundColor='#f7f7f7'}
                  onMouseLeave={e=>e.currentTarget.style.backgroundColor='white'}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontFamily:'Georgia, serif', fontSize:15, fontWeight:700, color:'#111', marginBottom:4 }}>{m.proyecto || 'Reunión sin nombre'}</div>
                    <div style={{ fontFamily:'helvetica, Arial, sans-serif', fontSize:11, color:'#888', display:'flex', gap:16, flexWrap:'wrap' }}>
                      <span>{fmt(m.started_at)}</span>
                      {m.responsable && <span>{m.responsable}</span>}
                      {m.acta?.tareas_nuevas?.length > 0 && (
                        <span>{m.acta.tareas_nuevas.length} tarea{m.acta.tareas_nuevas.length!==1?'s':''}</span>
                      )}
                      {m.approved_at && (
                        <span style={{ fontWeight:700, color:'#333' }}>Aprobada</span>
                      )}
                    </div>
                  </div>
                  <div style={{ color:'#aaa', fontSize:20, flexShrink:0, fontWeight:300 }}>›</div>
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

  const handleLogin  = (sessionData) => setSession(sessionData);
  const handleLogout = () => { localStorage.removeItem('client_token'); setSession(null); };

  if (!session) return <PortalLogin onLogin={handleLogin} />;
  return <ActasList session={session} onLogout={handleLogout} />;
}
