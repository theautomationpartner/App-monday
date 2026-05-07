/* global __APP_BUILD_VERSION__ */
import React, { useState, useEffect, useRef } from "react";
import mondaySdk from "monday-sdk-js";
import axios from "axios";
import "monday-ui-react-core/tokens";
import "monday-ui-react-core/dist/main.css";
import "./App.css";
import WelcomePage from "./WelcomePage";

const monday = mondaySdk();

// Inyectado por vite.config.js en cada build: YYYY-MM-DD-HHmm-<sha>.
const APP_BUILD_VERSION = typeof __APP_BUILD_VERSION__ !== "undefined" ? __APP_BUILD_VERSION__ : "dev";

// Whitelist de Monday account IDs que ven la barra de debug (Build + estado backend).
// Se configura en frontend-repo/.env con VITE_DEBUG_ACCOUNT_IDS=123,456 (separados por coma).
// Si un customer instala la app, como su account no está en la lista, no ve la franja.
const DEBUG_ACCOUNT_IDS = (import.meta.env.VITE_DEBUG_ACCOUNT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// URL del tutorial/video paso a paso para sacar el certificado en ARCA.
// Por defecto apunta a una búsqueda de YouTube (legal y útil para el usuario
// mientras TAP no publique su propio video). Cuando tengas el video propio,
// reemplazá esta constante por tu URL de YouTube/Loom/etc.
const CERT_TUTORIAL_URL = "https://www.youtube.com/results?search_query=certificado+digital+ARCA+AFIP+paso+a+paso";

// URL de la página de "Cómo usar la app" — visible desde el header.
// Reemplazá por la URL definitiva cuando esté lista la página de docs en
// theautomationpartner.com/arca/como-usar (ver checklist Documentation §6).
const HOW_TO_USE_URL = "https://theautomationpartner.com/arca/como-usar";

// URL del backend. En monday code el frontend y backend comparten dominio,
// así que usamos una ruta relativa "/api" que siempre resuelve a la versión actual.
const configuredApiUrl = (import.meta.env.VITE_BACKEND_URL || "/api").trim();
const API_URL = configuredApiUrl.replace(/\/$/, "");

// Instancia axios que inyecta un sessionToken FRESCO en cada request.
// El sessionToken de monday expira a los ~30 segundos, así que cachearlo causa
// errores "sessionToken inválido o vencido" en el backend. Pidiendo uno nuevo
// antes de cada llamada garantizamos que siempre esté vigente.
const api = axios.create({ baseURL: API_URL });
api.interceptors.request.use(async (config) => {
    try {
        const res = await monday.get("sessionToken");
        const token = res?.data;
        if (token) {
            config.headers = config.headers || {};
            config.headers.Authorization = `Bearer ${token}`;
        }
    } catch (err) {
        console.warn("No se pudo obtener sessionToken fresco:", err);
    }
    return config;
});

/* ─── Iconos SVG inline ─── */
const IconCert = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
);
const IconBuilding = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01"/></svg>
);
const IconList = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
);
const IconFile = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3v5h5"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
);
const IconUpload = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#0073ea" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
);
const IconCheck = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00ca72" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
);

const MENU_ITEMS = [
  { id: "datos", label: "Datos Fiscales", icon: <IconBuilding /> },
  { id: "certificados", label: "Certificados ARCA", icon: <IconCert /> },
  { id: "mapping_v2", label: "Mapeo Visual", icon: <IconList /> },
];



const COMPROBANTE_STATUS_FLOW = {
  trigger: "Crear Comprobante",
  processing: "Creando Comprobante",
  success: "Comprobante Creado",
  error: "Error - Mirar Comentarios",
};

// IDs fijos de columnas de la plantilla del workspace.
// Cuando un usuario instala la app y usa la plantilla, estos IDs son siempre iguales.
const TEMPLATE_MAPPING = {
  // Item-level
  fecha_emision:        "date",
  receptor_cuit:        "numeric_mm0yadnb",
  condicion_venta:      "dropdown_mm2ged22",
  fecha_servicio_desde: "date_mm2gyjvw",
  fecha_servicio_hasta: "date_mm2g8n2n",
  fecha_vto_pago:       "date_mm2gp00f",
  // Subitem-level
  concepto:             "name",
  cantidad:             "numeric_mm1srkr2",
  precio_unitario:      "numeric_mm1swnhz",
  prod_serv:            "dropdown_mm2fyez4",
  unidad_medida:        "dropdown_mm2gk2mv",
  alicuota_iva:         "dropdown_mm2g198w",
};
// Column IDs de la plantilla que no son de mapeo visual pero sí de config
const TEMPLATE_STATUS_COLUMN_ID = "status";
// ID de la columna File donde se sube el PDF emitido. Cuando un cliente clona
// la plantilla, monday preserva este ID, así que el match exacto funciona.
const TEMPLATE_PDF_COLUMN_ID = "file_mm1tg5w5";
// Detector de la columna de Estado (trigger de la receta). El board puede
// tener varias columnas tipo status/dropdown (Condición de Venta, etc.) y
// si solo agarramos la primera podemos caer en la equivocada.
const STATUS_COL_TYPES = ["status", "color", "dropdown"];
const STATUS_COL_NAME_REGEX = /estado.*comprobante|comprobante|^estado$/i;

// Busca la columna de "Estado Comprobante" priorizando match exacto:
//   1. ID hardcoded "status".
//   2. Nombre que matchee /estado.*comprobante|comprobante|^estado$/i + tipo status/color/dropdown.
//   3. Fallback estricto: primera columna tipo `status` o `color` (NO dropdown,
//      porque hay muchas dropdowns que no son de status).
// Formatea una fecha YYYY-MM-DD (o ISO con tiempo) como DD/MM/YYYY sin pasar
// por new Date() — evita el shift por timezone (en Argentina UTC-3, midnight UTC
// del 2025-01-01 se interpreta como 21:00 del 2024-12-31).
function formatDateAR(dateStr) {
  if (!dateStr) return "";
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function findStatusColumn(cols) {
  if (!Array.isArray(cols) || cols.length === 0) return null;
  const byId = cols.find((c) => c.value === TEMPLATE_STATUS_COLUMN_ID);
  if (byId) return byId;
  const byName = cols.find((c) =>
    STATUS_COL_TYPES.includes(c.type) && STATUS_COL_NAME_REGEX.test(c.label || "")
  );
  if (byName) return byName;
  return cols.find((c) => c.type === "status" || c.type === "color") || null;
}
// Todos los IDs de item para detectar si es tablero de plantilla
const TEMPLATE_BOARD_COLUMN_IDS = ["date", "numeric_mm0yadnb", "dropdown_mm2ged22", "date_mm2gyjvw", "date_mm2g8n2n", "date_mm2gp00f"];
const TEMPLATE_SUBITEM_COLUMN_IDS = ["numeric_mm1srkr2", "numeric_mm1swnhz", "dropdown_mm2fyez4", "dropdown_mm2gk2mv", "dropdown_mm2g198w"];

// Detectores por nombre + tipo, fallback robusto cuando los IDs cambian
// (porque monday genera IDs nuevos al clonar el tablero desde la plantilla
// en otra cuenta). Si todos los detectores encuentran una columna, podemos
// armar el mapeo con los IDs reales del cliente sin depender de hardcodes.
const TEMPLATE_COLUMN_DETECTORS_ITEM = {
  fecha_emision:        { type: "date",     nameRegex: /fecha.*emisi[oó]n|emisi[oó]n/i },
  receptor_cuit:        { type: "numbers",  nameRegex: /cuit/i },
  condicion_venta:      { type: "dropdown", nameRegex: /condici[oó]n.*venta|venta/i },
  fecha_servicio_desde: { type: "date",     nameRegex: /servic.*desde|desde.*servic/i },
  fecha_servicio_hasta: { type: "date",     nameRegex: /servic.*hasta|hasta.*servic/i },
  fecha_vto_pago:       { type: "date",     nameRegex: /vto|venc/i },
};
const TEMPLATE_COLUMN_DETECTORS_SUBITEM = {
  cantidad:        { type: "numbers",  nameRegex: /cantidad/i },
  precio_unitario: { type: "numbers",  nameRegex: /precio|unitario/i },
  prod_serv:       { type: "dropdown", nameRegex: /producto|servic/i },
  unidad_medida:   { type: "dropdown", nameRegex: /unidad|medida/i },
  alicuota_iva:    { type: "dropdown", nameRegex: /al[ií]cuota|iva/i },
};

// Busca la primera columna que matchee tipo + regex de nombre.
function findColumnByDetector(cols, detector) {
  return cols.find((c) => c.type === detector.type && detector.nameRegex.test(c.label || ""));
}

// Intenta armar un mapping completo a partir de las columnas reales del board
// del cliente, matcheando por nombre + tipo. Devuelve null si falta alguna.
function buildAutoMappingFromColumns(itemCols, subitemCols) {
  const result = { concepto: "name" };
  for (const [key, detector] of Object.entries(TEMPLATE_COLUMN_DETECTORS_ITEM)) {
    const col = findColumnByDetector(itemCols, detector);
    if (!col) {
      console.log(`[auto-mapeo-byname] no se encontró columna para "${key}" (type=${detector.type})`);
      return null;
    }
    result[key] = col.value;
  }
  for (const [key, detector] of Object.entries(TEMPLATE_COLUMN_DETECTORS_SUBITEM)) {
    const col = findColumnByDetector(subitemCols, detector);
    if (!col) {
      console.log(`[auto-mapeo-byname] no se encontró columna subitem para "${key}" (type=${detector.type})`);
      return null;
    }
    result[key] = col.value;
  }
  return result;
}

const App = () => {
  const [context, setContext] = useState(null);
  const [locationData, setLocationData] = useState(null);
  const [activeSection, setActiveSection] = useState("datos");
  const [toast, setToast] = useState(null);

  // Guard del auto-mapeo: para no postear varias veces a la DB cuando el
  // useEffect se re-ejecuta (cosa que pasa cada vez que cambia una dependencia).
  // Lo usamos como un flag de "ya fui posteado en esta sesión".
  const autoMappingPostedRef = useRef(false);

  const showToast = (type, message, opts = {}) => {
    setToast({ type, message });
    // Errores se quedan 7s para que dé tiempo a leer la sugerencia.
    const ms = opts.durationMs ?? (type === "error" ? 7000 : 3500);
    setTimeout(() => setToast(null), ms);
  };

  // Valida los datos fiscales antes de enviarlos al backend. Devuelve
  // { msg, hint } del primer error encontrado o null si está todo OK.
  // Cada error explica QUÉ está mal y CÓMO arreglarlo.
  const validateFiscal = (f) => {
    const cuitDigits = String(f.cuit || "").replace(/\D/g, "");
    if (!f.razonSocial?.trim()) {
      return { msg: "Falta la razón social", hint: "Cargá la razón social registrada en AFIP (la que figura en tu constancia)." };
    }
    if (!f.nombreFantasia?.trim()) {
      return { msg: "Falta el nombre de fantasía", hint: "Es el nombre comercial que aparece en negrita arriba del PDF. Si no tenés, poné lo mismo que la razón social." };
    }
    if (cuitDigits.length !== 11) {
      return { msg: "CUIT inválido", hint: "El CUIT debe tener 11 dígitos. Sin guiones ni puntos. Ejemplo: 20327446348." };
    }
    if (!f.puntoVenta || parseInt(f.puntoVenta) < 1) {
      return { msg: "Falta el punto de venta", hint: "Ingresá el número de punto de venta habilitado en AFIP/ARCA. Es un número (ej: 1, 2, 5)." };
    }
    if (!f.fechaInicio) {
      return { msg: "Falta la fecha de inicio de actividades", hint: "La fecha que figura en tu constancia de inscripción de AFIP." };
    }
    if (!f.domicilio?.trim()) {
      return { msg: "Falta el domicilio comercial", hint: "El domicilio fiscal registrado en AFIP. Aparece en el PDF de la factura." };
    }
    if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) {
      return { msg: "Email con formato inválido", hint: "Revisá que tenga el formato correcto, ej: ventas@empresa.com.ar" };
    }
    return null;
  };

  // Traduce errores del backend (con código y mensaje) a algo amigable
  // con sugerencia de solución concreta.
  const friendlyApiError = (err) => {
    const code = err?.response?.data?.code;
    const backendMsg = err?.response?.data?.error;
    const status = err?.response?.status;
    const map = {
      MISSING_TRADE_NAME:   { msg: "Falta el nombre de fantasía",     hint: "Cargálo arriba del CUIT. Puede ser igual a la razón social si no tenés uno comercial." },
      MISSING_FISCAL_DATA:  { msg: "Faltan datos fiscales",            hint: "Cargá razón social, CUIT y punto de venta antes de continuar." },
      INVALID_EMAIL:        { msg: "Email con formato inválido",       hint: "Tiene que tener un @ y un dominio válido (ej: ventas@empresa.com)." },
      INVALID_WEBSITE:      { msg: "Sitio web con formato inválido",   hint: "Empezá con http:// o https:// (ej: https://empresa.com)." },
      INVALID_LOGO_MIME:    { msg: "Formato de logo no soportado",     hint: "Usá PNG, JPG, SVG o WebP. Otros formatos no se aceptan." },
      LOGO_TOO_LARGE:       { msg: "El logo es muy grande",            hint: "Reducilo a menos de 500 KB (podés comprimirlo en tinypng.com)." },
      KEY_CRT_MISMATCH:     { msg: "El .crt y el .key no son pareja",  hint: "Bajaste el cert correspondiente a otra solicitud. Volvé a generar el CSR y descargá el .crt nuevo de ARCA." },
      CRT_EXPIRED:          { msg: "El certificado venció",            hint: "Generá uno nuevo en ARCA con el mismo alias y volvé a subirlo." },
      NO_PENDING_CSR:       { msg: "No hay una solicitud pendiente",   hint: "Generá primero el CSR desde el paso 1 antes de subir el .crt." },
    };
    if (code && map[code]) return map[code];
    if (status === 401)    return { msg: "Tu sesión expiró",        hint: "Cerrá la pestaña de monday y volvé a abrir la app." };
    if (status === 403)    return { msg: "No tenés permisos",       hint: "Pedíle al admin de monday que te de permisos sobre este tablero." };
    if (status === 404)    return { msg: "No se encontró la empresa", hint: "Cargá primero los Datos Fiscales antes de hacer esta acción." };
    if (status === 413)    return { msg: "El archivo es muy grande", hint: "Subí uno más liviano." };
    if (backendMsg)        return { msg: backendMsg,                  hint: "Si persiste, contactá soporte." };
    return { msg: err?.message || "Error desconocido", hint: "Intentá de nuevo en unos segundos. Si sigue fallando, contactá soporte." };
  };

  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingSavedData, setIsFetchingSavedData] = useState(false);
  // Gate del primer render: arranca en false y se marca true cuando el primer fetch
  // de /setup termina (success o fail), o tras un safety timeout si el context de
  // monday nunca llega. Mientras esté false, mostramos un splash en vez de la UI con
  // datos vacíos — evita el flash de "no tenés nada configurado" al abrir la vista.
  const [isInitialDataReady, setIsInitialDataReady] = useState(false);
  // Welcome page override: se setea a true cuando el user toca "Empezar" o
  // "Ya configuré, no mostrar" — permite saltar el welcome dentro de la sesion
  // sin tener que volver a chequear localStorage.
  const [showWelcomeOverride, setShowWelcomeOverride] = useState(false);
  const [apiStatus, setApiStatus] = useState("checking");
  const [apiError, setApiError] = useState("");
  // Usage del plan: { plan_id, is_trial, status, limit, used, remaining, allowed }
  // Se carga al montar la app y al cambiar de cuenta. El banner del header lo
  // muestra. Si la fetch falla (ej: backend viejo sin /api/usage), queda null
  // y el banner no se renderiza — degrada gracefully.
  const [usage, setUsage] = useState(null);
  const [sessionToken, setSessionToken] = useState("");
  // Datos Fiscales usa modo vista/edición (Stripe-style). El resto de las
  // secciones todavía usa el patrón viejo de lock — se migran en próximas etapas.
  const [isFiscalEditMode, setIsFiscalEditMode] = useState(false);
  const [savedFiscalSnapshot, setSavedFiscalSnapshot] = useState(null);
  // Certificados ya usa un patrón state-based (certificateStatus + certFlow);
  // no necesita un flag de lock separado.
  // Mapeo Visual: mismo patrón vista/edición que Datos Fiscales y Certificados.
  const [isMappingEditMode, setIsMappingEditMode] = useState(false);
  const [hasSavedMapping, setHasSavedMapping] = useState(false);
  const [savedMappingSnapshot, setSavedMappingSnapshot] = useState(null);

  // Certificados (flujo manual legacy)
  const [crtFile, setCrtFile] = useState(null);
  const [keyFile, setKeyFile] = useState(null);
  const [hasSavedCertificates, setHasSavedCertificates] = useState(false);
  const [certificateExpirationDate, setCertificateExpirationDate] = useState("");

  // Certificados — estado del flujo completo
  // certificateStatus: 'no_cert' | 'pending_crt' | 'active' (viene del backend)
  // certFlow: null | 'guided' | 'manual' (elección del usuario en la sesión)
  const [certificateStatus, setCertificateStatus] = useState("no_cert");
  const [certificateAlias, setCertificateAlias] = useState("");
  const [certificateUpdatedAt, setCertificateUpdatedAt] = useState("");
  const [certFlow, setCertFlow] = useState(null);
  const [guidedStep, setGuidedStep] = useState(1);
  const [aliasInput, setAliasInput] = useState("monday-facturacion");
  const [serviceAdhered, setServiceAdhered] = useState(false);
  const [finalCrtFile, setFinalCrtFile] = useState(null);
  const [lastGeneratedCsrPem, setLastGeneratedCsrPem] = useState("");
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Datos fiscales
  const [fiscal, setFiscal] = useState({
    puntoVenta: "",
    cuit: "",
    fechaInicio: "",
    razonSocial: "",
    nombreFantasia: "",
    domicilio: "",
    telefono: "",
    email: "",
    sitioWeb: "",
  });
  const [hasSavedFiscalData, setHasSavedFiscalData] = useState(false);

  // Logo (opcional, multipart): archivo nuevo a subir + preview de lo guardado.
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState(null);     // dataURL del archivo recién seleccionado
  const [savedLogoDataUrl, setSavedLogoDataUrl] = useState(null); // dataURL devuelto por el backend
  const [removeLogoOnSave, setRemoveLogoOnSave] = useState(false);
  const [logoNaturalSize, setLogoNaturalSize] = useState(null);   // {width, height} del archivo, para warning

  // Mapeo
  const [columns, setColumns] = useState([]);
  const [subitemColumns, setSubitemColumns] = useState([]);
  // workspace_id del board actual — el monday SDK lo expone vía GraphQL `boards { workspace { id } }`.
  // Se usa para multi-tenant: cada (account, workspace) tiene su propia company/fiscal/cert.
  const [workspaceId, setWorkspaceId] = useState(null);
  // Flag para evitar race condition: el fetch de /api/setup espera a que la
  // detección del workspace termine (sea exitosa o no). Sin esto, /setup se
  // dispara con workspace_id=null y el backend cae al fallback legacy → flash
  // de datos de OTRA company antes de que workspaceId se resuelva.
  const [workspaceCheckDone, setWorkspaceCheckDone] = useState(false);
  const [mapping, setMapping] = useState({});
  const [missingMappingFields, setMissingMappingFields] = useState([]);
  const [columnsLoadError, setColumnsLoadError] = useState(null);
  const [boardConfig, setBoardConfig] = useState({
    status_column_id: "",
    invoice_pdf_column_id: "", // columna tipo "file" donde se adjunta el PDF emitido
    trigger_label: COMPROBANTE_STATUS_FLOW.trigger,
    processing_label: COMPROBANTE_STATUS_FLOW.processing,
    success_label: COMPROBANTE_STATUS_FLOW.success,
    error_label: COMPROBANTE_STATUS_FLOW.error,
    // Toggles opcionales (default TRUE para que clientes nuevos tengan el
    // comportamiento "todo automatico" out of the box).
    auto_rename_item: true,    // ej: "Cliente Juan" -> "Factura B N° 0002-00000019"
    auto_update_status: true,  // ej: Procesando -> Comprobante Creado / Error
  });
  // Todos los campos del mapeo son obligatorios — se tienen que mapear sí o sí
  // para que el comprobante pueda emitirse correctamente.
  const requiredMappingFields = [
    "fecha_emision",
    "receptor_cuit",
    "condicion_venta",
    "fecha_servicio_desde",
    "fecha_servicio_hasta",
    "fecha_vto_pago",
    "concepto",
    "cantidad",
    "precio_unitario",
    "prod_serv",
    "unidad_medida",
    "alicuota_iva",
  ];
  // Campos opcionales — el cliente puede mapearlos pero no son obligatorios
  // para guardar el mapeo ni para emitir.
  //   - moneda:              columna donde el cliente escribe "Pesos"/"Dolares" por item.
  //                          Si no la mapea, todas las facturas se emiten en pesos (default).
  //   - cotizacion:          columna numerica con el tipo de cambio. Si esta vacia
  //                          al emitir, la app consulta AFIP y escribe el valor en
  //                          esa misma columna como registro. Si tiene valor, se usa.
  //   - precio_unitario_usd: columna numerica con el precio del subitem en USD.
  //                          Solo aplicable cuando el item tiene moneda=Dolares.
  //
  // Regla "los 3 van juntos": si mapean Moneda, deben mapear tambien Cotizacion
  // y Precio Unitario en USD. La validacion de Zod en el backend hace cumplir
  // esto al guardar; aca lo reflejamos visualmente.
  const optionalMappingFields = ["moneda", "cotizacion", "precio_unitario_usd"];
  // Campos obligatorios de operación (columnas del tablero, no del mapeo de datos):
  //   - status_column_id: columna Status — solo si auto_update_status=true
  //   - invoice_pdf_column_id: columna File donde se sube el PDF generado (siempre)
  const statusColumnRequired = Boolean(boardConfig.auto_update_status);
  const operationCompleted =
    Boolean(boardConfig.invoice_pdf_column_id) &&
    (!statusColumnRequired || Boolean(boardConfig.status_column_id));
  const mappingCompleted = requiredMappingFields.every((field) => Boolean(mapping[field])) && operationCompleted;
  const operationMappedCount =
    (statusColumnRequired ? (Boolean(boardConfig.status_column_id) ? 1 : 0) : 0) +
    (Boolean(boardConfig.invoice_pdf_column_id) ? 1 : 0);
  const mappedRequiredCount =
    requiredMappingFields.filter((field) => Boolean(mapping[field])).length + operationMappedCount;
  const totalRequiredCount = requiredMappingFields.length + (statusColumnRequired ? 2 : 1); // +2: status + pdf | +1: solo pdf
  const mappedOptionalCount = 0;

  const normalizeText = (value) =>
    (value || "")
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

  const statusColumns = columns.filter((column) =>
    ["status", "color", "dropdown"].includes(column.type)
  );
  // Columnas tipo "file" / "archivo" — para subir el PDF de la factura emitida
  const fileColumns = columns.filter((column) =>
    ["file", "files", "document", "doc"].includes(column.type)
  );
  // Columnas numericas del board principal (item) — usadas para mapear el
  // "tipo de cambio" (cotizacion).
  const numericColumns = columns.filter((column) =>
    ["numbers", "numeric", "number"].includes(column.type)
  );
  // Columnas numericas del subitem — usadas para mapear "precio unitario en
  // USD" (separado del precio en pesos obligatorio del subitem).
  const subitemNumericColumns = subitemColumns.filter((column) =>
    ["numbers", "numeric", "number"].includes(column.type)
  );

  useEffect(() => {
    monday
      .get("sessionToken")
      .then((res) => setSessionToken(res?.data || ""))
      .catch((err) => {
        console.error("No se pudo obtener sessionToken de monday:", err);
        setSessionToken("");
      });

    monday.get("context").then((res) => {
      console.log("Contexto inicial:", res.data);
      // Solo en desarrollo: imprime el Account ID en consola para que el dev
      // pueda agregarlo a VITE_DEBUG_ACCOUNT_IDS y ver la franja de debug.
      // En producción NO se loguea para no exponer información del cliente.
      if (import.meta.env.DEV && res.data?.account?.id) {
        console.log("%c👤 Monday account ID:", "color:#F0CA29;font-weight:bold", res.data.account.id, "— agregalo a VITE_DEBUG_ACCOUNT_IDS en .env para ver la franja de debug");
      }
      setContext(res.data);
    });

    monday.get("location").then((res) => {
      setLocationData(res.data);
    });

    const unsubscribeContext = monday.listen("context", (res) => {
      console.log("Contexto recibido:", res.data);
      setContext(res.data);
    });

    const unsubscribeLocation = monday.listen("location", (res) => {
      setLocationData(res.data);
    });

    return () => {
      unsubscribeContext?.();
      unsubscribeLocation?.();
    };
  }, []);

  // Cargar consumo / plan del mes actual. Se hace al cargar la app y cuando
  // cambia el sessionToken (ej: re-auth). El banner del header lo usa para
  // mostrar "X/limite facturas este mes" + estados visuales.
  useEffect(() => {
    if (!sessionToken) return;
    let cancelled = false;
    api.get('/usage')
      .then((res) => {
        if (!cancelled) setUsage(res.data);
      })
      .catch((err) => {
        // Si /usage no existe (backend viejo) o falla, dejamos usage = null y
        // el banner no se renderiza. No es bloqueante.
        console.warn('[usage] no se pudo obtener:', err?.response?.status || err.message);
      });
    return () => { cancelled = true; };
  }, [sessionToken]);

  // Notifica a monday cuando el usuario completa el setup de la app
  // (datos fiscales + certificados + mapeo). Se dispara una vez por sesión.
  // Requerido por el review (Product checklist): "implementa el método de
  // evento de valor creado en tu código".
  const valueCreatedFiredRef = useRef(false);
  useEffect(() => {
    if (
      hasSavedFiscalData &&
      hasSavedCertificates &&
      hasSavedMapping &&
      !valueCreatedFiredRef.current
    ) {
      valueCreatedFiredRef.current = true;
      try {
        monday.execute("valueCreatedForUser");
        console.log("[monday] valueCreatedForUser disparado");
      } catch (err) {
        console.warn("[monday] no se pudo disparar valueCreatedForUser:", err);
      }
    }
  }, [hasSavedFiscalData, hasSavedCertificates, hasSavedMapping]);

  useEffect(() => {
    const checkApi = async () => {
      try {
        await axios.get(`${API_URL}/health`, { timeout: 8000 }); // health no necesita auth
        setApiStatus("ok");
        setApiError("");
      } catch (err) {
        setApiStatus("error");
        setApiError(err?.message || "No se pudo conectar al backend");
      }
    };

    checkApi();
  }, []);

  const boardId = context?.boardId || context?.locationContext?.boardId || null;
  const appFeatureId = context?.appFeatureId || null;
  const viewIdFromHref = locationData?.href?.match(/\/views\/(\d+)/)?.[1] || null;

  // Fetch columns when context is ready
  useEffect(() => {
    const resolvedBoardId =
      context?.boardId ||
      context?.locationContext?.boardId ||
      null;

    if (!resolvedBoardId) return;

    setColumnsLoadError(null);

    // Probamos múltiples estrategias en orden hasta que una funcione.
    // Primero con workspace { id name } (multi-tenant). Si todas fallan
    // por scope/permission (la app puede no tener workspaces:read), repetimos
    // sin workspace para que la app siga funcionando en modo legacy.
    const boardIdStr = String(resolvedBoardId);
    const buildStrategies = (withWorkspace) => {
      const wsField = withWorkspace ? "workspace { id name } " : "";
      return [
        {
          name: `variables-ID!${withWorkspace ? "+ws" : ""}`,
          query: `query ($boardIds: [ID!]) { boards(ids: $boardIds) { ${wsField}columns { id title type settings_str } } }`,
          options: { variables: { boardIds: [boardIdStr] } },
        },
        {
          name: `variables-Int!${withWorkspace ? "+ws" : ""}`,
          query: `query ($boardIds: [Int!]) { boards(ids: $boardIds) { ${wsField}columns { id title type settings_str } } }`,
          options: { variables: { boardIds: [Number(boardIdStr)] } },
        },
        {
          name: `inline-number${withWorkspace ? "+ws" : ""}`,
          query: `query { boards(ids: [${Number(boardIdStr)}]) { ${wsField}columns { id title type settings_str } } }`,
          options: undefined,
        },
        {
          name: `inline-string${withWorkspace ? "+ws" : ""}`,
          query: `query { boards(ids: ["${boardIdStr}"]) { ${wsField}columns { id title type settings_str } } }`,
          options: undefined,
        },
      ];
    };
    const strategies = [...buildStrategies(true), ...buildStrategies(false)];

    const tryStrategies = async () => {
      const attempts = [];
      for (const s of strategies) {
        try {
          console.log(`[mapeo] Probando estrategia: ${s.name}`);
          const res = s.options ? await monday.api(s.query, s.options) : await monday.api(s.query);
          const errs = res?.errors || res?.error_message || res?.data?.errors;
          const boardColumns = res?.data?.boards?.[0]?.columns;
          if (!errs && Array.isArray(boardColumns) && boardColumns.length) {
            console.log(`[mapeo] ✔ Estrategia exitosa: ${s.name}`);
            return { ok: true, res, strategy: s.name };
          }
          const errText = errs
            ? (Array.isArray(errs) ? errs.map((e) => e.message || JSON.stringify(e)).join(" | ") : String(errs))
            : "respuesta vacía";
          attempts.push(`${s.name}: ${errText}`);
          console.warn(`[mapeo] ✘ ${s.name}:`, errText, res);
        } catch (err) {
          const detail =
            err?.errors?.map?.((e) => e.message).join(" | ") ||
            err?.data?.errors?.map?.((e) => e.message).join(" | ") ||
            err?.message ||
            JSON.stringify(err);
          attempts.push(`${s.name}: ${detail}`);
          console.error(`[mapeo] ✘ ${s.name} threw:`, err);
        }
      }
      return { ok: false, attempts };
    };

    tryStrategies()
      .then(async (result) => {
        if (!result.ok) {
          setColumnsLoadError("Todas las estrategias fallaron:\n" + result.attempts.join("\n"));
          // Aún en falla: marcamos workspace check como done para no bloquear
          // /setup indefinidamente — caerá al modo legacy.
          setWorkspaceCheckDone(true);
          return;
        }
        const res = result.res;
        const boardData = res.data?.boards?.[0] || {};
        const boardColumns = boardData.columns || [];
        const wsId = boardData.workspace?.id ? String(boardData.workspace.id) : null;
        if (wsId) {
          console.log(`[mapeo] workspace detectado: ${boardData.workspace?.name || ""} (id=${wsId})`);
          setWorkspaceId(wsId);
        } else {
          console.warn("[mapeo] el board no devolvió workspace.id — multi-tenant degradará a legacy (NULL)");
        }
        // Marcamos done para destrabar /setup ahora que tenemos la info.
        setWorkspaceCheckDone(true);
        console.log("[mapeo] Columnas cargadas:", boardColumns.length, boardColumns.map(c => c.title));

        if (!boardColumns.length) {
          setColumnsLoadError("La query respondió sin columnas. Verificá que el board esté accesible.");
          return;
        }

        const cols = boardColumns
          .filter((c) => c.type !== "subtasks" && c.type !== "button" && c.type !== "formula")
          .map((c) => ({ value: c.id, label: c.title, type: c.type }));
        setColumns(cols);

        // Cargar columnas de subitems
        const subitemsColumn = boardColumns.find((c) => c.type === "subtasks");
        if (!subitemsColumn?.settings_str) {
          setSubitemColumns([]);
          return;
        }

        let subitemsBoardId = null;
        try {
          const settings = JSON.parse(subitemsColumn.settings_str);
          subitemsBoardId =
            settings?.boardIds?.[0] ||
            settings?.boardId ||
            settings?.board_ids?.[0] ||
            null;
        } catch (err) {
          console.error("[mapeo] No se pudo parsear settings_str de subitems:", err);
        }

        if (!subitemsBoardId) {
          setSubitemColumns([]);
          return;
        }

        try {
          const subitemsRes = await monday.api(
            `query { boards(ids: [${Number(subitemsBoardId)}]) { columns { id title type } } }`
          );
          if (subitemsRes?.errors?.length) {
            console.error("[mapeo] GraphQL errors subitems:", subitemsRes.errors);
          }
          const subCols =
            subitemsRes.data?.boards?.[0]?.columns
              ?.filter((c) => c.type !== "button" && c.type !== "formula")
              .map((c) => ({
                value: c.id,
                label: c.id === "name" ? "Nombre/Concepto del subitem" : c.title,
                type: c.type,
              })) || [];
          console.log("[mapeo] Columnas subitems:", subCols.length, subCols.map(c => c.label));
          setSubitemColumns(subCols);
        } catch (err) {
          console.error("[mapeo] No se pudieron cargar columnas de subitems:", err);
          setSubitemColumns([]);
        }
      })
      .catch((err) => {
        console.error("[mapeo] Error cargando columnas del tablero:", err);
        setColumnsLoadError(err?.message || String(err));
        setWorkspaceCheckDone(true);
      });
  }, [context]);

  // Safety: si por algún motivo la detección del workspace nunca termina
  // (problema de red, monday API caída, etc.), no queremos bloquear /setup
  // para siempre. A los 5s lo destrabamos y caemos al modo legacy.
  useEffect(() => {
    if (workspaceCheckDone) return;
    if (!context?.account?.id) return;
    const t = setTimeout(() => {
      setWorkspaceCheckDone((prev) => {
        if (!prev) console.warn("[mapeo] safety timeout: destrabando /setup sin workspace_id");
        return true;
      });
    }, 5000);
    return () => clearTimeout(t);
  }, [context, workspaceCheckDone]);

  useEffect(() => {
    const fetchSavedSetup = async () => {
      if (!context?.account?.id) return;
      // Esperar a que la detección del workspace termine antes de pegarle a
      // /setup. Sin esto, el primer fetch va con workspace_id=null y el
      // backend cae al fallback legacy → flash de datos de OTRA company.
      if (!workspaceCheckDone) return;

      setIsFetchingSavedData(true);

      try {
        const response = await api.get(`/setup/${context.account.id}`, {
          params: {
            board_id: boardId,
            view_id: viewIdFromHref,
            app_feature_id: appFeatureId,
            workspace_id: workspaceId || undefined,
          }
        });
        const data = response.data;

        if (data?.hasFiscalData && data?.fiscalData) {
          const hydratedFiscal = {
            puntoVenta: data.fiscalData.default_point_of_sale?.toString() || "",
            cuit: data.fiscalData.cuit || "",
            // Tomar solo la parte YYYY-MM-DD del string que devuelve el backend
            // (puede venir como "2025-01-01" o "2025-01-01T00:00:00.000Z").
            // No pasar por new Date() porque shift de timezone arruina la fecha.
            fechaInicio: data.fiscalData.fecha_inicio
              ? String(data.fiscalData.fecha_inicio).slice(0, 10)
              : "",
            razonSocial: data.fiscalData.business_name || "",
            nombreFantasia: data.fiscalData.nombre_fantasia || data.fiscalData.business_name || "",
            domicilio: data.fiscalData.domicilio || "",
            telefono: data.fiscalData.phone || "",
            email: data.fiscalData.email || "",
            sitioWeb: data.fiscalData.website || "",
          };
          setFiscal(hydratedFiscal);
          setSavedFiscalSnapshot(hydratedFiscal);
          setSavedLogoDataUrl(data.fiscalData.logo_data_url || null);
          setLogoFile(null);
          setLogoPreviewUrl(null);
          setRemoveLogoOnSave(false);
          setHasSavedFiscalData(true);
          setIsFiscalEditMode(false);
        }

        const certStatus = data?.certificateStatus || 'no_cert';
        setCertificateStatus(certStatus);
        setCertificateAlias(data?.certificates?.alias || "");
        setCertificateUpdatedAt(data?.certificates?.updated_at || "");

        if (data?.hasCertificates) {
          setHasSavedCertificates(true);
          setCertificateExpirationDate(
            data?.certificates?.expiration_date
              ? new Date(data.certificates.expiration_date).toLocaleDateString("es-AR")
              : ""
          );
        } else {
          setHasSavedCertificates(false);
          setCertificateExpirationDate("");
        }

        if (data?.visualMapping?.mapping && typeof data.visualMapping.mapping === "object") {
          const hydratedMapping = data.visualMapping.mapping;
          setMapping(hydratedMapping);
          setSavedMappingSnapshot(hydratedMapping);
          setHasSavedMapping(Object.keys(hydratedMapping).length > 0);
          setIsMappingEditMode(false);
        } else {
          setMapping({});
          setSavedMappingSnapshot(null);
          setHasSavedMapping(false);
          setIsMappingEditMode(false);
        }

        if (data?.boardConfig && typeof data.boardConfig === "object") {
          // Extraer el invoice_pdf_column_id del required_columns_json (lo guarda el backend como array)
          const requiredCols = Array.isArray(data.boardConfig.required_columns) ? data.boardConfig.required_columns : [];
          const invoicePdfCol = requiredCols.find((c) => c?.key === "invoice_pdf");
          // Defaults TRUE para clientes existentes: si el backend no devuelve
          // los flags (cliente legacy sin migrar), arrancamos con true para
          // que la app siga "haciendolo todo" como hasta ahora.
          setBoardConfig({
            status_column_id: data.boardConfig.status_column_id || "",
            invoice_pdf_column_id: invoicePdfCol?.resolved_column_id || "",
            trigger_label: COMPROBANTE_STATUS_FLOW.trigger,
            processing_label: COMPROBANTE_STATUS_FLOW.processing,
            success_label: COMPROBANTE_STATUS_FLOW.success,
            error_label: COMPROBANTE_STATUS_FLOW.error,
            auto_rename_item: data.boardConfig.auto_rename_item !== false,
            auto_update_status: data.boardConfig.auto_update_status !== false,
          });
        }

      } catch (err) {
        console.error("No se pudieron recuperar datos guardados:", err);
        setApiStatus("error");
        setApiError(err?.response?.data?.error || err?.message || "Error consultando setup");
      } finally {
        setIsFetchingSavedData(false);
        setIsInitialDataReady(true);
      }
    };

    fetchSavedSetup();
  }, [context, boardId, viewIdFromHref, appFeatureId, sessionToken, workspaceId, workspaceCheckDone]);

  // Safety net: si el context de monday tarda demasiado o nunca llega, igual
  // mostramos la UI después de 10s para no dejar al usuario en splash infinito.
  useEffect(() => {
    if (isInitialDataReady) return;
    const safety = setTimeout(() => setIsInitialDataReady(true), 10000);
    return () => clearTimeout(safety);
  }, [isInitialDataReady]);

  // Auto-mapeo por plantilla: si no hay mapeo guardado y las columnas coinciden
  // con los IDs fijos de la plantilla, guardar el mapeo automáticamente en la DB.
  useEffect(() => {
    if (isFetchingSavedData) return;
    if (columns.length === 0) return;
    if (!context?.account?.id || !boardId) return;

    // Si los subitems aún no cargaron, esperar (los necesitamos para el match completo)
    if (subitemColumns.length === 0) return;

    // ── Detección de plantilla ────────────────────────────────────────────────
    // Estrategia en 2 pasos:
    //   1. Match por IDs hardcoded (rápido, funciona en boards no clonados).
    //   2. Match por nombre + tipo (fallback robusto cuando se clona el board
    //      desde la feature "Plantilla de espacio de trabajo" — monday genera
    //      IDs nuevos al clonar, entonces los hardcodes no sirven).
    let detectedMapping = null;
    let detectedStatusColumnId = TEMPLATE_STATUS_COLUMN_ID;
    let detectionMethod = null;

    const columnIds = columns.map((c) => c.value);
    const subitemIds = subitemColumns.map((c) => c.value);
    const isTemplateBoardMatch = TEMPLATE_BOARD_COLUMN_IDS.every((id) => columnIds.includes(id));
    const isTemplateSubitemMatch = TEMPLATE_SUBITEM_COLUMN_IDS.every((id) => subitemIds.includes(id));

    if (isTemplateBoardMatch && isTemplateSubitemMatch) {
      // 1. Match exacto por IDs hardcoded
      detectedMapping = TEMPLATE_MAPPING;
      detectionMethod = "by-ids";
    } else {
      // 2. Match por nombre + tipo (resuelve el caso de board clonado en otra cuenta)
      const byName = buildAutoMappingFromColumns(columns, subitemColumns);
      if (byName) {
        detectedMapping = byName;
        detectionMethod = "by-name";
      }
    }
    // Detectar la columna de status real (priorizando "Estado Comprobante"
    // por nombre, no la primera dropdown que aparezca — antes agarraba
    // "Condición de Venta" cuando esa estaba antes en la lista).
    const statusColForConfig = findStatusColumn(columns);
    if (statusColForConfig) detectedStatusColumnId = statusColForConfig.value;

    if (!detectedMapping) {
      console.log("[auto-mapeo] no se detectó plantilla (ni por IDs ni por nombre) — el cliente debe mapear manualmente");
      return;
    }

    // Detectar la columna File donde se va a subir el PDF de la factura emitida.
    // Estrategia:
    //   1. Match exacto por ID hardcoded (la plantilla preserva ese ID al clonarla).
    //   2. Si no, primera columna tipo file/files/document/doc (fallback robusto
    //      por si el cliente personalizó el board).
    const fileColById = columns.find((c) => c.value === TEMPLATE_PDF_COLUMN_ID);
    const fileColByType = columns.find((c) => ["file", "files", "document", "doc"].includes(c.type));
    const fileCol = fileColById || fileColByType;
    const detectedRequiredColumns = fileCol
      ? [{ key: "invoice_pdf", resolved_column_id: fileCol.value }]
      : [];

    console.log(`[auto-mapeo] tablero de plantilla detectado (${detectionMethod}).`);
    if (fileCol) console.log(`[auto-mapeo] columna PDF detectada: ${fileCol.label} (id=${fileCol.value}, type=${fileCol.type})`);
    else console.log("[auto-mapeo] no se detectó columna File para PDF — el cliente la va a tener que mapear manualmente");

    // PASO 1: pre-llenar state local SIEMPRE (independiente de Datos Fiscales).
    // Esto hace que el frontend muestre "14/14 Listo" desde el primer momento,
    // aunque el cliente todavía no haya cargado Datos Fiscales y la fila en DB
    // no exista. Cuando el cliente complete los datos, el POST a DB se hace en
    // el bloque de abajo (que sí depende de hasSavedFiscalData).
    // Nota: setMapping con un objeto nuevo causa re-render. Para evitar loops,
    // sólo seteamos si todavía no hay nada en el state local.
    const hasAnyMapping = Object.values(mapping).some(v => Boolean(v));
    if (!hasAnyMapping) {
      setMapping(detectedMapping);
      setSavedMappingSnapshot(detectedMapping);
      setHasSavedMapping(true);
      setIsMappingEditMode(false);
      setBoardConfig((prev) => ({
        ...prev,
        status_column_id: detectedStatusColumnId,
        invoice_pdf_column_id: fileCol ? fileCol.value : prev.invoice_pdf_column_id,
      }));
    }

    // PASO 2: si todavía no hay Datos Fiscales, no podemos postear a DB
    // (el endpoint POST /api/mappings tira 404 sin company). Salimos y dejamos
    // que el useEffect se vuelva a ejecutar cuando hasSavedFiscalData cambie.
    if (!hasSavedFiscalData) {
      console.log("[auto-mapeo] Datos Fiscales todavía no cargados — state local seteado, POST diferido");
      return;
    }

    // Evitar postear múltiples veces (el useEffect se vuelve a ejecutar por
    // cualquier cambio de dependencias). Usamos un ref como guard.
    if (autoMappingPostedRef.current) return;
    autoMappingPostedRef.current = true;

    console.log("[auto-mapeo] Datos Fiscales cargados — guardando mapeo en DB...");

    // Guardar en la DB automáticamente
    const autoSaveMapping = async () => {
      try {
        await api.post(`/mappings`, {
          monday_account_id: context.account.id.toString(),
          workspace_id: workspaceId || null,
          board_id: boardId,
          view_id: viewIdFromHref,
          app_feature_id: appFeatureId,
          mapping: detectedMapping,
          is_locked: true,
        });
        console.log("[auto-mapeo] Mapeo de plantilla guardado en DB exitosamente");

        // También guardar el board config con la columna de status + PDF detectadas
        await api.post(`/board-config`, {
          monday_account_id: context.account.id.toString(),
          workspace_id: workspaceId || null,
          board_id: boardId,
          view_id: viewIdFromHref,
          app_feature_id: appFeatureId,
          status_column_id: detectedStatusColumnId,
          trigger_label: COMPROBANTE_STATUS_FLOW.trigger,
          success_label: COMPROBANTE_STATUS_FLOW.success,
          error_label: COMPROBANTE_STATUS_FLOW.error,
          required_columns: detectedRequiredColumns,
        });
        setBoardConfig((prev) => ({
          ...prev,
          status_column_id: detectedStatusColumnId,
          invoice_pdf_column_id: fileCol ? fileCol.value : prev.invoice_pdf_column_id,
        }));
        console.log("[auto-mapeo] Board config de plantilla guardado en DB exitosamente");

        monday.execute("notice", {
          message: "Mapeo automático configurado para la plantilla de facturación",
          type: "success",
          duration: 4000,
        });
      } catch (err) {
        console.error("[auto-mapeo] Error guardando mapeo automático:", err);
      }
    };
    autoSaveMapping();
  }, [columns, subitemColumns, isFetchingSavedData, context, boardId, hasSavedFiscalData]);

  useEffect(() => {
    if (boardConfig.status_column_id || columns.length === 0) return;

    // Buscar primero por nombre/ID exacto. Si no hay match, fallback a la
    // primera de tipo "status" o "color" (NO dropdown — había muchas
    // dropdowns que no eran de estado y el código viejo las agarraba).
    const statusCol = findStatusColumn(columns);
    if (!statusCol) return;

    setBoardConfig((prev) => ({
      ...prev,
      status_column_id: statusCol.value,
    }));
  }, [boardConfig.status_column_id, columns]);

  // Auto-detect: si el tablero tiene una sola columna file, la usamos como PDF por default.
  useEffect(() => {
    if (boardConfig.invoice_pdf_column_id || fileColumns.length === 0) return;

    setBoardConfig((prev) => ({
      ...prev,
      invoice_pdf_column_id: fileColumns[0].value,
    }));
  }, [boardConfig.invoice_pdf_column_id, fileColumns]);

  // Al salir de una sección con datos guardados, salimos del modo edición
  // (descartando cambios pendientes — equivale a un "Cancelar" implícito).
  useEffect(() => {
    if (activeSection !== "datos" && hasSavedFiscalData && isFiscalEditMode) {
      if (savedFiscalSnapshot) setFiscal(savedFiscalSnapshot);
      setLogoFile(null);
      setLogoPreviewUrl(null);
      setRemoveLogoOnSave(false);
      setIsFiscalEditMode(false);
    }
    if (activeSection !== "mapping_v2" && hasSavedMapping && isMappingEditMode) {
      if (savedMappingSnapshot) setMapping(savedMappingSnapshot);
      setIsMappingEditMode(false);
    }
  }, [activeSection, hasSavedFiscalData, isFiscalEditMode, savedFiscalSnapshot, hasSavedMapping, isMappingEditMode, savedMappingSnapshot]);

  const handleFiscalChange = (field, value) => {
    setFiscal((prev) => ({ ...prev, [field]: value }));
  };

  const handleFileChange = (e, type) => {
    const file = e.target.files[0];
    if (!file) return;
    if (type === "crt") setCrtFile(file);
    if (type === "key") setKeyFile(file);
  };

  // Detecta dimensiones del logo activo (recién subido o guardado) para el warning.
  useEffect(() => {
    const url = logoPreviewUrl || (!removeLogoOnSave ? savedLogoDataUrl : null);
    if (!url) {
      setLogoNaturalSize(null);
      return;
    }
    const img = new Image();
    img.onload = () => setLogoNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => setLogoNaturalSize(null);
    img.src = url;
  }, [logoPreviewUrl, savedLogoDataUrl, removeLogoOnSave]);

  const handleLogoSelected = (file) => {
    if (!file) {
      setLogoFile(null);
      setLogoPreviewUrl(null);
      return;
    }
    const allowed = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"];
    if (!allowed.includes(file.type)) {
      showToast("error", "Formato de imagen no permitido. Usá PNG, JPG, SVG o WebP.");
      return;
    }
    const MAX_BYTES = 1024 * 1024;
    if (file.size > MAX_BYTES) {
      showToast("error", "El logo supera el tamaño máximo (1 MB).");
      return;
    }
    setLogoFile(file);
    setRemoveLogoOnSave(false);
    const reader = new FileReader();
    reader.onload = (e) => setLogoPreviewUrl(e.target?.result || null);
    reader.readAsDataURL(file);
  };

  const handleRemoveLogo = () => {
    setLogoFile(null);
    setLogoPreviewUrl(null);
    if (savedLogoDataUrl) setRemoveLogoOnSave(true);
  };

  // Entrar a modo edición: snapshot del estado actual para poder revertir.
  const handleEnterFiscalEdit = () => {
    setSavedFiscalSnapshot(fiscal);
    setIsFiscalEditMode(true);
  };

  // Cancelar edición: revierte fiscal y descarta cambios pendientes del logo.
  const handleCancelFiscalEdit = () => {
    if (savedFiscalSnapshot) setFiscal(savedFiscalSnapshot);
    setLogoFile(null);
    setLogoPreviewUrl(null);
    setRemoveLogoOnSave(false);
    setIsFiscalEditMode(false);
  };

  const handleSaveFiscal = async () => {
    console.log("🚀 Iniciando guardado de datos fiscales...");
    console.log("📦 Contexto actual:", context);
    if (!context || !context.account) return;

    // Validación previa: chequea campos obligatorios y formatos antes de
    // golpear al backend. Da feedback inmediato con explicación + solución.
    const v = validateFiscal(fiscal);
    if (v) {
      showToast("error", `${v.msg} — ${v.hint}`);
      return;
    }

    setIsLoading(true);
    try {
      const accountId = context.account.id.toString();
      const payload = {
        monday_account_id: accountId,
        workspace_id: workspaceId || null,
        board_id: boardId,
        view_id: viewIdFromHref,
        app_feature_id: appFeatureId,
        business_name: fiscal.razonSocial,
        nombre_fantasia: fiscal.nombreFantasia,
        cuit: fiscal.cuit,
        default_point_of_sale: parseInt(fiscal.puntoVenta) || 0,
        domicilio: fiscal.domicilio,
        fecha_inicio: fiscal.fechaInicio,
        phone: fiscal.telefono,
        email: fiscal.email,
        website: fiscal.sitioWeb,
      };

      await api.post(`/companies`, payload);

      // Logo: subimos solo si hay archivo nuevo o pidieron borrarlo.
      if (logoFile) {
        const fd = new FormData();
        fd.append("logo", logoFile);
        fd.append("monday_account_id", accountId);
        if (workspaceId) fd.append("workspace_id", workspaceId);
        const logoRes = await api.post(`/companies/logo`, fd, {
          headers: { "Content-Type": "multipart/form-data" }
        });
        setSavedLogoDataUrl(logoRes.data?.logo_data_url || null);
        setLogoFile(null);
        setLogoPreviewUrl(null);
      } else if (removeLogoOnSave) {
        await api.delete(`/companies/logo/${accountId}`, {
          params: { workspace_id: workspaceId || undefined }
        });
        setSavedLogoDataUrl(null);
        setRemoveLogoOnSave(false);
      }

      showToast("success", "Datos fiscales guardados correctamente");
      setHasSavedFiscalData(true);
      setSavedFiscalSnapshot(fiscal);
      setIsFiscalEditMode(false);
      setApiStatus("ok");
    } catch (err) {
      const { msg, hint } = friendlyApiError(err);
      showToast("error", `${msg} — ${hint}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUploadCertificates = async () => {
    if (!crtFile || !keyFile || !context) {
        showToast("error", "Seleccioná ambos archivos (.crt y .key)");
        return;
    }

    setIsLoading(true);
    const formData = new FormData();
    formData.append("crt", crtFile);
    formData.append("key", keyFile);
    formData.append("monday_account_id", context.account.id.toString());
    if (workspaceId) formData.append("workspace_id", workspaceId);
    formData.append("board_id", boardId || "");
    formData.append("view_id", viewIdFromHref || "");
    formData.append("app_feature_id", appFeatureId || "");

    try {
      const res = await api.post(`/certificates`, formData, {
        headers: { "Content-Type": "multipart/form-data" }
      });
      showToast("success", "Certificados subidos correctamente");
      setHasSavedCertificates(true);
      setCertificateStatus("active");
      setCertFlow(null);
      setCrtFile(null);
      setKeyFile(null);
      // El upload manual no tiene alias — limpiamos cualquier alias previo
      // que haya quedado de un CSR generado antes (por ejemplo, si abandonaste
      // el flujo guiado a mitad y subiste archivos propios).
      setCertificateAlias("");
      setLastGeneratedCsrPem("");
      // La fecha de vencimiento la lee el backend del .crt con node-forge
      // y nos la devuelve en ISO. La transformamos al formato local.
      setCertificateExpirationDate(
        res?.data?.expirationDate
          ? new Date(res.data.expirationDate).toLocaleDateString("es-AR")
          : ""
      );
      setApiStatus("ok");
    } catch (err) {
      const { msg, hint } = friendlyApiError(err);
      showToast("error", `${msg} — ${hint}`);
      setApiStatus("error");
      setApiError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  // ─── Helpers para disparar descarga de archivo en el navegador ──────────────
  const downloadBlob = (content, filename, mime = "application/x-pem-file") => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Genera CSR + key en el backend. La key queda guardada cifrada. Devuelve el
  // CSR como archivo descargable para que el usuario lo suba a ARCA.
  const handleGenerateCsr = async () => {
    if (!context) return;
    const aliasFinal = (aliasInput || "monday-facturacion").trim();
    setIsLoading(true);
    try {
      const res = await api.post(`/certificates/csr/generate`, {
        monday_account_id: context.account.id.toString(),
        workspace_id: workspaceId || null,
        alias: aliasFinal
      });
      const csrPem = res.data?.csrPem || "";
      const aliasUsed = res.data?.alias || aliasFinal;
      if (!csrPem) throw new Error("El servidor no devolvió el CSR");

      setLastGeneratedCsrPem(csrPem);
      setCertificateAlias(aliasUsed);
      setCertificateStatus("pending_crt");
      downloadBlob(csrPem, `${aliasUsed}.csr`);
      showToast("success", "Solicitud generada y descargada");
      setGuidedStep(3);
    } catch (err) {
      const { msg, hint } = friendlyApiError(err);
      showToast("error", `${msg} — ${hint}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Re-descarga el CSR ya guardado (para el caso en que el usuario cerró la
  // ventana y volvió más tarde sin tener el archivo).
  const handleRedownloadCsr = async () => {
    if (!context) return;
    if (lastGeneratedCsrPem) {
      const aliasSafe = (certificateAlias || "monday-facturacion").replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadBlob(lastGeneratedCsrPem, `${aliasSafe}.csr`);
      return;
    }
    try {
      setIsLoading(true);
      const res = await api.get(`/certificates/csr/download`, {
        params: {
          monday_account_id: context.account.id.toString(),
          workspace_id: workspaceId || undefined,
        },
        responseType: "text"
      });
      const csrPem = typeof res.data === "string" ? res.data : "";
      if (!csrPem) throw new Error("No se recibió el CSR del servidor");
      setLastGeneratedCsrPem(csrPem);
      const aliasSafe = (certificateAlias || "monday-facturacion").replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadBlob(csrPem, `${aliasSafe}.csr`);
    } catch (err) {
      const { msg, hint } = friendlyApiError(err);
      showToast("error", `${msg} — ${hint}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Paso 4 del flujo guiado: sube el .crt que ARCA generó a partir del CSR.
  const handleFinalizeCsr = async () => {
    if (!finalCrtFile || !context) {
      showToast("error", "Seleccioná el archivo .crt que descargaste de ARCA");
      return;
    }
    setIsLoading(true);
    const formData = new FormData();
    formData.append("crt", finalCrtFile);
    formData.append("monday_account_id", context.account.id.toString());
    if (workspaceId) formData.append("workspace_id", workspaceId);
    try {
      const res = await api.post(`/certificates/csr/finalize`, formData, {
        headers: { "Content-Type": "multipart/form-data" }
      });
      showToast("success", "Certificado activado correctamente");
      setCertificateStatus("active");
      setHasSavedCertificates(true);
      setCertificateExpirationDate(
        res?.data?.expirationDate
          ? new Date(res.data.expirationDate).toLocaleDateString("es-AR")
          : ""
      );
      setFinalCrtFile(null);
      setCertFlow(null);
      setGuidedStep(1);
      setLastGeneratedCsrPem("");
    } catch (err) {
      const { msg, hint } = friendlyApiError(err);
      showToast("error", `${msg} — ${hint}`);
    } finally {
      setIsLoading(false);
    }
  };

  const resetCertFlow = () => {
    setCertFlow(null);
    setGuidedStep(1);
    setFinalCrtFile(null);
    setCrtFile(null);
    setKeyFile(null);
    setLastGeneratedCsrPem("");
  };

  // Arranca el flujo guiado de renovación, prepoblando el alias con el mes actual.
  const handleStartCertRenewal = () => {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
    setAliasInput(`monday-facturacion-${ym}`);
    setCertFlow("guided");
    setGuidedStep(1);
  };

  // ─── Info derivada del certificado para UI ──────────────────────────────────
  const certDaysRemaining = (() => {
    if (!certificateExpirationDate) return null;
    // certificateExpirationDate viene como string en formato "es-AR" (DD/MM/YYYY)
    const parts = certificateExpirationDate.split("/");
    if (parts.length !== 3) return null;
    const expDate = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
    const diffMs = expDate.getTime() - Date.now();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  })();
  const certDaysBadge = (() => {
    if (certDaysRemaining === null) return null;
    if (certDaysRemaining < 0) return { cls: "expired", text: "Vencido" };
    if (certDaysRemaining < 30) return { cls: "warning", text: `Vence en ${certDaysRemaining} días` };
    if (certDaysRemaining < 90) return { cls: "notice", text: `${certDaysRemaining} días restantes` };
    return { cls: "ok", text: `${certDaysRemaining} días restantes` };
  })();

  const fiscalFormCompleted =
    Boolean(fiscal.razonSocial?.trim()) &&
    Boolean(fiscal.nombreFantasia?.trim()) &&
    Boolean(fiscal.cuit?.trim()) &&
    Boolean(fiscal.puntoVenta?.toString().trim()) &&
    Boolean(fiscal.fechaInicio) &&
    Boolean(fiscal.domicilio?.trim());

  const fiscalStatus = hasSavedFiscalData || fiscalFormCompleted ? "complete" : "incomplete";
  const certSidebarStatus = hasSavedCertificates || (crtFile && keyFile)
    ? "complete"
    : certificateStatus === "pending_crt"
      ? "pending"
      : "incomplete";
  const mappingStatus = hasSavedMapping || mappingCompleted ? "complete" : "incomplete";
  const sectionStatus = {
    datos: fiscalStatus,
    certificados: certSidebarStatus,
    mapping_v2: mappingStatus,
  };

  // Derivados para el header guiado (progreso global + próximo paso pendiente).
  const sectionStatusValues = Object.values(sectionStatus);
  const completedSections = sectionStatusValues.filter((s) => s === "complete").length;

  // La franja de debug (Build + estado backend) sólo se muestra en cuentas whitelisteadas.
  // Si querés ver tu Monday account ID, abrí la consola del navegador y buscá "Monday account ID:".
  const currentAccountId = context?.account?.id ? String(context.account.id) : null;
  const isDebugAccount = Boolean(currentAccountId && DEBUG_ACCOUNT_IDS.includes(currentAccountId));
  const totalSections = sectionStatusValues.length;
  const nextStepItem = MENU_ITEMS.find((m) => sectionStatus[m.id] !== "complete");
  const progressPct = totalSections > 0 ? completedSections / totalSections : 0;

  const getStatusLabel = (status) => {
    if (status === "complete") return "Completo";
    return "Pendiente";
  };

  // Mismo patrón vista/edición que en Datos Fiscales: snapshot al entrar, revertir al cancelar.
  const handleEnterMappingEdit = () => {
    setSavedMappingSnapshot(mapping);
    setIsMappingEditMode(true);
  };

  const handleCancelMappingEdit = () => {
    if (savedMappingSnapshot) setMapping(savedMappingSnapshot);
    setMissingMappingFields([]);
    setIsMappingEditMode(false);
  };

  const handleSaveVisualMapping = async () => {
    // ─── Validación estricta antes de guardar ─────────────────────────
    // Recolectamos TODOS los problemas y los mostramos juntos en un toast
    // claro. El cliente sabe exactamente qué le falta sin tener que
    // probar y guardar varias veces.
    const missingFields = requiredMappingFields.filter((field) => !mapping[field]);
    const blockers = [];

    if (missingFields.length > 0) {
      // Highlight visual en los selectores que faltan
      setMissingMappingFields(missingFields);
      setTimeout(() => setMissingMappingFields([]), 5000);
      // Construir labels legibles a partir de los IDs canónicos
      const labelMap = {
        fecha_emision:        "Fecha de Emisión",
        receptor_cuit:        "CUIT / DNI Receptor",
        condicion_venta:      "Condición de Venta",
        fecha_servicio_desde: "Fecha Servicio Desde",
        fecha_servicio_hasta: "Fecha Servicio Hasta",
        fecha_vto_pago:       "Fecha Vto. Pago",
        concepto:             "Concepto / Producto",
        cantidad:             "Cantidad",
        precio_unitario:      "Precio Unitario",
        prod_serv:            "Prod/Serv",
        unidad_medida:        "Unidad de Medida",
        alicuota_iva:         "Alícuota IVA %",
      };
      missingFields.forEach((f) => blockers.push(`Mapear "${labelMap[f] || f}"`));
    } else {
      setMissingMappingFields([]);
    }

    // Validar columnas de operación según los toggles activos
    if (!boardConfig.invoice_pdf_column_id) {
      blockers.push('Seleccionar la columna donde subir el PDF (en "Columna Comprobante PDF")');
    }
    // status_column_id solo es obligatoria si auto_update_status está ON
    if (boardConfig.auto_update_status && !boardConfig.status_column_id) {
      blockers.push('Seleccionar la columna de estado (porque activaste "Cambiar el estado del item")');
    }

    if (blockers.length > 0) {
      // Mostrar TODOS los problemas en un solo toast con bullets
      const lines = blockers.map((b, i) => `${i + 1}. ${b}`).join("\n");
      showToast(
        "error",
        `No se puede guardar — te falta:\n${lines}`
      );
      return;
    }

    if (!context?.account?.id || !boardId) {
      showToast("error", "No se pudo identificar cuenta/tablero para guardar el mapeo");
      return;
    }

    setIsLoading(true);
    try {
      // 1) Guardar el mapeo visual de campos (con is_complete=true para que
      //    el backend tambien valide los 12 campos obligatorios)
      await api.post(`/mappings`, {
        monday_account_id: context.account.id.toString(),
        workspace_id: workspaceId || null,
        board_id: boardId,
        view_id: viewIdFromHref,
        app_feature_id: appFeatureId,
        mapping,
        is_locked: true,
        is_complete: true,
      });

      // 2) Guardar el board-config (incluye los toggles auto_*)
      await api.post(`/board-config`, {
        monday_account_id: context.account.id.toString(),
        workspace_id: workspaceId || null,
        board_id: boardId,
        view_id: viewIdFromHref,
        app_feature_id: appFeatureId,
        // status_column_id solo se manda si el toggle esta activo. Si esta
        // OFF, el backend lo persiste como NULL.
        status_column_id: boardConfig.auto_update_status ? boardConfig.status_column_id : null,
        trigger_label: COMPROBANTE_STATUS_FLOW.trigger,
        success_label: COMPROBANTE_STATUS_FLOW.success,
        error_label: COMPROBANTE_STATUS_FLOW.error,
        required_columns: [
          { key: "invoice_pdf", resolved_column_id: boardConfig.invoice_pdf_column_id },
        ],
        auto_rename_item:   Boolean(boardConfig.auto_rename_item),
        auto_update_status: Boolean(boardConfig.auto_update_status),
      });

      setHasSavedMapping(true);
      setSavedMappingSnapshot(mapping);
      setIsMappingEditMode(false);
      showToast("success", "Mapeo visual guardado correctamente");
    } catch (err) {
      const { msg, hint } = friendlyApiError(err);
      showToast("error", `${msg} — ${hint}`);
    } finally {
      setIsLoading(false);
    }
  };

  const updateItemStatusInMonday = async (itemId, statusLabel) => {
    if (!boardConfig.status_column_id || !boardId || !itemId) return;

    const statusValueJson = JSON.stringify({ label: statusLabel });
    const statusValueLiteral = JSON.stringify(statusValueJson);

    const mutation = `mutation {
      change_column_value(
        board_id: ${Number(boardId)},
        item_id: ${Number(itemId)},
        column_id: "${boardConfig.status_column_id}",
        value: ${statusValueLiteral}
      ) { id }
    }`;

    await monday.api(mutation);
  };

  const createItemUpdateInMonday = async (itemId, body) => {
    if (!itemId || !body) return;
    const mutation = `mutation {
      create_update(item_id: ${Number(itemId)}, body: ${JSON.stringify(body)}) { id }
    }`;
    await monday.api(mutation);
  };


  const renderVisualSelect = (fieldId, placeholderText, scope = "board") => {
    const options = scope === "subitem" ? subitemColumns : columns;
    const hasValue = Boolean(mapping[fieldId]);
    const isMissing = missingMappingFields.includes(fieldId);

    return (
    <select
      className={`invoice-preview-select ${hasValue ? "mapped" : "unmapped"} ${isMissing ? "highlight-missing" : ""}`}
      value={mapping[fieldId] || ""}
      onChange={e => {
        setMapping({...mapping, [fieldId]: e.target.value});
        if (isMissing) setMissingMappingFields(prev => prev.filter(f => f !== fieldId));
      }}
      title={placeholderText}
    >
      <option value="">— Seleccionar {placeholderText} —</option>
      {options.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
    </select>
    );
  };

  const getMappedColumnLabel = (fieldId, scope = "board") => {
    const selectedValue = mapping[fieldId];
    if (!selectedValue) return "sin columna seleccionada";
    const options = scope === "subitem" ? subitemColumns : columns;
    const found = options.find((o) => o.value === selectedValue);
    return found?.label || selectedValue;
  };

  // Viewers de monday no pueden acceder a la API, así que no pueden usar la app.
  // Requisito del review de monday: mostrar un mensaje claro en vez de dejar
  // que toquen la UI y se rompa al guardar.
  if (context?.user?.isViewOnly) {
    return (
      <div className="gd-frame gd-frame-splash">
        <div className="gd-splash" style={{ maxWidth: 480 }}>
          <div className="gd-splash-title">Acceso de solo lectura</div>
          <div className="gd-splash-sub">
            Como viewer en monday no tenés permisos para usar ARCA Facturación.
            Pedile a un administrador del workspace que te asigne permisos de
            miembro para configurar y emitir facturas.
          </div>
        </div>
      </div>
    );
  }

  // Welcome page: aparece la primera vez que el user abre la app, antes del
  // flow de configuración. Requerido por monday para Board Views.
  // Visible si NO hay setup completo Y el user no la dismissó previamente.
  const welcomeDismissedKey = `arca-welcome-dismissed-${context?.account?.id || "default"}`;
  const welcomeDismissed = (() => {
    try { return localStorage.getItem(welcomeDismissedKey) === "1"; }
    catch { return false; }
  })();
  const setupComplete = hasSavedFiscalData && hasSavedCertificates && hasSavedMapping;
  const shouldShowWelcome = isInitialDataReady && !setupComplete && !welcomeDismissed && !showWelcomeOverride;
  if (shouldShowWelcome) {
    return (
      <WelcomePage
        onStart={() => {
          try { localStorage.setItem(welcomeDismissedKey, "1"); } catch {}
          setShowWelcomeOverride(true);
        }}
      />
    );
  }

  if (!isInitialDataReady) {
    return (
      <div className="gd-frame gd-frame-splash">
        <div className="gd-splash">
          <div className="loader" />
          <div className="gd-splash-title">Cargando tu app…</div>
          <div className="gd-splash-sub">Conectando con monday y trayendo tu configuración.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="gd-frame">
      {toast && (
        <div className={`toast toast-${toast.type}`} role="status">
          <span className="toast-icon">
            {toast.type === "success" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/><circle cx="12" cy="12" r="10"/></svg>
            )}
          </span>
          <span className="toast-message">{toast.message}</span>
        </div>
      )}

      {/* ─── SIDEBAR (checklist guiado, marca TAP) ─── */}
      <aside className="gd-sidebar">
        <div className="gd-sidebar-brand">
          <div className="gd-sidebar-logo">FE</div>
          <div>
            <div className="gd-sidebar-brand-title">Facturación AFIP</div>
            <div className="gd-sidebar-brand-sub">Monday App</div>
          </div>
        </div>

        <nav className="gd-checklist">
          <div className="gd-checklist-heading">Configuración</div>
          {MENU_ITEMS.map((item) => {
            const s = sectionStatus[item.id] || "incomplete";
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`gd-check-item ${isActive ? "active" : ""}`}
                onClick={() => setActiveSection(item.id)}
              >
                <span className={`gd-check-mark ${s}`}>
                  {s === "complete" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  ) : s === "pending" ? (
                    <span className="gd-check-half" />
                  ) : null}
                </span>
                <span className="gd-check-body">
                  <span className="gd-check-label">{item.label}</span>
                  <span className={`gd-check-status ${s}`}>
                    {s === "complete" ? "Listo" : s === "pending" ? "En progreso" : "Pendiente"}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="gd-sidebar-footer">
          <span className={`status-dot ${context ? "online" : ""}`} />
          <span>{context ? "Backend conectado" : "Sin contexto Monday"}</span>
        </div>
      </aside>

      {/* ─── MAIN: header guiado + contenido ─── */}
      <main className="gd-main">
        {usage && (() => {
          const { plan_id, limit, used, remaining, status, is_trial, allowed } = usage;
          let level = 'ok';
          if (limit != null) {
            const pct = limit > 0 ? (used / limit) * 100 : 0;
            if (pct >= 96) level = 'danger';
            else if (pct >= 80) level = 'warning';
          }
          if (!allowed) level = 'danger';
          if (status === 'cancelled' || status === 'trial_expired') level = 'danger';
          const planLabels = { free: 'Free', small: 'Small', medium: 'Medium', large: 'Large', enterprise: 'Enterprise' };
          const planLabel = planLabels[plan_id] || plan_id;
          let counterText;
          if (status === 'cancelled') counterText = 'Suscripción cancelada';
          else if (status === 'trial_expired') counterText = 'Trial finalizado';
          else if (limit == null) counterText = 'Facturas ilimitadas este mes';
          else counterText = `${used}/${limit} facturas este mes`;
          let cta = null;
          if (!allowed) cta = (status === 'cancelled' || status === 'trial_expired') ? 'Renová tu plan' : 'Upgradeá tu plan';
          return (
            <div className={`usage-banner usage-banner-${level}`}>
              <span className="usage-plan-pill">Plan {planLabel}{is_trial ? ' · Trial' : ''}</span>
              <span className="usage-counter">{counterText}</span>
              {cta && <span className="usage-cta">{cta}</span>}
            </div>
          );
        })()}
        <div className="gd-header">
          <div className="gd-header-main">
            <div className="gd-header-kicker">Monday App · Facturación Electrónica AFIP</div>
            <h1 className="gd-header-title">
              {completedSections === totalSections ? (
                <>Todo listo. Tu app está facturando.</>
              ) : nextStepItem ? (
                <>Te falta <span className="gd-header-accent">{nextStepItem.label.toLowerCase()}</span> para empezar a facturar</>
              ) : (
                <>Casi listo</>
              )}
            </h1>
            <p className="gd-header-sub">
              Configurá tu app una vez. Después cada cambio de estado en el tablero dispara una factura AFIP automática.
            </p>
            <a
              href={HOW_TO_USE_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                marginTop: 12,
                padding: "6px 12px",
                background: "rgba(255,255,255,0.15)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.35)",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                textDecoration: "none",
                width: "fit-content",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              Cómo usar la app
            </a>
          </div>
          <div className="gd-header-progress">
            <div className="gd-header-progress-circle">
              <svg width="110" height="110" viewBox="0 0 110 110">
                <circle cx="55" cy="55" r="46" fill="none" stroke="rgba(255,255,255,.25)" strokeWidth="8" />
                <circle
                  cx="55" cy="55" r="46" fill="none"
                  stroke="#fff" strokeWidth="8" strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 46}
                  strokeDashoffset={2 * Math.PI * 46 * (1 - progressPct)}
                  transform="rotate(-90 55 55)"
                  style={{ transition: "stroke-dashoffset 400ms ease" }}
                />
              </svg>
              <div className="gd-header-progress-num">
                <span className="mono">{completedSections}</span><span>/{totalSections}</span>
              </div>
            </div>
            <div className="gd-header-progress-label">pasos completos</div>
          </div>
        </div>

        <div className="gd-main-body">
          {isDebugAccount && (
            <div className="gd-meta-strip">
              <span className="gd-build-tag">Build: {APP_BUILD_VERSION}</span>
              <span>
                {apiStatus === "ok"       && <>Backend conectado correctamente ({API_URL})</>}
                {apiStatus === "checking" && <>Verificando conexión backend...</>}
                {apiStatus === "error"    && <>⚠ Backend sin conexión ({API_URL}) — {apiError}</>}
              </span>
            </div>
          )}

        {isLoading && (
            <div className="loading-overlay">
                <div className="loader"></div>
                <p>Procesando datos de forma segura...</p>
            </div>
        )}

        {/* ═══ SECCIÓN: DATOS FISCALES ═══ */}
        {activeSection === "datos" && (() => {
          const inEditMode = !hasSavedFiscalData || isFiscalEditMode;
          const isInitialSetup = !hasSavedFiscalData;
          const displayLogoUrl = !removeLogoOnSave ? (logoPreviewUrl || savedLogoDataUrl) : logoPreviewUrl;
          const hasContactData = Boolean(fiscal.telefono || fiscal.email || fiscal.sitioWeb || displayLogoUrl);

          return (
          <section className="gd-content">
            <div className="gd-section-head">
              <div>
                <h2 className="gd-section-title">Datos Fiscales</h2>
                <p className="gd-section-sub">
                  {hasSavedFiscalData
                    ? "Esto es lo que AFIP va a ver en tus comprobantes."
                    : "Completá la información de tu empresa para la facturación electrónica."}
                </p>
              </div>
              {!inEditMode && (
                <button type="button" className="btn-secondary section-edit-btn" onClick={handleEnterFiscalEdit}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
                  Editar
                </button>
              )}
            </div>

            {!inEditMode ? (
              /* ─── MODO VISTA ─── */
              <>
                <div className="gd-card">
                  <div className="gd-card-head">
                    <span className="h-eyebrow">Identidad fiscal</span>
                    <span className="gd-dim">Obligatorio</span>
                  </div>
                  <div className="gd-data-grid">
                    <div className="data-row">
                      <span className="data-label">Razón Social</span>
                      <span className={`data-value ${!fiscal.razonSocial ? "empty" : ""}`}>{fiscal.razonSocial || "—"}</span>
                    </div>
                    <div className="data-row">
                      <span className="data-label">Nombre de Fantasía</span>
                      <span className={`data-value ${!fiscal.nombreFantasia ? "empty" : ""}`}>{fiscal.nombreFantasia || "—"}</span>
                    </div>
                    <div className="data-row">
                      <span className="data-label">Punto de Venta</span>
                      <span className={`data-value mono ${!fiscal.puntoVenta ? "empty" : ""}`}>{fiscal.puntoVenta || "—"}</span>
                    </div>
                    <div className="data-row">
                      <span className="data-label">CUIT</span>
                      <span className={`data-value mono ${!fiscal.cuit ? "empty" : ""}`}>{fiscal.cuit || "—"}</span>
                    </div>
                    <div className="data-row">
                      <span className="data-label">Inicio de actividades</span>
                      <span className={`data-value mono ${!fiscal.fechaInicio ? "empty" : ""}`}>
                        {fiscal.fechaInicio
                          ? formatDateAR(fiscal.fechaInicio)
                          : "—"}
                      </span>
                    </div>
                    <div className="data-row full-width">
                      <span className="data-label">Domicilio Comercial</span>
                      <span className={`data-value ${!fiscal.domicilio ? "empty" : ""}`}>{fiscal.domicilio || "—"}</span>
                    </div>
                  </div>
                </div>

                <div className="gd-card">
                  <div className="gd-card-head">
                    <span className="h-eyebrow">Marca & contacto · opcional</span>
                    <span className="gd-dim">Se imprime en el PDF</span>
                  </div>
                  {hasContactData ? (
                    <div className="gd-brand-row">
                      <div className={`gd-logo-slot ${displayLogoUrl ? "has-logo" : ""}`}>
                        {displayLogoUrl ? (
                          <img src={displayLogoUrl} alt="Logo de la empresa" />
                        ) : (
                          <>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            <span>Sin logo</span>
                          </>
                        )}
                      </div>
                      <div className="gd-data-grid compact">
                        <div className="data-row">
                          <span className="data-label">Teléfono</span>
                          <span className={`data-value mono ${!fiscal.telefono ? "empty" : ""}`}>{fiscal.telefono || "—"}</span>
                        </div>
                        <div className="data-row">
                          <span className="data-label">Email</span>
                          <span className={`data-value ${!fiscal.email ? "empty" : ""}`}>{fiscal.email || "—"}</span>
                        </div>
                        <div className="data-row full-width">
                          <span className="data-label">Sitio web</span>
                          <span className={`data-value ${!fiscal.sitioWeb ? "empty" : ""}`}>
                            {fiscal.sitioWeb
                              ? <a href={fiscal.sitioWeb} target="_blank" rel="noreferrer">{fiscal.sitioWeb}</a>
                              : "—"}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="data-view-empty full-width">
                      Aún no configuraste datos de contacto ni logo. Apretá <em>Editar</em> para agregarlos.
                    </div>
                  )}
                </div>
              </>
            ) : (
            /* ─── MODO EDICIÓN ─── */
            <div className="gd-card">
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Razón Social</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="Ej: Mi Empresa S.A."
                  value={fiscal.razonSocial}
                  onChange={(e) => handleFiscalChange("razonSocial", e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Nombre de Fantasía</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="Ej: Martín Melendrez"
                  value={fiscal.nombreFantasia}
                  onChange={(e) => handleFiscalChange("nombreFantasia", e.target.value)}
                />
                <p className="form-hint">Es el nombre comercial que aparece en negrita arriba del PDF. Si no tenés, poné tu razón social.</p>
              </div>

              <div className="form-group">
                <label className="form-label">CUIT</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="20123456789"
                  value={fiscal.cuit}
                  onChange={(e) => handleFiscalChange("cuit", e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Punto de Venta</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="1"
                  value={fiscal.puntoVenta}
                  onChange={(e) => handleFiscalChange("puntoVenta", e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Fecha de Inicio de Actividades</label>
                <input
                  className="form-input"
                  type="date"
                  value={fiscal.fechaInicio}
                  onChange={(e) => handleFiscalChange("fechaInicio", e.target.value)}
                />
              </div>

              <div className="form-group full-width">
                <label className="form-label">Domicilio Comercial</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="Av. Corrientes 1234, CABA"
                  value={fiscal.domicilio}
                  onChange={(e) => handleFiscalChange("domicilio", e.target.value)}
                />
              </div>

            </div>

            {/* ─── Subsección opcional: contacto y branding ─── */}
            <div className="subsection-header">
              <h2 className="subsection-title">Datos de contacto y marca <span className="subsection-tag">opcional</span></h2>
              <p className="subsection-subtitle">
                Estos datos son opcionales. Más adelante los vamos a usar para personalizar el PDF de tus facturas con la información de tu empresa.
              </p>
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Teléfono</label>
                <input
                  className="form-input"
                  type="tel"
                  placeholder="+54 11 1234-5678"
                  value={fiscal.telefono}
                  onChange={(e) => handleFiscalChange("telefono", e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Email</label>
                <input
                  className="form-input"
                  type="email"
                  placeholder="contacto@miempresa.com"
                  value={fiscal.email}
                  onChange={(e) => handleFiscalChange("email", e.target.value)}
                />
              </div>

              <div className="form-group full-width">
                <label className="form-label">Sitio web</label>
                <input
                  className="form-input"
                  type="url"
                  placeholder="https://miempresa.com"
                  value={fiscal.sitioWeb}
                  onChange={(e) => handleFiscalChange("sitioWeb", e.target.value)}
                />
              </div>

              <div className="form-group full-width">
                <label className="form-label">Logo de la empresa</label>
                <div className="logo-uploader">
                  <div className="logo-uploader-row">
                    <div className="logo-preview">
                      {(logoPreviewUrl || (!removeLogoOnSave && savedLogoDataUrl)) ? (
                        <img src={logoPreviewUrl || savedLogoDataUrl} alt="Logo de la empresa" />
                      ) : (
                        <span className="logo-preview-empty">Sin logo</span>
                      )}
                    </div>
                    <div className="logo-uploader-actions">
                      <label className="btn-secondary logo-upload-btn">
                        {(logoPreviewUrl || savedLogoDataUrl) ? "Cambiar imagen" : "Subir imagen"}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/svg+xml,image/webp"
                          onChange={(e) => handleLogoSelected(e.target.files?.[0] || null)}
                          style={{ display: "none" }}
                        />
                      </label>
                      {(logoPreviewUrl || (!removeLogoOnSave && savedLogoDataUrl)) && (
                        <button type="button" className="btn-secondary" onClick={handleRemoveLogo}>
                          Quitar
                        </button>
                      )}
                      <p className="logo-uploader-hint">PNG, JPG, SVG o WebP. Hasta 1 MB.</p>
                    </div>
                  </div>

                  {/* Mockup en vivo: cómo va a quedar en la cabecera de la factura. */}
                  <div className="logo-mockup-wrap">
                    <span className="logo-mockup-label">Vista previa en la factura:</span>
                    <div className="invoice-mockup">
                      <div className="invoice-mockup-logo">
                        {(logoPreviewUrl || (!removeLogoOnSave && savedLogoDataUrl)) ? (
                          <img src={logoPreviewUrl || savedLogoDataUrl} alt="" />
                        ) : (
                          <span className="invoice-mockup-logo-empty">Tu logo<br/>acá</span>
                        )}
                      </div>
                      <div className="invoice-mockup-data">
                        <div className="invoice-mockup-name">
                          {(fiscal.nombreFantasia || fiscal.razonSocial || "TU EMPRESA S.A.").toUpperCase()}
                        </div>
                        <div className="invoice-mockup-line">
                          <strong>Razón Social:</strong> {(fiscal.razonSocial || "Tu Empresa S.A.")}
                        </div>
                        <div className="invoice-mockup-line">
                          <strong>Domicilio:</strong> {fiscal.domicilio || "Av. Ejemplo 1234, CABA"}
                        </div>
                        <div className="invoice-mockup-line">
                          <strong>CUIT:</strong> {fiscal.cuit || "20-12345678-9"}
                        </div>
                      </div>
                    </div>

                    {/* Warning automático según dimensiones naturales del logo. */}
                    {(() => {
                      const hasLogo = Boolean(logoPreviewUrl || (!removeLogoOnSave && savedLogoDataUrl));
                      if (!hasLogo) {
                        return (
                          <p className="logo-feedback neutral">
                            Subí tu logo para verlo en la vista previa.
                          </p>
                        );
                      }
                      if (!logoNaturalSize) return null;
                      const minDim = Math.min(logoNaturalSize.width, logoNaturalSize.height);
                      const ratio = logoNaturalSize.width / logoNaturalSize.height;
                      if (minDim < 200) {
                        return (
                          <p className="logo-feedback warn">
                            ⚠ La imagen es chica ({logoNaturalSize.width}×{logoNaturalSize.height} px). Puede verse borrosa al imprimir. Recomendamos al menos 300×300 px.
                          </p>
                        );
                      }
                      if (ratio > 3 || ratio < 0.34) {
                        return (
                          <p className="logo-feedback info">
                            ℹ Imagen muy alargada — el cuadro de la factura es casi cuadrado, así que puede quedar reducida.
                          </p>
                        );
                      }
                      return (
                        <p className="logo-feedback ok">
                          ✓ Se va a ver bien en la factura ({logoNaturalSize.width}×{logoNaturalSize.height} px).
                        </p>
                      );
                    })()}
                  </div>
                </div>
              </div>
            </div>

            </div>
            )}

            {inEditMode && (
              <div className="form-actions">
                {!isInitialSetup && (
                  <button type="button" className="btn-secondary" onClick={handleCancelFiscalEdit} disabled={isLoading}>
                    Cancelar
                  </button>
                )}
                <button className="btn-primary" onClick={handleSaveFiscal} disabled={isLoading}>
                  {isLoading
                    ? "Guardando..."
                    : (isInitialSetup ? "Guardar Datos Fiscales" : "Guardar cambios")}
                </button>
              </div>
            )}

            {isFetchingSavedData && (
              <p className="fetching-text">Cargando datos guardados...</p>
            )}
          </section>
          );
        })()}

        {/* ═══ SECCIÓN: CERTIFICADOS ═══ */}
        {activeSection === "certificados" && (
          <section className="gd-content">
            <div className="gd-section-head">
              <div>
                <h2 className="gd-section-title">
                  {certFlow === "guided"
                    ? "Obtené tu certificado ARCA"
                    : certFlow === "manual"
                      ? "Subir certificado manualmente"
                      : "Certificados ARCA"}
                </h2>
                <p className="gd-section-sub">
                  {certFlow === "guided"
                    ? "Asistente paso a paso. No necesitás usar terminal ni OpenSSL."
                    : certFlow === "manual"
                      ? "Si ya generaste tu .crt y .key por fuera, subilos directamente."
                      : certificateStatus === "active"
                        ? "Certificado digital de AFIP que firma tus comprobantes."
                        : "Para facturar necesitás un certificado digital de ARCA. Te guiamos paso a paso."}
                </p>
              </div>
              <div className="gd-section-head-actions">
                {certificateStatus === "active" && certFlow === null && (
                  <button
                    type="button"
                    className="btn-secondary section-edit-btn"
                    onClick={handleStartCertRenewal}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/></svg>
                    Renovar
                  </button>
                )}
                {CERT_TUTORIAL_URL && (
                  <a
                    className="btn-secondary"
                    href={CERT_TUTORIAL_URL}
                    target="_blank"
                    rel="noreferrer"
                    title="Abrir tutorial en video"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    Ver tutorial
                  </a>
                )}
              </div>
            </div>

            {/* ── ESTADO: CERTIFICADO ACTIVO (modo vista, consistente con Datos Fiscales) ── */}
            {certificateStatus === "active" && certFlow !== "guided" && certFlow !== "manual" && (
              <>
                <div className="cert-active-hero">
                  <div className="cert-active-hero-icon">
                    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#0b7841" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="10" fill="#e7f7ef" stroke="#0b7841" strokeWidth="1.5"/>
                      <polyline points="8 12 11 15 16 9" />
                    </svg>
                  </div>
                  <div className="cert-active-hero-text">
                    <h2 className="cert-active-hero-title">Certificado activo</h2>
                    <p className="cert-active-hero-sub">
                      Tu app está lista para emitir facturas en ARCA.
                      {certDaysBadge && (
                        <> Vence en <strong>{certificateExpirationDate}</strong> · {certDaysBadge.text.toLowerCase()}.</>
                      )}
                    </p>
                  </div>
                </div>

                <div className="data-view">
                  {certificateAlias && (
                    <div className="data-row">
                      <span className="data-label">Alias</span>
                      <span className="data-value">{certificateAlias}</span>
                    </div>
                  )}
                  <div className={`data-row ${!certificateAlias ? "full-width" : ""}`}>
                    <span className="data-label">Vencimiento</span>
                    <span className={`data-value ${!certificateExpirationDate ? "empty" : ""}`}>
                      {certificateExpirationDate || "—"}
                      {certDaysBadge && (
                        <span className={`cert-days-badge ${certDaysBadge.cls}`} style={{ marginLeft: 10 }}>
                          {certDaysBadge.text}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="data-row full-width">
                    <span className="data-label">Última actualización</span>
                    <span className={`data-value ${!certificateUpdatedAt ? "empty" : ""}`}>
                      {certificateUpdatedAt
                        ? new Date(certificateUpdatedAt).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })
                        : "—"}
                    </span>
                  </div>
                </div>

                <div className="cert-secondary-actions">
                  <button type="button" className="cert-secondary-link" onClick={() => setCertFlow("manual")}>
                    También podés subir nuevos archivos .crt y .key manualmente
                  </button>
                </div>
              </>
            )}

            {/* ── ESTADO: SOLICITUD PENDIENTE (recovery) ── */}
            {certificateStatus === "pending_crt" && certFlow !== "guided" && certFlow !== "manual" && (
              <div className="cert-pending-card">
                <div className="cert-pending-header">
                  <span className="cert-pending-dot" />
                  <div>
                    <h2 className="cert-active-title">Solicitud pendiente</h2>
                    <p className="cert-active-sub">
                      Generaste una solicitud
                      {certificateUpdatedAt ? <> el {new Date(certificateUpdatedAt).toLocaleDateString("es-AR")}</> : null}.
                      Falta subir el archivo <code>.crt</code> que te da ARCA para terminar.
                    </p>
                  </div>
                </div>

                <div className="cert-action-grid">
                  <button
                    type="button"
                    className="cert-action-card primary"
                    onClick={() => { setCertFlow("guided"); setGuidedStep(4); }}
                  >
                    <div className="cert-action-card-badge">✨ Recomendado</div>
                    <div className="cert-action-card-icon">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#0073ea" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                      </svg>
                    </div>
                    <div className="cert-action-card-title">Subir certificado .crt de ARCA</div>
                    <div className="cert-action-card-desc">Terminá el trámite que empezaste — solo te queda adjuntar el archivo que te dio ARCA.</div>
                    <span className="cert-action-card-cta">Continuar →</span>
                  </button>

                  <button
                    type="button"
                    className="cert-action-card"
                    onClick={() => setCertFlow("manual")}
                  >
                    <div className="cert-action-card-icon alt">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#676879" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3v5h5"/>
                      </svg>
                    </div>
                    <div className="cert-action-card-title">Subir archivos manualmente</div>
                    <div className="cert-action-card-desc">Si ya tenés tu <code>.crt</code> y <code>.key</code> generados por fuera.</div>
                    <span className="cert-action-card-cta alt">Subir archivos →</span>
                  </button>
                </div>

                {showResetConfirm ? (
                  <div className="cert-reset-confirm" role="alertdialog" aria-labelledby="cert-reset-title">
                    <div className="cert-reset-confirm-header">
                      <span className="cert-reset-confirm-icon">⚠</span>
                      <div>
                        <strong id="cert-reset-title">¿Empezar una nueva solicitud?</strong>
                        <p>La solicitud actual se reemplaza y vas a tener que hacer todo el trámite de nuevo en ARCA.</p>
                      </div>
                    </div>
                    <div className="cert-reset-confirm-actions">
                      <button
                        type="button"
                        className="cert-helper-btn"
                        onClick={() => setShowResetConfirm(false)}
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="cert-helper-btn danger filled"
                        onClick={() => {
                          setShowResetConfirm(false);
                          setCertFlow("guided");
                          setGuidedStep(1);
                        }}
                      >
                        Sí, empezar de nuevo
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="cert-pending-helpers">
                    <button type="button" className="cert-helper-btn" onClick={handleRedownloadCsr} disabled={isLoading}>
                      <span>📥</span>
                      <span>Re-descargar la solicitud (.csr)</span>
                    </button>
                    <button
                      type="button"
                      className="cert-helper-btn danger"
                      onClick={() => setShowResetConfirm(true)}
                    >
                      <span>↻</span>
                      <span>Empezar una nueva solicitud</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── ESTADO: SIN CERT + sin flujo elegido → hero card + link manual ── */}
            {certificateStatus === "no_cert" && certFlow === null && (
              <div className="cert-entry-wrapper">
                <button
                  type="button"
                  className="cert-entry-hero"
                  onClick={() => { setCertFlow("guided"); setGuidedStep(1); }}
                >
                  <div className="cert-entry-hero-badge">✨ Recomendado</div>
                  <div className="cert-entry-hero-icon">
                    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#0073ea" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                  </div>
                  <h2 className="cert-entry-hero-title">Obtené tu certificado ARCA con nuestro asistente</h2>
                  <p className="cert-entry-hero-desc">
                    La forma más rápida y segura. <strong>Sin tener que usar comandos técnicos</strong> — generamos la solicitud por vos, la subís al portal de ARCA y listo.
                  </p>
                  <ul className="cert-entry-hero-features">
                    <li><span className="cert-entry-check">✓</span> Guía paso a paso dentro de la app</li>
                    <li><span className="cert-entry-check">✓</span> Sólo subís un archivo al final</li>
                    <li><span className="cert-entry-check">✓</span> Tu clave privada queda cifrada automáticamente</li>
                  </ul>
                  <span className="cert-entry-hero-cta">Empezar ahora →</span>
                </button>

                <div className="cert-entry-alt">
                  <span>¿Ya generaste tu <code>.crt</code> y <code>.key</code> por fuera?</span>
                  <button className="btn-text" onClick={() => setCertFlow("manual")}>
                    Subirlos manualmente →
                  </button>
                </div>
              </div>
            )}

            {/* ── FLUJO GUIADO ── */}
            {certFlow === "guided" && (
              <div className="cert-guided">
                <div className="cert-guided-header">
                  <ol className="cert-stepper">
                    {[
                      { n: 1, title: "Confirmar datos",      desc: "Revisamos tu razón social y CUIT" },
                      { n: 2, title: "Descargar solicitud",  desc: "Generamos un .csr con tu clave privada cifrada" },
                      { n: 3, title: "Subir a ARCA",         desc: "Pegás el alias y el .csr en AFIP" },
                      { n: 4, title: "Subir certificado",    desc: "Adjuntás el .crt que te devuelve AFIP" },
                    ].map((s) => (
                      <li
                        key={s.n}
                        className={`cert-step ${guidedStep === s.n ? "current" : ""} ${guidedStep > s.n ? "done" : ""}`}
                      >
                        <span className="cert-step-num">{guidedStep > s.n ? "✓" : s.n}</span>
                        <span className="cert-step-text">
                          <span className="cert-step-title">{s.title}</span>
                          <span className="cert-step-desc">{s.desc}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>

                {/* ─── PASO 1: Confirmar datos ─── */}
                {guidedStep === 1 && (() => {
                  const isRenewing = certificateStatus === "active";
                  const missingFiscalData = !fiscal.razonSocial || !fiscal.cuit;
                  return (
                  <div className="cert-step-panel">
                    <h3 className="cert-step-title">Confirmá los datos</h3>
                    <p className="cert-step-desc">
                      Estos datos se firman en la solicitud. Si hay algo mal, corregilo en Datos Fiscales antes.
                    </p>

                    {isRenewing && (
                      <div className="gd-infobox warn">
                        <span className="gd-infobox-icon">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                        </span>
                        <div>
                          <p className="gd-infobox-title">Estás renovando tu certificado</p>
                          <p className="gd-infobox-body">
                            Al generar la nueva solicitud, el actual queda reemplazado y no vas a poder facturar hasta completar el paso 4. Usá un alias distinto al anterior — ARCA no permite repetirlos.
                          </p>
                        </div>
                      </div>
                    )}

                    {missingFiscalData ? (
                      <div className="gd-infobox warn">
                        <span className="gd-infobox-icon">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                        </span>
                        <div>
                          <p className="gd-infobox-title">Faltan datos fiscales</p>
                          <p className="gd-infobox-body">
                            Completá razón social y CUIT en la sección "Datos Fiscales" antes de generar la solicitud.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className="gd-confirm-grid">
                        <div className="gd-confirm-row">
                          <span className="gd-confirm-label">Razón Social</span>
                          <span className="gd-confirm-value">{fiscal.razonSocial}</span>
                        </div>
                        <div className="gd-confirm-row">
                          <span className="gd-confirm-label">CUIT</span>
                          <span className="gd-confirm-value mono">{fiscal.cuit}</span>
                        </div>
                        <div className="gd-confirm-row full">
                          <span className="gd-confirm-label">Alias del certificado</span>
                          <input
                            className="gd-input"
                            type="text"
                            value={aliasInput}
                            onChange={(e) => setAliasInput(e.target.value)}
                            placeholder="monday-facturacion"
                          />
                          <span className="gd-confirm-hint">
                            Tiene que ser único en ARCA. Prepoblado con el mes actual.
                          </span>
                        </div>
                      </div>
                    )}

                    <div className="gd-infobox">
                      <span className="gd-infobox-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                      </span>
                      <div>
                        <p className="gd-infobox-title">Tu clave privada queda cifrada</p>
                        <p className="gd-infobox-body">
                          Se genera y guarda con AES-256. No vas a tener que manejarla nunca.
                        </p>
                      </div>
                    </div>

                    <div className="gd-panel-actions">
                      <button className="btn-secondary" onClick={resetCertFlow} disabled={isLoading}>
                        Cancelar
                      </button>
                      <button
                        className="btn-primary"
                        onClick={handleGenerateCsr}
                        disabled={isLoading || missingFiscalData || !aliasInput.trim()}
                      >
                        {isLoading ? "Generando..." : "Generar solicitud"}
                        {!isLoading && <span aria-hidden="true">&nbsp;→</span>}
                      </button>
                    </div>
                  </div>
                  );
                })()}

                {/* ─── PASO 2: Descargar solicitud ─── */}
                {guidedStep === 2 && (() => {
                  const aliasSafe = (certificateAlias || aliasInput || "monday-facturacion").replace(/[^a-zA-Z0-9_-]/g, "_");
                  const csrFilename = `${aliasSafe}.csr`;
                  const csrSizeKb = lastGeneratedCsrPem
                    ? (new Blob([lastGeneratedCsrPem]).size / 1024).toFixed(1)
                    : "2.1";
                  return (
                  <div className="cert-step-panel">
                    <h3 className="cert-step-title">Descargá tu solicitud</h3>
                    <p className="cert-step-desc">
                      Este archivo <code>.csr</code> lo vas a subir al portal de ARCA en el siguiente paso.
                    </p>

                    <div className="gd-download-slot">
                      <div className="gd-download-file">
                        <span className="gd-download-file-icon">
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        </span>
                        <div className="gd-download-file-info">
                          <div className="gd-download-name">{csrFilename}</div>
                          <div className="gd-download-meta">{csrSizeKb} KB · listo para subir a ARCA</div>
                        </div>
                      </div>
                      <button className="btn-secondary" onClick={handleRedownloadCsr} disabled={isLoading}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        Descargar otra vez
                      </button>
                    </div>

                    {CERT_TUTORIAL_URL && (
                      <div className="gd-infobox">
                        <span className="gd-infobox-icon">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M19 15l.7 2L22 18l-2.3 1-.7 2-.7-2L16 18l2.3-1z"/></svg>
                        </span>
                        <div>
                          <p className="gd-infobox-title">¿Nunca hiciste este trámite?</p>
                          <p className="gd-infobox-body">
                            Te recomendamos abrir <a href={CERT_TUTORIAL_URL} target="_blank" rel="noreferrer" style={{color:"var(--accent)",fontWeight:600}}>el tutorial en video</a> antes de seguir. Dura ~4 minutos.
                          </p>
                        </div>
                      </div>
                    )}

                    <div className="gd-panel-actions">
                      <button className="btn-secondary" onClick={() => setGuidedStep(1)} disabled={isLoading}>
                        Volver
                      </button>
                      <button className="btn-primary" onClick={() => setGuidedStep(3)}>
                        Ya lo tengo&nbsp;<span aria-hidden="true">→</span>
                      </button>
                    </div>
                  </div>
                  );
                })()}

                {/* ─── PASO 3: Instrucciones ARCA ─── */}
                {guidedStep === 3 && (
                  <div className="cert-step-panel">
                    <h3 className="cert-step-title">Subí el <code>.csr</code> a ARCA</h3>
                    <p className="cert-step-desc">
                      Seguí estos pasos en el portal de AFIP.
                    </p>

                    {/* Collapsible de primera vez: adherir el servicio */}
                    <div className="gd-adhered-collapsible">
                      <label className="gd-adhered-head">
                        <input
                          type="checkbox"
                          checked={serviceAdhered}
                          onChange={(e) => setServiceAdhered(e.target.checked)}
                        />
                        <span className="gd-adhered-title">
                          Ya tengo adherido el servicio <strong>"Administración de Certificados Digitales"</strong> en ARCA
                        </span>
                      </label>
                      {!serviceAdhered && (
                        <div className="gd-adhered-body">
                          <div>
                            <strong>¿Primera vez?</strong> Primero adherí el servicio (una sola vez):
                          </div>
                          <ol>
                            <li>En el menú principal, entrá a <strong>Administrador de Relaciones de Clave Fiscal</strong>.</li>
                            <li>Click en <strong>Adherir Servicio</strong>.</li>
                            <li>Buscá <strong>"Administración de Certificados Digitales"</strong> (AFIP / ARCA).</li>
                            <li>Confirmá la adhesión. Una vez hecho esto, podés volver al menú principal.</li>
                          </ol>
                        </div>
                      )}
                    </div>

                    <ol className="gd-arca-steps">
                      <li>
                        Entrá a <a href="https://auth.afip.gob.ar/contribuyente_/login.xhtml" target="_blank" rel="noreferrer">auth.afip.gob.ar</a> con tu CUIT y clave fiscal.
                      </li>
                      <li>
                        Menú principal → <strong>Administración de Certificados Digitales</strong>.
                      </li>
                      <li>
                        Click en <strong>Agregar alias</strong> y pegá este valor:
                        <div className="gd-alias-copy">
                          <code>{certificateAlias || aliasInput}</code>
                          <button
                            type="button"
                            className="gd-alias-copy-btn"
                            onClick={() => {
                              navigator.clipboard?.writeText(certificateAlias || aliasInput);
                              showToast("success", "Alias copiado");
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            Copiar
                          </button>
                        </div>
                      </li>
                      <li>
                        Adjuntá el <code>.csr</code> que descargaste en el paso anterior.
                      </li>
                      <li>
                        Confirmá y después <strong>descargá el .crt</strong> generado.
                      </li>
                    </ol>

                    <div className="gd-panel-actions">
                      <button className="btn-secondary" onClick={() => setGuidedStep(2)} disabled={isLoading}>
                        Volver
                      </button>
                      <a
                        className="btn-secondary"
                        href="https://auth.afip.gob.ar/contribuyente_/login.xhtml"
                        target="_blank"
                        rel="noreferrer"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        Abrir ARCA
                      </a>
                      <button className="btn-primary" onClick={() => setGuidedStep(4)}>
                        Ya tengo el .crt&nbsp;<span aria-hidden="true">→</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* ─── PASO 4: Subir .crt ─── */}
                {guidedStep === 4 && (
                  <div className="cert-step-panel">
                    <h3 className="cert-step-title">Subí el certificado</h3>
                    <p className="cert-step-desc">
                      Adjuntá el <code>.crt</code> que descargaste de ARCA.
                    </p>

                    <div className="gd-upload-dropzone-wrap">
                      {finalCrtFile ? (
                        <label className="gd-upload-dropzone has-file" htmlFor="crt-final-upload">
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          <span className="gd-upload-main">Archivo seleccionado</span>
                          <span className="gd-upload-filename">{finalCrtFile.name}</span>
                          <button
                            type="button"
                            className="gd-upload-change"
                            onClick={(e) => { e.preventDefault(); setFinalCrtFile(null); }}
                          >
                            Cambiar archivo
                          </button>
                          <input
                            id="crt-final-upload"
                            type="file"
                            accept=".crt"
                            onChange={(e) => setFinalCrtFile(e.target.files[0] || null)}
                            hidden
                          />
                        </label>
                      ) : (
                        <label className="gd-upload-dropzone" htmlFor="crt-final-upload">
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                          <span className="gd-upload-main">Arrastrá el archivo o hacé clic</span>
                          <span className="gd-upload-hint">.crt · hasta 200 KB</span>
                          <input
                            id="crt-final-upload"
                            type="file"
                            accept=".crt"
                            onChange={(e) => setFinalCrtFile(e.target.files[0] || null)}
                            hidden
                          />
                        </label>
                      )}
                    </div>

                    <div className="gd-panel-actions">
                      <button className="btn-secondary" onClick={() => setGuidedStep(3)} disabled={isLoading}>
                        Volver
                      </button>
                      <button
                        className="btn-primary"
                        onClick={handleFinalizeCsr}
                        disabled={isLoading || !finalCrtFile}
                      >
                        {isLoading ? "Validando..." : "Activar certificado"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Alt-path: ofrecer subida manual fuera del wizard guiado */}
            {certFlow === "guided" && (
              <div className="gd-alt-path">
                <span>¿Ya generaste <code className="mono" style={{background:"var(--ink-100)", padding:"1px 6px", borderRadius:"4px", fontSize:"12px"}}>.crt</code> y <code className="mono" style={{background:"var(--ink-100)", padding:"1px 6px", borderRadius:"4px", fontSize:"12px"}}>.key</code> por fuera?</span>
                <button type="button" className="btn-link" onClick={() => setCertFlow("manual")}>
                  Subirlos manualmente →
                </button>
              </div>
            )}

            {/* ── FLUJO MANUAL (legacy) ── */}
            {certFlow === "manual" && (
              <div className="cert-manual">
                <div className="cert-guided-header">
                  <h3 className="cert-step-title" style={{margin: 0}}>Subí tus archivos .crt y .key</h3>
                  <button className="btn-text cert-guided-close" onClick={resetCertFlow}>Volver al asistente</button>
                </div>
                <p className="cert-step-desc">
                  Si ya tenés ambos archivos generados, adjuntalos. Validamos que sean pareja antes de guardarlos.
                </p>

                <div className="cards-row">
                  <div className="upload-card">
                    <div className="upload-card-header">
                      <h3>Certificado (.crt)</h3>
                      <p>Archivo de certificado público</p>
                    </div>
                    {crtFile ? (
                      <div className="upload-success">
                        <IconCheck />
                        <span>{crtFile.name}</span>
                        <button className="btn-text" onClick={() => setCrtFile(null)}>Cambiar</button>
                      </div>
                    ) : (
                      <label className="upload-zone" htmlFor="crt-upload">
                        <IconUpload />
                        <span className="upload-zone-text">Arrastrá o hacé clic para subir</span>
                        <span className="upload-zone-hint">.crt</span>
                        <input
                          id="crt-upload"
                          type="file"
                          accept=".crt"
                          onChange={(e) => handleFileChange(e, "crt")}
                          hidden
                        />
                      </label>
                    )}
                  </div>

                  <div className="upload-card">
                    <div className="upload-card-header">
                      <h3>Clave Privada (.key)</h3>
                      <p>Archivo de clave privada</p>
                    </div>
                    {keyFile ? (
                      <div className="upload-success">
                        <IconCheck />
                        <span>{keyFile.name}</span>
                        <button className="btn-text" onClick={() => setKeyFile(null)}>Cambiar</button>
                      </div>
                    ) : (
                      <label className="upload-zone" htmlFor="key-upload">
                        <IconUpload />
                        <span className="upload-zone-text">Arrastrá o hacé clic para subir</span>
                        <span className="upload-zone-hint">.key</span>
                        <input
                          id="key-upload"
                          type="file"
                          accept=".key"
                          onChange={(e) => handleFileChange(e, "key")}
                          hidden
                        />
                      </label>
                    )}
                  </div>
                </div>

                <div className="form-actions">
                  <button className="btn-secondary" onClick={resetCertFlow}>Cancelar</button>
                  <button
                    className="btn-primary"
                    onClick={handleUploadCertificates}
                    disabled={isLoading || !crtFile || !keyFile}
                  >
                    {isLoading ? "Subiendo..." : "Guardar certificados"}
                  </button>
                </div>

                <div className="info-box" style={{marginTop: "16px"}}>
                  <span className="info-box-icon">🔒</span>
                  <span>
                    <strong>Seguridad:</strong> tu clave privada se cifra con AES-256 antes de guardarse y nunca se expone en texto plano.
                  </span>
                </div>
              </div>
            )}
          </section>
        )}

        {/* ═══ SECCIÓN: MAPEO VISUAL V2 ═══ */}
        {activeSection === "mapping_v2" && (() => {
          const inMappingEditMode = !hasSavedMapping || isMappingEditMode;
          const isMappingInitialSetup = !hasSavedMapping;

          // Definición unificada de los campos para el view mode.
          // Todos los campos son obligatorios ahora (la distinción "opcional"
          // se eliminó — están todos integrados en el flujo de la factura modelo).
          const itemFieldsView = [
            { id: "fecha_emision",        label: "Fecha de Emisión",       scope: "board",   required: true },
            { id: "receptor_cuit",        label: "CUIT / DNI Receptor",    scope: "board",   required: true },
            { id: "condicion_venta",      label: "Condición de Venta",     scope: "board",   required: true },
            { id: "fecha_servicio_desde", label: "Fecha Servicio Desde",   scope: "board",   required: true },
            { id: "fecha_servicio_hasta", label: "Fecha Servicio Hasta",   scope: "board",   required: true },
            { id: "fecha_vto_pago",       label: "Fecha Vto. Pago",        scope: "board",   required: true },
          ];
          const subitemFieldsView = [
            { id: "concepto",         label: "Concepto / Detalle",  scope: "subitem", required: true },
            { id: "cantidad",         label: "Cantidad",            scope: "subitem", required: true },
            { id: "precio_unitario",  label: "Precio Unitario",     scope: "subitem", required: true },
            { id: "prod_serv",        label: "Prod / Serv",         scope: "subitem", required: true },
            { id: "unidad_medida",    label: "Unidad de Medida",    scope: "subitem", required: true },
            { id: "alicuota_iva",     label: "Alícuota IVA %",      scope: "subitem", required: true },
          ];

          // Helper: renderiza un select del estilo "pill" (variant Refined).
          // En modo vista lo dejamos disabled para conservar el visual de pill mapped/unmapped sin permitir cambios.
          const mapSel = (fieldId, placeholder, scope = "board") => (
            <select
              className={`invoice-preview-select ${mapping[fieldId] ? "mapped" : "unmapped"} ${missingMappingFields.includes(fieldId) ? "highlight-missing" : ""}`}
              value={mapping[fieldId] || ""}
              disabled={!inMappingEditMode}
              onChange={(e) => {
                setMapping({ ...mapping, [fieldId]: e.target.value });
                if (missingMappingFields.includes(fieldId)) {
                  setMissingMappingFields((prev) => prev.filter((f) => f !== fieldId));
                }
              }}
            >
              <option value="">— {placeholder} —</option>
              {(scope === "subitem" ? subitemColumns : columns).map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          );

          const pvFormatted = String(fiscal.puntoVenta || "0001").padStart(4, "0");
          const pillKind = mappedRequiredCount === totalRequiredCount ? "ok" : "warn";

          return (
          <section className="gd-content">
            <div className="gd-section-head">
              <div>
                <h2 className="gd-section-title">Mapeo Visual de Factura</h2>
                <p className="gd-section-sub">
                  Asociá cada campo de la factura con una columna del tablero de Monday.
                </p>
              </div>
              <div className="gd-section-head-actions">
                <span className={pillKind === "ok" ? "gd-pill-ok" : "gd-pill-warn"}>
                  {mappedRequiredCount}/{totalRequiredCount} campos mapeados
                </span>
                {!inMappingEditMode && (
                  <button type="button" className="btn-secondary section-edit-btn" onClick={handleEnterMappingEdit}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
                  Editar
                  </button>
                )}
              </div>
            </div>

            {/* Avisos solo en modo edición */}
            {inMappingEditMode && columns.length === 0 && (
              <div style={{
                background: "#fff8e1", border: "1.5px solid #f59e0b", borderRadius: "8px",
                padding: "10px 14px", color: "#7c5a00", fontSize: "13px"
              }}>
                <strong>Columnas no cargadas.</strong> Información de diagnóstico:
                <ul style={{margin:"6px 0 0 0", paddingLeft:"18px", fontSize:"12px"}}>
                  <li>boardId: <code>{String(context?.boardId ?? context?.locationContext?.boardId ?? "no disponible")}</code></li>
                  <li>Columnas ítem: {columns.length} · Subitems: {subitemColumns.length}</li>
                  {columnsLoadError && (
                    <li style={{color:"#a52020"}}>
                      Error:
                      <pre style={{whiteSpace:"pre-wrap", wordBreak:"break-word", background:"#fff", border:"1px solid #f0c0c0", padding:"6px", borderRadius:"4px", fontSize:"11px", maxHeight:"160px", overflow:"auto", margin:"4px 0 0 0"}}>{columnsLoadError}</pre>
                    </li>
                  )}
                </ul>
              </div>
            )}

            {inMappingEditMode && columns.length > 0 && subitemColumns.length === 0 && (
              <div style={{
                background: "#fff8e1", border: "1.5px solid #f59e0b", borderRadius: "8px",
                padding: "10px 14px", color: "#7c5a00", fontSize: "13px"
              }}>
                <strong>Columnas de subitems no detectadas.</strong> Asegurate de que el tablero tenga al menos un subitem creado y recargá la vista.
              </div>
            )}

            {missingMappingFields.length > 0 && (
              <div style={{
                background: "#fff0f0", border: "1.5px solid #d83b3b", borderRadius: "8px",
                padding: "10px 14px", color: "#a52020", fontSize: "13px"
              }}>
                <strong>Faltan seleccionar:</strong>{" "}
                {missingMappingFields.map(f => ({
                  fecha_emision: "Fecha Emisión",
                  receptor_cuit: "CUIT Receptor",
                  concepto: "Concepto/Detalle",
                  cantidad: "Cantidad",
                  precio_unitario: "Precio Unitario",
                  prod_serv: "Prod / Serv",
                }[f] || f)).join(", ")}
                {" "}— Los campos marcados en rojo deben asignarse antes de guardar.
              </div>
            )}

            {/* ─── Acciones automáticas en el item (2 checkboxes opcionales) ─── */}
            <div className="gd-card" style={{ marginBottom: 16 }}>
              <div className="gd-card-head">
                <span className="h-eyebrow">Acciones automáticas en el item</span>
                <span className="gd-dim">Opcionales</span>
              </div>
              <p className="gd-section-sub" style={{ marginTop: 4, marginBottom: 12 }}>
                Decidí qué cambios automáticos hace la app sobre el item de monday cuando se emite la factura.
              </p>

              {/* Checkbox 1: renombrar item */}
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "var(--surface-100, #f7f8fa)",
                  marginBottom: 10,
                  cursor: inMappingEditMode ? "pointer" : "default",
                }}
              >
                <input
                  type="checkbox"
                  checked={Boolean(boardConfig.auto_rename_item)}
                  disabled={!inMappingEditMode}
                  onChange={(e) =>
                    setBoardConfig((prev) => ({ ...prev, auto_rename_item: e.target.checked }))
                  }
                  style={{ marginTop: 3, cursor: inMappingEditMode ? "pointer" : "default" }}
                />
                <span style={{ flex: 1 }}>
                  <strong>Renombrar el item con el N° de factura</strong>
                  <span className="gd-confirm-hint" style={{ display: "block", marginTop: 2 }}>
                    Ej: <em>"Cliente Juan"</em> pasa a <em>"Factura B N° 0002-00000019"</em> tras emitir.
                  </span>
                </span>
              </label>

              {/* Checkbox 2: cambiar estado del item */}
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "var(--surface-100, #f7f8fa)",
                  cursor: inMappingEditMode ? "pointer" : "default",
                }}
              >
                <input
                  type="checkbox"
                  checked={Boolean(boardConfig.auto_update_status)}
                  disabled={!inMappingEditMode}
                  onChange={(e) =>
                    setBoardConfig((prev) => ({ ...prev, auto_update_status: e.target.checked }))
                  }
                  style={{ marginTop: 3, cursor: inMappingEditMode ? "pointer" : "default" }}
                />
                <span style={{ flex: 1 }}>
                  <strong>Cambiar el estado del item automáticamente</strong>
                  <span className="gd-confirm-hint" style={{ display: "block", marginTop: 2 }}>
                    Ej: <em>Procesando</em> → <em>Comprobante Creado</em>, o <em>Error</em> si falla.
                  </span>
                </span>
              </label>

              {/* Selector de columna de estado: solo aparece si auto_update_status = true */}
              {boardConfig.auto_update_status && (
                <div className="gd-confirm-grid" style={{ marginTop: 12 }}>
                  <div className="gd-confirm-row">
                    <span className="gd-confirm-label">Columna de estado del item</span>
                    {inMappingEditMode ? (
                      <select
                        className={`invoice-preview-select ${boardConfig.status_column_id ? "mapped" : "unmapped"}`}
                        value={boardConfig.status_column_id || ""}
                        onChange={(e) => setBoardConfig((prev) => ({ ...prev, status_column_id: e.target.value }))}
                      >
                        <option value="">— Elegir columna Status —</option>
                        {statusColumns.map((c) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="gd-confirm-value">
                        {statusColumns.find((c) => c.value === boardConfig.status_column_id)?.label || (
                          <em style={{ color: "var(--ink-400)" }}>Sin configurar</em>
                        )}
                      </span>
                    )}
                    <span className="gd-confirm-hint">
                      La app va a cambiar esta columna a "{COMPROBANTE_STATUS_FLOW.processing}" al disparar la emisión, y a "{COMPROBANTE_STATUS_FLOW.success}" cuando AFIP devuelva el CAE.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* ─── Columna de salida del PDF (siempre obligatoria) ─── */}
            <div className="gd-card" style={{ marginBottom: 16 }}>
              <div className="gd-card-head">
                <span className="h-eyebrow">Columna del PDF emitido</span>
                <span className="gd-dim">Obligatoria</span>
              </div>
              <div className="gd-confirm-grid">
                <div className="gd-confirm-row">
                  <span className="gd-confirm-label">Columna Comprobante PDF</span>
                  {inMappingEditMode ? (
                    <select
                      className={`invoice-preview-select ${boardConfig.invoice_pdf_column_id ? "mapped" : "unmapped"}`}
                      value={boardConfig.invoice_pdf_column_id || ""}
                      onChange={(e) => setBoardConfig((prev) => ({ ...prev, invoice_pdf_column_id: e.target.value }))}
                    >
                      <option value="">— Elegir columna Archivo —</option>
                      {fileColumns.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="gd-confirm-value">
                      {fileColumns.find((c) => c.value === boardConfig.invoice_pdf_column_id)?.label || (
                        <em style={{ color: "var(--ink-400)" }}>Sin configurar</em>
                      )}
                    </span>
                  )}
                  <span className="gd-confirm-hint">
                    La columna (tipo Archivo) donde se va a adjuntar el PDF emitido por AFIP.
                  </span>
                </div>
              </div>
              {inMappingEditMode && fileColumns.length === 0 && (
                <div className="gd-infobox warn" style={{ marginTop: 12 }}>
                  <span className="gd-infobox-icon">⚠</span>
                  <div>
                    <p className="gd-infobox-title">Tu tablero no tiene columna de Archivo</p>
                    <p className="gd-infobox-body">
                      Necesitás agregar una columna tipo "Archivo" al tablero para que la app pueda adjuntar el PDF de la factura.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* ─── Configuración opcional (campos no obligatorios — moneda, etc.) ─── */}
            <div className="gd-card" style={{ marginBottom: 16 }}>
              <div className="gd-card-head">
                <span className="h-eyebrow">Configuración opcional</span>
                <span className="gd-dim">Opcionales</span>
              </div>
              <p className="gd-section-sub" style={{ marginTop: 4, marginBottom: 12 }}>
                Configuraciones avanzadas que extienden el comportamiento de la app. Si no las usás, la app funciona en su modo por defecto.
              </p>

              <div className="gd-confirm-grid">
                <div className="gd-confirm-row">
                  <span className="gd-confirm-label">Moneda</span>
                  {inMappingEditMode ? (
                    <select
                      className={`invoice-preview-select ${mapping.moneda ? "mapped" : "unmapped"}`}
                      value={mapping.moneda || ""}
                      onChange={(e) => setMapping({ ...mapping, moneda: e.target.value })}
                    >
                      <option value="">— Default: pesos —</option>
                      {columns.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="gd-confirm-value">
                      {columns.find((c) => c.value === mapping.moneda)?.label || (
                        <em style={{ color: "var(--ink-400)" }}>Default: pesos</em>
                      )}
                    </span>
                  )}
                  <span className="gd-confirm-hint">
                    El item escribe <code>Pesos</code> o <code>Dólares</code> (mayúsc/minúsc/tilde indistinto). Vacío → Pesos.
                  </span>
                </div>

                <div className="gd-confirm-row">
                  <span className="gd-confirm-label">
                    Tipo de cambio
                    {mapping.moneda && <span style={{ color: "var(--danger-500, #b91c1c)", marginLeft: 4 }}>*</span>}
                  </span>
                  {inMappingEditMode ? (
                    <select
                      className={`invoice-preview-select ${mapping.cotizacion ? "mapped" : "unmapped"}`}
                      value={mapping.cotizacion || ""}
                      onChange={(e) => setMapping({ ...mapping, cotizacion: e.target.value })}
                    >
                      <option value="">— {mapping.moneda ? "Obligatorio si mapeás Moneda" : "Default: AFIP"} —</option>
                      {numericColumns.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="gd-confirm-value">
                      {numericColumns.find((c) => c.value === mapping.cotizacion)?.label || (
                        <em style={{ color: "var(--ink-400)" }}>
                          {mapping.moneda ? "Falta mapear" : "Default: cotización AFIP"}
                        </em>
                      )}
                    </span>
                  )}
                  <span className="gd-confirm-hint">
                    Celda vacía → la app pide cotización a AFIP y la escribe acá como registro. Con valor → se respeta como override.
                  </span>
                </div>

                <div className="gd-confirm-row">
                  <span className="gd-confirm-label">
                    Precio Unitario USD
                    <span style={{ color: "var(--ink-400)", fontWeight: 400, fontSize: 11, marginLeft: 4 }}>(subitem)</span>
                    {mapping.moneda && <span style={{ color: "var(--danger-500, #b91c1c)", marginLeft: 4 }}>*</span>}
                  </span>
                  {inMappingEditMode ? (
                    <select
                      className={`invoice-preview-select ${mapping.precio_unitario_usd ? "mapped" : "unmapped"}`}
                      value={mapping.precio_unitario_usd || ""}
                      onChange={(e) => setMapping({ ...mapping, precio_unitario_usd: e.target.value })}
                    >
                      <option value="">— {mapping.moneda ? "Obligatorio si mapeás Moneda" : "Solo si emitís en USD"} —</option>
                      {subitemNumericColumns.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="gd-confirm-value">
                      {subitemNumericColumns.find((c) => c.value === mapping.precio_unitario_usd)?.label || (
                        <em style={{ color: "var(--ink-400)" }}>
                          {mapping.moneda ? "Falta mapear" : "No mapeado"}
                        </em>
                      )}
                    </span>
                  )}
                  <span className="gd-confirm-hint">
                    Columna numérica del subitem con el precio en dólares. Solo se usa para items con moneda <code>Dólares</code>.
                  </span>
                </div>

                {mapping.moneda && (!mapping.cotizacion || !mapping.precio_unitario_usd) && (
                  <div style={{
                    background: "#fef3c7",
                    border: "1px solid #f59e0b",
                    borderRadius: 6,
                    padding: "8px 12px",
                    fontSize: 12,
                    color: "#78350f",
                    gridColumn: "1 / -1",
                  }}>
                    Mapeás Moneda → mapeá también <strong>Tipo de Cambio</strong> y <strong>Precio Unitario USD</strong>. Los 3 van juntos.
                  </div>
                )}
              </div>
            </div>

            {/* ─── Factura modelo: campos embebidos en el layout de la factura ─── */}
            <div className="rf-mapping-frame">
              <div className="rf-mapping-frame-head">
                <div>
                  <div className="rf-mapping-frame-eyebrow">Factura modelo</div>
                  <div className="rf-mapping-frame-title">
                    {inMappingEditMode
                      ? "Hacé click en cada campo para mapear una columna"
                      : "Vista del mapeo configurado — apretá Editar para cambiar"}
                  </div>
                </div>
                <div className="rf-mapping-legend">
                  <span><span className="rf-legend-swatch mapped" /> Mapeado</span>
                  <span><span className="rf-legend-swatch unmapped" /> Sin mapear</span>
                </div>
              </div>

              <div className="rf-invoice">
                {/* Header de la factura */}
                <div className="rf-invoice-head">
                  <div>
                    <div className="rf-invoice-title">FACTURA <span className="rf-invoice-type">X</span></div>
                    <div className="rf-invoice-sub">
                      {(fiscal.razonSocial || "Tu Empresa S.A.")} · CUIT {fiscal.cuit || "—"}
                    </div>
                  </div>
                  <div className="rf-invoice-meta">
                    <div className="rf-invoice-meta-row">
                      <span>Fecha de emisión</span>
                      {mapSel("fecha_emision", "Columna fecha")}
                    </div>
                    <div className="rf-invoice-meta-row">
                      <span>Punto de venta</span>
                      <span className="mono rf-invoice-meta-static">{pvFormatted}</span>
                    </div>
                  </div>
                </div>

                {/* Cliente */}
                <div className="rf-invoice-client">
                  <div>
                    <div className="rf-invoice-client-label">Cliente — CUIT/DNI</div>
                    {mapSel("receptor_cuit", "Columna CUIT receptor")}
                  </div>
                  <div>
                    <div className="rf-invoice-client-label">Condición de venta</div>
                    {mapSel("condicion_venta", "Opcional")}
                  </div>
                </div>

                {/* Fechas de servicio y vencimiento (integradas a la factura modelo) */}
                <div className="rf-invoice-client cols-3">
                  <div>
                    <div className="rf-invoice-client-label">Servicio desde</div>
                    {mapSel("fecha_servicio_desde", "Columna fecha")}
                  </div>
                  <div>
                    <div className="rf-invoice-client-label">Servicio hasta</div>
                    {mapSel("fecha_servicio_hasta", "Columna fecha")}
                  </div>
                  <div>
                    <div className="rf-invoice-client-label">Vencimiento de pago</div>
                    {mapSel("fecha_vto_pago", "Columna fecha")}
                  </div>
                </div>

                {/* Tabla de líneas */}
                <table className="rf-invoice-table">
                  <thead>
                    <tr>
                      <th style={{ width: "32%" }}>Concepto {mapSel("concepto", "Concepto", "subitem")}</th>
                      <th>Cant {mapSel("cantidad", "Cantidad", "subitem")}</th>
                      <th>Unidad {mapSel("unidad_medida", "Opcional", "subitem")}</th>
                      <th>Prod/Serv {mapSel("prod_serv", "Prod/Serv", "subitem")}</th>
                      <th>Precio unit. {mapSel("precio_unitario", "Precio", "subitem")}</th>
                      <th>IVA % {mapSel("alicuota_iva", "Opcional", "subitem")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="rf-invoice-row-sample">
                      <td>Consultoría abril 2026</td>
                      <td className="mono">1,00</td>
                      <td>Hora</td>
                      <td>Servicio</td>
                      <td className="mono">$ 180.000,00</td>
                      <td>21%</td>
                    </tr>
                    <tr className="rf-invoice-row-ghost">
                      <td colSpan="6">
                        Los subítems del tablero van a aparecer como líneas acá.
                      </td>
                    </tr>
                  </tbody>
                </table>

                {/* Totales (solo demo) */}
                <div className="rf-invoice-totals">
                  <div><span>Subtotal</span><span className="mono">$ 180.000,00</span></div>
                  <div><span>IVA 21%</span><span className="mono">$ 37.800,00</span></div>
                  <div className="rf-total"><span>Total</span><span className="mono">$ 217.800,00</span></div>
                </div>
              </div>
            </div>

            {inMappingEditMode && (
              <div className="form-actions" style={{marginTop: "8px"}}>
                {!isMappingInitialSetup && (
                  <button type="button" className="btn-secondary" onClick={handleCancelMappingEdit} disabled={isLoading}>
                    Cancelar
                  </button>
                )}
                <button className="btn-primary" onClick={handleSaveVisualMapping} disabled={isLoading}>
                  {isLoading
                    ? "Guardando..."
                    : (isMappingInitialSetup ? "Guardar Mapeo Visual" : "Guardar cambios")}
                </button>
              </div>
            )}
          </section>
          );
        })()}

        </div>{/* /gd-main-body */}
      </main>
    </div>
  );
};

export default App;
