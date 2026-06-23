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
    // ── Datos Fiscales (formulario) ──
    "fiscal.razonSocial": "Razón Social",
    "fiscal.razonSocialPh": "Ej: Mi Empresa S.A.",
    "fiscal.nombreFantasia": "Nombre de Fantasía",
    "fiscal.nombreFantasiaPh": "Ej: Kiosco El Sol",
    "fiscal.nombreFantasiaHint":
      "Es el nombre comercial que aparece en negrita arriba del PDF. Si no tenés, poné tu razón social.",
    "fiscal.cuit": "CUIT",
    "fiscal.puntoVenta": "Punto de Venta",
    "fiscal.fechaInicio": "Fecha de Inicio de Actividades",
    "fiscal.domicilio": "Domicilio Comercial",
    "fiscal.domicilioPh": "Av. Corrientes 1234, CABA",
    "fiscal.contactTitle": "Datos de contacto y marca",
    "fiscal.contactSub":
      "Estos datos son opcionales. Más adelante los vamos a usar para personalizar el PDF de tus facturas con la información de tu empresa.",
    "fiscal.phone": "Teléfono",
    "fiscal.email": "Email",
    "fiscal.emailPh": "contacto@miempresa.com",
    "fiscal.website": "Sitio web",
    "fiscal.websitePh": "https://miempresa.com",
    "fiscal.logo": "Logo de la empresa",
    "fiscal.logoNone": "Sin logo",
    "fiscal.logoChange": "Cambiar imagen",
    "fiscal.logoUpload": "Subir imagen",
    "fiscal.logoRemove": "Quitar",
    "fiscal.logoHint": "PNG, JPG, SVG o WebP. Hasta 1 MB.",
    // ── Datos Fiscales (vista solo-lectura + botones) ──
    "fiscal.identityTitle": "Identidad fiscal",
    "fiscal.startDateShort": "Inicio de actividades",
    "fiscal.brandContact": "Marca & contacto · opcional",
    "fiscal.printedOnPdf": "Se imprime en el PDF",
    "fiscal.noContactYet":
      "Aún no configuraste datos de contacto ni logo. Apretá Editar para agregarlos.",
    "fiscal.saving": "Guardando...",
    "fiscal.saveInitial": "Guardar Datos Fiscales",
    "fiscal.saveChanges": "Guardar cambios",
    "fiscal.loadingSaved": "Cargando datos guardados...",
    "common.optional": "opcional",
    "common.required": "Obligatorio",
    "common.cancel": "Cancelar",
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
    // ── Tax Details (form) ──
    "fiscal.razonSocial": "Legal Name",
    "fiscal.razonSocialPh": "e.g. Acme Inc.",
    "fiscal.nombreFantasia": "Trade Name",
    "fiscal.nombreFantasiaPh": "e.g. Sunny Store",
    "fiscal.nombreFantasiaHint":
      "It's the commercial name shown in bold at the top of the PDF. If you don't have one, use your legal name.",
    "fiscal.cuit": "Tax ID (CUIT)",
    "fiscal.puntoVenta": "Point of Sale",
    "fiscal.fechaInicio": "Business Start Date",
    "fiscal.domicilio": "Business Address",
    "fiscal.domicilioPh": "e.g. 123 Main St, City",
    "fiscal.contactTitle": "Contact & branding",
    "fiscal.contactSub":
      "These details are optional. We'll use them later to personalize your invoice PDF with your company information.",
    "fiscal.phone": "Phone",
    "fiscal.email": "Email",
    "fiscal.emailPh": "contact@mycompany.com",
    "fiscal.website": "Website",
    "fiscal.websitePh": "https://mycompany.com",
    "fiscal.logo": "Company logo",
    "fiscal.logoNone": "No logo",
    "fiscal.logoChange": "Change image",
    "fiscal.logoUpload": "Upload image",
    "fiscal.logoRemove": "Remove",
    "fiscal.logoHint": "PNG, JPG, SVG or WebP. Up to 1 MB.",
    // ── Tax Details (read-only view + buttons) ──
    "fiscal.identityTitle": "Tax identity",
    "fiscal.startDateShort": "Start date",
    "fiscal.brandContact": "Brand & contact · optional",
    "fiscal.printedOnPdf": "Printed on the PDF",
    "fiscal.noContactYet":
      "You haven't set up contact details or a logo yet. Click Edit to add them.",
    "fiscal.saving": "Saving...",
    "fiscal.saveInitial": "Save Tax Details",
    "fiscal.saveChanges": "Save changes",
    "fiscal.loadingSaved": "Loading saved data...",
    "common.optional": "optional",
    "common.required": "Required",
    "common.cancel": "Cancel",
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