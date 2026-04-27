/* global __APP_BUILD_VERSION__ */
import React, { useState, useEffect } from "react";
import mondaySdk from "monday-sdk-js";
import axios from "axios";
import "monday-ui-react-core/tokens";
import "monday-ui-react-core/dist/main.css";
import "./App.css";

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
// Todos los IDs de item para detectar si es tablero de plantilla
const TEMPLATE_BOARD_COLUMN_IDS = ["date", "numeric_mm0yadnb", "dropdown_mm2ged22", "date_mm2gyjvw", "date_mm2g8n2n", "date_mm2gp00f"];
const TEMPLATE_SUBITEM_COLUMN_IDS = ["numeric_mm1srkr2", "numeric_mm1swnhz", "dropdown_mm2fyez4", "dropdown_mm2gk2mv", "dropdown_mm2g198w"];

const App = () => {
  const [context, setContext] = useState(null);
  const [locationData, setLocationData] = useState(null);
  const [activeSection, setActiveSection] = useState("datos");
  const [toast, setToast] = useState(null);

  const showToast = (type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  };

  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingSavedData, setIsFetchingSavedData] = useState(false);
  const [apiStatus, setApiStatus] = useState("checking");
  const [apiError, setApiError] = useState("");
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
  const optionalMappingFields = []; // ya no hay opcionales
  // Campos obligatorios de operación (columnas del tablero, no del mapeo de datos):
  //   - status_column_id: columna Status donde ocurre el trigger de emisión
  //   - invoice_pdf_column_id: columna File donde se sube el PDF generado
  const operationCompleted = Boolean(boardConfig.status_column_id) && Boolean(boardConfig.invoice_pdf_column_id);
  const mappingCompleted = requiredMappingFields.every((field) => Boolean(mapping[field])) && operationCompleted;
  const operationMappedCount =
    (Boolean(boardConfig.status_column_id) ? 1 : 0) +
    (Boolean(boardConfig.invoice_pdf_column_id) ? 1 : 0);
  const mappedRequiredCount =
    requiredMappingFields.filter((field) => Boolean(mapping[field])).length + operationMappedCount;
  const totalRequiredCount = requiredMappingFields.length + 2; // +2: status + invoice pdf columns
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
      if (res.data?.account?.id) {
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
    const boardIdStr = String(resolvedBoardId);
    const strategies = [
      {
        name: "variables-ID!",
        query: `query ($boardIds: [ID!]) { boards(ids: $boardIds) { columns { id title type settings_str } } }`,
        options: { variables: { boardIds: [boardIdStr] } },
      },
      {
        name: "variables-Int!",
        query: `query ($boardIds: [Int!]) { boards(ids: $boardIds) { columns { id title type settings_str } } }`,
        options: { variables: { boardIds: [Number(boardIdStr)] } },
      },
      {
        name: "inline-number",
        query: `query { boards(ids: [${Number(boardIdStr)}]) { columns { id title type settings_str } } }`,
        options: undefined,
      },
      {
        name: "inline-string",
        query: `query { boards(ids: ["${boardIdStr}"]) { columns { id title type settings_str } } }`,
        options: undefined,
      },
    ];

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
          return;
        }
        const res = result.res;
        const boardColumns = res.data?.boards?.[0]?.columns || [];
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
      });
  }, [context]);

  useEffect(() => {
    const fetchSavedSetup = async () => {
      if (!context?.account?.id) return;

      setIsFetchingSavedData(true);

      try {
        const response = await api.get(`/setup/${context.account.id}`, {
          params: {
            board_id: boardId,
            view_id: viewIdFromHref,
            app_feature_id: appFeatureId,
          }
        });
        const data = response.data;

        if (data?.hasFiscalData && data?.fiscalData) {
          const hydratedFiscal = {
            puntoVenta: data.fiscalData.default_point_of_sale?.toString() || "",
            cuit: data.fiscalData.cuit || "",
            fechaInicio: data.fiscalData.fecha_inicio
              ? new Date(data.fiscalData.fecha_inicio).toISOString().split("T")[0]
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
          setBoardConfig({
            status_column_id: data.boardConfig.status_column_id || "",
            invoice_pdf_column_id: invoicePdfCol?.resolved_column_id || "",
            trigger_label: COMPROBANTE_STATUS_FLOW.trigger,
            processing_label: COMPROBANTE_STATUS_FLOW.processing,
            success_label: COMPROBANTE_STATUS_FLOW.success,
            error_label: COMPROBANTE_STATUS_FLOW.error,
          });
        }

      } catch (err) {
        console.error("No se pudieron recuperar datos guardados:", err);
        setApiStatus("error");
        setApiError(err?.response?.data?.error || err?.message || "Error consultando setup");
      } finally {
        setIsFetchingSavedData(false);
      }
    };

    fetchSavedSetup();
  }, [context, boardId, viewIdFromHref, appFeatureId, sessionToken]);

  // Auto-mapeo por plantilla: si no hay mapeo guardado y las columnas coinciden
  // con los IDs fijos de la plantilla, guardar el mapeo automáticamente en la DB.
  useEffect(() => {
    if (isFetchingSavedData) return;
    if (columns.length === 0) return;
    if (!context?.account?.id || !boardId) return;
    // Solo auto-mapear si el mapping está vacío (no hay mapeo guardado)
    const hasAnyMapping = Object.values(mapping).some(v => Boolean(v));
    if (hasAnyMapping) return;

    // Verificar si las columnas del tablero coinciden con los IDs de la plantilla
    const columnIds = columns.map(c => c.value);
    const isTemplateBoardMatch = TEMPLATE_BOARD_COLUMN_IDS.every(id => columnIds.includes(id));
    if (!isTemplateBoardMatch) {
      console.log("[auto-mapeo] No es tablero de plantilla, IDs no coinciden");
      return;
    }

    // Verificar subitems si están cargados
    const subitemIds = subitemColumns.map(c => c.value);
    const isTemplateSubitemMatch = subitemColumns.length > 0 &&
      TEMPLATE_SUBITEM_COLUMN_IDS.every(id => subitemIds.includes(id));

    if (subitemColumns.length > 0 && !isTemplateSubitemMatch) {
      console.log("[auto-mapeo] Subitems no coinciden con plantilla");
      return;
    }

    // Si los subitems aún no cargaron, esperar
    if (subitemColumns.length === 0) return;

    // Tablero de plantilla detectado — usar mapeo fijo
    console.log("[auto-mapeo] Tablero de plantilla detectado. Guardando mapeo automático...");
    setMapping(TEMPLATE_MAPPING);
    setSavedMappingSnapshot(TEMPLATE_MAPPING);
    setHasSavedMapping(true);
    setIsMappingEditMode(false);

    // Guardar en la DB automáticamente
    const autoSaveMapping = async () => {
      try {
        await api.post(`/mappings`, {
          monday_account_id: context.account.id.toString(),
          board_id: boardId,
          view_id: viewIdFromHref,
          app_feature_id: appFeatureId,
          mapping: TEMPLATE_MAPPING,
          is_locked: true,
        });
        console.log("[auto-mapeo] Mapeo de plantilla guardado en DB exitosamente");

        // También guardar el board config con la columna de status
        await api.post(`/board-config`, {
          monday_account_id: context.account.id.toString(),
          board_id: boardId,
          view_id: viewIdFromHref,
          app_feature_id: appFeatureId,
          status_column_id: TEMPLATE_STATUS_COLUMN_ID,
          trigger_label: COMPROBANTE_STATUS_FLOW.trigger,
          success_label: COMPROBANTE_STATUS_FLOW.success,
          error_label: COMPROBANTE_STATUS_FLOW.error,
          required_columns: [],
        });
        setBoardConfig(prev => ({ ...prev, status_column_id: TEMPLATE_STATUS_COLUMN_ID }));
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
  }, [columns, subitemColumns, isFetchingSavedData, context, boardId]);

  useEffect(() => {
    if (boardConfig.status_column_id || statusColumns.length === 0) return;

    setBoardConfig((prev) => ({
      ...prev,
      status_column_id: statusColumns[0].value,
    }));
  }, [boardConfig.status_column_id, statusColumns]);

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
    setIsLoading(true);
    try {
      const accountId = context.account.id.toString();
      const payload = {
        monday_account_id: accountId,
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
        const logoRes = await api.post(`/companies/logo`, fd, {
          headers: { "Content-Type": "multipart/form-data" }
        });
        setSavedLogoDataUrl(logoRes.data?.logo_data_url || null);
        setLogoFile(null);
        setLogoPreviewUrl(null);
      } else if (removeLogoOnSave) {
        await api.delete(`/companies/logo/${accountId}`);
        setSavedLogoDataUrl(null);
        setRemoveLogoOnSave(false);
      }

      showToast("success", "Datos fiscales guardados correctamente");
      setHasSavedFiscalData(true);
      setSavedFiscalSnapshot(fiscal);
      setIsFiscalEditMode(false);
      setApiStatus("ok");
    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message;
      showToast("error", "Error al guardar: " + errorMsg);
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
      const errorMsg = err?.response?.data?.error || err?.message || "Error al subir certificados";
      showToast("error", errorMsg);
      setApiStatus("error");
      setApiError(errorMsg);
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
      const errorMsg = err?.response?.data?.error || err?.message || "Error generando la solicitud";
      showToast("error", errorMsg);
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
        params: { monday_account_id: context.account.id.toString() },
        responseType: "text"
      });
      const csrPem = typeof res.data === "string" ? res.data : "";
      if (!csrPem) throw new Error("No se recibió el CSR del servidor");
      setLastGeneratedCsrPem(csrPem);
      const aliasSafe = (certificateAlias || "monday-facturacion").replace(/[^a-zA-Z0-9_-]/g, "_");
      downloadBlob(csrPem, `${aliasSafe}.csr`);
    } catch (err) {
      const errorMsg = err?.response?.data?.error || err?.message || "Error descargando el CSR";
      showToast("error", errorMsg);
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
      const errorMsg = err?.response?.data?.error || err?.message || "Error activando el certificado";
      showToast("error", errorMsg);
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
    const missingFields = requiredMappingFields.filter((field) => !mapping[field]);
    if (missingFields.length > 0) {
      setMissingMappingFields(missingFields);
      // Auto-limpiar el highlight después de 3s
      setTimeout(() => setMissingMappingFields([]), 3000);
      return;
    }
    setMissingMappingFields([]);

    // Validar columnas de operación (status + PDF) antes de guardar
    if (!boardConfig.status_column_id) {
      showToast("error", "Elegí la Columna de estado del tablero antes de guardar");
      return;
    }
    if (!boardConfig.invoice_pdf_column_id) {
      showToast("error", "Elegí la Columna Comprobante PDF antes de guardar");
      return;
    }

    if (!context?.account?.id || !boardId) {
      showToast("error", "No se pudo identificar cuenta/tablero para guardar el mapeo");
      return;
    }

    setIsLoading(true);
    try {
      // 1) Guardar el mapeo visual de campos
      await api.post(`/mappings`, {
        monday_account_id: context.account.id.toString(),
        board_id: boardId,
        view_id: viewIdFromHref,
        app_feature_id: appFeatureId,
        mapping,
        is_locked: true,
      });

      // 2) Guardar el board-config con las columnas de operación (status + PDF)
      await api.post(`/board-config`, {
        monday_account_id: context.account.id.toString(),
        board_id: boardId,
        view_id: viewIdFromHref,
        app_feature_id: appFeatureId,
        status_column_id: boardConfig.status_column_id,
        trigger_label: COMPROBANTE_STATUS_FLOW.trigger,
        success_label: COMPROBANTE_STATUS_FLOW.success,
        error_label: COMPROBANTE_STATUS_FLOW.error,
        required_columns: [
          { key: "invoice_pdf", resolved_column_id: boardConfig.invoice_pdf_column_id },
        ],
      });

      setHasSavedMapping(true);
      setSavedMappingSnapshot(mapping);
      setIsMappingEditMode(false);
      showToast("success", "Mapeo visual guardado correctamente");
    } catch (err) {
      const errorMsg = err?.response?.data?.error || err?.message || "Error al guardar mapeo visual";
      showToast("error", errorMsg);
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
                          ? new Date(fiscal.fechaInicio).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" })
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

            {/* ─── Columnas de operación: status trigger + PDF output ─── */}
            <div className="gd-card" style={{ marginBottom: 16 }}>
              <div className="gd-card-head">
                <span className="h-eyebrow">Columnas de operación</span>
                <span className="gd-dim">Obligatorias</span>
              </div>
              <div className="gd-confirm-grid">
                <div className="gd-confirm-row">
                  <span className="gd-confirm-label">Columna de estado (trigger)</span>
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
                    La columna donde el usuario cambia el estado a "{COMPROBANTE_STATUS_FLOW.trigger}" para disparar la emisión.
                  </span>
                </div>

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
