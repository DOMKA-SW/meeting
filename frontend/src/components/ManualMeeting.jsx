import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_BASE_URL;

const EJEMPLOS = {
  notas: `Reunión de seguimiento proyecto App Móvil - 23 Feb 2026

Asistentes: Juan (PM), María (Dev), Carlos (QA), Ana (Diseño)

TEMAS TRATADOS:
- Revisamos el avance del sprint 4. María reportó que el módulo de login está completo al 90%, falta solo pruebas.
- Carlos encontró 3 bugs críticos en el flujo de pago. Hay que resolverlos antes del lunes.
- Ana mostró los nuevos diseños de onboarding, quedaron aprobados por el equipo.
- Se discutió la fecha de lanzamiento beta: acordamos el 5 de marzo.

PENDIENTES Y COMPROMISOS:
- María va a terminar el módulo de login el viernes 28
- Carlos debe documentar los bugs en Jira hoy mismo
- Juan tiene que coordinar con el cliente la fecha de UAT para la semana del 3 de marzo
- Ana entrega los assets exportados el miércoles 26
- Se necesita contratar un desarrollador backend adicional. Juan queda de publicar la oferta esta semana.

DECISIONES:
- Se aprobó el presupuesto adicional de $2,000 para servidores
- El lanzamiento beta queda confirmado para el 5 de marzo
- Las reuniones de seguimiento pasan a ser los martes en vez de los lunes`,

  transcripcion: `[Juan]: Buenos días a todos. Vamos a revisar el avance del sprint 4. María, ¿cómo vamos con el módulo de login?
[María]: El login está al 90%, básicamente terminado. Solo me falta correr las pruebas unitarias, eso lo tengo el viernes.
[Carlos]: Oye, yo quería comentar que encontré tres bugs bastante serios en el flujo de pago. Uno de ellos hace que la app se cierre.
[Juan]: ¿Qué tan críticos son?
[Carlos]: Críticos, hay que resolverlos antes del lunes sin falta.
[Juan]: De acuerdo. María, ¿puedes revisar eso después del login?
[María]: Sí, el lunes los tengo resueltos.
[Ana]: Yo tenía para mostrar los diseños del onboarding que estuvimos discutiendo.
[Juan]: Adelante, Ana.
[Ana]: Básicamente redujimos los pasos de 5 a 3. Aquí están las pantallas.
[Juan]: Me parece muy bien. ¿Todos de acuerdo con esto?
[Carlos]: Sí, mucho mejor.
[María]: Aprobado.
[Juan]: Perfecto. Entonces Ana, ¿cuándo tienes los assets exportados listos?
[Ana]: El miércoles 26 sin problema.
[Juan]: Bien. Sobre la fecha de lanzamiento beta, estamos hablando del 5 de marzo, ¿lo ven factible?
[María]: Si resolvemos los bugs esta semana, sí.
[Carlos]: De mi parte sí, para esa fecha QA debería estar listo.
[Juan]: Quedamos entonces con el 5 de marzo. Voy a coordinar con el cliente la fecha de UAT para la semana del 3.`,

  email: `De: juan.pm@empresa.com
Para: equipo@empresa.com
Asunto: Resumen reunión 23/02 - Proyecto App Móvil

Hola equipo,

Les resumo lo que acordamos hoy:

1. El módulo de login va al 90% - María lo entrega el viernes completo
2. Hay 3 bugs críticos en pagos - Carlos los documenta hoy en Jira y María los corrige para el lunes
3. Onboarding aprobado - Ana entrega assets el miércoles 26
4. Lanzamiento beta confirmado: 5 de marzo
5. Voy a coordinar UAT con el cliente para la semana del 3 de marzo
6. Aprobamos $2,000 adicionales para servidores

Si algo quedó mal o falta algo, me avisan.

Saludos,
Juan`
};

const MODOS = [
  { id: 'notas', icon: '📝', label: 'Notas libres', desc: 'Cualquier formato: párrafos, bullets, pendientes' },
  { id: 'transcripcion', icon: '🎙️', label: 'Transcripción', desc: 'Formato [Nombre]: texto o diálogo libre' },
  { id: 'email', icon: '📧', label: 'Email / Resumen', desc: 'Resumen por correo, mensaje de WhatsApp, etc.' },
];

const PASOS_LOADING = [
  'Analizando el contenido...',
  'Identificando participantes y temas...',
  'Extrayendo compromisos y tareas...',
  'Generando resumen del acta...',
  'Estructurando el documento final...',
];

export default function ManualMeeting() {
  const navigate = useNavigate();
  const textareaRef = useRef(null);

  const [modo, setModo] = useState('notas');
  const [form, setForm] = useState({
    cliente: '', proyecto: '', responsable: '',
    participantes: '',
    fecha: new Date().toISOString().split('T')[0],
    hora_inicio: '', hora_fin: '',
  });
  const [texto, setTexto] = useState('');
  const [loading, setLoading] = useState(false);
  const [pasoActual, setPasoActual] = useState(0);
  const [error, setError] = useState('');

  // Animación de pasos mientras carga
  useEffect(() => {
    if (!loading) { setPasoActual(0); return; }
    const interval = setInterval(() => {
      setPasoActual(prev => (prev + 1) % PASOS_LOADING.length);
    }, 2200);
    return () => clearInterval(interval);
  }, [loading]);

  const palabras = texto.trim() ? texto.trim().split(/\s+/).length : 0;
  const caracteres = texto.length;
  const calidadTexto = palabras < 30 ? 'bajo' : palabras < 100 ? 'medio' : 'bueno';
  const colorCalidad = { bajo: '#f44336', medio: '#ff9800', bueno: '#4CAF50' };

  const limpiar = () => {
    if (texto && !confirm('¿Limpiar el texto?')) return;
    setTexto('');
    textareaRef.current?.focus();
  };

  const pegarPortapapeles = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setTexto(prev => prev ? prev + '\n\n' + t : t);
    } catch (_) {
      alert('No se pudo acceder al portapapeles. Usa Ctrl+V directamente.');
    }
  };

  const handleSubmit = async () => {
    setError('');
    if (!texto.trim() || palabras < 10) {
      setError('Necesitas al menos 10 palabras para generar un acta.');
      return;
    }
    setLoading(true);
    try {
      const participantesArr = form.participantes
        ? form.participantes.split(/[,;]/).map(p => p.trim()).filter(Boolean)
        : [];

      const res = await fetch(`${API_URL}/meetings/from-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'user1',
          cliente: form.cliente.trim(),
          proyecto: form.proyecto.trim(),
          responsable: form.responsable.trim(),
          participantes: participantesArr,
          texto: texto.trim(),
          modo,          // Le decimos al backend qué tipo de texto es
          fecha: form.fecha,
          hora_inicio: form.hora_inicio,
          hora_fin: form.hora_fin,
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Error ${res.status}`);
      }

      const data = await res.json();
      navigate(`/meetings/${data.meetingId}`);
    } catch (e) {
      setError('Error: ' + e.message);
      setLoading(false);
    }
  };

  const inp = {
    width: '100%', padding: '8px 12px', borderRadius: 6,
    border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box',
    outline: 'none',
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 style={{ marginBottom: 2 }}>✍️ Reunión desde Texto</h1>
      <p style={{ color: '#666', fontSize: 13, marginBottom: 24 }}>
        Ingresa tus notas, una transcripción o cualquier resumen y el sistema generará el acta, tareas y responsables automáticamente.
      </p>

      {/* ── Selector de modo ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
        {MODOS.map(m => (
          <div key={m.id} onClick={() => setModo(m.id)} style={{
            flex: 1, padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
            border: modo === m.id ? '2px solid #1565C0' : '2px solid #e0e0e0',
            backgroundColor: modo === m.id ? '#e3f2fd' : 'white',
            transition: 'all 0.15s',
          }}>
            <div style={{ fontSize: 18, marginBottom: 4 }}>{m.icon}</div>
            <div style={{ fontWeight: 'bold', fontSize: 13, color: modo === m.id ? '#1565C0' : '#333' }}>{m.label}</div>
            <div style={{ fontSize: 11, color: '#777', marginTop: 2 }}>{m.desc}</div>
          </div>
        ))}
      </div>

      {/* ── Datos de la reunión ── */}
      <div style={{ padding: 20, backgroundColor: '#fafafa', borderRadius: 10, border: '1px solid #eee', marginBottom: 20 }}>
        <p style={{ fontWeight: 'bold', fontSize: 14, marginBottom: 14, color: '#333' }}>📋 Datos de la reunión</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[
            ['cliente', 'Cliente', 'Empresa o cliente'],
            ['proyecto', 'Proyecto', 'Nombre del proyecto o reunión'],
            ['responsable', 'Responsable / Moderador', 'Quien dirige la reunión'],
            ['participantes', 'Participantes', 'Juan, María, Carlos...'],
          ].map(([field, label, ph]) => (
            <div key={field}>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, fontWeight: 600, color: '#555' }}>{label}</label>
              <input style={inp} value={form[field]}
                onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
                placeholder={ph} />
            </div>
          ))}

          <div>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 12, fontWeight: 600, color: '#555' }}>Fecha</label>
            <input style={inp} type="date" value={form.fecha}
              onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, fontWeight: 600, color: '#555' }}>Hora inicio</label>
              <input style={inp} type="time" value={form.hora_inicio}
                onChange={e => setForm(f => ({ ...f, hora_inicio: e.target.value }))} />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 4, fontSize: 12, fontWeight: 600, color: '#555' }}>Hora fin</label>
              <input style={inp} type="time" value={form.hora_fin}
                onChange={e => setForm(f => ({ ...f, hora_fin: e.target.value }))} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Área de texto ── */}
      <div style={{ marginBottom: 16 }}>
        {/* Toolbar del textarea */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <label style={{ fontWeight: 'bold', fontSize: 14, color: '#333' }}>
            {MODOS.find(m => m.id === modo)?.icon} Contenido de la reunión
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={pegarPortapapeles} style={{
              padding: '4px 10px', fontSize: 12, cursor: 'pointer',
              backgroundColor: 'white', border: '1px solid #ddd', borderRadius: 4,
            }}>📋 Pegar</button>
            <button onClick={() => setTexto(EJEMPLOS[modo])} style={{
              padding: '4px 10px', fontSize: 12, cursor: 'pointer',
              backgroundColor: '#e3f2fd', border: '1px solid #90caf9', borderRadius: 4, color: '#1565C0',
            }}>Ver ejemplo</button>
            {texto && <button onClick={limpiar} style={{
              padding: '4px 10px', fontSize: 12, cursor: 'pointer',
              backgroundColor: '#fff3e0', border: '1px solid #ffcc80', borderRadius: 4, color: '#e65100',
            }}>🗑 Limpiar</button>}
          </div>
        </div>

        <textarea
          ref={textareaRef}
          value={texto}
          onChange={e => setTexto(e.target.value)}
          placeholder={
            modo === 'notas'
              ? 'Escribe o pega aquí tus notas. Cualquier formato sirve:\n- Bullets, párrafos, pendientes\n- Mezcla de temas\n- Decisiones, compromisos\n- Sin estructura definida está bien'
              : modo === 'transcripcion'
              ? 'Pega aquí la transcripción. Formatos aceptados:\n\n[Juan]: Lo que dijo Juan...\nMaría: Lo que dijo María...\n\nO simplemente el diálogo sin formato, el sistema detecta los turnos.'
              : 'Pega aquí el email, mensaje o resumen enviado después de la reunión.\nEl sistema extrae los compromisos y genera el acta.'
          }
          style={{
            width: '100%', minHeight: 320, padding: 14,
            borderRadius: 8, border: error ? '2px solid #f44336' : '1px solid #ddd',
            fontSize: 14, fontFamily: 'inherit', lineHeight: 1.6,
            resize: 'vertical', boxSizing: 'border-box', outline: 'none',
          }}
        />

        {/* Barra de métricas */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
          <div style={{ fontSize: 12, color: '#888' }}>
            {palabras > 0 && (
              <>
                <span style={{ color: colorCalidad[calidadTexto], fontWeight: 'bold' }}>
                  {calidadTexto === 'bajo' ? '⚠️ Poco texto' : calidadTexto === 'medio' ? '👍 Texto suficiente' : '✅ Texto completo'}
                </span>
                <span style={{ marginLeft: 8 }}>{palabras} palabras · {caracteres} caracteres</span>
              </>
            )}
          </div>
          {palabras > 500 && (
            <span style={{ fontSize: 11, color: '#888' }}>
              ~{Math.ceil(palabras / 150)} min de lectura
            </span>
          )}
        </div>

        {error && (
          <div style={{ marginTop: 8, padding: '8px 12px', backgroundColor: '#ffebee', borderRadius: 6, fontSize: 13, color: '#c62828' }}>
            {error}
          </div>
        )}
      </div>

      {/* Tips por modo */}
      {!loading && (
        <div style={{ padding: '10px 14px', backgroundColor: '#f3f4f6', borderRadius: 8, marginBottom: 16, fontSize: 12, color: '#555' }}>
          {modo === 'notas' && '💡 Funciona con cualquier formato. Mientras más detalles incluyas (nombres, fechas, compromisos), mejor será el acta generada.'}
          {modo === 'transcripcion' && '💡 Si el texto tiene formato [Nombre]: el sistema respeta los speakers. Sin formato, el LLM detecta los cambios de turno automáticamente.'}
          {modo === 'email' && '💡 Ideal para re-procesar correos de seguimiento o resúmenes enviados por WhatsApp después de una reunión.'}
        </div>
      )}

      {/* Botón principal */}
      <button onClick={handleSubmit} disabled={loading || palabras < 10} style={{
        width: '100%', padding: '16px', fontSize: 16, fontWeight: 'bold',
        backgroundColor: loading ? '#90caf9' : palabras < 10 ? '#ccc' : '#1565C0',
        color: 'white', border: 'none', borderRadius: 8,
        cursor: loading || palabras < 10 ? 'default' : 'pointer',
        transition: 'background-color 0.2s',
      }}>
        {loading ? `⏳ ${PASOS_LOADING[pasoActual]}` : '🚀 Generar Acta y Tareas'}
      </button>

      {/* Loading detallado */}
      {loading && (
        <div style={{ marginTop: 16, padding: 16, backgroundColor: '#e3f2fd', borderRadius: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 'bold', marginBottom: 12, color: '#1565C0' }}>
            Procesando tu reunión...
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {PASOS_LOADING.map((paso, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{
                  width: 18, height: 18, borderRadius: '50%', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 'bold',
                  backgroundColor: i < pasoActual ? '#4CAF50' : i === pasoActual ? '#1565C0' : '#e0e0e0',
                  color: i <= pasoActual ? 'white' : '#999',
                  flexShrink: 0,
                }}>
                  {i < pasoActual ? '✓' : i + 1}
                </span>
                <span style={{ color: i === pasoActual ? '#1565C0' : i < pasoActual ? '#4CAF50' : '#999', fontWeight: i === pasoActual ? 'bold' : 'normal' }}>
                  {paso}
                </span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: '#666' }}>
            Serás redirigido automáticamente al acta cuando esté lista.
          </div>
        </div>
      )}
    </div>
  );
}
