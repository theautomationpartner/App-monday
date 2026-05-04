// Welcome page que se muestra antes de la app principal para users nuevos.
// Requerido por monday review (UI/UX checklist):
//   "Include a welcome page that displays before the app's main page for
//    board views and widgets. It should include a welcome message,
//    first-time-use instructions with screenshots..."
//
// Logica:
//   - Aparece solo si NO hay setup completo Y no fue dismissada
//   - Click "Empezar configuración" → guarda dismissed en localStorage
//   - Click en una imagen → la abre en lightbox a pantalla completa

import { useState } from "react";
import step1 from "./assets/onboarding/step-1-datos.png";
import step2 from "./assets/onboarding/step-2-certificados.png";
import step3 from "./assets/onboarding/step-3-mapeo.png";

const STEPS = [
  {
    n: 1,
    title: "Datos Fiscales",
    desc: "Cargá los datos de tu empresa (CUIT, razón social, punto de venta). Es la información que va a aparecer en cada factura que emitas.",
    img: step1,
  },
  {
    n: 2,
    title: "Certificados ARCA",
    desc: "Conectá tu certificado digital de ARCA. Si ya tenés uno, lo subís. Si no, te guiamos paso a paso para generarlo sin salir de la app.",
    img: step2,
  },
  {
    n: 3,
    title: "Mapeo Visual",
    desc: "Decile a la app qué columna del board representa el cliente, qué columna el monto, etc. Es como armar la plantilla de la factura una sola vez.",
    img: step3,
  },
];

export default function WelcomePage({ onStart }) {
  const [zoomImg, setZoomImg] = useState(null);

  return (
    <div className="welcome-frame">
      <div className="welcome-card">
        <div className="welcome-hero">
          <h1 className="welcome-title">¡Bienvenido a Factura ARCA!</h1>
          <p className="welcome-subtitle">
            Vas a poder facturar electrónicamente desde tus boards de monday en
            3 pasos. Configurá una vez y olvidate de la carga manual en la web
            de AFIP.
          </p>
        </div>

        <div className="welcome-steps">
          {STEPS.map((s) => (
            <div key={s.n} className="welcome-step">
              <div className="welcome-step-header">
                <div className="welcome-step-num">{s.n}</div>
                <div>
                  <div className="welcome-step-title">{s.title}</div>
                  <div className="welcome-step-desc">{s.desc}</div>
                </div>
              </div>
              <button
                type="button"
                className="welcome-step-img-wrap"
                onClick={() => setZoomImg(s)}
                aria-label={`Ampliar captura del paso ${s.n}: ${s.title}`}
              >
                <img
                  src={s.img}
                  alt={`Paso ${s.n}: ${s.title}`}
                  className="welcome-step-img"
                />
                <span className="welcome-step-img-hint">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    <line x1="11" y1="8" x2="11" y2="14" />
                    <line x1="8" y1="11" x2="14" y2="11" />
                  </svg>
                  Click para ampliar
                </span>
              </button>
            </div>
          ))}
        </div>

        <div className="welcome-footer">
          <p className="welcome-footer-text">
            Después, cada cambio de estado en el board dispara una factura AFIP
            automática con CAE, número y PDF adjunto al item.
          </p>
          <div className="welcome-actions">
            <button
              type="button"
              className="welcome-btn-primary"
              onClick={onStart}
            >
              Empezar configuración
            </button>
          </div>
        </div>
      </div>

      {zoomImg && (
        <div
          className="welcome-lightbox"
          onClick={() => setZoomImg(null)}
          role="dialog"
          aria-label="Imagen ampliada"
        >
          <button
            type="button"
            className="welcome-lightbox-close"
            onClick={() => setZoomImg(null)}
            aria-label="Cerrar"
          >
            ✕
          </button>
          <div className="welcome-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <div className="welcome-lightbox-caption">
              Paso {zoomImg.n}: {zoomImg.title}
            </div>
            <img src={zoomImg.img} alt={zoomImg.title} className="welcome-lightbox-img" />
          </div>
        </div>
      )}
    </div>
  );
}
