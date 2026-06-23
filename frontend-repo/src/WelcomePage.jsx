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
//   - Las screenshots se cargan via vite import (bundleadas con el JS).

import { useState } from "react";
import step1 from "./assets/onboarding/step-1-datos.png";
import step2 from "./assets/onboarding/step-2-certificados.png";
import step3 from "./assets/onboarding/step-3-mapeo.png";
import { useT } from "./i18n.jsx";

const STEPS = [
  { n: 1, titleKey: "fiscal.title", descKey: "welcome.step1Desc", img: step1 },
  { n: 2, titleKey: "cert.title", descKey: "welcome.step2Desc", img: step2 },
  { n: 3, titleKey: "menu.mapping", descKey: "welcome.step3Desc", img: step3 },
];

export default function WelcomePage({ onStart }) {
  const { t } = useT();
  const [zoomImg, setZoomImg] = useState(null);

  return (
    <div className="welcome-frame">
      <div className="welcome-card">
        <div className="welcome-hero">
          <h1 className="welcome-title">{t("welcome.title")}</h1>
          <p className="welcome-subtitle">{t("welcome.subtitle")}</p>
        </div>

        <div className="welcome-steps">
          {STEPS.map((s) => (
            <div key={s.n} className="welcome-step">
              <div className="welcome-step-header">
                <div className="welcome-step-num">{s.n}</div>
                <div>
                  <div className="welcome-step-title">{t(s.titleKey)}</div>
                  <div className="welcome-step-desc">{t(s.descKey)}</div>
                </div>
              </div>
              <button
                type="button"
                className="welcome-step-img-wrap"
                onClick={() => setZoomImg(s)}
                aria-label={`${t("welcome.zoomAria")} ${s.n}: ${t(s.titleKey)}`}
              >
                <img
                  src={s.img}
                  alt={`${t("welcome.stepWord")} ${s.n}: ${t(s.titleKey)}`}
                  className="welcome-step-img"
                />
                <span className="welcome-step-img-hint">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    <line x1="11" y1="8" x2="11" y2="14" />
                    <line x1="8" y1="11" x2="14" y2="11" />
                  </svg>
                  {t("welcome.clickToZoom")}
                </span>
              </button>
            </div>
          ))}
        </div>

        <div className="welcome-footer">
          <p className="welcome-footer-text">{t("welcome.footer")}</p>
          <div className="welcome-actions">
            <button
              type="button"
              className="welcome-btn-primary"
              onClick={onStart}
            >
              {t("welcome.startBtn")}
            </button>
          </div>
        </div>
      </div>

      {zoomImg && (
        <div
          className="welcome-lightbox"
          onClick={() => setZoomImg(null)}
          role="dialog"
          aria-label={t("welcome.lightboxAria")}
        >
          <button
            type="button"
            className="welcome-lightbox-close"
            onClick={() => setZoomImg(null)}
            aria-label={t("common.close")}
          >
            ✕
          </button>
          <div className="welcome-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <div className="welcome-lightbox-caption">
              {t("welcome.stepWord")} {zoomImg.n}: {t(zoomImg.titleKey)}
            </div>
            <img src={zoomImg.img} alt={t(zoomImg.titleKey)} className="welcome-lightbox-img" />
          </div>
        </div>
      )}
    </div>
  );
}
