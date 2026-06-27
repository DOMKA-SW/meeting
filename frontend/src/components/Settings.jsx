// =============================================================================
// Settings.jsx — Configuracion de empresa (solo superadmin)
// Permite al superadmin definir el contexto de rol del LLM para personalizar
// el tono y enfoque de las actas generadas automaticamente.
// =============================================================================
import { useState, useEffect } from 'react';
import { apiFetch } from '../utils/api';

const EJEMPLOS = [
  { label: 'Corporativo (default)', value: '' },
  { label: 'Analisis financiero', value: 'Actua como un experto en analisis financiero y contabilidad empresarial. Usa terminologia financiera precisa.' },
  { label: 'Tecnologia / Software', value: 'Actua como un lider tecnico experto en desarrollo de software y gestion de proyectos agiles. Usa terminologia tecnica apropiada.' },
  { label: 'Comercial / Ventas', value: 'Actua como un experto en estrategia comercial y desarrollo de negocios. Enfoca el acta en compromisos comerciales y seguimiento de oportunidades.' },
  { label: 'Legal / Cumplimiento', value: 'Actua como un experto en asuntos legales y cumplimiento normativo. Usa un lenguaje preciso y formal, destacando compromisos y responsabilidades.' },
  { label: 'Operaciones / Logistica', value: 'Actua como un experto en operaciones y logistica. Enfoca el acta en procesos, eficiencia y metricas operativas.' },
];

export default function Settings() {
  const [promptContext, setPromptContext] = useState('');
  const [saved, setSaved]               = useState(false);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);

  useEffect(() => {
    apiFetch('/admin/settings')
      .then(r => r.ok && r.json())
      .then(d => { if (d) setPromptContext(d.prompt_context || ''); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true); setSaved(false);
    const r = await apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify({ prompt_context: promptContext }) });
    if (r.ok) setSaved(true);
    setSaving(false);
    setTimeout(() => setSaved(false), 3000);
  };

  if (loading) return <div style={{ padding: 40 }}>Cargando...</div>;

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 4 }}>Configuracion del sistema</h1>
      <p style={{ color: '#666', fontSize: 14, marginBottom: 28 }}>
        Solo visible para superadmin. Los cambios aplican a todas las actas generadas por esta empresa.
      </p>

      {/* Contexto del LLM */}
      <div style={{ backgroundColor: 'white', border: '1px solid #e2e8f0', borderRadius: 10, padding: 24, marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 16, color: '#1e3a5f' }}>Contexto del redactor de actas</h2>
        <p style={{ fontSize: 13, color: '#666', margin: '0 0 16px', lineHeight: 1.6 }}>
          Define el rol o especialidad del asistente de IA. Se inyecta al inicio del prompt antes de generar cada acta.
          Deja en blanco para usar el redactor corporativo general.
        </p>

        {/* Selector de ejemplos */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>
            Ejemplos predefinidos
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {EJEMPLOS.map(e => (
              <button key={e.label} onClick={() => setPromptContext(e.value)}
                style={{ padding: '5px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: '1px solid',
                  backgroundColor: promptContext === e.value ? '#1565C0' : '#f8fafc',
                  color: promptContext === e.value ? 'white' : '#475569',
                  borderColor: promptContext === e.value ? '#1565C0' : '#e2e8f0',
                  fontWeight: promptContext === e.value ? 600 : 400 }}>
                {e.label}
              </button>
            ))}
          </div>
        </div>

        {/* Editor */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#555', display: 'block', marginBottom: 6 }}>
            Contexto personalizado ({promptContext.length}/500 caracteres)
          </label>
          <textarea
            value={promptContext}
            onChange={e => setPromptContext(e.target.value.slice(0, 500))}
            placeholder="Ej: Actua como un experto en analisis de mercado latinoamericano con enfoque en consumo masivo..."
            rows={4}
            style={{ width: '100%', padding: '10px 12px', border: '1px solid #dde1e7', borderRadius: 6,
              fontSize: 13, resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6, fontFamily: 'inherit' }}
          />
          <p style={{ fontSize: 11, color: '#999', margin: '4px 0 0' }}>
            Solo define el rol y el tono. Las instrucciones de formato, tareas y resumen son fijas y no se modifican.
          </p>
        </div>

        {/* Preview */}
        {promptContext && (
          <div style={{ marginTop: 14, padding: '10px 14px', backgroundColor: '#F0F9FF', borderRadius: 6, border: '1px solid #BAE6FD', fontSize: 12 }}>
            <strong style={{ color: '#0369a1' }}>Vista previa del prompt:</strong>
            <p style={{ margin: '4px 0 0', color: '#0c4a6e', fontStyle: 'italic' }}>"{promptContext}"</p>
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '10px 24px', backgroundColor: saving ? '#94a3b8' : '#1565C0', color: 'white',
              border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: saving ? 'default' : 'pointer' }}>
            {saving ? 'Guardando...' : 'Guardar configuracion'}
          </button>
          {saved && <span style={{ fontSize: 13, color: '#16a34a', fontWeight: 600 }}>Guardado correctamente</span>}
        </div>
      </div>
    </div>
  );
}
