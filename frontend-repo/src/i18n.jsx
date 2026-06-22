import { createContext, useContext, useState, useCallback } from "react";

/**
 * Sistema de idiomas (i18n) — liviano, sin librerías externas.
 *
 * CÓMO FUNCIONA (en criollo):
 *  - `translations` es el "diccionario": cada texto tiene su versión en
 *    español (es) y en inglés (en).
 *  - `es` es el set COMPLETO y de referencia (lo que ya existía).
 *  - `en` se va completando de a poco. Si falta una clave en el idioma actual,
 *    la función `t()` cae a español → la app NUNCA se rompe ni muestra una clave
 *    cruda durante el rollout. (regla: "sin romper nada").
 *  - El idioma elegido se guarda en localStorage para recordarlo la próxima vez.
 *  - Arranca en INGLÉS por defecto (requisito de monday para aprobar la app).
 */

export const translations = {
  es: {
    // ── Sidebar / navegación ──
    "sidebar.config": "Configuración",
    "sidebar.connected": "Backend conectado",
    "sidebar.noContext": "Sin contexto Monday",
    "menu.datos": "Datos Fiscales",
    "menu.certificados": "Certificados ARCA",
    "menu.mapping": "Mapeo Visual",
    "status.complete": "Listo",
    "status.pending": "En progreso",
    "status.incomplete": "Pendiente",
    // ── General ──
    "common.edit": "Editar",
    "header.stepsComplete": "pasos completos",
    // ── Datos Fiscales (encabezado) ──
    "fiscal.title": "Datos Fiscales",
    "fiscal.subSaved": "Esto es lo que AFIP va a ver en tus comprobantes.",
    "fiscal.subSetup":
      "Completá la información de tu empresa para la facturación electrónica.",
  },
  en: {
    // ── Sidebar / navigation ──
    "sidebar.config": "Setup",
    "sidebar.connected": "Backend connected",
    "sidebar.noContext": "No monday context",
    "menu.datos": "Tax Details",
    "menu.certificados": "ARCA Certificates",
    "menu.mapping": "Visual Mapping",
    "status.complete": "Done",
    "status.pending": "In progress",
    "status.incomplete": "Pending",
    // ── General ──
    "common.edit": "Edit",
    "header.stepsComplete": "steps complete",
    // ── Tax Details (header) ──
    "fiscal.title": "Tax Details",
    "fiscal.subSaved": "This is what AFIP will see on your invoices.",
    "fiscal.subSetup":
      "Complete your company information for electronic invoicing.",
  },
};

const STORAGE_KEY = "arca_lang";
const DEFAULT_LANG = "en"; // monday exige inglés por defecto

const LangContext = createContext({
  lang: DEFAULT_LANG,
  setLang: () => {},
  t: (key) => key,
});

function readInitialLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "es" || saved === "en") return saved;
  } catch {
    /* iframe sin acceso a localStorage → usamos el default */
  }
  return DEFAULT_LANG;
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(readInitialLang);

  const setLang = useCallback((next) => {
    if (next !== "es" && next !== "en") return;
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* sin localStorage: igual cambia en memoria para esta sesión */
    }
  }, []);

  // t(key): devuelve el texto en el idioma actual; si no existe, cae a español;
  // si tampoco existe en español, devuelve la clave (señal visible para el dev).
  const t = useCallback(
    (key) =>
      translations[lang]?.[key] ?? translations.es?.[key] ?? key,
    [lang]
  );

  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LangContext.Provider>
  );
}

export function useT() {
  return useContext(LangContext);
}

// Selector de idioma (EN / ES). Pill chiquito, marca la opción activa.
export function LanguageSwitcher() {
  const { lang, setLang } = useT();
  return (
    <div className="lang-switcher" role="group" aria-label="Idioma / Language">
      <button
        type="button"
        className={`lang-opt ${lang === "en" ? "active" : ""}`}
        onClick={() => setLang("en")}
        aria-pressed={lang === "en"}
      >
        EN
      </button>
      <button
        type="button"
        className={`lang-opt ${lang === "es" ? "active" : ""}`}
        onClick={() => setLang("es")}
        aria-pressed={lang === "es"}
      >
        ES
      </button>
    </div>
  );
}