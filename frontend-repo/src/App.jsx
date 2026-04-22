import React, { useState, useEffect } from "react";
import mondaySdk from "monday-sdk-js";
import axios from "axios";
import "monday-ui-react-core/tokens";
import "monday-ui-react-core/dist/main.css";
import "./App.css";

const monday = mondaySdk();
const APP_BUILD_VERSION = "v25-2026-04-22-cert-guided-flow";
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
  const [isFiscalLocked, setIsFiscalLocked] = useState(false);
  const [isCertificatesLocked, setIsCertificatesLocked] = useState(false);
  const [isMappingLocked, setIsMappingLocked] = useState(false);

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

  // Datos fiscales
  const [fiscal, setFiscal] = useState({
    puntoVenta: "",
    cuit: "",
    fechaInicio: "",
    razonSocial: "",
    domicilio: "",
  });
  const [hasSavedFiscalData, setHasSavedFiscalData] = useState(false);

  // Mapeo
  const [columns, setColumns] = useState([]);
  const [subitemColumns, setSubitemColumns] = useState([]);
  const [mapping, setMapping] = useState({});
  const [missingMappingFields, setMissingMappingFields] = useState([]);
  const [columnsLoadError, setColumnsLoadError] = useState(null);
  const [boardConfig, setBoardConfig] = useState({
    status_column_id: "",
    trigger_label: COMPROBANTE_STATUS_FLOW.trigger,
    processing_label: COMPROBANTE_STATUS_FLOW.processing,
    success_label: COMPROBANTE_STATUS_FLOW.success,
    error_label: COMPROBANTE_STATUS_FLOW.error,
  });
  const requiredMappingFields = ["fecha_emision", "receptor_cuit", "concepto", "cantidad", "precio_unitario", "prod_serv"];
  const optionalMappingFields = [
    { id: "condicion_venta", label: "Condición de Venta", scope: "board" },
    { id: "fecha_servicio_desde", label: "Fecha Servicio Desde", scope: "board" },
    { id: "fecha_servicio_hasta", label: "Fecha Servicio Hasta", scope: "board" },
    { id: "fecha_vto_pago", label: "Fecha Vto. Pago", scope: "board" },
    { id: "alicuota_iva", label: "Alícuota IVA %", scope: "subitem" },
    { id: "unidad_medida", label: "Unidad de Medida", scope: "subitem" },
  ];
  const mappingCompleted = requiredMappingFields.every((field) => Boolean(mapping[field]));
  const mappedRequiredCount = requiredMappingFields.filter((field) => Boolean(mapping[field])).length;
  const mappedOptionalCount = optionalMappingFields.filter((f) => Boolean(mapping[f.id])).length;

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
            app_feature_id: appFeatureId
          }
        });
        const data = response.data;

        if (data?.hasFiscalData && data?.fiscalData) {
          setFiscal({
            puntoVenta: data.fiscalData.default_point_of_sale?.toString() || "",
            cuit: data.fiscalData.cuit || "",
            fechaInicio: data.fiscalData.fecha_inicio
              ? new Date(data.fiscalData.fecha_inicio).toISOString().split("T")[0]
              : "",
            razonSocial: data.fiscalData.business_name || "",
            domicilio: data.fiscalData.domicilio || "",
          });
          setHasSavedFiscalData(true);
          setIsFiscalLocked(true);
        }

        const certStatus = data?.certificateStatus || 'no_cert';
        setCertificateStatus(certStatus);
        setCertificateAlias(data?.certificates?.alias || "");
        setCertificateUpdatedAt(data?.certificates?.updated_at || "");

        if (data?.hasCertificates) {
          setHasSavedCertificates(true);
          setIsCertificatesLocked(true);
          setCertificateExpirationDate(
            data?.certificates?.expiration_date
              ? new Date(data.certificates.expiration_date).toLocaleDateString("es-AR")
              : ""
          );
        } else {
          setHasSavedCertificates(false);
          setIsCertificatesLocked(false);
          setCertificateExpirationDate("");
        }

        if (data?.visualMapping?.mapping && typeof data.visualMapping.mapping === "object") {
          setMapping(data.visualMapping.mapping);
          setIsMappingLocked(Boolean(data.visualMapping.is_locked));
        } else {
          setMapping({});
          setIsMappingLocked(false);
        }

        if (data?.boardConfig && typeof data.boardConfig === "object") {
          setBoardConfig({
            status_column_id: data.boardConfig.status_column_id || "",
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
    setIsMappingLocked(true);

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

  useEffect(() => {
    if (activeSection !== "datos" && hasSavedFiscalData) {
      setIsFiscalLocked(true);
    }
    if (activeSection !== "certificados" && hasSavedCertificates) {
      setIsCertificatesLocked(true);
    }
    if (activeSection !== "mapping_v2" && mappingCompleted) {
      setIsMappingLocked(true);
    }
  }, [activeSection, hasSavedFiscalData, hasSavedCertificates, mappingCompleted]);

  const handleFiscalChange = (field, value) => {
    setFiscal((prev) => ({ ...prev, [field]: value }));
  };

  const handleFileChange = (e, type) => {
    const file = e.target.files[0];
    if (!file) return;
    if (type === "crt") setCrtFile(file);
    if (type === "key") setKeyFile(file);
  };

  const handleSaveFiscal = async () => {
    console.log("🚀 Iniciando guardado de datos fiscales...");
    console.log("📦 Contexto actual:", context);
    if (!context || !context.account) return;
    setIsLoading(true);
    try {
      const payload = {
        monday_account_id: context.account.id.toString(),
        board_id: boardId,
        view_id: viewIdFromHref,
        app_feature_id: appFeatureId,
        business_name: fiscal.razonSocial,
        cuit: fiscal.cuit,
        default_point_of_sale: parseInt(fiscal.puntoVenta) || 0,
        domicilio: fiscal.domicilio,
        fecha_inicio: fiscal.fechaInicio
      };

      const response = await api.post(`/companies`, payload);
      showToast("success", "Datos fiscales guardados correctamente");
      setHasSavedFiscalData(true);
      setIsFiscalLocked(true);
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
        await api.post(`/certificates`, formData, {
          headers: { "Content-Type": "multipart/form-data" }
        });
      showToast("success", "Certificados subidos correctamente");
      setHasSavedCertificates(true);
      setIsCertificatesLocked(true);
      setCertificateStatus("active");
      setCertFlow(null);
      setCrtFile(null);
      setKeyFile(null);
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
      setIsCertificatesLocked(true);
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
  const mappingStatus = isMappingLocked || mappingCompleted ? "complete" : "incomplete";
  const sectionStatus = {
    datos: fiscalStatus,
    certificados: certSidebarStatus,
    mapping_v2: mappingStatus,
  };

  const getStatusLabel = (status) => {
    if (status === "complete") return "Completo";
    return "Pendiente";
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

    if (!context?.account?.id || !boardId) {
      showToast("error", "No se pudo identificar cuenta/tablero para guardar el mapeo");
      return;
    }

    setIsLoading(true);
    try {
      await api.post(`/mappings`, {
        monday_account_id: context.account.id.toString(),
        board_id: boardId,
        view_id: viewIdFromHref,
        app_feature_id: appFeatureId,
        mapping,
        is_locked: true,
      });

      setIsMappingLocked(true);
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
      className={`invoice-preview-select ${hasValue ? "mapped" : "unmapped"} ${isMissing ? "highlight-missing" : ""} ${isMappingLocked ? "disabled" : ""}`}
      value={mapping[fieldId] || ""}
      onChange={e => {
        setMapping({...mapping, [fieldId]: e.target.value});
        if (isMissing) setMissingMappingFields(prev => prev.filter(f => f !== fieldId));
      }}
      title={placeholderText}
      disabled={isMappingLocked}
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
    <div className="app-container">
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
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">FE</div>
          <span className="sidebar-title">Facturación<br/>Electrónica</span>
        </div>

        <nav className="sidebar-nav">
          {MENU_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`sidebar-item ${activeSection === item.id ? "active" : ""}`}
              onClick={() => setActiveSection(item.id)}
            >
              <span className="sidebar-item-icon">{item.icon}</span>
              <span className="sidebar-item-content">
                <span>{item.label}</span>
                {sectionStatus[item.id] && (
                  <span className={`status-pill ${sectionStatus[item.id]}`}>
                    {getStatusLabel(sectionStatus[item.id])}
                  </span>
                )}
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-status">
            <span className={`status-dot ${context ? "online" : ""}`} />
            <span className="status-text">
              {context ? "Conectado" : "Sin contexto"}
            </span>
          </div>
        </div>
      </aside>

      {/* ─── CONTENIDO PRINCIPAL ─── */}
      <main className="main-content">
        <div style={{
          display:"inline-block", background:"#1f2937", color:"#fff",
          padding:"3px 10px", borderRadius:"12px", fontSize:"11px",
          fontFamily:"monospace", marginBottom:"8px", letterSpacing:"0.3px"
        }}>
          Build: {APP_BUILD_VERSION}
        </div>
        <div className={`section-status-banner ${apiStatus === "ok" ? "complete" : apiStatus === "error" ? "incomplete" : "neutral"}`} style={{ marginBottom: "14px" }}>
          {apiStatus === "ok" && (
            <><strong>Backend:</strong> conectado correctamente ({API_URL}).</>
          )}
          {apiStatus === "checking" && (
            <><strong>Backend:</strong> verificando conexión ({API_URL})...</>
          )}
          {apiStatus === "error" && (
            <><strong>Backend:</strong> sin conexión o URL incorrecta ({API_URL}). {apiError}</>
          )}
        </div>

        {isLoading && (
            <div className="loading-overlay">
                <div className="loader"></div>
                <p>Procesando datos de forma segura...</p>
            </div>
        )}

        {/* ═══ SECCIÓN: DATOS FISCALES ═══ */}
        {activeSection === "datos" && (
          <section className="section">
            <div className="section-header">
              <h1 className="section-title">Datos Fiscales</h1>
              <p className="section-subtitle">
                Completá la información de tu empresa para la facturación electrónica.
              </p>
            </div>

            <div className={`section-status-banner ${fiscalStatus}`}>
              {hasSavedFiscalData ? (
                <><strong>Estado:</strong> Datos fiscales ya guardados. Revisalos y actualizalos si cambió algo.</>
              ) : (
                <><strong>Estado:</strong> Faltan completar datos fiscales para continuar.</>
              )}
            </div>

            <fieldset className={`section-fieldset ${isFiscalLocked ? "locked" : ""}`} disabled={isFiscalLocked}>
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

            </fieldset>

            <div className="form-actions">
              {hasSavedFiscalData && (
                <button type="button" className="btn-secondary" onClick={() => setIsFiscalLocked((prev) => !prev)}>
                  {isFiscalLocked ? "Modificar" : "Bloquear"}
                </button>
              )}
              <button className="btn-primary" onClick={handleSaveFiscal} disabled={isLoading || isFiscalLocked}>
                {isLoading ? "Guardando..." : "Guardar Datos Fiscales"}
              </button>
            </div>

            {isFetchingSavedData && (
              <p className="fetching-text">Cargando datos guardados...</p>
            )}
          </section>
        )}

        {/* ═══ SECCIÓN: CERTIFICADOS ═══ */}
        {activeSection === "certificados" && (
          <section className="section">
            <div className="section-header">
              <h1 className="section-title">Certificados ARCA</h1>
              <p className="section-subtitle">
                Para facturar necesitás un certificado digital de ARCA (AFIP). Te guiamos paso a paso.
              </p>
            </div>

            {/* ── ESTADO: CERTIFICADO ACTIVO ── */}
            {certificateStatus === "active" && certFlow !== "guided" && certFlow !== "manual" && (
              <div className="cert-active-card">
                <div className="cert-active-header">
                  <div className="cert-active-icon">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00ca72" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                  </div>
                  <div>
                    <h2 className="cert-active-title">Certificado activo</h2>
                    <p className="cert-active-sub">Tu app está lista para facturar en ARCA.</p>
                  </div>
                </div>
                <div className="cert-active-details">
                  {certificateAlias && (
                    <div><span>Alias:</span> <strong>{certificateAlias}</strong></div>
                  )}
                  {certificateExpirationDate && (
                    <div>
                      <span>Vencimiento:</span> <strong>{certificateExpirationDate}</strong>
                      {certDaysBadge && (
                        <span className={`cert-days-badge ${certDaysBadge.cls}`}>{certDaysBadge.text}</span>
                      )}
                    </div>
                  )}
                </div>
                <div className="cert-active-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      const now = new Date();
                      const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
                      setAliasInput(`monday-facturacion-${ym}`);
                      setCertFlow("guided");
                      setGuidedStep(1);
                    }}
                  >
                    Renovar certificado
                  </button>
                  <button className="btn-text" onClick={() => { setCertFlow("manual"); setIsCertificatesLocked(false); }}>
                    Subir nuevos archivos manualmente
                  </button>
                </div>
              </div>
            )}

            {/* ── ESTADO: SOLICITUD PENDIENTE (recovery) ── */}
            {certificateStatus === "pending_crt" && certFlow !== "guided" && certFlow !== "manual" && (
              <div className="cert-pending-card">
                <div className="cert-pending-header">
                  <span className="cert-pending-dot" />
                  <div>
                    <h2 className="cert-active-title">Solicitud pendiente</h2>
                    <p className="cert-active-sub">
                      Generaste una solicitud{certificateAlias ? <> con alias <strong>{certificateAlias}</strong></> : null}
                      {certificateUpdatedAt ? <> el {new Date(certificateUpdatedAt).toLocaleDateString("es-AR")}</> : null}.
                      Falta subir el archivo <code>.crt</code> que te da ARCA.
                    </p>
                  </div>
                </div>
                <div className="cert-active-actions">
                  <button className="btn-primary" onClick={() => { setCertFlow("guided"); setGuidedStep(4); }}>
                    Continuar — subir el .crt
                  </button>
                  <button className="btn-secondary" onClick={handleRedownloadCsr}>
                    Re-descargar solicitud (.csr)
                  </button>
                  <button className="btn-text" onClick={() => { setCertFlow("guided"); setGuidedStep(1); }}>
                    Empezar de cero
                  </button>
                </div>
              </div>
            )}

            {/* ── ESTADO: SIN CERT + sin flujo elegido → dos tarjetas de entrada ── */}
            {certificateStatus === "no_cert" && certFlow === null && (
              <div className="cert-entry-grid">
                <button
                  type="button"
                  className="cert-entry-card primary"
                  onClick={() => { setCertFlow("guided"); setGuidedStep(1); }}
                >
                  <div className="cert-entry-badge">Recomendado</div>
                  <div className="cert-entry-icon">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#0073ea" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                  </div>
                  <h3>Crear certificado nuevo</h3>
                  <p>No tengo certificado ARCA todavía o quiero renovarlo. Te guiamos paso a paso.</p>
                  <span className="cert-entry-cta">Empezar →</span>
                </button>

                <button
                  type="button"
                  className="cert-entry-card"
                  onClick={() => setCertFlow("manual")}
                >
                  <div className="cert-entry-icon">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#676879" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3v5h5"/>
                    </svg>
                  </div>
                  <h3>Ya tengo mis archivos</h3>
                  <p>Generé antes mi <code>.crt</code> y <code>.key</code> por mi cuenta y los quiero subir.</p>
                  <span className="cert-entry-cta">Subir archivos →</span>
                </button>
              </div>
            )}

            {/* ── FLUJO GUIADO ── */}
            {certFlow === "guided" && (
              <div className="cert-guided">
                <div className="cert-guided-header">
                  <ol className="cert-stepper">
                    {[
                      { n: 1, label: "Confirmar datos" },
                      { n: 2, label: "Descargar solicitud" },
                      { n: 3, label: "Subir a ARCA" },
                      { n: 4, label: "Subir certificado" }
                    ].map((s) => (
                      <li
                        key={s.n}
                        className={`cert-step ${guidedStep === s.n ? "current" : ""} ${guidedStep > s.n ? "done" : ""}`}
                      >
                        <span className="cert-step-num">{guidedStep > s.n ? "✓" : s.n}</span>
                        <span className="cert-step-label">{s.label}</span>
                      </li>
                    ))}
                  </ol>
                  <button className="btn-text cert-guided-close" onClick={resetCertFlow}>Cambiar método</button>
                </div>

                {/* ─── PASO 1: Confirmar datos ─── */}
                {guidedStep === 1 && (
                  <div className="cert-step-panel">
                    <h3 className="cert-step-title">Confirmá los datos del certificado</h3>
                    <p className="cert-step-desc">
                      Estos datos van a ir en la solicitud que firmará ARCA. Si algo está mal, corregilo en la sección "Datos Fiscales" antes de continuar.
                    </p>

                    {certificateStatus === "active" && (
                      <div className="cert-warn-box">
                        <strong>Estás renovando tu certificado.</strong> Al generar una nueva solicitud, el certificado actual queda reemplazado y no vas a poder facturar hasta completar el paso 4 con el <code>.crt</code> nuevo. Además, usá un alias distinto al anterior — ARCA no permite repetirlos.
                      </div>
                    )}

                    {(!fiscal.razonSocial || !fiscal.cuit) ? (
                      <div className="cert-warn-box">
                        <strong>Faltan datos fiscales.</strong> Completá razón social y CUIT en la sección "Datos Fiscales" antes de generar la solicitud.
                      </div>
                    ) : (
                      <div className="cert-confirm-grid">
                        <div className="cert-confirm-row">
                          <span>Razón Social</span><strong>{fiscal.razonSocial || "—"}</strong>
                        </div>
                        <div className="cert-confirm-row">
                          <span>CUIT</span><strong>{fiscal.cuit || "—"}</strong>
                        </div>
                        <div className="cert-confirm-row">
                          <span>Alias del certificado</span>
                          <input
                            className="form-input cert-alias-input"
                            type="text"
                            value={aliasInput}
                            onChange={(e) => setAliasInput(e.target.value)}
                            placeholder="monday-facturacion"
                          />
                        </div>
                      </div>
                    )}

                    <div className="info-box">
                      <span className="info-box-icon">🔒</span>
                      <span>
                        <strong>Tu clave privada:</strong> se genera y guarda cifrada con AES-256. No la vas a ver ni descargar — no hace falta que la manejes.
                      </span>
                    </div>

                    <div className="form-actions">
                      <button className="btn-secondary" onClick={resetCertFlow}>Cancelar</button>
                      <button
                        className="btn-primary"
                        onClick={handleGenerateCsr}
                        disabled={isLoading || !fiscal.razonSocial || !fiscal.cuit || !aliasInput.trim()}
                      >
                        {isLoading ? "Generando..." : "Generar solicitud y descargar"}
                      </button>
                    </div>
                  </div>
                )}

                {/* ─── PASO 2 (opcional si ya se descargó) ─── */}
                {guidedStep === 2 && (
                  <div className="cert-step-panel">
                    <h3 className="cert-step-title">Descargá tu solicitud</h3>
                    <p className="cert-step-desc">
                      Si el archivo no se descargó, tocá el botón para bajarlo de nuevo.
                    </p>
                    <div className="form-actions">
                      <button className="btn-secondary" onClick={handleRedownloadCsr} disabled={isLoading}>
                        Re-descargar solicitud
                      </button>
                      <button className="btn-primary" onClick={() => setGuidedStep(3)}>
                        Ya lo tengo — siguiente
                      </button>
                    </div>
                  </div>
                )}

                {/* ─── PASO 3: Instrucciones ARCA ─── */}
                {guidedStep === 3 && (
                  <div className="cert-step-panel">
                    <h3 className="cert-step-title">Subí la solicitud a ARCA</h3>
                    <p className="cert-step-desc">
                      Seguí estos pasos en el portal de ARCA para que generen tu certificado.
                    </p>

                    <label className="cert-adhered-check">
                      <input
                        type="checkbox"
                        checked={serviceAdhered}
                        onChange={(e) => setServiceAdhered(e.target.checked)}
                      />
                      <span>Ya tengo adherido el servicio "Administración de Certificados Digitales" en ARCA</span>
                    </label>

                    <ol className="cert-instructions">
                      <li>
                        Entrá a <a href="https://auth.afip.gob.ar/contribuyente_/login.xhtml" target="_blank" rel="noreferrer">auth.afip.gob.ar</a> e iniciá sesión con tu CUIT y clave fiscal.
                      </li>
                      {!serviceAdhered && (
                        <>
                          <li>
                            Menú <strong>Administrador de Relaciones de Clave Fiscal</strong> → <strong>Adherir Servicio</strong>.
                          </li>
                          <li>
                            Buscá <strong>"Administración de Certificados Digitales"</strong> (AFIP / ARCA) → Confirmar adhesión.
                          </li>
                        </>
                      )}
                      <li>
                        Volvé al menú principal → entrá a <strong>Administración de Certificados Digitales</strong>.
                      </li>
                      <li>
                        Click en <strong>Agregar alias</strong>.
                      </li>
                      <li>
                        Pegá este alias:{" "}
                        <span className="cert-alias-copy">
                          <code>{certificateAlias || aliasInput}</code>
                          <button
                            type="button"
                            className="btn-text"
                            onClick={() => {
                              navigator.clipboard?.writeText(certificateAlias || aliasInput);
                              showToast("success", "Alias copiado");
                            }}
                          >Copiar</button>
                        </span>
                      </li>
                      <li>Adjuntá el archivo <code>.csr</code> que descargaste en el paso anterior.</li>
                      <li>Click <strong>Agregar alias</strong> → ARCA lo confirma y aparece en tu lista.</li>
                      <li>
                        Entrá al alias recién creado y <strong>descargá el archivo .crt</strong>.
                      </li>
                    </ol>

                    <div className="form-actions">
                      <button className="btn-secondary" onClick={() => setGuidedStep(2)}>Volver</button>
                      <a
                        className="btn-secondary"
                        href="https://auth.afip.gob.ar/contribuyente_/login.xhtml"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Abrir portal de ARCA
                      </a>
                      <button className="btn-primary" onClick={() => setGuidedStep(4)}>
                        Ya tengo el .crt — siguiente
                      </button>
                    </div>
                  </div>
                )}

                {/* ─── PASO 4: Subir .crt ─── */}
                {guidedStep === 4 && (
                  <div className="cert-step-panel">
                    <h3 className="cert-step-title">Subí el certificado que te dio ARCA</h3>
                    <p className="cert-step-desc">
                      Adjuntá el archivo <code>.crt</code> que descargaste del alias <strong>{certificateAlias || "—"}</strong>.
                    </p>

                    <div className="cards-row">
                      <div className="upload-card">
                        <div className="upload-card-header">
                          <h3>Certificado (.crt)</h3>
                          <p>Archivo que descargaste de ARCA</p>
                        </div>
                        {finalCrtFile ? (
                          <div className="upload-success">
                            <IconCheck />
                            <span>{finalCrtFile.name}</span>
                            <button className="btn-text" onClick={() => setFinalCrtFile(null)}>Cambiar</button>
                          </div>
                        ) : (
                          <label className="upload-zone" htmlFor="crt-final-upload">
                            <IconUpload />
                            <span className="upload-zone-text">Arrastrá o hacé clic para subir</span>
                            <span className="upload-zone-hint">.crt</span>
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
                    </div>

                    <div className="form-actions">
                      <button className="btn-secondary" onClick={() => setGuidedStep(3)}>Volver</button>
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

            {/* ── FLUJO MANUAL (legacy) ── */}
            {certFlow === "manual" && (
              <div className="cert-manual">
                <div className="cert-guided-header">
                  <h3 className="cert-step-title" style={{margin: 0}}>Subí tus archivos .crt y .key</h3>
                  <button className="btn-text cert-guided-close" onClick={resetCertFlow}>Cambiar método</button>
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
        {activeSection === "mapping_v2" && (
          <section className="section">
            <div className="section-header">
              <h1 className="section-title">Mapeo Visual de Factura</h1>
              <p className="section-subtitle">
                Mapeá las columnas haciendo click directamente en los campos de una factura modelo.
              </p>
            </div>

            <div className={`section-status-banner ${mappingStatus}`}>
              {isMappingLocked ? (
                <><strong>Estado:</strong> Mapeo visual guardado y bloqueado. Obligatorios: {mappedRequiredCount}/{requiredMappingFields.length} · Opcionales: {mappedOptionalCount}/{optionalMappingFields.length}.</>
              ) : (
                <><strong>Estado:</strong> Configurá el mapeo visual y guardalo. Obligatorios: {mappedRequiredCount}/{requiredMappingFields.length} · Opcionales: {mappedOptionalCount}/{optionalMappingFields.length} (necesarios para Factura A/B).</>
              )}
            </div>

            {columns.length === 0 && !isMappingLocked && (
              <div style={{
                background: "#fff8e1", border: "1.5px solid #f59e0b", borderRadius: "8px",
                padding: "10px 14px", marginBottom: "10px", color: "#7c5a00", fontSize: "13px"
              }}>
                <strong>Columnas no cargadas.</strong> Información de diagnóstico:
                <ul style={{margin:"6px 0 0 0", paddingLeft:"18px", fontSize:"12px"}}>
                  <li>boardId: <code>{String(context?.boardId ?? context?.locationContext?.boardId ?? "no disponible")}</code></li>
                  <li>context keys: <code>{context ? Object.keys(context).join(", ") : "null"}</code></li>
                  <li>Columnas ítem: {columns.length} · Subitems: {subitemColumns.length}</li>
                  {columnsLoadError && (
                    <li style={{color:"#a52020"}}>
                      Error:
                      <pre style={{
                        whiteSpace:"pre-wrap", wordBreak:"break-word",
                        background:"#fff", border:"1px solid #f0c0c0",
                        padding:"6px", borderRadius:"4px", fontSize:"11px",
                        maxHeight:"160px", overflow:"auto", margin:"4px 0 0 0"
                      }}>{columnsLoadError}</pre>
                    </li>
                  )}
                </ul>
                <button
                  style={{marginTop:"8px", padding:"4px 12px", fontSize:"12px", cursor:"pointer", background:"#f59e0b", border:"none", borderRadius:"4px", color:"#fff"}}
                  onClick={() => {
                    const bid = context?.boardId || context?.locationContext?.boardId;
                    if (!bid) { alert("boardId no disponible en el contexto"); return; }
                    setColumnsLoadError(null);
                    monday.api(`query { boards(ids: [${Number(bid)}]) { columns { id title type settings_str } } }`)
                      .then(res => {
                        console.log("[retry] respuesta cruda:", res);
                        const errs = res?.errors || res?.error_message;
                        if (errs) {
                          const msg = Array.isArray(errs) ? errs.map(e=>e.message||JSON.stringify(e)).join(" | ") : String(errs);
                          setColumnsLoadError("GraphQL: " + msg + "\nRaw: " + JSON.stringify(res).slice(0,500));
                          return;
                        }
                        const cols = (res.data?.boards?.[0]?.columns || [])
                          .filter(c => c.type !== "subtasks" && c.type !== "button" && c.type !== "formula")
                          .map(c => ({ value: c.id, label: c.title, type: c.type }));
                        setColumns(cols);
                        alert(`Cargadas ${cols.length} columnas: ${cols.map(c=>c.label).join(", ")}`);
                      })
                      .catch(e => {
                        console.error("[retry] error:", e);
                        const detail =
                          e?.errors?.map?.(x => x.message).join(" | ") ||
                          e?.data?.errors?.map?.(x => x.message).join(" | ") ||
                          e?.message ||
                          JSON.stringify(e);
                        setColumnsLoadError("Catch: " + detail);
                      });
                  }}
                >Reintentar carga de columnas</button>
              </div>
            )}

            {columns.length > 0 && subitemColumns.length === 0 && !isMappingLocked && (
              <div style={{
                background: "#fff8e1", border: "1.5px solid #f59e0b", borderRadius: "8px",
                padding: "10px 14px", marginBottom: "10px", color: "#7c5a00", fontSize: "13px"
              }}>
                <strong>Columnas de subitems no detectadas.</strong> Asegurate de que el tablero tenga al menos un subitem creado y recargá la vista.
              </div>
            )}

            {missingMappingFields.length > 0 && (
              <div style={{
                background: "#fff0f0", border: "1.5px solid #d83b3b", borderRadius: "8px",
                padding: "10px 14px", marginBottom: "10px", color: "#a52020", fontSize: "13px"
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

            {/* ── Mapeo de campos a nivel ITEM (cabecera) ── */}
            <div className="mapping-group">
              <h3 className="mapping-group-title">Columnas del Ítem (cabecera de factura)</h3>
              <div className="mapping-grid">
                <div className="mapping-field">
                  <span className="mapping-field-label">Fecha de Emisión <span className="req">*</span></span>
                  {renderVisualSelect("fecha_emision", "Fecha Emisión")}
                </div>
                <div className="mapping-field">
                  <span className="mapping-field-label">CUIT / DNI Receptor <span className="req">*</span></span>
                  {renderVisualSelect("receptor_cuit", "CUIT Receptor")}
                </div>
                <div className="mapping-field">
                  <span className="mapping-field-label">Condición de Venta</span>
                  {renderVisualSelect("condicion_venta", "Cond. Venta")}
                </div>
                <div className="mapping-field">
                  <span className="mapping-field-label">Fecha Servicio Desde</span>
                  {renderVisualSelect("fecha_servicio_desde", "Serv. Desde")}
                </div>
                <div className="mapping-field">
                  <span className="mapping-field-label">Fecha Servicio Hasta</span>
                  {renderVisualSelect("fecha_servicio_hasta", "Serv. Hasta")}
                </div>
                <div className="mapping-field">
                  <span className="mapping-field-label">Fecha Vto. Pago</span>
                  {renderVisualSelect("fecha_vto_pago", "Vto. Pago")}
                </div>
              </div>
            </div>

            {/* ── Mapeo de campos a nivel SUBITEM (líneas de factura) ── */}
            <div className="mapping-group">
              <h3 className="mapping-group-title">Columnas del Subítem (líneas de factura)</h3>
              <div className="mapping-grid">
                <div className="mapping-field">
                  <span className="mapping-field-label">Concepto / Detalle <span className="req">*</span></span>
                  {renderVisualSelect("concepto", "Concepto/Detalle", "subitem")}
                </div>
                <div className="mapping-field">
                  <span className="mapping-field-label">Cantidad <span className="req">*</span></span>
                  {renderVisualSelect("cantidad", "Cantidad", "subitem")}
                </div>
                <div className="mapping-field">
                  <span className="mapping-field-label">Precio Unitario <span className="req">*</span></span>
                  {renderVisualSelect("precio_unitario", "Precio Unitario", "subitem")}
                </div>
                <div className="mapping-field">
                  <span className="mapping-field-label">Prod / Serv <span className="req">*</span></span>
                  {renderVisualSelect("prod_serv", "Prod / Serv", "subitem")}
                </div>
                <div className="mapping-field">
                  <span className="mapping-field-label">Unidad de Medida</span>
                  {renderVisualSelect("unidad_medida", "U. Medida", "subitem")}
                </div>
                <div className="mapping-field">
                  <span className="mapping-field-label">Alícuota IVA %</span>
                  {renderVisualSelect("alicuota_iva", "IVA %", "subitem")}
                </div>
              </div>
            </div>

            <div className="form-actions" style={{marginTop: "20px"}}>
              <button type="button" className="btn-secondary" onClick={() => setIsMappingLocked((prev) => !prev)}>
                {isMappingLocked ? "Modificar" : "Bloquear"}
              </button>
              <button className="btn-primary" onClick={handleSaveVisualMapping} disabled={isMappingLocked}>
                Guardar Mapeo Visual
              </button>
            </div>
          </section>
        )}



      </main>
    </div>
  );
};

export default App;
