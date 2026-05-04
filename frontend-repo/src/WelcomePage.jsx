// Welcome page que se muestra antes de la app principal para users nuevos.
// Requerido por monday review (UI/UX checklist):
//   "Include a welcome page that displays before the app's main page for
//    board views and widgets. It should include a welcome message,
//    first-time-use instructions with screenshots..."
//
// Logica:
//   - Aparece solo si NO hay setup completo
//   - El user puede skipearla con "Ya configuré, no mostrar" (localStorage)
//   - Una vez skipeada, no vuelve a aparecer en esa cuenta

import step1 from "./assets/onboarding/step-1-datos.png";
import step2 from "./assets/onboarding/step-2-certificados.png";
import step3 from "./assets/onboarding/step-3-mapeo.png";

const STEPS = [
  {
    n: 1,
    title: "Datos Fiscales",
    desc: "Cargá la información de tu empresa: CUIT, razón social, condición fiscal y punto de venta. Es lo que ARCA va a ver en cada comprobante que emitas.",
    img: step1,
  },
  {
    n: 2,
    title: "Certificados ARCA",
    desc: "Subí tus certificados digitales (.crt y .key). Los guardamos cifrados con AES-256 y solo se usan para firmar requests a ARCA en tu nombre.",
    img: step2,
  },
  {
    n: 3,
    title: "Mapeo Visual",
    desc: "Asociá las columnas de tu board (cliente, monto, fecha) con los campos de la factura. Después, cada cambio de estado dispara la emisión automática.",
    img: step3,
  },
];

export default function WelcomePage({ onStart, onDismiss }) {
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
              <div className="welcome-step-img-wrap">
                <img
                  src={s.img}
                  alt={`Paso ${s.n}: ${s.title}`}
                  className="welcome-step-img"
                />
              </div>
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
            <button
              type="button"
              className="welcome-btn-secondary"
              onClick={onDismiss}
            >
              Ya configuré, no mostrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
