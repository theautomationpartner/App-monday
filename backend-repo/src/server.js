const express = require('express');
const cors = require('cors');
const multer = require('multer');
const CryptoJS = require('crypto-js');
const jwt = require('jsonwebtoken');
const forge = require('node-forge');
const PDFDocument = require('pdfkit');
const FormDataNode = require('form-data');
const db = require('./db');
require('dotenv').config();

// ─── Módulos de facturación ───────────────────────────────────────────────────
const afipAuthModule    = require('./modules/afipAuth');
const afipPadron        = require('./modules/afipPadron');
const invoiceRules      = require('./modules/invoiceRules');

// Inicializar SDK de monday code para inyectar env vars y secrets en process.env
try {
    const { EnvironmentVariablesManager, SecretsManager } = require('@mondaycom/apps-sdk');
    const envManager = new EnvironmentVariablesManager({ updateProcessEnv: true });
    const secretsManager = new SecretsManager();
    const secretKeys = ['MONDAY_CLIENT_SECRET', 'MONDAY_SIGNING_SECRET', 'MONDAY_OAUTH_SECRET', 'ENCRYPTION_KEY'];
    for (const key of secretKeys) {
        if (!process.env[key]) {
            const val = secretsManager.get(key);
            if (val) process.env[key] = val;
        }
    }
} catch (e) {
    // En desarrollo local el SDK no está disponible, se usa .env directamente
}

const app = express();

// Middlewares
app.use(cors({
    origin: '*', // Permitir cualquier origen (necesario para repos separados)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Multer en memoria (en Monday Code no persistimos archivos en disco)
const storage = multer.memoryStorage();
const upload = multer({ storage });

async function getCompanyByMondayAccountId(mondayAccountId) {
    const companyQuery = `
        SELECT id, monday_account_id, business_name, cuit, iva_condition, default_point_of_sale, address, start_date
        FROM companies
        WHERE monday_account_id::text = $1
        LIMIT 1;
    `;
    const companyResult = await db.query(companyQuery, [String(mondayAccountId)]);
    return companyResult.rows[0] || null;
}

/**
 * Chequea que toda la configuración necesaria para emitir una factura esté presente.
 * Devuelve { ready: boolean, missing: string[], company, certificate, mapping, boardConfig }.
 *
 * Si boardId es null, solo valida config a nivel cuenta (empresa + certificados).
 */
async function validateEmissionReadiness({ mondayAccountId, boardId = null }) {
    const missing = [];
    const company = await getCompanyByMondayAccountId(mondayAccountId);

    if (!company) {
        missing.push('datos_fiscales');
        return { ready: false, missing, company: null, certificate: null, mapping: null, boardConfig: null };
    }

    // Datos fiscales mínimos
    if (!company.business_name) missing.push('datos_fiscales.business_name');
    if (!company.cuit)          missing.push('datos_fiscales.cuit');
    if (!company.iva_condition) missing.push('datos_fiscales.iva_condition');
    if (!company.default_point_of_sale) missing.push('datos_fiscales.punto_venta');

    // Certificados AFIP
    const certResult = await db.query(
        'SELECT id, expiration_date FROM afip_credentials WHERE company_id = $1 LIMIT 1',
        [company.id]
    );
    const certificate = certResult.rows[0] || null;
    if (!certificate) {
        missing.push('certificados_afip');
    } else if (certificate.expiration_date && new Date(certificate.expiration_date) < new Date()) {
        missing.push('certificados_afip.expirados');
    }

    let mapping = null;
    let boardConfig = null;

    if (boardId) {
        const mappingResult = await db.query(
            `SELECT mapping_json FROM visual_mappings
             WHERE company_id=$1 AND board_id=$2
             ORDER BY updated_at DESC LIMIT 1`,
            [company.id, String(boardId)]
        );
        mapping = mappingResult.rows[0]?.mapping_json || null;
        if (!mapping) {
            missing.push('mapeo_columnas');
        } else {
            // Todas las columnas de la plantilla deben estar mapeadas (menos el nombre del item).
            const requiredKeys = [
                'fecha_emision', 'receptor_cuit', 'condicion_venta',
                'fecha_servicio_desde', 'fecha_servicio_hasta', 'fecha_vto_pago',
                'concepto', 'cantidad', 'precio_unitario', 'prod_serv',
                'unidad_medida', 'alicuota_iva',
            ];
            for (const k of requiredKeys) {
                if (!mapping[k]) missing.push(`mapeo_columnas.${k}`);
            }
        }

        const boardCfgResult = await db.query(
            `SELECT status_column_id, trigger_label, success_label, error_label, required_columns_json
             FROM board_automation_configs
             WHERE company_id=$1 AND board_id=$2
             ORDER BY updated_at DESC LIMIT 1`,
            [company.id, String(boardId)]
        );
        boardConfig = boardCfgResult.rows[0] || null;
        if (!boardConfig) {
            missing.push('board_config');
        } else {
            if (!boardConfig.status_column_id) missing.push('board_config.status_column_id');
            const reqCols = boardConfig.required_columns_json || [];
            const pdfCol = reqCols.find(c => c?.key === 'invoice_pdf');
            if (!pdfCol || !pdfCol.resolved_column_id) {
                missing.push('board_config.invoice_pdf_column');
            }
            const pendientes = reqCols.filter(c => c.status && c.status !== 'ok').map(c => c.key);
            if (pendientes.length > 0) missing.push(`board_config.columnas_pendientes:${pendientes.join(',')}`);
        }
    }

    return { ready: missing.length === 0, missing, company, certificate, mapping, boardConfig };
}

function formatMissingConfigError(missing) {
    const labels = {
        'datos_fiscales':                  'Datos fiscales de la empresa',
        'datos_fiscales.business_name':    'Razón social',
        'datos_fiscales.cuit':              'CUIT del emisor',
        'datos_fiscales.iva_condition':     'Condición IVA',
        'datos_fiscales.punto_venta':       'Punto de venta',
        'certificados_afip':                'Certificados AFIP (.crt + .key)',
        'certificados_afip.expirados':      'Certificados AFIP vencidos',
        'mapeo_columnas':                        'Mapeo visual de columnas del tablero',
        'mapeo_columnas.fecha_emision':          'Columna Fecha de Emisión (item)',
        'mapeo_columnas.receptor_cuit':          'Columna CUIT/DNI Receptor (item)',
        'mapeo_columnas.condicion_venta':        'Columna Condición de Venta (item)',
        'mapeo_columnas.fecha_servicio_desde':   'Columna Fecha Servicio Desde (item)',
        'mapeo_columnas.fecha_servicio_hasta':   'Columna Fecha Servicio Hasta (item)',
        'mapeo_columnas.fecha_vto_pago':         'Columna Fecha Vto. Pago (item)',
        'mapeo_columnas.concepto':               'Columna Concepto / nombre (subitem)',
        'mapeo_columnas.cantidad':               'Columna Cantidad (subitem)',
        'mapeo_columnas.precio_unitario':        'Columna Precio Unitario (subitem)',
        'mapeo_columnas.prod_serv':              'Columna Prod/Serv (subitem)',
        'mapeo_columnas.unidad_medida':          'Columna Unidad de Medida (subitem)',
        'mapeo_columnas.alicuota_iva':           'Columna Alícuota IVA % (subitem)',
        'board_config':                          'Configuración de automatización del tablero',
        'board_config.status_column_id':         'Columna de estado del tablero',
        'board_config.invoice_pdf_column':       'Columna Comprobante PDF (tipo Archivo, item)',
    };
    const list = missing.map(k => {
        if (k.startsWith('board_config.columnas_pendientes:')) {
            return `Columnas requeridas sin resolver: ${k.split(':')[1]}`;
        }
        return labels[k] || k;
    });
    return `Configuración incompleta. Falta: ${list.join(' · ')}`;
}

/**
 * Valida que todas las celdas requeridas del item tengan valores válidos antes
 * de llamar a AFIP. Se corre DESPUÉS de validateEmissionReadiness (que chequea
 * que las columnas estén mapeadas en la config) y ANTES de la primera llamada
 * externa. Si algo falla, tira un error con el detalle exacto de qué corregir.
 */
function validateItemDataCompleteness({ mainColumns, subitems, mapping }) {
    const errors = [];
    const VALID_ALICUOTAS = new Set(['0', '2.5', '5', '10.5', '21', '27']);
    const VALID_PROD_SERV = new Set(['servicio', 'producto']);

    const fechaEmision = getColumnTextById(mainColumns, mapping.fecha_emision);
    if (!fechaEmision) errors.push('Item: falta "Fecha de Emisión"');

    const condicionVenta = getColumnTextById(mainColumns, mapping.condicion_venta);
    if (!condicionVenta) errors.push('Item: falta "Condición de Venta"');

    if (!subitems || subitems.length === 0) {
        errors.push('El item no tiene subitems (al menos uno es obligatorio)');
        return { ok: false, errors };
    }

    let hayServicio = false;
    subitems.forEach(sub => {
        const name = sub.name || `#${sub.id}`;

        if (!sub.name || !String(sub.name).trim()) {
            errors.push(`Subitem "${name}": falta nombre (concepto)`);
        }

        const unidadMedida = getColumnTextById(sub.column_values, mapping.unidad_medida);
        if (!unidadMedida) errors.push(`Subitem "${name}": falta "Unidad de Medida"`);

        const cantNum = toNumberOrNull(getColumnTextById(sub.column_values, mapping.cantidad));
        if (cantNum === null || cantNum <= 0) {
            errors.push(`Subitem "${name}": "Cantidad" inválida (debe ser número > 0)`);
        }

        const precioNum = toNumberOrNull(getColumnTextById(sub.column_values, mapping.precio_unitario));
        if (precioNum === null || precioNum <= 0) {
            errors.push(`Subitem "${name}": "Precio Unitario" inválido (debe ser número > 0)`);
        }

        const prodServRaw = getColumnTextById(sub.column_values, mapping.prod_serv) || '';
        const prodServ = prodServRaw.toLowerCase().trim();
        if (!prodServ) {
            errors.push(`Subitem "${name}": falta "Prod/Serv"`);
        } else if (!VALID_PROD_SERV.has(prodServ)) {
            errors.push(`Subitem "${name}": "Prod/Serv" debe ser "servicio" o "producto" (actual: "${prodServRaw}")`);
        } else if (prodServ === 'servicio') {
            hayServicio = true;
        }

        const alicuotaRaw = getColumnTextById(sub.column_values, mapping.alicuota_iva) || '';
        const alicuotaNorm = String(alicuotaRaw).replace(/[^0-9.,]/g, '').replace(',', '.').trim();
        if (!alicuotaNorm) {
            errors.push(`Subitem "${name}": falta "Alícuota IVA %"`);
        } else if (!VALID_ALICUOTAS.has(alicuotaNorm)) {
            errors.push(`Subitem "${name}": "Alícuota IVA" inválida. Permitidas: 0, 2.5, 5, 10.5, 21, 27 (actual: "${alicuotaRaw}")`);
        }
    });

    if (hayServicio) {
        if (!getColumnTextById(mainColumns, mapping.fecha_servicio_desde)) {
            errors.push('Item: falta "Fecha Servicio Desde" (hay subitems de servicio)');
        }
        if (!getColumnTextById(mainColumns, mapping.fecha_servicio_hasta)) {
            errors.push('Item: falta "Fecha Servicio Hasta" (hay subitems de servicio)');
        }
        if (!getColumnTextById(mainColumns, mapping.fecha_vto_pago)) {
            errors.push('Item: falta "Fecha Vto. Pago" (hay subitems de servicio)');
        }
    }

    return { ok: errors.length === 0, errors };
}

function isMissingTableError(err) {
    return err?.code === '42P01';
}

/**
 * Devuelve TODOS los secretos candidatos para verificar JWTs de Monday.
 *
 * Monday firma con dos secretos distintos según el tipo de token:
 *   - sessionToken (monday.get("sessionToken") del frontend) → Client Secret de OAuth
 *   - Automation webhook (trigger de automation recipe)       → Signing Secret
 *
 * Para no tener que saber cuál corresponde a cada endpoint, intentamos
 * verificar con todos los secretos configurados en orden, aceptando el
 * primero que valide la firma.
 */
function getSessionSecrets() {
    const raw = [
        process.env.MONDAY_CLIENT_SECRET,
        process.env.MONDAY_SIGNING_SECRET,
        process.env.MONDAY_OAUTH_SECRET,
        process.env.CLIENT_SECRET,
    ];
    // Dedupe manteniendo orden
    const seen = new Set();
    const out = [];
    for (const s of raw) {
        if (s && !seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out;
}

function getSessionSecret() {
    return getSessionSecrets()[0] || null;
}

/**
 * Intenta verificar un JWT con cualquiera de los secretos configurados.
 * Devuelve el payload decodificado si alguno valida, o lanza el último error.
 */
function verifyWithAnySecret(token) {
    const secrets = getSessionSecrets();
    if (secrets.length === 0) {
        throw new Error('No hay secretos configurados (MONDAY_CLIENT_SECRET / MONDAY_SIGNING_SECRET)');
    }
    let lastErr;
    for (const s of secrets) {
        try {
            return jwt.verify(token, s);
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr;
}

const COMPROBANTE_STATUS_FLOW = {
    trigger: 'Crear Comprobante',
    processing: 'Creando Comprobante',
    success: 'Comprobante Creado',
    error: 'Error - Mirar Comentarios',
};

function parseAuthorizationToken(req) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || typeof authHeader !== 'string') return null;
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim();
    }
    return authHeader.trim();
}

function extractMondayIdentity(decodedToken) {
    const dat = decodedToken?.dat || decodedToken?.data || {};
    const accountId = dat.account_id || decodedToken?.account_id || decodedToken?.accountId || null;
    return {
        accountId: accountId ? String(accountId) : null,
        userId: null,
    };
}

function requireMondaySession(req, res, next) {
    const secrets = getSessionSecrets();
    if (secrets.length === 0) {
        console.log('[session] FAIL: no secrets configured');
        return res.status(500).json({ error: 'Falta configurar MONDAY_CLIENT_SECRET en el backend' });
    }

    const token = parseAuthorizationToken(req);
    console.log('[session]', req.method, req.path,
        'hasToken:', Boolean(token), 'len:', token ? token.length : 0,
        'numSecrets:', secrets.length);

    if (!token) {
        console.log('[session] FAIL: no authorization header');
        return res.status(401).json({ error: 'Falta Authorization Bearer sessionToken de monday' });
    }

    try {
        const decoded = verifyWithAnySecret(token);
        console.log('[session] verify OK, keys:', Object.keys(decoded).join(','),
            'exp:', decoded.exp, 'now:', Math.floor(Date.now() / 1000));
        const identity = extractMondayIdentity(decoded);
        if (!identity.accountId) {
            console.log('[session] FAIL: no accountId in token, payload:', JSON.stringify(decoded).slice(0, 400));
            return res.status(401).json({ error: 'sessionToken inválido: account_id ausente' });
        }

        req.mondayIdentity = identity;
        return next();
    } catch (err) {
        console.log('[session] FAIL: jwt.verify threw:', err.name, '-', err.message);
        try {
            const unsafe = jwt.decode(token);
            console.log('[session] unsafe decode:', JSON.stringify(unsafe).slice(0, 400));
        } catch (_) {}
        return res.status(401).json({ error: 'sessionToken inválido o vencido', details: err.message });
    }
}

function ensureAccountMatch(req, res, providedAccountId) {
    if (!req.mondayIdentity?.accountId || !providedAccountId) {
        res.status(401).json({ error: 'No se pudo validar la cuenta monday desde sessionToken' });
        return false;
    }

    if (String(req.mondayIdentity.accountId) !== String(providedAccountId)) {
        res.status(403).json({ error: 'Cuenta monday no autorizada para esta operación' });
        return false;
    }

    return true;
}

function createDebugId(prefix = 'dbg') {
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${Date.now()}_${random}`;
}

async function getUserTokenSchemaDiagnostics() {
    const diagnostics = {
        database: null,
        db_user: null,
        companies_monday_account_id_type: null,
        user_api_tokens_monday_user_id_type: null,
        user_api_tokens_v2_encrypted_api_token_type: null,
        user_api_tokens_v3_monday_account_id_type: null,
    };

    try {
        const dbInfoResult = await db.query('SELECT current_database() AS database, current_user AS db_user');
        if (dbInfoResult.rows[0]) {
            diagnostics.database = dbInfoResult.rows[0].database || null;
            diagnostics.db_user = dbInfoResult.rows[0].db_user || null;
        }

        const columnTypesResult = await db.query(
            `SELECT table_name, column_name, data_type
             FROM information_schema.columns
                         WHERE table_name IN ('companies', 'user_api_tokens', 'user_api_tokens_v2', 'user_api_tokens_v3')
                             AND column_name IN ('monday_account_id', 'monday_user_id', 'encrypted_api_token')`
        );

        for (const row of columnTypesResult.rows) {
            if (row.table_name === 'companies' && row.column_name === 'monday_account_id') {
                diagnostics.companies_monday_account_id_type = row.data_type;
            }
            if (row.table_name === 'user_api_tokens' && row.column_name === 'monday_user_id') {
                diagnostics.user_api_tokens_monday_user_id_type = row.data_type;
            }
            if (row.table_name === 'user_api_tokens_v2' && row.column_name === 'encrypted_api_token') {
                diagnostics.user_api_tokens_v2_encrypted_api_token_type = row.data_type;
            }
            if (row.table_name === 'user_api_tokens_v3' && row.column_name === 'monday_account_id') {
                diagnostics.user_api_tokens_v3_monday_account_id_type = row.data_type;
            }
        }
    } catch (diagErr) {
        diagnostics.diagnostics_error = diagErr.message;
    }

    return diagnostics;
}

function normalizePem(rawValue, label) {
    if (!rawValue) return '';
    const trimmed = String(rawValue).trim();
    if (trimmed.includes(`-----BEGIN ${label}-----`)) {
        return trimmed;
    }

    const body = trimmed
        .replace(/-----BEGIN[^-]+-----/g, '')
        .replace(/-----END[^-]+-----/g, '')
        .replace(/\s+/g, '');
    const chunks = body.match(/.{1,64}/g) || [];
    return `-----BEGIN ${label}-----\n${chunks.join('\n')}\n-----END ${label}-----`;
}

function getAfipEnvironment() {
    const env = (process.env.AFIP_ENV || 'homologation').toLowerCase();
    return env === 'production' ? 'production' : 'homologation';
}

function getAfipEndpoints() {
    const env = getAfipEnvironment();
    if (env === 'production') {
        return {
            wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
            wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
        };
    }

    return {
        wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
        wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
    };
}

function xmlEscape(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function extractXmlTag(xml, tagName) {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = String(xml || '').match(regex);
    return match?.[1]?.trim() || '';
}

async function afipGetLastVoucher({ token, sign, cuit, pointOfSale, cbteType }) {
    const endpoints = getAfipEndpoints();
    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">\n  <soapenv:Header/>\n  <soapenv:Body>\n    <ar:FECompUltimoAutorizado>\n      <ar:Auth>\n        <ar:Token>${xmlEscape(token)}</ar:Token>\n        <ar:Sign>${xmlEscape(sign)}</ar:Sign>\n        <ar:Cuit>${xmlEscape(cuit)}</ar:Cuit>\n      </ar:Auth>\n      <ar:PtoVta>${xmlEscape(pointOfSale)}</ar:PtoVta>\n      <ar:CbteTipo>${xmlEscape(cbteType)}</ar:CbteTipo>\n    </ar:FECompUltimoAutorizado>\n  </soapenv:Body>\n</soapenv:Envelope>`;

    const response = await fetch(endpoints.wsfe, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: 'http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado',
        },
        body: soapBody,
    });

    const xml = await response.text();
    if (!response.ok) {
        throw new Error(`FECompUltimoAutorizado HTTP ${response.status}: ${xml.slice(0, 500)}`);
    }

    const cbteNro = extractXmlTag(xml, 'CbteNro');
    const parsed = Number(cbteNro);
    if (!Number.isFinite(parsed)) {
        throw new Error(`No se pudo obtener último comprobante: ${xml.slice(0, 500)}`);
    }
    return parsed;
}

// Tipos de comprobante AFIP: A=1, B=6, C=11
const INVOICE_TYPE_CONFIG = {
    A: { cbteType: 1,  ivaRate: 0.21, requiresCuit: true  },
    B: { cbteType: 6,  ivaRate: 0.21, requiresCuit: false },
    C: { cbteType: 11, ivaRate: 0,    requiresCuit: false },
};

async function afipIssueFactura({ token, sign, cuit, pointOfSale, draft, invoiceType = 'C' }) {
    const config = INVOICE_TYPE_CONFIG[invoiceType];
    if (!config) throw new Error(`Tipo de factura no soportado: ${invoiceType}`);

    const endpoints = getAfipEndpoints();
    const { cbteType } = config;
    const lastVoucher = await afipGetLastVoucher({ token, sign, cuit, pointOfSale, cbteType });
    const nextVoucher = lastVoucher + 1;

    const docNumberDigits = String(draft.receptor_cuit_o_dni || '').replace(/\D/g, '');
    // A siempre requiere CUIT (docType=80), B/C: CUIT si 11 dígitos, DNI si 7-8, consumidor final si vacío
    const docType = draft.docTipo ?? (invoiceType === 'A'
        ? 80
        : (docNumberDigits.length === 11 ? 80 : (docNumberDigits.length >= 7 ? 96 : 99)));
    const docNumber = draft.docNro ?? (docNumberDigits ? Number(docNumberDigits) : 0);

    // Condición IVA del receptor (RG 5616 lo hizo obligatorio)
    // Códigos AFIP: 1=RI, 4=Exento, 5=CF, 6=Monotributista
    const condicionIvaMap = {
        RESPONSABLE_INSCRIPTO: 1,
        MONOTRIBUTO: 6,
        EXENTO: 4,
        CONSUMIDOR_FINAL: 5,
    };
    const condicionIvaReceptor = condicionIvaMap[draft.receptorCondicion] || 5;
    console.log(`[emit] WSFE params: docType=${docType}, docNumber=${docNumber}, condIvaRec=${condicionIvaReceptor} (${draft.receptorCondicion})`);

    const dateYYYYMMDD = String(draft.fecha_emision || '').replace(/-/g, '') || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    // Concepto AFIP: 1=Productos, 2=Servicios, 3=Productos y Servicios
    const conceptoAfip = draft.concepto_afip || 1;
    console.log(`[emit] WSFE Concepto: ${conceptoAfip} (1=Prod, 2=Serv, 3=Ambos)`);

    // Fechas de servicio (obligatorias si Concepto = 2 o 3)
    // Usar fechas mapeadas del draft si existen, sino la fecha de emisión como fallback
    const toYYYYMMDD = (val) => {
        if (!val) return dateYYYYMMDD;
        return String(val).replace(/-/g, '').slice(0, 8) || dateYYYYMMDD;
    };
    const fchServXml = (conceptoAfip === 2 || conceptoAfip === 3)
        ? `<ar:FchServDesde>${toYYYYMMDD(draft.fecha_servicio_desde)}</ar:FchServDesde>
            <ar:FchServHasta>${toYYYYMMDD(draft.fecha_servicio_hasta)}</ar:FchServHasta>
            <ar:FchVtoPago>${toYYYYMMDD(draft.fecha_vto_pago)}</ar:FchVtoPago>`
        : '';

    const totalAmount = Number(draft.importe_total || 0);

    // Usar importes pre-calculados del draft (ya tienen la alícuota real aplicada)
    const alicuotaIvaId = draft.alicuota_iva_id || 5; // Id AFIP (3=0%, 4=10.5%, 5=21%, 6=27%, 8=5%, 9=2.5%)
    const impNeto  = Number((draft.importe_neto || totalAmount).toFixed(2));
    const impIva   = Number((draft.importe_iva || 0).toFixed(2));
    const impTotal = Number((draft.importe_total || totalAmount).toFixed(2));

    // Alícuotas IVA (solo para A y B con IVA > 0)
    const alicuotasXml = (impIva > 0 && alicuotaIvaId !== 3)
        ? `<ar:Iva>
              <ar:AlicIva>
                <ar:Id>${alicuotaIvaId}</ar:Id>
                <ar:BaseImp>${impNeto.toFixed(2)}</ar:BaseImp>
                <ar:Importe>${impIva.toFixed(2)}</ar:Importe>
              </ar:AlicIva>
            </ar:Iva>`
        : '';

    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FECAESolicitar>
      <ar:Auth>
        <ar:Token>${xmlEscape(token)}</ar:Token>
        <ar:Sign>${xmlEscape(sign)}</ar:Sign>
        <ar:Cuit>${xmlEscape(cuit)}</ar:Cuit>
      </ar:Auth>
      <ar:FeCAEReq>
        <ar:FeCabReq>
          <ar:CantReg>1</ar:CantReg>
          <ar:PtoVta>${xmlEscape(pointOfSale)}</ar:PtoVta>
          <ar:CbteTipo>${cbteType}</ar:CbteTipo>
        </ar:FeCabReq>
        <ar:FeDetReq>
          <ar:FECAEDetRequest>
            <ar:Concepto>${conceptoAfip}</ar:Concepto>
            <ar:DocTipo>${docType}</ar:DocTipo>
            <ar:DocNro>${docNumber}</ar:DocNro>
            <ar:CondicionIVAReceptorId>${condicionIvaReceptor}</ar:CondicionIVAReceptorId>
            <ar:CbteDesde>${nextVoucher}</ar:CbteDesde>
            <ar:CbteHasta>${nextVoucher}</ar:CbteHasta>
            <ar:CbteFch>${dateYYYYMMDD}</ar:CbteFch>
            <ar:ImpTotal>${impTotal.toFixed(2)}</ar:ImpTotal>
            <ar:ImpTotConc>0.00</ar:ImpTotConc>
            <ar:ImpNeto>${impNeto.toFixed(2)}</ar:ImpNeto>
            <ar:ImpOpEx>0.00</ar:ImpOpEx>
            <ar:ImpTrib>0.00</ar:ImpTrib>
            <ar:ImpIVA>${impIva.toFixed(2)}</ar:ImpIVA>
            <ar:MonId>PES</ar:MonId>
            <ar:MonCotiz>1.000</ar:MonCotiz>
            ${fchServXml}
            ${alicuotasXml}
          </ar:FECAEDetRequest>
        </ar:FeDetReq>
      </ar:FeCAEReq>
    </ar:FECAESolicitar>
  </soapenv:Body>
</soapenv:Envelope>`;

    async function callWsfe(attempt) {
        try {
            const resp = await fetch(endpoints.wsfe, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml; charset=utf-8',
                    SOAPAction: 'http://ar.gov.afip.dif.FEV1/FECAESolicitar',
                },
                body: soapBody,
                signal: AbortSignal.timeout(30000),
            });
            const txt = await resp.text();
            return { resp, txt };
        } catch (err) {
            const cause = err.cause || {};
            const causeInfo = [cause.code, cause.errno, cause.message].filter(Boolean).join(' | ');
            console.warn(`[wsfe] FECAESolicitar attempt ${attempt} failed: ${err.message} | cause: ${causeInfo || 'n/a'}`);
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 2000));
                return callWsfe(attempt + 1);
            }
            throw new Error(`WSFE FECAESolicitar falló tras 2 intentos: ${err.message}${causeInfo ? ` (${causeInfo})` : ''}`);
        }
    }

    const { resp: response, txt: xml } = await callWsfe(1);
    if (!response.ok) {
        throw new Error(`FECAESolicitar HTTP ${response.status}: ${xml.slice(0, 500)}`);
    }

    const result = extractXmlTag(xml, 'Resultado');
    const cae = extractXmlTag(xml, 'CAE');
    const caeExpiration = extractXmlTag(xml, 'CAEFchVto');
    const observation = extractXmlTag(xml, 'Msg') || extractXmlTag(xml, 'Obs') || '';

    return {
        resultado: result || 'N/D',
        cae: cae || null,
        cae_vencimiento: caeExpiration || null,
        numero_comprobante: nextVoucher,
        tipo_comprobante: invoiceType,
        imp_neto: impNeto,
        imp_iva: impIva,
        observacion: observation || null,
        raw_xml: xml.slice(0, 2000),
    };
}

function toNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const normalized = String(value).trim().replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function getColumnTextById(columnValues, columnId) {
    if (!columnId) return '';
    const found = (columnValues || []).find((column) => column.id === columnId);
    return found?.text || '';
}

async function ensureInvoiceEmissionsTable() {
    await db.query(
        `CREATE TABLE IF NOT EXISTS invoice_emissions (
            id SERIAL PRIMARY KEY,
            company_id UUID NOT NULL,
            board_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            invoice_type TEXT NOT NULL,
            status TEXT NOT NULL,
            request_json JSONB,
            draft_json JSONB,
            afip_result_json JSONB,
            pdf_base64 TEXT,
            error_message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (company_id, board_id, item_id, invoice_type)
        )`
    );

    // Migracion: si la tabla se creo antes con company_id INTEGER, convertirla a UUID.
    // Como ninguna emision fue exitosa, es seguro truncar antes del ALTER.
    await db.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'invoice_emissions'
                  AND column_name = 'company_id'
                  AND data_type = 'integer'
            ) THEN
                TRUNCATE TABLE invoice_emissions;
                ALTER TABLE invoice_emissions ALTER COLUMN company_id TYPE UUID USING NULL;
            END IF;
        END $$;
    `);
}

async function ensureUserApiTokensTable() {
    await db.query(
        `CREATE TABLE IF NOT EXISTS user_api_tokens (
            id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            monday_user_id TEXT NOT NULL,
            encrypted_api_token TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (company_id, monday_user_id)
        )`
    );

    // Compatibility migration: some environments may have monday_user_id as INTEGER.
    // Monday user IDs can be UUID strings, so the column must be TEXT.
    await db.query(
        `ALTER TABLE user_api_tokens
         ALTER COLUMN monday_user_id TYPE TEXT
         USING monday_user_id::text`
    );
}

async function ensureUserApiTokensV2Table() {
    await db.query(
        `CREATE TABLE IF NOT EXISTS user_api_tokens_v2 (
            id SERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL UNIQUE,
            encrypted_api_token TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
    );
}

async function ensureUserApiTokensV3Table() {
    await db.query(
        `CREATE TABLE IF NOT EXISTS user_api_tokens_v3 (
            id SERIAL PRIMARY KEY,
            monday_account_id TEXT NOT NULL UNIQUE,
            encrypted_api_token TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
    );
}

// ─── Custom Trigger: tabla de suscripciones ─────────────────────────────────
async function ensureTriggerSubscriptionsTable() {
    await db.query(
        `CREATE TABLE IF NOT EXISTS trigger_subscriptions (
            id SERIAL PRIMARY KEY,
            subscription_id TEXT NOT NULL UNIQUE,
            monday_account_id TEXT NOT NULL,
            board_id TEXT NOT NULL,
            webhook_url TEXT NOT NULL,
            monday_webhook_id TEXT,
            status_column_id TEXT,
            trigger_value TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
    );
}

async function getStoredMondayUserApiToken({ mondayAccountId }) {
    if (!mondayAccountId) return null;

    await ensureUserApiTokensV3Table();

    const result = await db.query(
        `SELECT encrypted_api_token
         FROM user_api_tokens_v3
         WHERE monday_account_id = $1
         LIMIT 1`,
        [String(mondayAccountId)]
    );

    if (result.rows.length === 0) return null;

    const decrypted = CryptoJS.AES.decrypt(
        result.rows[0].encrypted_api_token,
        process.env.ENCRYPTION_KEY
    ).toString(CryptoJS.enc.Utf8);

    return decrypted || null;
}

async function getInvoicePdfColumnId({ companyId, boardId }) {
    if (!companyId || !boardId) return null;

    const configResult = await db.query(
        `SELECT required_columns_json
         FROM board_automation_configs
         WHERE company_id = $1
           AND board_id = $2
         ORDER BY updated_at DESC
         LIMIT 1`,
        [companyId, String(boardId)]
    );

    const requiredColumns = configResult.rows[0]?.required_columns_json;
    if (!Array.isArray(requiredColumns)) return null;

    const invoicePdfColumn = requiredColumns.find((column) => column?.key === 'invoice_pdf');
    const resolvedColumnId = invoicePdfColumn?.resolved_column_id;

    return resolvedColumnId ? String(resolvedColumnId) : null;
}

async function uploadPdfToMondayFileColumn({ apiToken, itemId, fileColumnId, pdfBuffer, filename }) {
    if (!apiToken || !itemId || !fileColumnId || !pdfBuffer) {
        console.log('[upload] missing inputs:', { apiToken: !!apiToken, itemId, fileColumnId, pdfBuffer: !!pdfBuffer });
        return { uploaded: false, reason: 'missing_upload_inputs' };
    }

    const safeColumnId = String(fileColumnId).replace(/"/g, '');
    const safeName = filename || 'comprobante.pdf';
    const query = `mutation add_file($file: File!) { add_file_to_column (file: $file, item_id: ${Number(itemId)}, column_id: "${safeColumnId}") { id } }`;

    console.log('[upload] query:', query);
    console.log('[upload] filename:', safeName, 'size:', pdfBuffer.length, 'bytes');

    // Usar form-data (npm) + https.request — probado localmente OK.
    // Node.js fetch nativo NO es compatible con form-data npm package.
    const https = require('https');
    const form = new FormDataNode();
    form.append('query', query);
    form.append('variables[file]', pdfBuffer, {
        filename: safeName,
        contentType: 'application/pdf',
    });

    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.monday.com',
            path: '/v2/file',
            method: 'POST',
            headers: {
                ...form.getHeaders(),
                Authorization: String(apiToken).trim(),
            },
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                console.log('[upload] response status:', res.statusCode, 'body:', body.slice(0, 500));

                if (res.statusCode >= 400) {
                    reject(new Error(`Monday file upload HTTP ${res.statusCode}: ${body.slice(0, 400)}`));
                    return;
                }

                let payload;
                try {
                    payload = JSON.parse(body);
                } catch {
                    reject(new Error(`Monday file upload: respuesta no es JSON: ${body.slice(0, 300)}`));
                    return;
                }

                if (payload?.errors?.length) {
                    reject(new Error(`Monday file upload error: ${JSON.stringify(payload.errors).slice(0, 400)}`));
                    return;
                }

                const uploadedAssetId = payload?.data?.add_file_to_column?.id || null;
                resolve({
                    uploaded: Boolean(uploadedAssetId),
                    asset_id: uploadedAssetId,
                });
            });
        });

        req.on('error', reject);
        form.pipe(req);
    });
}

/**
 * Genera un PDF de Factura C replicando el diseño oficial de ARCA.
 * Estructura: Original tag → Header (emisor | C | comprobante) → Período →
 * Receptor → Tabla items → Totales → Footer (ARCA + CAE).
 */
async function generateFacturaCPdfBuffer({ company, draft, afipResult, itemId }) {
    // ── Fetch QR code image ─────────────────────────────────────────
    let qrImageBuffer = null;
    try {
        const qrData = {
            ver: 1,
            fecha: draft.fecha_emision || new Date().toISOString().slice(0, 10),
            cuit: Number(String(company.cuit).replace(/\D/g, '')),
            ptoVta: Number(draft.punto_venta),
            tipoCmp: 11, // Factura C
            nroCmp: Number(afipResult?.numero_comprobante || 0),
            importe: Number(draft.importe_total || 0),
            moneda: 'PES',
            ctz: 1,
            tipoDocRec: Number(draft.docTipo ?? 99),
            nroDocRec: Number(draft.docNro ?? 0),
            tipoCodAut: 'E',
            codAut: Number(afipResult?.cae || 0),
        };
        const base64Payload = Buffer.from(JSON.stringify(qrData)).toString('base64');
        const arcaUrl = `https://www.afip.gob.ar/fe/qr/?p=${base64Payload}`;
        const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(arcaUrl)}`;
        const qrResp = await fetch(qrApiUrl);
        if (qrResp.ok) {
            qrImageBuffer = Buffer.from(await qrResp.arrayBuffer());
        }
    } catch (qrErr) {
        console.warn('[pdf] No se pudo generar QR:', qrErr.message);
    }

    return new Promise((resolve, reject) => {
        try {
            const { condicionLabel } = invoiceRules;
            const M = 28;
            const doc = new PDFDocument({ size: 'A4', margin: M });
            const buffers = [];
            doc.on('data', (chunk) => buffers.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            const W = 595.28 - M * 2;
            const colLeft = M;
            const colRight = M + W;

            // ── Helpers ──────────────────────────────────────────
            function fmtCuit(c) {
                const s = String(c || '').replace(/\D/g, '');
                return s.length === 11 ? `${s.slice(0,2)}-${s.slice(2,10)}-${s.slice(10)}` : (c || '');
            }
            function fmtMoney(n) {
                return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            }
            function padNum(n, len) { return String(n || '').padStart(len, '0'); }

            /** Formatea fechas: YYYY-MM-DD → DD/MM/YYYY, YYYYMMDD → DD/MM/YYYY, ya DD/MM/YYYY lo deja */
            function fmtDate(d) {
                if (!d || d === '-') return '-';
                // Si es un objeto Date, formatearlo directamente
                if (d instanceof Date) {
                    const dd = String(d.getDate()).padStart(2, '0');
                    const mm = String(d.getMonth() + 1).padStart(2, '0');
                    const yyyy = d.getFullYear();
                    return `${dd}/${mm}/${yyyy}`;
                }
                const s = String(d).trim();
                // YYYY-MM-DD
                if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10).split('-').reverse().join('/');
                // YYYYMMDD
                if (/^\d{8}$/.test(s)) return `${s.slice(6,8)}/${s.slice(4,6)}/${s.slice(0,4)}`;
                return s;
            }

            const pv = padNum(draft.punto_venta, 5);
            const nroComp = padNum(afipResult?.numero_comprobante, 8);
            const fechaEmision = fmtDate(draft.fecha_emision) || new Date().toLocaleDateString('es-AR');
            const caeVto = fmtDate(afipResult?.cae_vencimiento);
            const startDate = fmtDate(company.start_date);

            // ── Borde exterior ───────────────────────────────────
            const boxTop = M;
            const boxH = 700;
            doc.rect(colLeft, boxTop, W, boxH).stroke('#000');

            // ── ORIGINAL tag ─────────────────────────────────────
            let y = boxTop;
            doc.rect(colLeft, y, W, 16).stroke('#000');
            doc.fontSize(8).font('Helvetica-Bold')
               .text('O R I G I N A L', colLeft, y + 4, { width: W, align: 'center', characterSpacing: 3 });
            y += 16;

            // ── HEADER ROW ───────────────────────────────────────
            const headerH = 110;
            doc.rect(colLeft, y, W, headerH).stroke('#000');

            const leftW = W * 0.46;
            const centerW = W * 0.08;

            // Emisor (izquierda)
            let ey = y + 12;
            doc.fontSize(12).font('Helvetica-Bold')
               .text((company.business_name || '').toUpperCase(), colLeft + 8, ey, { width: leftW - 16, align: 'center' });
            ey += 22;
            doc.fontSize(8).font('Helvetica');
            doc.font('Helvetica-Bold').text('Razón Social: ', colLeft + 8, ey, { continued: true });
            doc.font('Helvetica').text((company.business_name || '').toUpperCase());
            ey += 12;
            doc.font('Helvetica-Bold').text('Domicilio Comercial: ', colLeft + 8, ey, { continued: true });
            doc.font('Helvetica').text((company.address || '-').toUpperCase());
            ey += 12;
            doc.font('Helvetica-Bold').text('Condición frente al IVA: ', colLeft + 8, ey, { continued: true });
            doc.font('Helvetica').text(condicionLabel(draft.emisorCondicion || '').toUpperCase());

            // Centro — caja con letra C
            const centerX = colLeft + leftW;
            const boxSize = 42;
            const boxX = centerX + (centerW - boxSize) / 2;
            doc.rect(boxX, y, boxSize, boxSize).stroke('#000');
            doc.fontSize(26).font('Helvetica-Bold')
               .text('C', boxX, y + 6, { width: boxSize, align: 'center' });
            doc.fontSize(6).font('Helvetica-Bold')
               .text('COD. 011', boxX, y + 34, { width: boxSize, align: 'center' });
            doc.moveTo(centerX + centerW / 2, y + boxSize).lineTo(centerX + centerW / 2, y + headerH).stroke('#000');

            // Comprobante (derecha)
            const rx = centerX + centerW + 8;
            let ry = y + 12;
            doc.fontSize(16).font('Helvetica-Bold').text('FACTURA', rx, ry);
            ry += 22;
            doc.fontSize(8).font('Helvetica-Bold')
               .text(`Punto de Venta: ${pv}    Comp. Nro: ${nroComp}`, rx, ry);
            ry += 12;
            doc.font('Helvetica-Bold').text('Fecha de Emisión: ', rx, ry, { continued: true });
            doc.font('Helvetica').text(fechaEmision);
            ry += 12;
            doc.font('Helvetica-Bold').text('CUIT: ', rx, ry, { continued: true });
            doc.font('Helvetica').text(fmtCuit(company.cuit));
            ry += 12;
            doc.font('Helvetica-Bold').text('Ingresos Brutos: ', rx, ry, { continued: true });
            doc.font('Helvetica').text(fmtCuit(company.cuit));
            ry += 12;
            doc.font('Helvetica-Bold').text('Fecha de Inicio de Actividades: ', rx, ry, { continued: true });
            doc.font('Helvetica').text(startDate);

            y += headerH;

            // ── PERÍODO ──────────────────────────────────────────
            const periodoH = 18;
            doc.rect(colLeft, y, W, periodoH).stroke('#000');
            doc.fontSize(7.5);
            const periodoY = y + 5;
            const thirdW = W / 3;
            doc.font('Helvetica-Bold').text('Período Facturado Desde: ', colLeft + 8, periodoY, { continued: true });
            doc.font('Helvetica').text(fmtDate(draft.fecha_servicio_desde) || fechaEmision);
            doc.font('Helvetica-Bold').text('Hasta: ', colLeft + thirdW + 8, periodoY, { continued: true });
            doc.font('Helvetica').text(fmtDate(draft.fecha_servicio_hasta) || fechaEmision);
            doc.font('Helvetica-Bold').text('Fecha de Vto. para el pago: ', colLeft + thirdW * 2 + 8, periodoY, { continued: true });
            doc.font('Helvetica').text(fmtDate(draft.fecha_vto_pago) || fechaEmision);
            y += periodoH;

            // ── RECEPTOR (2 columnas) ────────────────────────────
            const receptorH = 44;
            doc.rect(colLeft, y, W, receptorH).stroke('#000');
            const halfW = W / 2;
            let cy = y + 5;
            doc.fontSize(7.5);
            // Fila 1
            doc.font('Helvetica-Bold').text('CUIT: ', colLeft + 8, cy, { continued: true });
            doc.font('Helvetica').text(fmtCuit(draft.receptor_cuit_o_dni));
            doc.font('Helvetica-Bold').text('Apellido y Nombre / Razón Social: ', colLeft + halfW + 8, cy, { continued: true });
            doc.font('Helvetica').text((draft.receptor_nombre || '-').toUpperCase());
            cy += 12;
            // Fila 2
            doc.font('Helvetica-Bold').text('Condición frente al IVA: ', colLeft + 8, cy, { continued: true });
            doc.font('Helvetica').text(condicionLabel(draft.receptorCondicion || '').toUpperCase());
            doc.font('Helvetica-Bold').text('Domicilio: ', colLeft + halfW + 8, cy, { continued: true });
            doc.font('Helvetica').text((draft.receptor_domicilio || '-').toUpperCase());
            cy += 12;
            // Fila 3
            doc.font('Helvetica-Bold').text('Condición de venta: ', colLeft + 8, cy, { continued: true });
            doc.font('Helvetica').text((draft.condicion_venta || 'Contado').toUpperCase());
            y += receptorH;

            // ── TABLA DE ITEMS ───────────────────────────────────
            const cols = [
                { label: 'Código',              w: W * 0.08, align: 'center' },
                { label: 'Producto / Servicio',  w: W * 0.30, align: 'left'   },
                { label: 'Cantidad',             w: W * 0.08, align: 'right'  },
                { label: 'U. Medida',            w: W * 0.10, align: 'center' },
                { label: 'Precio Unit.',         w: W * 0.13, align: 'right'  },
                { label: '% Bonif',              w: W * 0.08, align: 'right'  },
                { label: 'Imp. Bonif.',          w: W * 0.10, align: 'right'  },
                { label: 'Subtotal',             w: W * 0.13, align: 'right'  },
            ];
            const rowH = 16;

            // Header de la tabla
            doc.rect(colLeft, y, W, rowH).fill('#f1f1f1').stroke('#000');
            let cx = colLeft;
            doc.fillColor('#000');
            for (const col of cols) {
                doc.rect(cx, y, col.w, rowH).stroke('#000');
                doc.fontSize(7).font('Helvetica-Bold')
                   .text(col.label, cx + 2, y + 4, { width: col.w - 4, align: 'center' });
                cx += col.w;
            }
            y += rowH;

            // Filas de items (campos: concept, quantity, unit_price)
            const lineas = draft.lineas || [];
            for (const line of lineas) {
                const qty = Number(line.quantity || line.cantidad || 0);
                const price = Number(line.unit_price || line.precio_unitario || 0);
                const subtotal = qty * price;
                cx = colLeft;
                const vals = [
                    '',
                    line.concept || line.descripcion || '',
                    String(qty),
                    'unidades',
                    fmtMoney(price),
                    '0,00',
                    '0,00',
                    fmtMoney(subtotal),
                ];
                for (let i = 0; i < cols.length; i++) {
                    doc.rect(cx, y, cols[i].w, rowH).stroke('#000');
                    doc.fontSize(7).font('Helvetica')
                       .text(vals[i], cx + 3, y + 4, { width: cols[i].w - 6, align: cols[i].align });
                    cx += cols[i].w;
                }
                y += rowH;
            }

            // Espacio vacío restante hasta totales
            const totalsY = boxTop + boxH - 50;
            if (y < totalsY) {
                doc.moveTo(colLeft, y).lineTo(colLeft, totalsY).stroke('#000');
                doc.moveTo(colRight, y).lineTo(colRight, totalsY).stroke('#000');
                y = totalsY;
            }

            // ── TOTALES ──────────────────────────────────────────
            doc.rect(colLeft, y, W, 50).stroke('#000');
            const labelW = 160;
            const valueW = 90;
            const totLabelX = colRight - labelW - valueW - 12;
            const totValueX = colRight - valueW - 8;
            let ty = y + 8;
            doc.fontSize(8);

            doc.font('Helvetica-Bold').text('Subtotal: $', totLabelX, ty, { width: labelW, align: 'right' });
            doc.font('Helvetica-Bold').text(fmtMoney(draft.importe_total), totValueX, ty, { width: valueW, align: 'right' });
            ty += 14;
            doc.font('Helvetica-Bold').text('Importe Otros Tributos: $', totLabelX, ty, { width: labelW, align: 'right' });
            doc.font('Helvetica-Bold').text('0,00', totValueX, ty, { width: valueW, align: 'right' });
            ty += 14;
            doc.font('Helvetica-Bold').text('Importe Total: $', totLabelX, ty, { width: labelW, align: 'right' });
            doc.font('Helvetica-Bold').text(fmtMoney(draft.importe_total), totValueX, ty, { width: valueW, align: 'right' });

            y = boxTop + boxH;

            // ── FOOTER (fuera del borde) ─────────────────────────
            y += 8;
            const footerY = y;

            // QR code (izquierda)
            if (qrImageBuffer) {
                try {
                    doc.image(qrImageBuffer, colLeft, footerY, { width: 60, height: 60 });
                } catch (imgErr) {
                    console.warn('[pdf] No se pudo insertar QR en PDF:', imgErr.message);
                }
            }

            // ARCA branding (centro-izquierda, al lado del QR)
            const arcaX = colLeft + (qrImageBuffer ? 68 : 0);
            doc.fontSize(16).font('Helvetica-Bold').text('ARCA', arcaX, footerY);
            doc.fontSize(5).font('Helvetica-Bold')
               .text('AGENCIA DE RECAUDACIÓN Y CONTROL ADUANERO', arcaX, footerY + 18);
            doc.fontSize(9).font('Helvetica-BoldOblique')
               .text('Comprobante Autorizado', arcaX, footerY + 28);
            doc.fontSize(5.5).font('Helvetica')
               .text('Esta Agencia no se responsabiliza por los datos ingresados en el detalle de la operación',
                      arcaX, footerY + 40);

            // CAE (derecha)
            doc.fontSize(8).font('Helvetica-Bold')
               .text(`CAE N°: ${afipResult?.cae || 'PENDIENTE'}`, colRight - 180, footerY + 18, { width: 180, align: 'right' });
            doc.fontSize(8).font('Helvetica')
               .text(`Fecha de Vto. de CAE: ${caeVto}`, colRight - 180, footerY + 30, { width: 180, align: 'right' });

            // Pág
            doc.fontSize(8).font('Helvetica')
               .text('Pág. 1/1', colLeft + W / 2 - 20, footerY + 24);

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// --- RUTAS ---

app.get('/api/health', async (req, res) => {
    try {
        await db.query('SELECT NOW()');
        res.json({ status: 'ok', message: 'Servidor y DB conectados' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/setup/:mondayAccountId', requireMondaySession, async (req, res) => {
    const { mondayAccountId } = req.params;
    const { board_id, view_id, app_feature_id } = req.query;

    if (!ensureAccountMatch(req, res, mondayAccountId)) return;

    console.log('🔎 setup request', {
        mondayAccountId,
        board_id: board_id || null,
        view_id: view_id || null,
        app_feature_id: app_feature_id || null
    });

    try {
        const company = await getCompanyByMondayAccountId(mondayAccountId);

        if (!company) {
            return res.json({
                hasFiscalData: false,
                hasCertificates: false,
                fiscalData: null,
                certificates: null,
                visualMapping: null,
                boardConfig: null,
                identifiers: {
                    monday_account_id: mondayAccountId,
                    board_id: board_id || null,
                    view_id: view_id || null,
                    app_feature_id: app_feature_id || null
                }
            });
        }

        const certResult = await db.query(
            'SELECT expiration_date FROM afip_credentials WHERE company_id = $1 LIMIT 1',
            [company.id]
        );

        let visualMapping = null;
        if (board_id) {
            const mappingResult = await db.query(
                `SELECT mapping_json, is_locked, updated_at
                 FROM visual_mappings
                 WHERE company_id = $1
                   AND board_id = $2
                   AND COALESCE(view_id, '') = COALESCE($3, '')
                   AND COALESCE(app_feature_id, '') = COALESCE($4, '')
                 LIMIT 1`,
                [company.id, String(board_id), view_id || null, app_feature_id || null]
            );

            if (mappingResult.rows.length > 0) {
                visualMapping = {
                    mapping: mappingResult.rows[0].mapping_json || {},
                    is_locked: mappingResult.rows[0].is_locked,
                    updated_at: mappingResult.rows[0].updated_at || null
                };
            }
        }

        let boardConfig = null;
        if (board_id) {
            try {
                const boardConfigResult = await db.query(
                    `SELECT status_column_id, trigger_label, success_label, error_label, required_columns_json, updated_at
                     FROM board_automation_configs
                     WHERE company_id = $1
                       AND board_id = $2
                       AND COALESCE(view_id, '') = COALESCE($3, '')
                       AND COALESCE(app_feature_id, '') = COALESCE($4, '')
                     LIMIT 1`,
                    [company.id, String(board_id), view_id || null, app_feature_id || null]
                );

                if (boardConfigResult.rows.length > 0) {
                    const row = boardConfigResult.rows[0];
                    boardConfig = {
                        status_column_id: row.status_column_id || '',
                        trigger_label: row.trigger_label || COMPROBANTE_STATUS_FLOW.trigger,
                        processing_label: COMPROBANTE_STATUS_FLOW.processing,
                        success_label: row.success_label || COMPROBANTE_STATUS_FLOW.success,
                        error_label: row.error_label || COMPROBANTE_STATUS_FLOW.error,
                        required_columns: row.required_columns_json || [],
                        updated_at: row.updated_at || null
                    };
                }
            } catch (boardConfigErr) {
                if (!isMissingTableError(boardConfigErr)) {
                    throw boardConfigErr;
                }
            }
        }

        res.json({
            hasFiscalData: true,
            hasCertificates: certResult.rows.length > 0,
            fiscalData: {
                business_name: company.business_name || '',
                cuit: company.cuit || '',
                iva_condition: company.iva_condition || '',
                default_point_of_sale: company.default_point_of_sale || '',
                domicilio: company.address || '',
                fecha_inicio: company.start_date || ''
            },
            certificates: certResult.rows[0] || null,
            visualMapping,
            boardConfig,
            identifiers: {
                monday_account_id: mondayAccountId,
                board_id: board_id || null,
                view_id: view_id || null,
                app_feature_id: app_feature_id || null
            }
        });
    } catch (err) {
        console.error('❌ Error al consultar setup inicial:', err);
        res.status(500).json({ error: 'Error al consultar datos guardados' });
    }
});

/**
 * Pre-flight: devuelve si todo está listo para emitir facturas.
 * Útil para que el frontend muestre el estado de preparación antes de disparar la automation.
 *
 * GET /api/preflight/:mondayAccountId?board_id=123
 * Respuesta: { ready: boolean, missing: string[], message: string }
 */
app.get('/api/preflight/:mondayAccountId', requireMondaySession, async (req, res) => {
    const { mondayAccountId } = req.params;
    const { board_id } = req.query;

    if (!ensureAccountMatch(req, res, mondayAccountId)) return;

    try {
        const readiness = await validateEmissionReadiness({
            mondayAccountId,
            boardId: board_id || null,
        });
        res.json({
            ready:   readiness.ready,
            missing: readiness.missing,
            message: readiness.ready
                ? 'Todo listo para emitir facturas'
                : formatMissingConfigError(readiness.missing),
        });
    } catch (err) {
        console.error('❌ Error en preflight:', err);
        res.status(500).json({ error: 'Error al verificar configuración' });
    }
});

app.get('/api/board-config/:mondayAccountId', requireMondaySession, async (req, res) => {
    const { mondayAccountId } = req.params;
    const { board_id, view_id, app_feature_id } = req.query;

    if (!ensureAccountMatch(req, res, mondayAccountId)) return;

    if (!board_id) {
        return res.status(400).json({ error: 'board_id es obligatorio' });
    }

    try {
        const company = await getCompanyByMondayAccountId(mondayAccountId);
        if (!company) {
            return res.json({ hasConfig: false, config: null });
        }

        const result = await db.query(
            `SELECT id, status_column_id, trigger_label, success_label, error_label, required_columns_json, updated_at
             FROM board_automation_configs
             WHERE company_id = $1
               AND board_id = $2
               AND COALESCE(view_id, '') = COALESCE($3, '')
               AND COALESCE(app_feature_id, '') = COALESCE($4, '')
             LIMIT 1`,
            [company.id, String(board_id), view_id || null, app_feature_id || null]
        );

        if (result.rows.length === 0) {
            return res.json({ hasConfig: false, config: null });
        }

        const row = result.rows[0];
        return res.json({
            hasConfig: true,
            config: {
                id: row.id,
                status_column_id: row.status_column_id || '',
                trigger_label: row.trigger_label || COMPROBANTE_STATUS_FLOW.trigger,
                processing_label: COMPROBANTE_STATUS_FLOW.processing,
                success_label: row.success_label || COMPROBANTE_STATUS_FLOW.success,
                error_label: row.error_label || COMPROBANTE_STATUS_FLOW.error,
                required_columns: row.required_columns_json || [],
                updated_at: row.updated_at || null
            }
        });
    } catch (err) {
        if (isMissingTableError(err)) {
            return res.status(503).json({
                error: 'Falta crear la tabla board_automation_configs en la base de datos'
            });
        }

        console.error('❌ Error al consultar configuración de tablero:', err);
        return res.status(500).json({ error: 'Error al consultar configuración de tablero' });
    }
});

app.post('/api/board-config', requireMondaySession, async (req, res) => {
    const {
        monday_account_id,
        board_id,
        view_id,
        app_feature_id,
        status_column_id,
        required_columns
    } = req.body;

    const accountId = String(monday_account_id || req.mondayIdentity.accountId || '');

    if (!accountId || !board_id || !status_column_id) {
        return res.status(400).json({ error: 'monday_account_id, board_id y status_column_id son obligatorios' });
    }

    if (!ensureAccountMatch(req, res, accountId)) return;

    if (!Array.isArray(required_columns)) {
        return res.status(400).json({ error: 'required_columns debe ser un array' });
    }

    try {
        const company = await getCompanyByMondayAccountId(accountId);
        if (!company) {
            return res.status(404).json({ error: 'Empresa no encontrada' });
        }

        // Match sólo por company + board. view_id / app_feature_id cambian cada
        // vez que se publica una versión nueva de la app; incluirlos en el WHERE
        // hacía que cada deploy insertara una fila nueva con config vacía.
        const updateResult = await db.query(
            `UPDATE board_automation_configs
             SET status_column_id = $3,
                 view_id = $4,
                 app_feature_id = $5,
                 trigger_label = $6,
                 success_label = $7,
                 error_label = $8,
                 required_columns_json = $9,
                 updated_at = CURRENT_TIMESTAMP
             WHERE company_id = $1
               AND board_id = $2
             RETURNING *`,
            [
                company.id,
                String(board_id),
                String(status_column_id),
                view_id || null,
                app_feature_id || null,
                COMPROBANTE_STATUS_FLOW.trigger,
                COMPROBANTE_STATUS_FLOW.success,
                COMPROBANTE_STATUS_FLOW.error,
                JSON.stringify(required_columns)
            ]
        );

        if (updateResult.rows.length > 0) {
            return res.json({ message: 'Configuración de tablero actualizada', config: updateResult.rows[0] });
        }

        const insertResult = await db.query(
            `INSERT INTO board_automation_configs (
                company_id,
                board_id,
                view_id,
                app_feature_id,
                status_column_id,
                trigger_label,
                success_label,
                error_label,
                required_columns_json
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *`,
            [
                company.id,
                String(board_id),
                view_id || null,
                app_feature_id || null,
                String(status_column_id),
                COMPROBANTE_STATUS_FLOW.trigger,
                COMPROBANTE_STATUS_FLOW.success,
                COMPROBANTE_STATUS_FLOW.error,
                JSON.stringify(required_columns)
            ]
        );

        return res.status(201).json({ message: 'Configuración de tablero creada', config: insertResult.rows[0] });
    } catch (err) {
        if (isMissingTableError(err)) {
            return res.status(503).json({
                error: 'Falta crear la tabla board_automation_configs en la base de datos'
            });
        }

        console.error('❌ Error al guardar configuración de tablero:', err);
        return res.status(500).json({
            error: 'Error al guardar configuración de tablero',
            details: err.message,
            code: err.code
        });
    }
});

const getUserApiTokenHandler = async (req, res) => {
    const { mondayAccountId } = req.params;
    if (!ensureAccountMatch(req, res, mondayAccountId)) return;

    try {
        const company = await getCompanyByMondayAccountId(mondayAccountId);
        if (!company) {
            return res.json({ has_token: false });
        }

        await ensureUserApiTokensV3Table();
        const tokenResult = await db.query(
            `SELECT id
             FROM user_api_tokens_v3
             WHERE monday_account_id = $1
             LIMIT 1`,
            [String(accountId)]
        );

        return res.json({ has_token: tokenResult.rows.length > 0 });
    } catch (err) {
        console.error('❌ Error al consultar token de usuario monday:', err);
        return res.status(500).json({ error: 'Error al consultar token de usuario' });
    }
};

app.get('/api/user-api-token/:mondayAccountId', requireMondaySession, getUserApiTokenHandler);
app.get('/api/user-api-token-v2/:mondayAccountId', requireMondaySession, getUserApiTokenHandler);

const saveUserApiTokenHandler = async (req, res) => {
    const { monday_account_id, api_token } = req.body;
    const accountId = String(monday_account_id || req.mondayIdentity.accountId || '');
    const debugId = createDebugId('save_token');

    if (!accountId) {
        return res.status(400).json({ error: 'monday_account_id es obligatorio' });
    }

    if (!ensureAccountMatch(req, res, accountId)) return;

    if (!api_token || !String(api_token).trim()) {
        return res.status(400).json({ error: 'api_token es obligatorio' });
    }

    if (!process.env.ENCRYPTION_KEY) {
        return res.status(500).json({ error: 'Falta ENCRYPTION_KEY en backend' });
    }

    try {
        console.log('ℹ️ saveUserApiToken start', {
            debug_id: debugId,
            account_id: accountId,
            token_length: String(api_token || '').length,
            identity_account_id: req.mondayIdentity?.accountId || null,
        });

        const company = await getCompanyByMondayAccountId(accountId);
        if (!company) {
            return res.status(404).json({ error: 'Empresa no encontrada' });
        }

        await ensureUserApiTokensV3Table();
        const encryptedToken = CryptoJS.AES.encrypt(String(api_token).trim(), process.env.ENCRYPTION_KEY).toString();

        await db.query(
            `INSERT INTO user_api_tokens_v3 (monday_account_id, encrypted_api_token)
             VALUES ($1, $2)
             ON CONFLICT (monday_account_id)
             DO UPDATE SET
               encrypted_api_token = EXCLUDED.encrypted_api_token,
               updated_at = CURRENT_TIMESTAMP`,
            [String(accountId), encryptedToken]
        );

        console.log('✅ saveUserApiToken success', {
            debug_id: debugId,
            company_id: company.id,
            storage: 'user_api_tokens_v3',
        });

        return res.json({
            message: 'Token de usuario guardado correctamente',
            debug_id: debugId,
        });
    } catch (err) {
        const diagnostics = await getUserTokenSchemaDiagnostics();
        console.error('❌ Error al guardar token de usuario monday:', {
            debug_id: debugId,
            error_message: err.message,
            error_code: err.code,
            error_detail: err.detail,
            error_where: err.where,
            diagnostics,
        });
        return res.status(500).json({
            error: 'Error al guardar token de usuario',
            details: err.message,
            code: err.code,
            debug_id: debugId,
        });
    }
};

app.post('/api/user-api-token', requireMondaySession, saveUserApiTokenHandler);
app.post('/api/user-api-token-v2', requireMondaySession, saveUserApiTokenHandler);

app.get('/api/mappings/:mondayAccountId', requireMondaySession, async (req, res) => {
    const { mondayAccountId } = req.params;
    const { board_id, view_id, app_feature_id } = req.query;

    if (!ensureAccountMatch(req, res, mondayAccountId)) return;

    if (!board_id) {
        return res.status(400).json({ error: 'board_id es obligatorio' });
    }

    try {
        const company = await getCompanyByMondayAccountId(mondayAccountId);
        if (!company) {
            return res.json({ hasMapping: false, mapping: null });
        }

        const mappingResult = await db.query(
            `SELECT id, mapping_json, is_locked, created_at, updated_at
             FROM visual_mappings
             WHERE company_id = $1
               AND board_id = $2
               AND COALESCE(view_id, '') = COALESCE($3, '')
               AND COALESCE(app_feature_id, '') = COALESCE($4, '')
             LIMIT 1`,
            [company.id, String(board_id), view_id || null, app_feature_id || null]
        );

        if (mappingResult.rows.length === 0) {
            return res.json({ hasMapping: false, mapping: null });
        }

        return res.json({
            hasMapping: true,
            mapping: {
                id: mappingResult.rows[0].id,
                mapping: mappingResult.rows[0].mapping_json || {},
                is_locked: mappingResult.rows[0].is_locked,
                created_at: mappingResult.rows[0].created_at,
                updated_at: mappingResult.rows[0].updated_at
            }
        });
    } catch (err) {
        console.error('❌ Error al consultar mapeo visual:', err);
        return res.status(500).json({ error: 'Error al consultar mapeo visual' });
    }
});

app.post('/api/mappings', requireMondaySession, async (req, res) => {
    const {
        monday_account_id,
        board_id,
        view_id,
        app_feature_id,
        mapping,
        is_locked
    } = req.body;

    const accountId = String(monday_account_id || req.mondayIdentity.accountId || '');

    if (!accountId || !board_id) {
        return res.status(400).json({ error: 'monday_account_id y board_id son obligatorios' });
    }

    if (!ensureAccountMatch(req, res, accountId)) return;

    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        return res.status(400).json({ error: 'mapping debe ser un objeto JSON valido' });
    }

    try {
        const company = await getCompanyByMondayAccountId(accountId);
        if (!company) {
            return res.status(404).json({ error: 'Empresa no encontrada' });
        }

        const updateResult = await db.query(
            `UPDATE visual_mappings
             SET mapping_json = $5,
                 is_locked = COALESCE($6, is_locked),
                 updated_at = CURRENT_TIMESTAMP,
                 version = version + 1
             WHERE company_id = $1
               AND board_id = $2
               AND COALESCE(view_id, '') = COALESCE($3, '')
               AND COALESCE(app_feature_id, '') = COALESCE($4, '')
             RETURNING *`,
            [
                company.id,
                String(board_id),
                view_id || null,
                app_feature_id || null,
                JSON.stringify(mapping),
                typeof is_locked === 'boolean' ? is_locked : null
            ]
        );

        if (updateResult.rows.length > 0) {
            return res.json({ message: 'Mapeo visual actualizado', mapping: updateResult.rows[0] });
        }

        const insertResult = await db.query(
            `INSERT INTO visual_mappings (
                company_id,
                board_id,
                view_id,
                app_feature_id,
                mapping_json,
                is_locked
            ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, TRUE))
            RETURNING *`,
            [
                company.id,
                String(board_id),
                view_id || null,
                app_feature_id || null,
                JSON.stringify(mapping),
                typeof is_locked === 'boolean' ? is_locked : null
            ]
        );

        return res.status(201).json({ message: 'Mapeo visual creado', mapping: insertResult.rows[0] });
    } catch (err) {
        console.error('❌ Error al guardar mapeo visual:', err);
        return res.status(500).json({
            error: 'Error al guardar mapeo visual',
            details: err.message,
            code: err.code
        });
    }
});

app.post('/api/companies', requireMondaySession, async (req, res) => {
    const { monday_account_id, business_name, cuit, iva_condition, default_point_of_sale, domicilio, fecha_inicio } = req.body;
    const accountId = String(monday_account_id || req.mondayIdentity.accountId || '');

    if (!accountId) {
        return res.status(400).json({ error: 'monday_account_id es obligatorio' });
    }

    if (!ensureAccountMatch(req, res, accountId)) return;

    try {
        const query = `
            INSERT INTO companies (monday_account_id, business_name, cuit, iva_condition, default_point_of_sale, address, start_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (monday_account_id) 
            DO UPDATE SET 
                business_name = EXCLUDED.business_name,
                cuit = EXCLUDED.cuit,
                iva_condition = EXCLUDED.iva_condition,
                default_point_of_sale = EXCLUDED.default_point_of_sale,
                address = EXCLUDED.address,
                start_date = EXCLUDED.start_date,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *;
        `;
        const result = await db.query(query, [accountId, business_name, cuit, iva_condition, default_point_of_sale, domicilio, fecha_inicio]);
        res.json(result.rows[0]);
    } catch (err) {
        console.error("❌ Error en DB:", err);
        res.status(500).json({ 
            error: 'Error al guardar los datos fiscales',
            details: err.message,
            code: err.code 
        });
    }
});

app.post('/api/certificates', requireMondaySession, upload.fields([
    { name: 'crt', maxCount: 1 },
    { name: 'key', maxCount: 1 }
]), async (req, res) => {
    const { monday_account_id } = req.body;
    const accountId = String(monday_account_id || req.mondayIdentity.accountId || '');

    if (!accountId) {
        return res.status(400).json({ error: 'monday_account_id es obligatorio' });
    }

    if (!ensureAccountMatch(req, res, accountId)) return;

    const files = req.files;

    if (!files || !files['crt'] || !files['key']) {
        return res.status(400).json({ error: 'Faltan archivos' });
    }

    try {
        const companyRes = await db.query('SELECT id FROM companies WHERE monday_account_id = $1', [accountId]);
        if (companyRes.rows.length === 0) return res.status(404).json({ error: 'Empresa no encontrada' });
        
        const companyId = companyRes.rows[0].id;

        // Leemos el contenido desde la MEMORIA
        const crtContent = files['crt'][0].buffer.toString('utf8');
        const keyContent = files['key'][0].buffer.toString('utf8');

        // Extraer la fecha de vencimiento real desde el certificado
        let expirationDate;
        try {
            const cert = forge.pki.certificateFromPem(crtContent);
            expirationDate = cert.validity.notAfter;
        } catch (parseErr) {
            return res.status(400).json({
                error: 'El archivo .crt no es un certificado X.509 válido',
                details: parseErr.message,
            });
        }

        // Encriptamos la clave privada
        const encryptedKey = CryptoJS.AES.encrypt(keyContent, process.env.ENCRYPTION_KEY).toString();

        const query = `
            INSERT INTO afip_credentials (company_id, crt_file_url, encrypted_private_key, expiration_date)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (company_id)
            DO UPDATE SET
                crt_file_url = EXCLUDED.crt_file_url,
                encrypted_private_key = EXCLUDED.encrypted_private_key,
                expiration_date = EXCLUDED.expiration_date
            RETURNING *;
        `;

        // Guardamos el CONTENIDO del CRT directamente en el campo que antes era para la URL
        await db.query(query, [companyId, crtContent, encryptedKey, expirationDate]);

        res.json({ message: 'Certificados guardados en DB y clave encriptada correctamente' });
    } catch (err) {
        console.error("❌ Error al procesar certificados:", err);
        res.status(500).json({ 
            error: 'Error al procesar certificados',
            details: err.message,
            code: err.code
        });
    }
});


// ─── Custom Trigger: subscribe / unsubscribe / webhook ───────────────────────
// Cuando Monday activa una receta con nuestro custom trigger, llama a subscribe.
// Nos da un webhookUrl al que debemos POST cuando el trigger se dispare.
// Nosotros creamos un webhook en el board de Monday para escuchar cambios de columna.

app.post('/api/triggers/status-change/subscribe', requireAutomationBlock, async (req, res) => {
    try {
        await ensureTriggerSubscriptionsTable();

        const { payload } = req.body || {};
        const webhookUrl    = payload?.webhookUrl;
        const subscriptionId = String(payload?.subscriptionId || '');
        const inputFields   = payload?.inputFields || {};
        const boardId       = String(inputFields.boardId || '');
        const accountId     = String(req.mondayAutomation.accountId || '');

        console.log('[trigger-subscribe] webhookUrl:', webhookUrl);
        console.log('[trigger-subscribe] subscriptionId:', subscriptionId);
        console.log('[trigger-subscribe] inputFields:', JSON.stringify(inputFields));
        console.log('[trigger-subscribe] accountId:', accountId);

        if (!webhookUrl || !subscriptionId) {
            return res.status(400).json({ error: 'webhookUrl y subscriptionId son obligatorios' });
        }

        // Intentar token de usuario guardado, fallback a shortLivedToken
        let mondayToken = null;
        try {
            mondayToken = await getStoredMondayUserApiToken({ mondayAccountId: accountId });
        } catch (tokenErr) {
            console.log('[trigger-subscribe] Error obteniendo stored token:', tokenErr.message);
        }
        if (!mondayToken) mondayToken = req.mondayAutomation.shortLivedToken;

        let mondayWebhookId = null;

        if (boardId && mondayToken) {
            // Construir la URL base para nuestro webhook receiver
            const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
            const appBaseUrl = process.env.APP_BASE_URL
                || (req.headers.host ? `${proto}://${req.headers.host}` : '');
            const receiverUrl = `${appBaseUrl}/api/webhooks/monday-trigger`;

            console.log('[trigger-subscribe] Creando webhook en board', boardId, '→', receiverUrl);

            // Crear webhook en Monday para escuchar cambios de columnas
            const createWebhookMutation = `mutation {
                create_webhook(board_id: ${boardId}, url: "${receiverUrl}", event: change_column_value) {
                    id
                }
            }`;

            const whResponse = await fetch('https://api.monday.com/v2', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: mondayToken },
                body: JSON.stringify({ query: createWebhookMutation }),
            });
            const whData = await whResponse.json();
            mondayWebhookId = whData?.data?.create_webhook?.id || null;
            console.log('[trigger-subscribe] Monday webhook creado, id:', mondayWebhookId);

            if (whData.errors) {
                console.error('[trigger-subscribe] Monday webhook errors:', JSON.stringify(whData.errors));
            }
        } else {
            console.log('[trigger-subscribe] No se pudo crear webhook (boardId:', boardId, ', hasToken:', Boolean(mondayToken), ')');
        }

        // Guardar la suscripción en nuestra DB
        await db.query(
            `INSERT INTO trigger_subscriptions
                (subscription_id, monday_account_id, board_id, webhook_url, monday_webhook_id, status_column_id, trigger_value)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (subscription_id) DO UPDATE SET
                webhook_url = EXCLUDED.webhook_url,
                monday_webhook_id = EXCLUDED.monday_webhook_id,
                board_id = EXCLUDED.board_id,
                status_column_id = EXCLUDED.status_column_id,
                trigger_value = EXCLUDED.trigger_value`,
            [
                subscriptionId,
                accountId,
                boardId,
                webhookUrl,
                mondayWebhookId ? String(mondayWebhookId) : null,
                typeof inputFields.statusColumnId === 'string' ? inputFields.statusColumnId : (inputFields.statusColumnId?.id || inputFields.statusColumnId || null),
                inputFields.triggerValue ? JSON.stringify(inputFields.triggerValue) : null,
            ]
        );

        console.log('[trigger-subscribe] Suscripción guardada OK');
        // Monday espera { webhookId } como respuesta
        return res.status(200).json({ webhookId: subscriptionId });
    } catch (err) {
        console.error('[trigger-subscribe] ERROR:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/triggers/status-change/unsubscribe', requireAutomationBlock, async (req, res) => {
    try {
        await ensureTriggerSubscriptionsTable();

        const { payload } = req.body || {};
        const webhookId = String(payload?.webhookId || '');
        const accountId = String(req.mondayAutomation.accountId || '');

        console.log('[trigger-unsubscribe] webhookId (subscriptionId):', webhookId);

        if (!webhookId) {
            return res.status(200).json({ success: true }); // nada que borrar
        }

        // Buscar la suscripción para obtener el monday_webhook_id
        const subResult = await db.query(
            'SELECT monday_webhook_id FROM trigger_subscriptions WHERE subscription_id = $1',
            [webhookId]
        );
        const mondayWebhookId = subResult.rows[0]?.monday_webhook_id;

        // Intentar eliminar el webhook de Monday
        if (mondayWebhookId) {
            const mondayToken = req.mondayAutomation.shortLivedToken
                || await getStoredMondayUserApiToken({ mondayAccountId: accountId });
            if (mondayToken) {
                try {
                    const deleteMutation = `mutation { delete_webhook(id: ${mondayWebhookId}) { id } }`;
                    await fetch('https://api.monday.com/v2', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: mondayToken },
                        body: JSON.stringify({ query: deleteMutation }),
                    });
                    console.log('[trigger-unsubscribe] Monday webhook', mondayWebhookId, 'eliminado');
                } catch (e) {
                    console.log('[trigger-unsubscribe] No se pudo eliminar webhook:', e.message);
                }
            }
        }

        // Borrar suscripción de nuestra DB
        await db.query('DELETE FROM trigger_subscriptions WHERE subscription_id = $1', [webhookId]);
        console.log('[trigger-unsubscribe] Suscripción eliminada OK');

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('[trigger-unsubscribe] ERROR:', err.message);
        return res.status(200).json({ success: true }); // no fallar el unsubscribe
    }
});

// ─── Webhook receiver: Monday nos notifica cambios de columna en el board ────
// Cuando una columna cambia, verificamos si matchea alguna suscripción de trigger
// y si es así, llamamos al webhookUrl de Monday para disparar la receta.
app.post('/api/webhooks/monday-trigger', async (req, res) => {
    const body = req.body || {};

    // Monday envía un challenge la primera vez para verificar la URL
    if (body.challenge) {
        console.log('[webhook-trigger] Challenge recibido, respondiendo...');
        return res.status(200).json({ challenge: body.challenge });
    }

    const event = body.event || {};
    const boardId  = String(event.boardId || body.boardId || '');
    const itemId   = String(event.pulseId || event.itemId || '');
    const columnId = String(event.columnId || '');
    const newValue = event.value?.label?.text || event.value?.label?.index
        || (typeof event.value === 'string' ? event.value : '');

    console.log('[webhook-trigger] Evento recibido: board=', boardId, 'item=', itemId, 'col=', columnId);
    console.log('[webhook-trigger] Nuevo valor:', JSON.stringify(event.value));

    // Responder inmediatamente a Monday
    res.status(200).json({ ok: true });

    if (!boardId || !itemId) {
        console.log('[webhook-trigger] Sin boardId/itemId, ignorando');
        return;
    }

    // Buscar suscripciones que matcheen este board
    try {
        await ensureTriggerSubscriptionsTable();
        const subs = await db.query(
            'SELECT * FROM trigger_subscriptions WHERE board_id = $1',
            [boardId]
        );

        if (subs.rows.length === 0) {
            console.log('[webhook-trigger] No hay suscripciones para board', boardId);
            return;
        }

        for (const sub of subs.rows) {
            // Si la suscripción especifica una columna de estado, verificar que matchea
            if (sub.status_column_id && sub.status_column_id !== columnId) {
                continue;
            }

            // Si la suscripción especifica un valor trigger, verificar que matchea
            if (sub.trigger_value) {
                let triggerConfig;
                try { triggerConfig = JSON.parse(sub.trigger_value); } catch { triggerConfig = sub.trigger_value; }

                // Monday status columns: event.value puede ser { label: { index: N, text: "..." } }
                // o un JSON string con la misma estructura
                let eventValue = event.value;
                if (typeof eventValue === 'string') {
                    try { eventValue = JSON.parse(eventValue); } catch {}
                }

                const eventIndex = eventValue?.label?.index ?? eventValue?.index;
                const eventText  = eventValue?.label?.text  ?? eventValue?.text ?? '';

                let matches = false;
                if (typeof triggerConfig === 'object' && triggerConfig.index !== undefined) {
                    // Matchear por index del status column value
                    matches = (eventIndex !== undefined && String(eventIndex) === String(triggerConfig.index));
                } else {
                    // Matchear por texto
                    matches = (eventText.toLowerCase() === String(triggerConfig).toLowerCase());
                }

                console.log('[webhook-trigger] Matching: triggerConfig=', JSON.stringify(triggerConfig),
                    'eventIndex=', eventIndex, 'eventText=', eventText, 'matches=', matches);

                if (!matches) continue;
            }

            console.log('[webhook-trigger] ¡Match! Disparando trigger para sub', sub.subscription_id,
                '→ item', itemId);

            // Llamar al webhookUrl de Monday con los outputFields
            try {
                const triggerPayload = {
                    trigger: {
                        outputFields: {
                            itemId: parseInt(itemId, 10) || itemId,
                            boardId: parseInt(boardId, 10) || boardId,
                        },
                    },
                };
                console.log('[webhook-trigger] POST a webhookUrl:', sub.webhook_url);
                console.log('[webhook-trigger] Payload:', JSON.stringify(triggerPayload));

                const triggerResponse = await fetch(sub.webhook_url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(triggerPayload),
                });
                console.log('[webhook-trigger] Respuesta de Monday:', triggerResponse.status);
            } catch (e) {
                console.error('[webhook-trigger] Error llamando webhookUrl:', e.message);
            }
        }
    } catch (err) {
        console.error('[webhook-trigger] Error procesando evento:', err.message);
    }
});

// ─── Middleware para bloques de automatización de Monday ─────────────────────
// El JWT viene firmado con CLIENT_SECRET y contiene shortLivedToken, accountId, userId
function requireAutomationBlock(req, res, next) {
    console.log('[automation] ───── incoming request ─────');
    console.log('[automation] method:', req.method, 'path:', req.path);
    console.log('[automation] headers keys:', Object.keys(req.headers).join(', '));
    console.log('[automation] authorization header present:', Boolean(req.headers.authorization || req.headers.Authorization));
    console.log('[automation] content-type:', req.headers['content-type']);
    console.log('[automation] body keys:', req.body ? Object.keys(req.body).join(', ') : 'no body');
    try { console.log('[automation] body preview:', JSON.stringify(req.body).slice(0, 500)); } catch {}

    const secrets = getSessionSecrets();
    console.log('[automation] secrets configured:', secrets.length);
    if (secrets.length === 0) {
        console.log('[automation] FAIL: no secrets configured');
        return res.status(500).json({ error: 'Falta configurar MONDAY_CLIENT_SECRET / MONDAY_SIGNING_SECRET en el backend' });
    }
    const token = parseAuthorizationToken(req);
    console.log('[automation] token parsed:', Boolean(token), 'length:', token ? token.length : 0, 'preview:', token ? token.slice(0, 30) + '...' : 'none');
    if (!token) {
        console.log('[automation] FAIL: no token in authorization header');
        return res.status(401).json({ error: 'Falta Authorization Bearer token de monday' });
    }
    try {
        const decoded = verifyWithAnySecret(token);
        console.log('[automation] JWT verify OK, decoded keys:', Object.keys(decoded).join(', '));
        req.mondayAutomation = {
            accountId: String(decoded.accountId || decoded.dat?.account_id || ''),
            userId: String(decoded.userId || decoded.dat?.user_id || ''),
            shortLivedToken: decoded.shortLivedToken || decoded.shortLivedToken || decoded.dat?.shortLivedToken || null,
        };
        console.log('[automation] ready, accountId:', req.mondayAutomation.accountId, 'hasShortLivedToken:', Boolean(req.mondayAutomation.shortLivedToken));
        next();
    } catch (err) {
        console.log('[automation] FAIL: JWT verify threw:', err.message);
        // Intentar decodificar sin verificar para ver el contenido
        try {
            const decodedUnsafe = jwt.decode(token);
            console.log('[automation] token payload (unsafe decode):', JSON.stringify(decodedUnsafe).slice(0, 400));
        } catch (decodeErr) {
            console.log('[automation] no se pudo decodificar ni sin verificar:', decodeErr.message);
        }
        return res.status(401).json({ error: 'Token de automatización inválido', details: err.message });
    }
}

// ─── Endpoint unificado para bloques de automatización (A, B, C) ──────────────
// Monday llama a este endpoint cuando se dispara la receta.
// Flujo:
//   1. Responde 200 inmediatamente (monday requiere respuesta rápida)
//   2. En background: consulta padrón → valida tipo → emite → genera PDF → sube a monday
app.post('/api/invoices/emit', requireAutomationBlock, async (req, res) => {
    const { payload, runtimeMetadata } = req.body || {};
    const inbound      = payload?.inboundFieldValues || {};
    const inputFields  = payload?.inputFields || {};
    const triggerOutput = payload?.triggerOutputs || {};
    const callbackUrl  = payload?.callbackUrl || null;
    const actionUuid   = runtimeMetadata?.actionUuid || null;

    // Log completo del payload para debug
    console.log('[emit] ── payload completo ──');
    console.log('[emit] inboundFieldValues:', JSON.stringify(inbound));
    console.log('[emit] inputFields:', JSON.stringify(inputFields));
    console.log('[emit] triggerOutputs:', JSON.stringify(triggerOutput));
    console.log('[emit] payload keys:', Object.keys(payload || {}).join(', '));
    try { console.log('[emit] payload full (2000 chars):', JSON.stringify(payload).slice(0, 2000)); } catch {}

    const accountId   = String(req.mondayAutomation.accountId || inbound.accountId || '');

    // Buscar itemId en múltiples ubicaciones del payload de Monday
    const itemId = String(
        inbound.itemId
        || inputFields.itemId
        || triggerOutput.itemId
        || payload?.itemId
        || ''
    ).trim();

    // boardId: buscar en múltiples ubicaciones
    let boardId = String(
        inbound.boardId
        || inputFields.boardId
        || triggerOutput.boardId
        || payload?.boardId
        || ''
    ).trim();

    console.log(`[emit] Resolved: accountId=${accountId}, itemId=${itemId}, boardId=${boardId}`);

    // invoiceType puede venir del campo o se determina automáticamente desde el padrón
    const requestedType = (inbound.invoiceType || inputFields.invoiceType)
        ? String(inbound.invoiceType || inputFields.invoiceType).toUpperCase()
        : null; // null = determinar automáticamente

    if (requestedType && !['A', 'B', 'C'].includes(requestedType)) {
        return res.status(400).json({ error: `Tipo de factura inválido: ${requestedType}. Usar A, B o C.` });
    }
    if (!accountId || !itemId) {
        console.error('[emit] FAIL: faltan datos. accountId:', accountId, 'itemId:', itemId);
        return res.status(400).json({ error: 'itemId es obligatorio. Verificá la configuración de la receta en Monday.' });
    }

    // Responder inmediatamente (acción asíncrona de monday)
    res.status(200).json({ status: 'received', actionUuid });

    // ── Procesar en background ────────────────────────────────────────────────
    setImmediate(async () => {
        let afipResult  = null;
        let pdfBuffer   = null;
        let pdfBase64   = null;
        let mondayUpload = null;
        let resolvedType = requestedType;

        try {
            // ── 1. Empresa emisora ─────────────────────────────────────────────
            const company = await getCompanyByMondayAccountId(accountId);
            if (!company) throw new Error('Empresa no encontrada para la cuenta monday. Configurá los datos fiscales en la app.');

            await ensureInvoiceEmissionsTable();

            // ── 2. Token de monday + datos del item ────────────────────────────
            // Traemos el item primero para resolver boardId (si no vino en inboundFieldValues)
            const mondayToken = req.mondayAutomation.shortLivedToken
                || await getStoredMondayUserApiToken({ mondayAccountId: accountId });
            if (!mondayToken) throw new Error('No hay token de Monday para consultar el item');

            const itemData = await fetchMondayItem({ apiToken: mondayToken, itemId });
            const { mainColumns, subitems } = itemData;
            if (!boardId) boardId = itemData.boardId;
            if (!boardId) throw new Error(`No se pudo resolver boardId para item ${itemId}`);

            // ── 2b. Pre-flight 1: bloquear si falta configuración ──────────────
            console.log(`[emit] Emitiendo factura para item ${itemId} | Entorno: ${(process.env.AFIP_ENV || 'homologation').toUpperCase()}`);
            const readiness = await validateEmissionReadiness({ mondayAccountId: accountId, boardId });
            if (!readiness.ready) {
                console.warn(`[emit] Pre-flight falló:`, readiness.missing);
                throw new Error(formatMissingConfigError(readiness.missing));
            }

            // ── 2b-bis. Pre-flight 2: bloquear si faltan valores en celdas ─────
            const dataCheck = validateItemDataCompleteness({
                mainColumns,
                subitems,
                mapping: readiness.mapping,
            });
            if (!dataCheck.ok) {
                console.warn(`[emit] Validación de datos falló:`, dataCheck.errors);
                throw new Error(
                    'Item incompleto — corregí los siguientes datos antes de emitir:\n' +
                    dataCheck.errors.map(e => `• ${e}`).join('\n')
                );
            }

            // ── 2c. Cambiar status a "Creando Comprobante" ────────────────────
            const statusColumnId = readiness.boardConfig?.status_column_id;
            if (statusColumnId) {
                await updateMondayItemStatus({
                    apiToken: mondayToken, boardId, itemId,
                    statusColumnId,
                    label: COMPROBANTE_STATUS_FLOW.processing,
                });
            }

            // ── 3. Idempotencia ────────────────────────────────────────────────
            const typeForIdempotency = resolvedType || 'AUTO';
            const existing = await db.query(
                `SELECT id, status, afip_result_json FROM invoice_emissions
                 WHERE company_id=$1 AND board_id=$2 AND item_id=$3 AND invoice_type=$4 LIMIT 1`,
                [company.id, boardId, itemId, typeForIdempotency]
            );
            if (existing.rows[0]?.status === 'success') {
                const prevUpload = existing.rows[0].afip_result_json?.monday_upload;
                const uploadComplete = prevUpload?.uploaded === true
                    || prevUpload?.reason === 'no_column_configured';
                if (uploadComplete) {
                    console.log('[emit] Idempotencia: factura ya completa (CAE + upload OK), skip');
                    if (callbackUrl) await notifyCallback(callbackUrl, actionUuid, false,
                        `Factura ya emitida para este item (idempotencia)`);
                    return;
                }
                console.log('[emit] Row existe con CAE pero sin upload a Monday; borrando para reintentar');
                await db.query(`DELETE FROM invoice_emissions WHERE id=$1`, [existing.rows[0].id]);
            }

            await db.query(
                `INSERT INTO invoice_emissions (company_id, board_id, item_id, invoice_type, status, request_json)
                 VALUES ($1,$2,$3,$4,'processing',$5)
                 ON CONFLICT (company_id, board_id, item_id, invoice_type)
                 DO UPDATE SET status='processing', error_message=NULL, updated_at=CURRENT_TIMESTAMP`,
                [company.id, boardId, itemId, typeForIdempotency, JSON.stringify(inbound)]
            );

            // ── 4. Certificados AFIP del emisor ────────────────────────────────
            const certResult = await db.query(
                'SELECT id, crt_file_url, encrypted_private_key FROM afip_credentials WHERE company_id=$1 LIMIT 1',
                [company.id]
            );
            if (certResult.rows.length === 0) throw new Error('Faltan certificados AFIP para este emisor');

            const certRow = certResult.rows[0];
            const emisorCertPem = normalizePem(certRow.crt_file_url, 'CERTIFICATE');
            const decryptedKey  = CryptoJS.AES.decrypt(certRow.encrypted_private_key, process.env.ENCRYPTION_KEY)
                .toString(CryptoJS.enc.Utf8);
            const emisorKeyPem  = normalizePem(decryptedKey, 'PRIVATE KEY');

            // ── 5. Mapeo visual de columnas ────────────────────────────────────
            const mappingResult = await db.query(
                `SELECT mapping_json FROM visual_mappings WHERE company_id=$1 AND board_id=$2
                 ORDER BY updated_at DESC LIMIT 1`,
                [company.id, boardId]
            );
            if (!mappingResult.rows[0]?.mapping_json) throw new Error('Falta configurar el mapeo de columnas para este tablero');

            const mapping = mappingResult.rows[0].mapping_json;
            const fechaEmisionRaw = getColumnTextById(mainColumns, mapping.fecha_emision);
            const receptorCuitRaw = getColumnTextById(mainColumns, mapping.receptor_cuit) || null;
            const receptorNombre  = getColumnTextById(mainColumns, mapping.receptor_nombre) || null;
            const receptorDomicilio = getColumnTextById(mainColumns, mapping.receptor_domicilio) || null;
            const condicionVenta     = mapping.condicion_venta ? (getColumnTextById(mainColumns, mapping.condicion_venta) || null) : null;
            const fechaServDesdeRaw  = mapping.fecha_servicio_desde ? (getColumnTextById(mainColumns, mapping.fecha_servicio_desde) || null) : null;
            const fechaServHastaRaw  = mapping.fecha_servicio_hasta ? (getColumnTextById(mainColumns, mapping.fecha_servicio_hasta) || null) : null;
            const fechaVtoPagoRaw    = mapping.fecha_vto_pago ? (getColumnTextById(mainColumns, mapping.fecha_vto_pago) || null) : null;

            // ── 6. Consultar padrón: condición fiscal del EMISOR ──────────────
            console.log(`[emit] Consultando padrón para emisor CUIT: ${company.cuit}`);
            let emisorInfo;
            try {
                emisorInfo = await afipPadron.getCondicionFiscal({ cuitAConsultar: company.cuit, db });
            } catch (padronErr) {
                // Si el padrón falla, continuamos con la condición guardada en la DB (degraded mode)
                console.warn(`[emit] Padrón emisor falló (usando DB): ${padronErr.message}`);
                emisorInfo = {
                    condicion: (company.iva_condition || 'DESCONOCIDO').toUpperCase(),
                    nombre:    company.business_name,
                };
            }

            // ── 7. Consultar padrón: condición fiscal del RECEPTOR ────────────
            let receptorInfo = { condicion: 'CONSUMIDOR_FINAL', nombre: receptorNombre || 'Consumidor Final', domicilio: null, docTipo: 99, docNro: 0 };
            if (receptorCuitRaw) {
                const receptorDocClean = String(receptorCuitRaw).replace(/\D/g, '');
                if (receptorDocClean.length >= 7) {
                    console.log(`[emit] Consultando padrón para receptor doc: ${receptorDocClean}`);
                    try {
                        receptorInfo = await afipPadron.getCondicionFiscalByDoc({ documento: receptorDocClean, db });
                        console.log(`[emit] Receptor: ${receptorInfo.nombre}, condición: ${receptorInfo.condicion}, CUIT: ${receptorInfo.cuitUsado || receptorDocClean}`);
                    } catch (padronErr) {
                        console.warn(`[emit] Padrón receptor falló (usando CF por defecto): ${padronErr.message}`);
                    }
                }
            }

            // ── 8. Determinar tipo de factura fiscal correcto ─────────────────
            const { tipo, discriminaIva, descripcion } = invoiceRules.resolveInvoiceType({
                requestedType:    requestedType,
                emisorCondicion:  emisorInfo.condicion,
                receptorCondicion: receptorInfo.condicion,
                emisorNombre:     emisorInfo.nombre,
                receptorNombre:   receptorInfo.nombre,
            });
            resolvedType = tipo;
            console.log(`[emit] Tipo determinado: ${tipo} — ${descripcion}`);

            // ── 9. Construir draft de la factura ──────────────────────────────
            const rawLines = subitems.map(sub => ({
                subitem_name: sub.name || `Subitem #${sub.id}`,
                concept:    getColumnTextById(sub.column_values, mapping.concepto) || sub.name || '',
                quantity:   getColumnTextById(sub.column_values, mapping.cantidad),
                unit_price: getColumnTextById(sub.column_values, mapping.precio_unitario),
                prod_serv:  mapping.prod_serv ? (getColumnTextById(sub.column_values, mapping.prod_serv) || '').toLowerCase().trim() : '',
                alicuota_iva: mapping.alicuota_iva ? (getColumnTextById(sub.column_values, mapping.alicuota_iva) || '') : '',
                unidad_medida: mapping.unidad_medida ? (getColumnTextById(sub.column_values, mapping.unidad_medida) || '') : '',
            }));
            const validLines = rawLines.filter(l =>
                l.concept && toNumberOrNull(l.quantity) !== null && toNumberOrNull(l.unit_price) !== null
            );
            if (validLines.length === 0) {
                // Generar detalle de qué falta en cada subitem
                const detalles = rawLines.map(l => {
                    const faltantes = [];
                    if (!l.concept) faltantes.push('Concepto');
                    if (toNumberOrNull(l.quantity) === null) faltantes.push('Cantidad');
                    if (toNumberOrNull(l.unit_price) === null) faltantes.push('Precio Unitario');
                    return { name: l.subitem_name, faltantes };
                });
                const detalleStr = detalles
                    .map(d => `• "${d.name}": falta ${d.faltantes.join(', ')}`)
                    .join('\n');
                throw new Error(`No hay líneas válidas en subitems para emitir la factura.\n${subitems.length === 0 ? 'El item no tiene subitems creados.' : `Subitems con problemas:\n${detalleStr}`}`);
            }

            // Determinar Concepto AFIP: 1=Productos, 2=Servicios, 3=Ambos
            const hasProducto = validLines.some(l => l.prod_serv.includes('producto') || l.prod_serv.includes('prod'));
            const hasServicio = validLines.some(l => l.prod_serv.includes('servicio') || l.prod_serv.includes('serv'));
            let conceptoAfip = 1; // default: Productos
            if (hasProducto && hasServicio) conceptoAfip = 3;
            else if (hasServicio) conceptoAfip = 2;
            else conceptoAfip = 1;

            // Validar que todos los subitems tengan prod_serv si la columna está mapeada
            if (mapping.prod_serv) {
                const sinTipo = validLines.filter(l => !l.prod_serv);
                if (sinTipo.length > 0) {
                    console.warn(`[emit] ${sinTipo.length} subitem(s) sin Prod/Serv asignado, usando Producto por defecto`);
                }
            }
            console.log(`[emit] Concepto AFIP: ${conceptoAfip} (Producto: ${hasProducto}, Servicio: ${hasServicio})`);

            // Validar fechas de servicio obligatorias cuando hay servicios (concepto 2 o 3)
            const fechaEmision = fechaEmisionRaw || new Date().toISOString().slice(0, 10);
            if (conceptoAfip === 2 || conceptoAfip === 3) {
                const faltanFechas = [];
                if (!fechaServDesdeRaw) faltanFechas.push('Fecha Servicio Desde');
                if (!fechaServHastaRaw) faltanFechas.push('Fecha Servicio Hasta');
                if (!fechaVtoPagoRaw)   faltanFechas.push('Fecha Vto. Pago');
                if (faltanFechas.length > 0) {
                    throw new Error(
                        `Fechas de servicio obligatorias faltantes: ${faltanFechas.join(', ')}.\n` +
                        `Cuando el tipo de producto/servicio incluye servicios (Concepto AFIP: ${conceptoAfip === 2 ? 'Servicios' : 'Productos y Servicios'}), ` +
                        `AFIP exige las fechas del período facturado y el vencimiento de pago.`
                    );
                }
            }

            // ── Validar alícuota IVA uniforme en todos los subitems ──────────
            const ALICUOTA_MAP = {
                '0':    { id: 3, rate: 0 },
                '2.5':  { id: 9, rate: 0.025 },
                '5':    { id: 8, rate: 0.05 },
                '10.5': { id: 4, rate: 0.105 },
                '21':   { id: 5, rate: 0.21 },
                '27':   { id: 6, rate: 0.27 },
            };

            // Extraer y normalizar alícuota de cada subitem
            const alicuotasDetalle = validLines.map(l => {
                const raw = String(l.alicuota_iva).replace(/[^0-9.,]/g, '').replace(',', '.').trim();
                return { name: l.subitem_name, raw, normalized: raw || null };
            });

            // Verificar que todos tengan alícuota asignada
            const sinAlicuota = alicuotasDetalle.filter(a => !a.normalized);
            if (mapping.alicuota_iva && sinAlicuota.length > 0) {
                const nombres = sinAlicuota.map(a => `"${a.name}"`).join(', ');
                throw new Error(
                    `Alícuota IVA faltante en subitems: ${nombres}.\n` +
                    `Todos los subitems deben tener una alícuota IVA asignada (0, 2.5, 5, 10.5, 21 o 27).`
                );
            }

            // Verificar que todas las alícuotas sean iguales
            const alicuotasUnicas = [...new Set(alicuotasDetalle.map(a => a.normalized).filter(Boolean))];
            if (alicuotasUnicas.length > 1) {
                const detalle = alicuotasDetalle
                    .map(a => `• "${a.name}": ${a.normalized}%`)
                    .join('\n');
                throw new Error(
                    `Alícuotas IVA diferentes entre subitems.\n` +
                    `Todos los subitems deben tener la misma alícuota IVA. Alícuotas encontradas:\n${detalle}`
                );
            }

            // Determinar alícuota a usar
            const alicuotaElegida = alicuotasUnicas.length === 1 ? alicuotasUnicas[0] : '21';
            const alicuotaConfig = ALICUOTA_MAP[alicuotaElegida];
            if (!alicuotaConfig) {
                throw new Error(
                    `Alícuota IVA no válida: ${alicuotaElegida}%.\n` +
                    `Las alícuotas permitidas son: 0%, 2.5%, 5%, 10.5%, 21%, 27%.`
                );
            }
            console.log(`[emit] Alícuota IVA: ${alicuotaElegida}% (Id AFIP: ${alicuotaConfig.id}, Tasa: ${alicuotaConfig.rate})`);

            // Factura C no lleva IVA: si el usuario configuró una alícuota distinta de 0%, es un error de carga.
            if (tipo === 'C' && alicuotaElegida !== '0') {
                throw new Error(
                    `Alícuota IVA incompatible con Factura C.\n` +
                    `Configuraste ${alicuotaElegida}% pero las Facturas C no llevan IVA ` +
                    `(emisor ${emisorInfo.condicion}).\n` +
                    `Cambiá la alícuota de los subítems a 0% antes de emitir.`
                );
            }

            const lineas = validLines.map(l => ({
                concept:       l.concept,
                quantity:      toNumberOrNull(l.quantity) || 0,
                unit_price:    toNumberOrNull(l.unit_price) || 0,
                alicuota_iva:  l.alicuota_iva || '',
                unidad_medida: l.unidad_medida || '',
            }));

            const importeNeto  = lineas.reduce((s, l) => s + l.quantity * l.unit_price, 0);
            const ivaRate      = discriminaIva ? alicuotaConfig.rate : 0;
            const importeIva   = discriminaIva ? Number((importeNeto * ivaRate).toFixed(2)) : 0;
            const importeTotal = Number((importeNeto + importeIva).toFixed(2));

            const draft = {
                tipo_comprobante:    tipo,
                cuit_emisor:         company.cuit,
                punto_venta:         company.default_point_of_sale,
                fecha_emision:       fechaEmision,
                receptor_cuit_o_dni: receptorInfo.cuitUsado || receptorCuitRaw,
                receptor_nombre:     receptorInfo.nombre || receptorNombre,
                receptor_domicilio:  receptorInfo.domicilio || receptorDomicilio || '-',
                emisorCondicion:     emisorInfo.condicion,
                receptorCondicion:   receptorInfo.condicion,
                docTipo:             receptorInfo.docTipo ?? 99,
                docNro:              receptorInfo.docNro  ?? 0,
                concepto_afip:       conceptoAfip,
                discriminaIva,
                condicion_venta:     condicionVenta || 'Contado',
                fecha_servicio_desde: fechaServDesdeRaw || null,
                fecha_servicio_hasta: fechaServHastaRaw || null,
                fecha_vto_pago:       fechaVtoPagoRaw || null,
                alicuota_iva_id:     alicuotaConfig.id,
                alicuota_iva_pct:    alicuotaElegida,
                importe_neto:        Number(importeNeto.toFixed(2)),
                importe_iva:         importeIva,
                importe_total:       importeTotal,
                lineas,
            };

            // ── 10. Emitir en AFIP (WSFE) ─────────────────────────────────────
            const { token, sign } = await afipAuthModule.getToken({
                certPem: emisorCertPem, keyPem: emisorKeyPem,
                cuit: company.cuit, service: 'wsfe',
            });

            afipResult = await afipIssueFactura({
                token, sign,
                cuit:        company.cuit,
                pointOfSale: company.default_point_of_sale,
                draft,
                invoiceType: tipo,
            });

            console.log(`[emit] AFIP respuesta (${(process.env.AFIP_ENV || 'homologation').toUpperCase()}) — CAE: ${afipResult?.cae}, resultado: ${afipResult?.resultado}`);

            // ── 10b. Persistir CAE inmediatamente ──────────────────────────────
            // Guardamos el CAE ni bien AFIP lo aprueba, para que si algo crashea
            // después (pdfmake, upload a Monday) no perdamos el registro del CAE.
            try {
                await db.query(
                    `UPDATE invoice_emissions
                     SET draft_json=$5, afip_result_json=$6, updated_at=CURRENT_TIMESTAMP
                     WHERE company_id=$1 AND board_id=$2 AND item_id=$3 AND invoice_type=$4`,
                    [company.id, boardId, itemId, typeForIdempotency,
                     JSON.stringify(draft), JSON.stringify(afipResult)]
                );
                console.log('[emit] CAE persistido en DB');
            } catch (dbErr) {
                console.error('[emit] ⚠ Error persistiendo CAE en DB:', dbErr.message);
            }

            // ── 11. Generar PDF ────────────────────────────────────────────────
            if (afipResult?.cae) {
                console.log('[emit] Generando PDF…');
                try {
                    pdfBuffer = await generateFacturaCPdfBuffer({
                        company,
                        draft,
                        afipResult,
                        itemId,
                    });
                    pdfBase64 = pdfBuffer ? pdfBuffer.toString('base64') : null;
                    console.log(`[emit] PDF generado, ${pdfBuffer?.length || 0} bytes`);
                } catch (pdfErr) {
                    console.error('[emit] ⚠ Error generando PDF:', pdfErr.message);
                    console.error('[emit] stack:', pdfErr.stack?.slice(0, 800));
                    // seguimos sin PDF para que al menos el item se marque como éxito
                }
            }

            // ── 12. Subir PDF a Monday ─────────────────────────────────────────
            if (pdfBuffer && mondayToken) {
                console.log('[emit] Resolviendo columna de PDF en board', boardId);
                try {
                    const invoicePdfColumnId = await getInvoicePdfColumnId({ companyId: company.id, boardId });
                    console.log('[emit] invoicePdfColumnId:', invoicePdfColumnId);
                    if (invoicePdfColumnId) {
                        console.log('[emit] Subiendo PDF a Monday…');
                        const nroCompPadded = String(afipResult?.numero_comprobante || '').padStart(8, '0');
                        mondayUpload = await uploadPdfToMondayFileColumn({
                            apiToken: mondayToken, itemId,
                            fileColumnId: invoicePdfColumnId,
                            pdfBuffer,
                            filename: `Factura_${tipo}_Nro_${nroCompPadded}.pdf`,
                        });
                        console.log('[emit] PDF subido:', JSON.stringify(mondayUpload).slice(0, 300));
                    } else {
                        console.warn('[emit] No hay columna de PDF configurada (invoice_pdf) en el mapeo');
                        mondayUpload = { uploaded: false, reason: 'no_column_configured' };
                    }
                } catch (upErr) {
                    console.error('[emit] ⚠ Error subiendo PDF a Monday:', upErr.message);
                    mondayUpload = { uploaded: false, reason: 'upload_failed', details: upErr.message };
                }
            } else {
                console.warn('[emit] Saltando upload: pdfBuffer=', Boolean(pdfBuffer), 'mondayToken=', Boolean(mondayToken));
            }

            // ── 13. Persistir resultado final ──────────────────────────────────
            console.log('[emit] UPDATE final de invoice_emissions…');
            const finalAfipResult = afipResult
                ? { ...afipResult, monday_upload: mondayUpload }
                : null;
            await db.query(
                `UPDATE invoice_emissions
                 SET status=$5, draft_json=$6, afip_result_json=$7, pdf_base64=$8, updated_at=CURRENT_TIMESTAMP
                 WHERE company_id=$1 AND board_id=$2 AND item_id=$3 AND invoice_type=$4`,
                [
                    company.id, boardId, itemId, typeForIdempotency,
                    afipResult?.cae ? 'success' : 'prepared',
                    JSON.stringify(draft),
                    JSON.stringify(finalAfipResult),
                    pdfBase64,
                ]
            );

            // ── 14. Cambiar status a "Comprobante Creado" ──────────────────
            if (statusColumnId && afipResult?.cae) {
                await updateMondayItemStatus({
                    apiToken: mondayToken, boardId, itemId,
                    statusColumnId,
                    label: COMPROBANTE_STATUS_FLOW.success,
                });
            }

            if (callbackUrl) {
                await notifyCallback(callbackUrl, actionUuid, true, null, {
                    invoiceType:      tipo,
                    cae:              afipResult?.cae,
                    numero:           afipResult?.numero_comprobante,
                    emisorCondicion:  emisorInfo.condicion,
                    receptorCondicion: receptorInfo.condicion,
                });
            }

        } catch (err) {
            console.error(`❌ [emit] Error factura:`, err.message);

            // Cambiar status a "Error - Mirar Comentarios"
            try {
                const errToken = req.mondayAutomation?.shortLivedToken
                    || await getStoredMondayUserApiToken({ mondayAccountId: accountId });
                if (errToken && itemId && boardId) {
                    // Primero publicar el comentario con el error
                    await postMondayErrorComment({ apiToken: errToken, itemId, error: err });

                    // Luego cambiar el status
                    const readinessForErr = await validateEmissionReadiness({ mondayAccountId: accountId, boardId }).catch(() => null);
                    const errStatusColId = readinessForErr?.boardConfig?.status_column_id;
                    if (errStatusColId) {
                        await updateMondayItemStatus({
                            apiToken: errToken, boardId, itemId,
                            statusColumnId: errStatusColId,
                            label: COMPROBANTE_STATUS_FLOW.error,
                        });
                    }
                }
            } catch (_) {}

            // Persistir error en DB
            try {
                const company = await getCompanyByMondayAccountId(accountId);
                if (company) {
                    await db.query(
                        `UPDATE invoice_emissions
                         SET status='error', error_message=$5, updated_at=CURRENT_TIMESTAMP
                         WHERE company_id=$1 AND board_id=$2 AND item_id=$3 AND invoice_type=$4`,
                        [company.id, boardId, itemId, resolvedType || 'AUTO', err.message]
                    );
                }
            } catch (_) {}

            if (callbackUrl) await notifyCallback(callbackUrl, actionUuid, false, err.message);
        }
    });
});

// ─── Mapeo de errores → mensaje claro con HTML para Monday updates ───────────
function buildErrorComment(err) {
    const msg = err?.message || 'Error desconocido';

    // Extraer detalle de subitems si viene en el mensaje (líneas con "•")
    const lines = msg.split('\n');
    const mainMsg = lines[0];
    const subitemDetails = lines.filter(l => l.startsWith('•'));

    const KNOWN_ERRORS = [
        {
            match: /falta.*mapeo|falta.*configurar.*mapeo|falta.*mapping/i,
            title: 'Falta configurar el mapeo de columnas',
            detail: 'El tablero no tiene configurado qué columna corresponde a cada campo de la factura.',
            solucion: 'Abrí la vista de la app → sección <b>Mapeo Visual</b> → seleccioná las columnas y guardá.',
        },
        {
            match: /no hay.*subitems|no hay líneas|sin.*subitems|validLines.*0/i,
            title: 'Subitems incompletos o faltantes',
            detail: subitemDetails.length > 0
                ? 'Los siguientes subitems tienen campos vacíos o inválidos:<br/>' +
                  subitemDetails.map(l => l.replace('•', '').trim()).map(l => `&nbsp;&nbsp;- ${l}`).join('<br/>')
                : 'No se encontraron subitems con Concepto, Cantidad y Precio Unitario completos.',
            solucion: 'Revisá cada subitem del item y completá los campos obligatorios: <b>Concepto</b>, <b>Cantidad</b> (número) y <b>Precio Unitario</b> (número). Si no hay subitems, creá al menos uno.',
        },
        {
            match: /Configuración incompleta/i,
            title: 'Configuración incompleta',
            detail: mainMsg,
            solucion: 'Abrí la vista de la app → completá los pasos pendientes en <b>Mapeo Visual</b>. Asegurate de mapear todas las columnas obligatorias.',
        },
        {
            match: /faltan certificados|certificados.*afip|falta.*crt|falta.*key/i,
            title: 'Faltan los certificados AFIP',
            detail: 'No se encontraron certificados digitales para autenticar con AFIP.',
            solucion: 'Abrí la vista de la app → sección <b>Certificados ARCA</b> → cargá el archivo .crt y la clave privada (.key).',
        },
        {
            match: /certificados.*expirados|expir/i,
            title: 'Certificados AFIP expirados',
            detail: 'Los certificados digitales están vencidos y AFIP rechaza la autenticación.',
            solucion: 'Generá nuevos certificados en AFIP/ARCA y subílos en la vista de la app → sección <b>Certificados ARCA</b>.',
        },
        {
            match: /tipo de factura incorrecto|factura.*incorrecto|corresponde.*[ABC]/i,
            title: 'Tipo de factura incorrecto',
            detail: mainMsg,
            solucion: 'Verificá la condición IVA del emisor y receptor. El sistema determina automáticamente si corresponde Factura A, B o C.',
        },
        {
            match: /cuit.*inválido|cuit.*invalido|cuit.*vac|receptor_cuit.*null/i,
            title: 'CUIT / DNI del receptor inválido',
            detail: 'El campo CUIT / DNI del receptor está vacío o no tiene el formato correcto.',
            solucion: 'Completá la columna <b>CUIT / DNI Receptor</b> del item con exactamente 11 dígitos numéricos (ej: 20327446348). Sin guiones ni espacios.',
        },
        {
            match: /padrón.*error|padron.*error|padrón.*falló|padron.*fallo/i,
            title: 'Error consultando el Padrón AFIP',
            detail: 'No se pudo verificar la condición IVA del CUIT en los servidores de AFIP.',
            solucion: 'Verificá que el CUIT del receptor sea correcto. Si es correcto, reintentá en unos minutos (puede ser caída temporal de AFIP).',
        },
        {
            match: /empresa no encontrada|no encontrada.*cuenta/i,
            title: 'Empresa no configurada',
            detail: 'No se encontraron los datos fiscales de la empresa emisora.',
            solucion: 'Abrí la vista de la app → sección <b>Datos Fiscales</b> → completá Razón Social, CUIT, Punto de Venta y guardá.',
        },
        {
            match: /wsfe|wsaa|soap|afip.*http|loginCms|afip.*500|afip.*timeout/i,
            title: 'Error de comunicación con AFIP',
            detail: `Los servidores de AFIP respondieron con un error: ${mainMsg.substring(0, 150)}`,
            solucion: 'Los servidores de AFIP pueden tener mantenimiento. Reintentá en unos minutos. Si persiste, verificá que los certificados estén vigentes.',
        },
        {
            match: /token.*monday|no hay token|sessionToken/i,
            title: 'Error de autenticación con Monday',
            detail: 'No se pudo obtener un token válido para acceder a los datos del tablero.',
            solucion: 'Reintentá la operación. Si persiste, revisá que la app esté correctamente instalada en el workspace.',
        },
        {
            match: /fechas de servicio obligatorias|fecha servicio desde|fecha servicio hasta/i,
            title: 'Fechas de servicio obligatorias',
            detail: mainMsg,
            solucion: 'Completá las columnas <b>Fecha Servicio Desde</b> y <b>Fecha Servicio Hasta</b> en el item. Son obligatorias cuando los subitems incluyen servicios.',
        },
        {
            match: /alícuotas? iva diferentes|alícuotas? iva faltante|alícuota iva no válida/i,
            title: 'Alícuota IVA inválida',
            detail: subitemDetails.length > 0
                ? 'Los subitems tienen alícuotas IVA diferentes:<br/>' +
                  subitemDetails.map(l => l.replace('•', '').trim()).map(l => `&nbsp;&nbsp;- ${l}`).join('<br/>')
                : mainMsg,
            solucion: 'Todos los subitems de una factura deben tener la <b>misma alícuota IVA</b>. Revisá la columna Alícuota IVA % y asegurate de que todos los subitems tengan el mismo valor (0, 2.5, 5, 10.5, 21 o 27).',
        },
        {
            match: /idempotencia|ya emitida|ya completa/i,
            title: 'Factura ya emitida',
            detail: 'Este item ya tiene una factura emitida previamente.',
            solucion: 'Si necesitás emitir otra factura para este item, contactá al administrador.',
        },
    ];

    const known = KNOWN_ERRORS.find(e => e.match.test(msg));

    if (known) {
        return `<b>Error al emitir factura</b><br/><br/>` +
            `<b>Causa:</b> ${known.title}<br/>${known.detail}<br/><br/>` +
            `<b>Cómo solucionarlo:</b> ${known.solucion}`;
    }

    return `<b>Error al emitir factura</b><br/><br/>` +
        `<b>Causa:</b> ${mainMsg}<br/><br/>` +
        `<b>Cómo solucionarlo:</b> Revisá los datos del item y reintentá. Si el error persiste, revisá los logs en Developer Center → Registros.`;
}

/**
 * Publica un comentario/update en el item de monday explicando el error.
 */
async function postMondayErrorComment({ apiToken, itemId, error }) {
    const body = buildErrorComment(error);
    const mutation = `
        mutation {
            create_update(item_id: ${itemId}, body: ${JSON.stringify(body)}) {
                id
            }
        }
    `;
    await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: apiToken,
        },
        body: JSON.stringify({ query: mutation }),
    });
}

// Llamar al callbackUrl de Monday con el resultado de la acción asíncrona
async function notifyCallback(callbackUrl, actionUuid, success, errorMsg = null, outputFields = {}) {
    try {
        const body = success
            ? { success: true, actionUuid, outputFields }
            : { success: false, actionUuid,
                severityCode: 4000,
                notificationErrorTitle: 'Error al emitir factura',
                notificationErrorDescription: errorMsg || 'Error desconocido' };
        await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (e) {
        console.error('Error notificando callback:', e.message);
    }
}

// Obtener datos del item desde la API de Monday
async function fetchMondayItem({ apiToken, itemId }) {
    const query = `query {
        items(ids: [${itemId}]) {
            id name
            board { id }
            column_values { id text value }
            subitems {
                id name
                column_values { id text value }
            }
        }
    }`;
    const response = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiToken },
        body: JSON.stringify({ query }),
    });
    const data = await response.json();
    const item = data?.data?.items?.[0];
    if (!item) throw new Error(`Item ${itemId} no encontrado en Monday`);
    return {
        boardId: item.board?.id ? String(item.board.id) : null,
        mainColumns: item.column_values || [],
        subitems: (item.subitems || []).map(s => ({
            id: s.id, name: s.name, column_values: s.column_values || []
        })),
    };
}

// Actualizar el estado de un item en Monday (columna de status).
// Usa create_labels_if_missing para crear el label automáticamente si no existe.
async function updateMondayItemStatus({ apiToken, boardId, itemId, statusColumnId, label }) {
    if (!apiToken || !boardId || !itemId || !statusColumnId || !label) return;
    try {
        // change_column_value espera value como JSON string: "{\"label\":\"...\"}""
        const valueJson = JSON.stringify(JSON.stringify({ label }));
        const mutation = `mutation {
            change_column_value(
                board_id: ${Number(boardId)},
                item_id: ${Number(itemId)},
                column_id: "${statusColumnId}",
                value: ${valueJson},
                create_labels_if_missing: true
            ) { id }
        }`;
        const res = await fetch('https://api.monday.com/v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: apiToken },
            body: JSON.stringify({ query: mutation }),
        });
        const data = await res.json();
        if (data?.errors?.length) {
            console.error(`[status] Error cambiando status a "${label}":`, data.errors[0].message);
        } else {
            console.log(`[status] Status cambiado a "${label}" OK`);
        }
    } catch (err) {
        console.error(`[status] Exception cambiando status a "${label}":`, err.message);
    }
}

// Servir frontend React desde public/
const path = require('path');
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));
app.get('/*splat', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(publicPath, 'index.html'));
});

// Arranca el servidor (local y monday code)
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT} | AFIP_ENV: ${(process.env.AFIP_ENV || 'homologation').toUpperCase()}`));

module.exports = app;
