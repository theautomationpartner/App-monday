const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const CryptoJS = require('crypto-js');
const jwt = require('jsonwebtoken');
const forge = require('node-forge');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const FormDataNode = require('form-data');
const path = require('path');
const db = require('./db');
require('dotenv').config();

// ─── Módulos de facturación ───────────────────────────────────────────────────
const afipAuthModule    = require('./modules/afipAuth');
const afipPadron        = require('./modules/afipPadron');
const invoiceRules      = require('./modules/invoiceRules');
const { generateFacturaPdfBuffer } = require('./modules/invoicePdf');

// ─── Validación de inputs (Zod) ─────────────────────────────────────────────
const {
    validateBody,
    CompanySchema,
    BoardConfigSchema,
    MappingSchema,
    UserApiTokenSchema,
    CSRGenerateSchema,
} = require('./validation');

// ─── Cache del padrón del EMISOR en DB ───────────────────────────────────────
// La condición fiscal propia no cambia seguido y AFIP tarda 24-48h en reflejar
// cambios en el padrón A5 de todas formas. Guardamos el resultado en la tabla
// companies (padron_condicion, padron_fetched_at, etc.) para:
//   • Sobrevivir reinicios del container de Monday Code
//   • Funcionar aun cuando el usuario nunca abre la app (automation pura)
//   • Compartir el dato entre todas las instancias del servicio
//
// Invalidación:
//   • Al editar Datos Fiscales (POST /api/companies) → SET padron_fetched_at=NULL
//   • Al re-subir certificado → idem
//   • Cron diario 2am Argentina (5am UTC) refresca todas las empresas con
//     datos > 18h o con fetched_at NULL.
const PADRON_EMISOR_TTL_MS = 24 * 60 * 60 * 1000;    // 24 horas
const PADRON_EMISOR_STALE_MS = 18 * 60 * 60 * 1000;  // el cron refresca si > 18h

function normalizeCuit(cuit) {
    return String(cuit || '').replace(/\D/g, '');
}

// Devuelve la condición del emisor desde DB si está fresca, sino consulta AFIP
// y actualiza la DB. Si AFIP falla y hay dato viejo, usa ese con warning.
async function getOrRefreshEmisorPadron(company) {
    const cuit = normalizeCuit(company?.cuit);
    if (!cuit) throw new Error('La empresa no tiene CUIT configurado');

    const fetchedAt = company.padron_fetched_at
        ? new Date(company.padron_fetched_at).getTime()
        : 0;
    const ageMs = fetchedAt ? Date.now() - fetchedAt : Infinity;
    const hasCached = Boolean(company.padron_condicion) && fetchedAt > 0;

    // Cache hit: dato fresco en DB → usarlo.
    if (hasCached && ageMs < PADRON_EMISOR_TTL_MS) {
        console.log(`[padron-db] HIT — condición: ${company.padron_condicion} (edad: ${Math.round(ageMs/1000)}s)`);
        return {
            condicion: company.padron_condicion,
            nombre: company.padron_nombre || '',
            tipoPersona: company.padron_tipo_persona || '',
            domicilio: company.padron_domicilio || '',
        };
    }

    // Miss o stale → consultar AFIP.
    try {
        console.log(`[padron-db] MISS/stale (ageMs=${ageMs === Infinity ? 'null' : ageMs}) — consultando AFIP`);
        const info = await afipPadron.getCondicionFiscal({ cuitAConsultar: cuit });
        await db.query(
            `UPDATE companies
             SET padron_condicion=$1, padron_nombre=$2, padron_tipo_persona=$3,
                 padron_domicilio=$4, padron_fetched_at=NOW()
             WHERE id=$5`,
            [info.condicion, info.nombre || '', info.tipoPersona || '', info.domicilio || '', company.id]
        );
        return info;
    } catch (err) {
        // AFIP falló. Si tenemos dato viejo, usamos ese con warning.
        if (hasCached) {
            console.warn(`[padron-db] AFIP falló (${err.message}) — usando dato viejo (edad: ${Math.round(ageMs/1000/60)}min)`);
            return {
                condicion: company.padron_condicion,
                nombre: company.padron_nombre || '',
                tipoPersona: company.padron_tipo_persona || '',
                domicilio: company.padron_domicilio || '',
                _stale: true,
            };
        }
        throw err; // primera vez sin dato viejo → propagar
    }
}

// Invalida el cache en DB (para ser llamado al editar datos fiscales o certs).
async function invalidateEmisorPadronDb(companyId) {
    if (!companyId) return;
    try {
        await db.query(`UPDATE companies SET padron_fetched_at=NULL WHERE id=$1`, [companyId]);
        console.log(`[padron-db] invalidado para company ${companyId}`);
    } catch (err) {
        console.warn(`[padron-db] error invalidando company ${companyId}: ${err.message}`);
    }
}

// ─── Cache del padrón de RECEPTORES ─────────────────────────────────────────
// Cada factura consulta a AFIP la condición fiscal del cliente final (~8s).
// Como los clientes suelen ser recurrentes (SaaS, servicios, etc), cachear
// por documento (CUIT o DNI) ahorra esos 8s en todas las facturas siguientes
// al mismo receptor. Es un cache GLOBAL por documento — compartido entre
// todas las empresas usuarias del sistema.
//
// TTL: 24h. AFIP mismo tarda 24-48h en reflejar cambios en su padrón, así
// que cachear 24h no suma riesgo relevante. Si AFIP falla y tenemos dato
// viejo, lo usamos con warning (fallback a stale-while-error).
const PADRON_RECEPTOR_TTL_MS = 24 * 60 * 60 * 1000;
const PADRON_RECEPTOR_STALE_MS = 20 * 60 * 60 * 1000; // el cron refresca si > 20h

async function ensurePadronReceptoresCacheTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS padron_receptores_cache (
            documento TEXT PRIMARY KEY,
            condicion TEXT,
            nombre TEXT,
            tipo_persona TEXT,
            domicilio TEXT,
            cuit_usado TEXT,
            doc_tipo INTEGER,
            doc_nro TEXT,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    // Índice para buscar stales en el cron.
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_padron_receptores_fetched
        ON padron_receptores_cache (fetched_at)
    `);
}

// Devuelve la condición fiscal del receptor usando cache DB. Si el dato
// en DB es fresco (<24h), lo devuelve inmediatamente. Si es stale o no
// existe, consulta AFIP, guarda y devuelve. Si AFIP falla y hay dato
// viejo, lo usa con warning (stale-while-error).
async function getOrRefreshReceptorPadron(documento) {
    const doc = String(documento || '').replace(/\D/g, '');
    if (!doc || doc.length < 7) {
        throw new Error(`Documento inválido para consultar padrón: "${documento}"`);
    }

    // Intentar cache
    let row = null;
    try {
        const result = await db.query(
            `SELECT condicion, nombre, tipo_persona, domicilio, cuit_usado, doc_tipo, doc_nro, fetched_at
             FROM padron_receptores_cache WHERE documento = $1 LIMIT 1`,
            [doc]
        );
        row = result.rows[0] || null;
    } catch (err) {
        console.warn(`[padron-rec] error leyendo cache: ${err.message}`);
    }

    const fetchedAt = row?.fetched_at ? new Date(row.fetched_at).getTime() : 0;
    const ageMs = fetchedAt ? Date.now() - fetchedAt : Infinity;
    const hasCache = Boolean(row?.condicion);

    // HIT: cache fresco
    if (hasCache && ageMs < PADRON_RECEPTOR_TTL_MS) {
        console.log(`[padron-rec] HIT — doc=${doc} condicion=${row.condicion} (edad: ${Math.round(ageMs/1000)}s)`);
        return {
            condicion: row.condicion,
            nombre: row.nombre || '',
            tipoPersona: row.tipo_persona || '',
            domicilio: row.domicilio || '',
            cuitUsado: row.cuit_usado || null,
            docTipo: row.doc_tipo,
            docNro: row.doc_nro,
        };
    }

    // MISS o STALE: consultar AFIP
    try {
        console.log(`[padron-rec] MISS/stale — consultando AFIP para doc ${doc}`);
        const info = await afipPadron.getCondicionFiscalByDoc({ documento: doc });
        // Guardar en DB (fire-and-forget — no bloquea el flujo de emisión)
        db.query(
            `INSERT INTO padron_receptores_cache
             (documento, condicion, nombre, tipo_persona, domicilio, cuit_usado, doc_tipo, doc_nro, fetched_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (documento) DO UPDATE SET
                condicion    = EXCLUDED.condicion,
                nombre       = EXCLUDED.nombre,
                tipo_persona = EXCLUDED.tipo_persona,
                domicilio    = EXCLUDED.domicilio,
                cuit_usado   = EXCLUDED.cuit_usado,
                doc_tipo     = EXCLUDED.doc_tipo,
                doc_nro      = EXCLUDED.doc_nro,
                fetched_at   = NOW()`,
            [
                doc, info.condicion, info.nombre || '', info.tipoPersona || '',
                info.domicilio || '', info.cuitUsado || null,
                info.docTipo || 99, info.docNro || null
            ]
        ).catch(err => console.warn(`[padron-rec] save error: ${err.message}`));
        return info;
    } catch (err) {
        // AFIP falló. Si hay dato viejo, usar ese con warning.
        if (hasCache) {
            console.warn(`[padron-rec] AFIP falló (${err.message}) — usando dato viejo (edad: ${Math.round(ageMs/1000/60)}min)`);
            return {
                condicion: row.condicion,
                nombre: row.nombre || '',
                tipoPersona: row.tipo_persona || '',
                domicilio: row.domicilio || '',
                cuitUsado: row.cuit_usado || null,
                docTipo: row.doc_tipo,
                docNro: row.doc_nro,
                _stale: true,
            };
        }
        // Primera vez sin dato viejo: propagar (el caller decide qué hacer).
        throw err;
    }
}

// Refresh preventivo de receptores cercanos a expirar. Se llama desde el
// cron diario después del refresh del emisor. Toma los que tienen fetched_at
// > 20h y los regenera espaciando 2s para no saturar AFIP.
async function refreshStaleReceptores() {
    console.log('[padron-rec-cron] iniciando refresh de receptores stale');
    const started = Date.now();
    let ok = 0, fail = 0;
    try {
        await ensurePadronReceptoresCacheTable();
        const result = await db.query(`
            SELECT documento FROM padron_receptores_cache
            WHERE fetched_at IS NULL
               OR fetched_at < NOW() - INTERVAL '20 hours'
            LIMIT 100
        `);
        console.log(`[padron-rec-cron] ${result.rows.length} receptor(es) a refrescar`);
        for (const r of result.rows) {
            try {
                const info = await afipPadron.getCondicionFiscalByDoc({ documento: r.documento });
                await db.query(
                    `UPDATE padron_receptores_cache
                     SET condicion=$1, nombre=$2, tipo_persona=$3, domicilio=$4,
                         cuit_usado=$5, doc_tipo=$6, doc_nro=$7, fetched_at=NOW()
                     WHERE documento=$8`,
                    [info.condicion, info.nombre || '', info.tipoPersona || '', info.domicilio || '',
                     info.cuitUsado || null, info.docTipo || 99, info.docNro || null, r.documento]
                );
                ok++;
            } catch (err) {
                console.warn(`[padron-rec-cron] doc ${r.documento} falló: ${err.message}`);
                fail++;
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (err) {
        console.warn(`[padron-rec-cron] error: ${err.message}`);
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`[padron-rec-cron] fin — OK: ${ok} | FAIL: ${fail} | ${elapsed}s`);
}

// ─── Cron diario: refresca padrón de todas las empresas a las 2am AR ─────────
// Corre una vez por día a las 2am Argentina (5am UTC, AR no hace horario de
// verano). Levanta todas las empresas con CUIT y padrón stale (>18h o NULL),
// consulta AFIP para cada una con 2s de espaciado para no saturar AFIP, y
// guarda el resultado en DB. Errores individuales no detienen el batch.
async function runPadronEmisorDailyRefresh() {
    console.log('[padron-cron] iniciando refresh masivo de padrones');
    const started = Date.now();
    let rows;
    try {
        await ensureCompaniesExtraColumns();
        const result = await db.query(`
            SELECT id, cuit, padron_condicion, padron_nombre, padron_tipo_persona,
                   padron_domicilio, padron_fetched_at
            FROM companies
            WHERE cuit IS NOT NULL AND cuit <> ''
              AND (padron_fetched_at IS NULL
                   OR padron_fetched_at < NOW() - INTERVAL '18 hours')
        `);
        rows = result.rows;
    } catch (err) {
        console.error('[padron-cron] error levantando empresas:', err.message);
        return;
    }
    console.log(`[padron-cron] ${rows.length} empresa(s) a refrescar`);
    let ok = 0, fail = 0;
    for (const company of rows) {
        try {
            await getOrRefreshEmisorPadron(company);
            ok++;
        } catch (err) {
            console.warn(`[padron-cron] company ${company.id} falló: ${err.message}`);
            fail++;
        }
        // Espaciado para no saturar AFIP durante el batch.
        await new Promise(r => setTimeout(r, 2000));
    }
    const elapsedSec = Math.round((Date.now() - started) / 1000);
    console.log(`[padron-cron] fin — OK: ${ok} | FAIL: ${fail} | ${elapsedSec}s`);

    // Después del padrón, refrescar también los tokens WSAA que estén cerca
    // de expirar. Si falla, no afecta al cron del padrón.
    try {
        await refreshAllWsaaTokens();
    } catch (err) {
        console.warn(`[wsaa-cron] error en refresh post-padrón: ${err.message}`);
    }

    // Luego refrescar receptores stale (cache de padrón de clientes finales).
    try {
        await refreshStaleReceptores();
    } catch (err) {
        console.warn(`[padron-rec-cron] error: ${err.message}`);
    }
}

// Dos corridas por día: 2am (UTC 5am) como principal y 1pm (UTC 4pm) como
// red de seguridad por si AFIP estuvo caído a las 2am. Argentina no hace
// horario de verano (UTC-3 fijo).
function schedulePadronEmisorCron(label, utcHour) {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(utcHour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delayMs = next.getTime() - now.getTime();
    console.log(`[padron-cron ${label}] próxima corrida: ${next.toISOString()} (en ${Math.round(delayMs/1000/60)} min)`);
    setTimeout(async () => {
        try { await runPadronEmisorDailyRefresh(); }
        catch (err) { console.error(`[padron-cron ${label}] error en corrida:`, err.message); }
        schedulePadronEmisorCron(label, utcHour); // re-agendar
    }, delayMs);
}
function schedulePadronEmisorDailyRefresh() {
    // 3 slots cada 8 horas (2am, 10am, 6pm Argentina = UTC-3).
    // Cada token dura 11h cacheado; con 3 refresh por día (cada 8h) siempre
    // hay margen de 3h antes de que expire el anterior → cobertura continua
    // sin huecos y con fallback si un cron falla.
    schedulePadronEmisorCron('02am-AR', 5);   // 5am UTC = 2am Argentina
    schedulePadronEmisorCron('10am-AR', 13);  // 1pm UTC = 10am Argentina
    schedulePadronEmisorCron('06pm-AR', 21);  // 9pm UTC = 6pm Argentina
}

// Warm-up de pdfkit al arrancar: la primera instancia de PDFDocument en el
// proceso toma ~5s cargando las fuentes Helvetica. Con este dummy forzamos
// esa carga AL ARRANQUE, así la primera factura real no paga ese costo.
function warmupPdfkit() {
    try {
        const PDFDocument = require('pdfkit');
        const doc = new PDFDocument();
        doc.font('Helvetica-Bold').fontSize(8).text('warmup');
        doc.font('Helvetica').text('ok');
        doc.font('Helvetica-BoldOblique').text('ok');
        // No hace falta capturar el output — solo forzar la carga de fuentes.
        doc.on('data', () => {});
        doc.on('end', () => console.log('[pdf-warmup] pdfkit fonts pre-cargadas'));
        doc.end();
    } catch (err) {
        console.warn('[pdf-warmup] falló:', err.message);
    }
}

// Refresh en batch de tokens WSAA (padrón global + wsfe por empresa).
// Se ejecuta como parte del cron diario. Cada token que esté cerca de
// expirar (<3h de vida) se regenera anticipadamente.
async function refreshAllWsaaTokens() {
    console.log('[wsaa-cron] iniciando refresh de tokens');
    const started = Date.now();
    let refreshed = 0, failed = 0;

    // Helper que chequea si el token de una empresa necesita refresh.
    const needsRefresh = async (service, companyId) => {
        const row = await wsaaDbLoad({ service, companyId });
        if (!row) return true; // no hay → generar
        const hoursLeft = (row.expiresAt - Date.now()) / (60 * 60 * 1000);
        return hoursLeft < 3; // < 3h de vida → regenerar
    };

    // 1. Token del Padrón (global, cert de Martín). Solo si está configurado.
    try {
        const padronCreds = (() => {
            try {
                const afipPadronMod = require('./modules/afipPadron');
                // El módulo tiene loadPadronCredentials privado; usamos una
                // bandera: si hay env vars, hay credenciales.
                if (process.env.PADRON_CRT && process.env.PADRON_KEY) return true;
            } catch {}
            return false;
        })();
        if (padronCreds && await needsRefresh('ws_sr_constancia_inscripcion', null)) {
            console.log('[wsaa-cron] refrescando token del Padrón (global)');
            // Disparar una consulta al padrón con un CUIT conocido fuerza la
            // generación del token. Usamos el CUIT del padrón (de Martín) que
            // siempre debería existir en AFIP.
            const afipPadron = require('./modules/afipPadron');
            try {
                // getCondicionFiscal internamente llama a afipAuth.getToken
                // que ahora usa DB storage → se guarda automáticamente.
                const padronCuit = require('./config').padronCuit;
                if (padronCuit) {
                    await afipPadron.getCondicionFiscal({ cuitAConsultar: padronCuit });
                    refreshed++;
                }
            } catch (err) {
                console.warn(`[wsaa-cron] refresh padrón falló: ${err.message}`);
                failed++;
            }
        }
    } catch (err) {
        console.warn(`[wsaa-cron] error chequeando padrón: ${err.message}`);
    }

    // 2. Tokens WSFE por empresa con certificado activo.
    try {
        const companies = await db.query(`
            SELECT c.id, c.cuit, ac.crt_file_url, ac.encrypted_private_key
            FROM companies c
            JOIN afip_credentials ac ON ac.company_id = c.id
            WHERE c.cuit IS NOT NULL AND c.cuit <> ''
              AND ac.status = 'active'
              AND ac.crt_file_url IS NOT NULL
              AND ac.encrypted_private_key IS NOT NULL
        `);
        console.log(`[wsaa-cron] ${companies.rows.length} empresa(s) con cert activo`);
        for (const company of companies.rows) {
            if (!(await needsRefresh('wsfe', company.id))) continue;
            try {
                const certPem = normalizePem(company.crt_file_url, 'CERTIFICATE');
                const decryptedKey = CryptoJS.AES.decrypt(
                    company.encrypted_private_key, process.env.ENCRYPTION_KEY
                ).toString(CryptoJS.enc.Utf8);
                const keyPem = normalizePem(decryptedKey, 'PRIVATE KEY');
                await afipAuthModule.getToken({
                    certPem, keyPem, cuit: company.cuit, service: 'wsfe',
                    companyId: company.id, force: true,
                });
                refreshed++;
            } catch (err) {
                console.warn(`[wsaa-cron] company ${company.id} wsfe falló: ${err.message}`);
                failed++;
            }
            // Espaciado para no saturar AFIP.
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (err) {
        console.warn(`[wsaa-cron] error listando empresas: ${err.message}`);
    }

    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`[wsaa-cron] fin — refreshed: ${refreshed} | failed: ${failed} | ${elapsed}s`);
}

// Inicializar SDK de monday code para inyectar env vars y secrets en process.env
try {
    const { EnvironmentVariablesManager, SecretsManager } = require('@mondaycom/apps-sdk');
    const envManager = new EnvironmentVariablesManager({ updateProcessEnv: true });
    const secretsManager = new SecretsManager();
    const secretKeys = ['MONDAY_CLIENT_SECRET', 'MONDAY_SIGNING_SECRET', 'MONDAY_OAUTH_SECRET', 'ENCRYPTION_KEY', 'PADRON_KEY', 'PADRON_CRT', 'DEV_MONDAY_TOKEN', 'SLACK_WEBHOOK_URL'];
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

// ─── Security headers ───────────────────────────────────────────────────────
// Requeridos por el privacy & security review de monday:
// - HSTS: forzar HTTPS por 1 año (la app ya es HTTPS-only, refuerza a nivel browser)
// - CSP frame-ancestors: solo permite que la embeben subdominios de monday.com
// - X-Content-Type-Options: previene MIME-sniffing
// - Referrer-Policy: no filtra paths/queries a sitios externos
app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "frame-ancestors https://*.monday.com https://monday.com");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});

// Middlewares
app.use(cors({
    origin: '*', // Permitir cualquier origen (necesario para repos separados)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Rate limiting ──────────────────────────────────────────────────────────
// Protege contra abuso/DOS. 3 niveles por criticidad:
//   - apiLimiter: general para API (300 req / 15 min / IP)
//   - emitLimiter: estricto para emision de facturas (20 / min / IP)
//   - webhookLimiter: para endpoints de webhook (60 / min / IP)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas requests, esperá unos minutos.' },
});
const emitLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas emisiones en poco tiempo.' },
});
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
});

// Aplicar limiter general a /api/*
app.use('/api/', apiLimiter);

// Multer en memoria (en Monday Code no persistimos archivos en disco).
// Limites estrictos: max 5MB por archivo, max 2 archivos por request, max 20
// fields. Previene memory exhaustion via uploads gigantes.
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: {
        fileSize: 5 * 1024 * 1024,  // 5 MB
        files: 2,
        fields: 20,
        fieldSize: 1 * 1024 * 1024, // 1 MB por campo de texto
    },
});

// Lookup de la empresa que corresponde a un boardId de monday. Útil cuando se
// emite una factura: el JOIN con board_automation_configs garantiza que se
// devuelve la empresa CONFIGURADA en ese board, sin importar cuántas empresas
// distintas tenga la cuenta. Si el board no tiene config (caso edge), cae al
// fallback legacy de getCompanyByMondayAccountId.
async function getCompanyForBoard(mondayAccountId, boardId) {
    if (!mondayAccountId || !boardId) return null;
    const r = await db.query(
        `SELECT c.id, c.monday_account_id, c.workspace_id, c.business_name,
                c.trade_name, c.cuit, c.default_point_of_sale, c.address,
                c.start_date, c.phone, c.email, c.website, c.logo_base64,
                c.logo_mime_type, c.padron_condicion, c.padron_nombre,
                c.padron_tipo_persona, c.padron_domicilio, c.padron_fetched_at
         FROM companies c
         JOIN board_automation_configs bac ON bac.company_id = c.id
         WHERE c.monday_account_id::text = $1
           AND bac.board_id = $2
         ORDER BY bac.updated_at DESC
         LIMIT 1`,
        [String(mondayAccountId), String(boardId)]
    );
    if (r.rows[0]) return r.rows[0];
    // Fallback: sin board_config ya configurado, probamos la lookup legacy.
    return getCompanyByMondayAccountId(mondayAccountId);
}

// Lookup de la empresa que corresponde a un (monday_account_id, workspace_id).
// Si workspaceId es null/undefined → fallback a comportamiento legacy: trae la
// primera empresa de la cuenta priorizando la "legacy" (workspace_id NULL),
// que sostiene compatibilidad con clientes con frontend viejo que todavía no
// manda workspace_id.
async function getCompanyByMondayAccountId(mondayAccountId, workspaceId = null) {
    const baseSelect = `
        SELECT id, monday_account_id, workspace_id, business_name, trade_name, cuit, default_point_of_sale, address, start_date,
               phone, email, website, logo_base64, logo_mime_type,
               padron_condicion, padron_nombre, padron_tipo_persona, padron_domicilio, padron_fetched_at
        FROM companies`;
    if (workspaceId) {
        // Match exacto al workspace solicitado.
        const r = await db.query(
            `${baseSelect} WHERE monday_account_id::text = $1 AND workspace_id = $2 LIMIT 1`,
            [String(mondayAccountId), String(workspaceId)]
        );
        if (r.rows[0]) return r.rows[0];

        // Fallback legacy single-company: si no hay match estricto pero existe
        // EXACTAMENTE 1 company legacy (workspace_id NULL) y NINGUNA company
        // ya scoped a otro workspace, asumimos que es el mismo cliente
        // abriendo desde un workspace nuevo y devolvemos esa legacy. Esto
        // permite que clientes pre-multi-tenant sigan funcionando sin perder
        // cert ni mapeo. El claim al workspace ocurre en POST /api/companies.
        const fallback = await db.query(
            `WITH counts AS (
                SELECT
                    COUNT(*) FILTER (WHERE workspace_id IS NULL) AS legacy_count,
                    COUNT(*) FILTER (WHERE workspace_id IS NOT NULL) AS scoped_count
                  FROM companies
                 WHERE monday_account_id::text = $1
             )
             ${baseSelect}
              WHERE monday_account_id::text = $1
                AND workspace_id IS NULL
                AND (SELECT legacy_count FROM counts) = 1
                AND (SELECT scoped_count FROM counts) = 0
              LIMIT 1`,
            [String(mondayAccountId)]
        );
        return fallback.rows[0] || null;
    }
    // Sin workspace en el request: priorizamos la legacy (workspace_id NULL),
    // luego la más vieja por created_at. Esto preserva el comportamiento que
    // tenía la app antes del cambio multi-empresa.
    const r = await db.query(
        `${baseSelect}
         WHERE monday_account_id::text = $1
         ORDER BY (workspace_id IS NULL) DESC, created_at ASC
         LIMIT 1`,
        [String(mondayAccountId)]
    );
    return r.rows[0] || null;
}

/**
 * Chequea que toda la configuración necesaria para emitir una factura esté presente.
 * Devuelve { ready: boolean, missing: string[], company, certificate, mapping, boardConfig }.
 *
 * Si boardId es null, solo valida config a nivel cuenta (empresa + certificados).
 */
async function validateEmissionReadiness({ mondayAccountId, boardId = null }) {
    const missing = [];
    // Multi-empresa: si tenemos boardId, resolver la company configurada para
    // ESE board via board_automation_configs. Sin boardId, fallback legacy
    // (compatibilidad con flujos viejos).
    // Sin esto, en cuentas con varias companies se elige la legacy y se busca
    // el mapping con la company equivocada → falso "Falta configurar mapeo".
    const company = boardId
        ? await getCompanyForBoard(mondayAccountId, boardId)
        : await getCompanyByMondayAccountId(mondayAccountId);

    if (!company) {
        missing.push('datos_fiscales');
        return { ready: false, missing, company: null, certificate: null, mapping: null, boardConfig: null };
    }

    // Datos fiscales mínimos
    if (!company.business_name) missing.push('datos_fiscales.business_name');
    if (!company.cuit)          missing.push('datos_fiscales.cuit');
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
            `SELECT status_column_id, trigger_label, success_label, error_label,
                    required_columns_json, auto_rename_item, auto_update_status
             FROM board_automation_configs
             WHERE company_id=$1 AND board_id=$2
             ORDER BY updated_at DESC LIMIT 1`,
            [company.id, String(boardId)]
        );
        boardConfig = boardCfgResult.rows[0] || null;
        if (!boardConfig) {
            missing.push('board_config');
        } else {
            // Defaults TRUE para clientes legacy que no tienen estos flags
            // grabados todavia. Garantiza que el comportamiento siga siendo
            // el de siempre: renombrar y cambiar estado automaticos.
            if (boardConfig.auto_rename_item   === null) boardConfig.auto_rename_item   = true;
            if (boardConfig.auto_update_status === null) boardConfig.auto_update_status = true;

            // status_column_id solo es obligatoria si el cliente quiere que
            // la app cambie el estado del item. Si desactivo ese toggle, no
            // tiene sentido exigir la columna.
            if (boardConfig.auto_update_status !== false && !boardConfig.status_column_id) {
                missing.push('board_config.status_column_id');
            }
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
// Devuelve el nombre que el CLIENTE le puso a una columna en SU board
// (column.title), con fallback al label canonico si no se pudo recuperar.
// Formato: si tenemos title, "Mi Columna" (Fecha de emision)
//          si no tenemos:    "Fecha de emision"
function getColumnLabel(columnValues, columnId, canonicalLabel) {
    if (!columnId) return `"${canonicalLabel}"`;
    const found = (columnValues || []).find(c => c.id === columnId);
    const realTitle = found?.column?.title;
    if (realTitle && realTitle !== canonicalLabel) {
        return `"${realTitle}" (${canonicalLabel})`;
    }
    return `"${canonicalLabel}"`;
}

function validateItemDataCompleteness({ mainColumns, subitems, mapping }) {
    const errors = [];
    const VALID_ALICUOTAS = new Set(['0', '2.5', '5', '10.5', '21', '27']);
    const VALID_PROD_SERV = new Set(['servicio', 'producto']);

    const fechaEmision = getColumnTextById(mainColumns, mapping.fecha_emision);
    if (!fechaEmision) {
        errors.push(`Item: falta la columna ${getColumnLabel(mainColumns, mapping.fecha_emision, 'Fecha de Emisión')}`);
    }

    const condicionVenta = getColumnTextById(mainColumns, mapping.condicion_venta);
    if (!condicionVenta) {
        errors.push(`Item: falta la columna ${getColumnLabel(mainColumns, mapping.condicion_venta, 'Condición de Venta')}`);
    }

    if (!subitems || subitems.length === 0) {
        errors.push('El item no tiene subitems (al menos uno es obligatorio)');
        return { ok: false, errors };
    }

    // Resolvemos moneda upfront para saber que columna de precio validar en
    // cada subitem. Para items en USD, los subitems deben tener valor en
    // mapping.precio_unitario_usd; los items en pesos siguen usando el
    // mapping.precio_unitario obligatorio.
    const monedaRawForPrice = mapping.moneda
        ? (getColumnTextById(mainColumns, mapping.moneda) || '')
        : '';
    const monedaParsedForPrice = monedaRawForPrice
        ? invoiceRules.parseMoneda(monedaRawForPrice)
        : null;
    const precioColumnForValidation = (monedaParsedForPrice === 'DOL' && mapping.precio_unitario_usd)
        ? mapping.precio_unitario_usd
        : mapping.precio_unitario;
    const precioLabelForValidation = (monedaParsedForPrice === 'DOL' && mapping.precio_unitario_usd)
        ? 'Precio Unitario (USD)'
        : 'Precio Unitario';

    let hayServicio = false;
    subitems.forEach(sub => {
        const name = sub.name || `#${sub.id}`;

        if (!sub.name || !String(sub.name).trim()) {
            errors.push(`Subitem "${name}": falta el nombre (concepto)`);
        }

        const unidadMedida = getColumnTextById(sub.column_values, mapping.unidad_medida);
        if (!unidadMedida) {
            errors.push(`Subitem "${name}": falta la columna ${getColumnLabel(sub.column_values, mapping.unidad_medida, 'Unidad de Medida')}`);
        }

        const cantNum = toNumberOrNull(getColumnTextById(sub.column_values, mapping.cantidad));
        if (cantNum === null || cantNum <= 0) {
            errors.push(`Subitem "${name}": columna ${getColumnLabel(sub.column_values, mapping.cantidad, 'Cantidad')} inválida (debe ser número > 0)`);
        }

        const precioNum = toNumberOrNull(getColumnTextById(sub.column_values, precioColumnForValidation));
        if (precioNum === null || precioNum <= 0) {
            errors.push(`Subitem "${name}": columna ${getColumnLabel(sub.column_values, precioColumnForValidation, precioLabelForValidation)} inválida (debe ser número > 0)`);
        }

        const prodServRaw = getColumnTextById(sub.column_values, mapping.prod_serv) || '';
        const prodServ = prodServRaw.toLowerCase().trim();
        const prodServLabel = getColumnLabel(sub.column_values, mapping.prod_serv, 'Prod/Serv');
        if (!prodServ) {
            errors.push(`Subitem "${name}": falta la columna ${prodServLabel} — debe decir "producto" o "servicio"`);
        } else if (!VALID_PROD_SERV.has(prodServ)) {
            errors.push(`Subitem "${name}": columna ${prodServLabel} debe decir "producto" o "servicio" (actual: "${prodServRaw}")`);
        } else if (prodServ === 'servicio') {
            hayServicio = true;
        }

        const alicuotaRaw = getColumnTextById(sub.column_values, mapping.alicuota_iva) || '';
        const alicuotaNorm = String(alicuotaRaw).replace(/[^0-9.,]/g, '').replace(',', '.').trim();
        const alicuotaLabel = getColumnLabel(sub.column_values, mapping.alicuota_iva, 'Alícuota IVA %');
        if (!alicuotaNorm) {
            errors.push(`Subitem "${name}": falta la columna ${alicuotaLabel}`);
        } else if (!VALID_ALICUOTAS.has(alicuotaNorm)) {
            errors.push(`Subitem "${name}": columna ${alicuotaLabel} inválida. Valores permitidos: 0, 2.5, 5, 10.5, 21, 27 (actual: "${alicuotaRaw}")`);
        }
    });

    if (hayServicio) {
        if (!getColumnTextById(mainColumns, mapping.fecha_servicio_desde)) {
            errors.push(`Item: falta la columna ${getColumnLabel(mainColumns, mapping.fecha_servicio_desde, 'Fecha Servicio Desde')} (obligatoria cuando hay subitems de servicio)`);
        }
        if (!getColumnTextById(mainColumns, mapping.fecha_servicio_hasta)) {
            errors.push(`Item: falta la columna ${getColumnLabel(mainColumns, mapping.fecha_servicio_hasta, 'Fecha Servicio Hasta')} (obligatoria cuando hay subitems de servicio)`);
        }
        if (!getColumnTextById(mainColumns, mapping.fecha_vto_pago)) {
            errors.push(`Item: falta la columna ${getColumnLabel(mainColumns, mapping.fecha_vto_pago, 'Fecha Vto. Pago')} (obligatoria cuando hay subitems de servicio)`);
        }
    }

    // ── Moneda y cotizacion (opcionales) ──────────────────────────────────
    // Solo validamos si el cliente mapeo la columna. Si no la mapeo,
    // default = pesos. Si la mapeo pero el item esta vacio, tambien default
    // = pesos. Solo error si tiene un valor que no es ni pesos ni dolares.
    if (mapping.moneda) {
        const monedaRaw = getColumnTextById(mainColumns, mapping.moneda) || '';
        if (monedaRaw.trim()) {
            const monedaParsed = invoiceRules.parseMoneda(monedaRaw);
            if (!monedaParsed) {
                const monedaLabel = getColumnLabel(mainColumns, mapping.moneda, 'Moneda');
                errors.push(`Item: columna ${monedaLabel} tiene un valor no reconocido ("${monedaRaw}"). Debe decir "Pesos" o "Dólares" (acepta cualquier mayuscula/minuscula y singular/plural).`);
            }
        }
    }
    if (mapping.cotizacion) {
        const cotRaw = getColumnTextById(mainColumns, mapping.cotizacion) || '';
        if (cotRaw.trim()) {
            const cotNum = toNumberOrNull(cotRaw);
            if (cotNum === null || cotNum <= 0) {
                const cotLabel = getColumnLabel(mainColumns, mapping.cotizacion, 'Tipo de cambio');
                errors.push(`Item: columna ${cotLabel} debe ser un número mayor a 0 (actual: "${cotRaw}")`);
            }
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
    const userId    = dat.user_id    || decodedToken?.user_id    || null;
    const appId     = dat.app_id     || null;
    const appVersionId = dat.app_version_id || null;
    return {
        accountId: accountId ? String(accountId) : null,
        userId:    userId    ? String(userId)    : null,
        appId,
        appVersionId,
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
        const identity = extractMondayIdentity(decoded);
        if (!identity.accountId) {
            console.log('[session] FAIL: no accountId in token');
            return res.status(401).json({ error: 'sessionToken inválido: account_id ausente' });
        }

        req.mondayIdentity = { ...identity, sessionToken: token };
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
        user_api_tokens_monday_account_id_type: null,
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
                         WHERE table_name IN ('companies', 'user_api_tokens', 'user_api_tokens_v2')
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
            if (row.table_name === 'user_api_tokens' && row.column_name === 'monday_account_id') {
                diagnostics.user_api_tokens_monday_account_id_type = row.data_type;
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

// Consulta una factura ya emitida en AFIP para verificar su existencia y
// recuperar sus datos. Se usa para:
//  1. Verificacion post-emision (Fase 2): confirmar que el CAE recibido
//     existe efectivamente en AFIP y los datos matchean lo que enviamos.
//  2. Recuperacion en timeout (Fase 1): si una emision quedo en 'processing'
//     porque no recibimos response, podemos consultar AFIP para saber si
//     se llego a emitir y recuperar el CAE.
//
// Retorna null si AFIP responde "comprobante no encontrado" (codigo 602/15).
async function afipConsultarComprobante({ token, sign, cuit, pointOfSale, cbteType, cbteNro }) {
    const endpoints = getAfipEndpoints();
    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">\n  <soapenv:Header/>\n  <soapenv:Body>\n    <ar:FECompConsultar>\n      <ar:Auth>\n        <ar:Token>${xmlEscape(token)}</ar:Token>\n        <ar:Sign>${xmlEscape(sign)}</ar:Sign>\n        <ar:Cuit>${xmlEscape(cuit)}</ar:Cuit>\n      </ar:Auth>\n      <ar:FeCompConsReq>\n        <ar:CbteTipo>${xmlEscape(cbteType)}</ar:CbteTipo>\n        <ar:CbteNro>${xmlEscape(cbteNro)}</ar:CbteNro>\n        <ar:PtoVta>${xmlEscape(pointOfSale)}</ar:PtoVta>\n      </ar:FeCompConsReq>\n    </ar:FECompConsultar>\n  </soapenv:Body>\n</soapenv:Envelope>`;

    let response, xml;
    try {
        response = await fetch(endpoints.wsfe, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                SOAPAction: 'http://ar.gov.afip.dif.FEV1/FECompConsultar',
            },
            body: soapBody,
            signal: AbortSignal.timeout(30000),
        });
        xml = await response.text();
    } catch (err) {
        throw new Error(`FECompConsultar network error: ${err.message}`);
    }

    if (!response.ok) {
        throw new Error(`FECompConsultar HTTP ${response.status}: ${xml.slice(0, 300)}`);
    }

    // Parsear errores. AFIP devuelve en <Errors><Err><Code>X</Code><Msg>...
    const errBlock = xml.match(/<Errors[^>]*>([\s\S]*?)<\/Errors>/i);
    if (errBlock) {
        const errs = errBlock[1].match(/<Err>[\s\S]*?<\/Err>/gi) || [];
        const codes = errs.map(e => extractXmlTag(e, 'Code')).filter(Boolean);
        const msgs  = errs.map(e => `[${extractXmlTag(e, 'Code')}] ${extractXmlTag(e, 'Msg')}`).filter(Boolean);
        // Codigos conocidos de "comprobante no encontrado": 602, 1502, 15.
        // Cualquier otro error lo propagamos.
        if (codes.some(c => /^(602|1502|15)$/.test(String(c)))) {
            return null;
        }
        if (codes.length > 0) {
            throw new Error(`FECompConsultar error AFIP: ${msgs.join(' | ')}`);
        }
    }

    // Extraer datos del comprobante encontrado.
    const cae = extractXmlTag(xml, 'CodAutorizacion') || extractXmlTag(xml, 'CAE');
    if (!cae) return null; // sin CAE = no encontrado

    return {
        cae,
        cae_vencimiento: extractXmlTag(xml, 'FchVto') || null,
        resultado: extractXmlTag(xml, 'Resultado') || null,
        cbte_tipo: Number(extractXmlTag(xml, 'CbteTipo') || 0),
        cbte_nro: Number(extractXmlTag(xml, 'CbteDesde') || extractXmlTag(xml, 'CbteNro') || 0),
        pto_vta: Number(extractXmlTag(xml, 'PtoVta') || 0),
        cbte_fecha: extractXmlTag(xml, 'CbteFch') || null,
        imp_total: Number(extractXmlTag(xml, 'ImpTotal') || 0),
        imp_neto: Number(extractXmlTag(xml, 'ImpNeto') || 0),
        imp_iva: Number(extractXmlTag(xml, 'ImpIVA') || 0),
        doc_tipo: Number(extractXmlTag(xml, 'DocTipo') || 0),
        doc_nro: Number(extractXmlTag(xml, 'DocNro') || 0),
        raw_xml_preview: xml.slice(0, 500),
    };
}

// Tipos de comprobante AFIP: A=1, B=6, C=11
const INVOICE_TYPE_CONFIG = {
    A: { cbteType: 1,  ivaRate: 0.21, requiresCuit: true  },
    B: { cbteType: 6,  ivaRate: 0.21, requiresCuit: false },
    C: { cbteType: 11, ivaRate: 0,    requiresCuit: false },
};

// ─── Cotizacion de monedas (FEParamGetCotizacion) ─────────────────────────
// Consulta la cotizacion oficial de AFIP para una moneda extranjera.
// Para PES devolvemos 1.0 sin pegar a AFIP.
//
// Cache en memoria por monId con TTL 5 min — la cotizacion oficial cambia
// 1 vez por dia. Aun asi 5 min es conservador y evita rate limits si emitimos
// varias facturas USD seguidas.
const _cotizacionCache = new Map(); // monId → { monCotiz, fchCotiz, cachedAt }
const COTIZACION_TTL_MS = 5 * 60 * 1000;

async function afipGetCotizacion({ token, sign, cuit, monId }) {
    if (monId === 'PES') return { monCotiz: 1.0, fchCotiz: null };

    // Cache check
    const cached = _cotizacionCache.get(monId);
    if (cached && (Date.now() - cached.cachedAt) < COTIZACION_TTL_MS) {
        console.log(`[wsfe] cotizacion cache HIT monId=${monId} → ${cached.monCotiz}`);
        return { monCotiz: cached.monCotiz, fchCotiz: cached.fchCotiz };
    }

    const endpoints = getAfipEndpoints();
    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:FEParamGetCotizacion>
      <ar:Auth>
        <ar:Token>${xmlEscape(token)}</ar:Token>
        <ar:Sign>${xmlEscape(sign)}</ar:Sign>
        <ar:Cuit>${xmlEscape(cuit)}</ar:Cuit>
      </ar:Auth>
      <ar:MonId>${xmlEscape(monId)}</ar:MonId>
    </ar:FEParamGetCotizacion>
  </soapenv:Body>
</soapenv:Envelope>`;

    let response, xml;
    try {
        response = await fetch(endpoints.wsfe, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                SOAPAction: 'http://ar.gov.afip.dif.FEV1/FEParamGetCotizacion',
            },
            body: soapBody,
            signal: AbortSignal.timeout(15000),
        });
        xml = await response.text();
    } catch (err) {
        throw new Error(`FEParamGetCotizacion network error: ${err.message}`);
    }

    if (!response.ok) {
        throw new Error(`FEParamGetCotizacion HTTP ${response.status}: ${xml.slice(0, 300)}`);
    }

    // Parsear errores AFIP
    const errBlock = xml.match(/<Errors[^>]*>([\s\S]*?)<\/Errors>/i);
    if (errBlock) {
        const errs = errBlock[1].match(/<Err>[\s\S]*?<\/Err>/gi) || [];
        const msgs = errs.map(e => `[${extractXmlTag(e, 'Code')}] ${extractXmlTag(e, 'Msg')}`).filter(Boolean);
        if (msgs.length > 0) {
            throw new Error(`AFIP rechazo cotizacion ${monId}: ${msgs.join(' | ')}`);
        }
    }

    const monCotizRaw = extractXmlTag(xml, 'MonCotiz');
    const monCotiz = Number(monCotizRaw);
    if (!Number.isFinite(monCotiz) || monCotiz <= 0) {
        throw new Error(`FEParamGetCotizacion devolvio cotizacion invalida para ${monId}: "${monCotizRaw}"`);
    }
    const fchCotiz = extractXmlTag(xml, 'FchCotiz') || null;

    // Cachear
    _cotizacionCache.set(monId, { monCotiz, fchCotiz, cachedAt: Date.now() });
    console.log(`[wsfe] cotizacion AFIP fresh monId=${monId} → ${monCotiz} (fecha ${fchCotiz})`);
    return { monCotiz, fchCotiz };
}

async function afipIssueFactura({
    token, sign, cuit, pointOfSale, draft, invoiceType = 'C',
    // Fase 1 — idempotency: si en un attempt anterior reservamos un cbteNro
    // y la respuesta de AFIP no llego (timeout / micro-corte), `previousCbteNro`
    // permite consultar AFIP primero (FECompConsultar) para verificar si la
    // factura realmente se emitio. `onCbteNroAssigned` es un callback que se
    // invoca cuando reservamos un cbteNro nuevo, para persistirlo en DB ANTES
    // del SOAP — asi sabemos que numero "intentamos" en caso de timeout.
    previousCbteNro = null,
    onCbteNroAssigned = null,
    // PASO 2 USD — moneda y cotizacion ya RESUELTAS por el caller.
    // Defaults preservan el comportamiento PES historico cuando el caller
    // no las pasa (clientes legacy o tests que no las setean).
    monId = 'PES',
    monCotiz = 1.0,
}) {
    const config = INVOICE_TYPE_CONFIG[invoiceType];
    if (!config) throw new Error(`Tipo de factura no soportado: ${invoiceType}`);

    const endpoints = getAfipEndpoints();
    const { cbteType } = config;

    // ── Fase 1 — Recovery de attempt previo ──────────────────────────────
    // Si hay cbteNro de un intento anterior, primero consultar AFIP. Si la
    // factura ya existe (AFIP la proceso pero la respuesta no nos llego),
    // reutilizamos esos datos en vez de reemitir.
    if (previousCbteNro) {
        try {
            const recovered = await afipConsultarComprobante({
                token, sign, cuit, pointOfSale, cbteType, cbteNro: previousCbteNro,
            });
            if (recovered && recovered.cae) {
                console.log(`[wsfe] recovery: cbteNro=${previousCbteNro} ya existe en AFIP con CAE=${recovered.cae} — reutilizando emision previa`);
                const totalAmountForCheck = Number(draft.importe_total || 0);
                return {
                    resultado: recovered.resultado || 'A',
                    cae: recovered.cae,
                    cae_vencimiento: recovered.cae_vencimiento,
                    numero_comprobante: recovered.cbte_nro,
                    tipo_comprobante: invoiceType,
                    imp_neto: recovered.imp_neto,
                    imp_iva: recovered.imp_iva,
                    observacion: null,
                    raw_xml: recovered.raw_xml_preview || '',
                    recovered: true,
                    verification: {
                        cae_match: true,
                        cbte_nro_match: recovered.cbte_nro === previousCbteNro,
                        imp_total_match: Math.abs(recovered.imp_total - totalAmountForCheck) <= 0.01,
                        checked_at: new Date().toISOString(),
                        source: 'recovery',
                    },
                };
            }
            console.log(`[wsfe] recovery: cbteNro=${previousCbteNro} no existe en AFIP — continuando con emision nueva`);
        } catch (recErr) {
            // Si la consulta falla (red, AFIP lenta), seguimos con emision
            // nueva. Riesgo conocido: si el cbte previo si existia, podriamos
            // duplicar. Pero bloquear emision por una falla de red transitoria
            // de FECompConsultar tambien es malo. Loggeamos para auditoria.
            console.warn(`[wsfe] recovery: error consultando cbteNro=${previousCbteNro}: ${recErr.message} — continuando con emision nueva`);
        }
    }

    const lastVoucher = await afipGetLastVoucher({ token, sign, cuit, pointOfSale, cbteType });
    const nextVoucher = lastVoucher + 1;

    // Persistir el cbteNro reservado ANTES del SOAP para que en caso de
    // timeout el retry pueda recuperarlo via FECompConsultar.
    if (typeof onCbteNroAssigned === 'function') {
        try {
            await onCbteNroAssigned({
                cbteType,
                pointOfSale: Number(pointOfSale),
                cbteNro: nextVoucher,
            });
        } catch (cbErr) {
            // No bloquea la emision: si fallamos persistiendo el numero
            // reservado, perdemos solo la capacidad de recovery — la
            // emision en si sigue funcionando.
            console.warn(`[wsfe] onCbteNroAssigned fallo: ${cbErr.message}`);
        }
    }

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
            <ar:MonId>${xmlEscape(monId)}</ar:MonId>
            <ar:MonCotiz>${Number(monCotiz).toFixed(6)}</ar:MonCotiz>
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

    // Extraer mensajes de error y observaciones de AFIP.
    // <Errors><Err><Code>X</Code><Msg>...</Msg></Err></Errors>
    // <Observaciones><Obs><Code>X</Code><Msg>...</Msg></Obs></Observaciones>
    const extractMsgsFromBlock = (blockTag) => {
        const block = xml.match(new RegExp(`<${blockTag}[^>]*>([\\s\\S]*?)<\\/${blockTag}>`, 'i'));
        if (!block) return [];
        const items = block[1].match(/<(Err|Obs)[^>]*>[\s\S]*?<\/(Err|Obs)>/gi) || [];
        return items.map((it) => {
            const code = extractXmlTag(it, 'Code') || '';
            const msg  = extractXmlTag(it, 'Msg')  || '';
            return code ? `[${code}] ${msg}` : msg;
        }).filter(Boolean);
    };

    const errors = extractMsgsFromBlock('Errors');
    const observations = extractMsgsFromBlock('Observaciones');
    const observation = [...errors, ...observations].join(' | ') || null;

    // Si AFIP rechazó (sin CAE o Resultado != 'A'), tirar error para que el handler
    // lo marque como "Error - Mirar Comentarios" en Monday en vez de quedar colgado.
    if (!cae || (result && result.toUpperCase() !== 'A')) {
        console.error(`[wsfe] AFIP rechazó — Resultado: ${result || 'N/D'} | Errors: ${errors.join(' | ') || 'ninguno'} | Obs: ${observations.join(' | ') || 'ninguna'}`);
        console.error(`[wsfe] XML raw (primeros 2000 chars): ${xml.slice(0, 2000)}`);
        const detalle = observation || `Resultado=${result || 'N/D'}, sin CAE`;
        throw new Error(`AFIP rechazó la factura: ${detalle}`);
    }

    // ── Fase 2: verificación post-emisión ────────────────────────────────
    // Confirmar con FECompConsultar que el comprobante existe en AFIP y que
    // los datos matchean lo que enviamos. Si hay discrepancia, log warning
    // (pero no fail — el CAE es valido y la factura existe).
    let verification = null;
    let verificationError = null;
    try {
        verification = await afipConsultarComprobante({
            token, sign, cuit,
            pointOfSale,
            cbteType,
            cbteNro: nextVoucher,
        });
        if (!verification) {
            console.warn(`[wsfe] verify: AFIP no encontro el comprobante recien emitido cbteNro=${nextVoucher} (posible delay de propagacion)`);
        } else {
            const mismatches = [];
            if (verification.cae !== cae) mismatches.push(`CAE: emitido=${cae} vs verificado=${verification.cae}`);
            if (verification.cbte_nro !== nextVoucher) mismatches.push(`cbteNro: emitido=${nextVoucher} vs verificado=${verification.cbte_nro}`);
            if (Math.abs(verification.imp_total - totalAmount) > 0.01) mismatches.push(`importe: emitido=${totalAmount} vs verificado=${verification.imp_total}`);
            if (mismatches.length > 0) {
                console.warn(`[wsfe] verify: MISMATCH detectado para cbteNro=${nextVoucher}: ${mismatches.join(' | ')}`);
            } else {
                console.log(`[wsfe] verify: OK cbteNro=${nextVoucher} CAE=${cae}`);
            }
        }
    } catch (verifyErr) {
        // No bloquear la emision si la verificacion falla (red, AFIP lenta).
        // Pero loggear con detalle para auditoria.
        verificationError = verifyErr.message;
        console.warn(`[wsfe] verify: error consultando cbteNro=${nextVoucher}: ${verifyErr.message}`);
    }

    return {
        resultado: result || 'N/D',
        cae: cae || null,
        cae_vencimiento: caeExpiration || null,
        numero_comprobante: nextVoucher,
        tipo_comprobante: invoiceType,
        imp_neto: impNeto,
        imp_iva: impIva,
        observacion: observation,
        raw_xml: xml.slice(0, 2000),
        verification: verification ? {
            cae_match: verification.cae === cae,
            cbte_nro_match: verification.cbte_nro === nextVoucher,
            imp_total_match: Math.abs(verification.imp_total - totalAmount) <= 0.01,
            checked_at: new Date().toISOString(),
        } : (verificationError ? { error: verificationError, checked_at: new Date().toISOString() } : { skipped: 'no_response', checked_at: new Date().toISOString() }),
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
    if (!found) return '';

    // Para columnas normales el texto displayed esta en `text`.
    // Para mirror y board_relation el `text` suele venir vacio aunque el
    // cliente vea el valor en monday: el dato real esta en `display_value`.
    // Tambien parseamos `value` como ultimo fallback (algunas mirrors viejas).
    if (found.text) return found.text;
    if (found.display_value) return found.display_value;

    if (found.value) {
        try {
            const parsed = JSON.parse(found.value);
            if (typeof parsed === 'string') return parsed;
            if (parsed?.display_value) return String(parsed.display_value);
            // BoardRelation: array de items con name
            if (Array.isArray(parsed?.linkedPulseIds) && Array.isArray(parsed?.linkedPulses)) {
                return parsed.linkedPulses.map(p => p?.name || '').filter(Boolean).join(', ');
            }
        } catch (_) {
            // value no era JSON, lo devolvemos como string puro
            return String(found.value);
        }
    }
    return '';
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

    // Migracion Fase 1 - Idempotency:
    // Guardamos el cbte_nro/cbte_tipo/pto_vta del intento de emision (antes
    // de que AFIP responda) para que en caso de timeout, en el retry podamos
    // consultar AFIP con FECompConsultar y verificar si la factura realmente
    // se emitio o no. Sin estos campos, no podriamos saber que numero
    // intentamos en el attempt anterior.
    await db.query(`
        ALTER TABLE invoice_emissions
            ADD COLUMN IF NOT EXISTS attempted_cbte_tipo INTEGER,
            ADD COLUMN IF NOT EXISTS attempted_pto_vta   INTEGER,
            ADD COLUMN IF NOT EXISTS attempted_cbte_nro  INTEGER
    `);

    // Migracion Fase 3 - Reconciliation cron:
    // Cuando el cron toma una row para intentar recovery, marcamos
    // last_reconciliation_at para no procesarla repetidamente cada
    // ciclo si AFIP devuelve "no existe" o si falla el upload.
    await db.query(`
        ALTER TABLE invoice_emissions
            ADD COLUMN IF NOT EXISTS last_reconciliation_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER DEFAULT 0
    `);

    // Indice para que el SELECT del cron sea barato cuando la tabla crece.
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_invoice_emissions_reconciliation
        ON invoice_emissions (status, attempted_cbte_nro, updated_at, last_reconciliation_at)
        WHERE status != 'success' AND attempted_cbte_nro IS NOT NULL
    `);

    // Migracion Fase 4 - Nightly audit:
    // Cada noche el cron consulta AFIP por cada factura nuestra exitosa
    // (status='success', audit_status IS NULL) para verificar que CAE,
    // numero e importe coincidan exactamente. Resultado en audit_status:
    // 'ok' | 'mismatch' | 'not_found_in_afip' | 'error'.
    // Una vez auditada, nunca se re-revisa (el campo deja de ser NULL).
    await db.query(`
        ALTER TABLE invoice_emissions
            ADD COLUMN IF NOT EXISTS audit_status TEXT,
            ADD COLUMN IF NOT EXISTS audited_at   TIMESTAMP,
            ADD COLUMN IF NOT EXISTS audit_findings JSONB
    `);

    // Migracion Fase 5 - Soporte de moneda extranjera (USD):
    // Default 'PES' / 1.0 garantiza que rows existentes no cambian su
    // comportamiento. Solo facturas nuevas con mapping.moneda configurado
    // van a tener valores distintos.
    await db.query(`
        ALTER TABLE invoice_emissions
            ADD COLUMN IF NOT EXISTS moneda VARCHAR(3) DEFAULT 'PES',
            ADD COLUMN IF NOT EXISTS cotizacion NUMERIC(14,6) DEFAULT 1.0
    `);

    // Indice parcial sobre rows pendientes de auditar para que el SELECT
    // nocturno no escanee toda la tabla a medida que crece.
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_invoice_emissions_audit_pending
        ON invoice_emissions (created_at DESC)
        WHERE status = 'success' AND audit_status IS NULL
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
        `CREATE TABLE IF NOT EXISTS user_api_tokens (
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

// ─── Certificados AFIP: columnas nuevas para el flujo guiado ────────────────
// La tabla afip_credentials ya existe. Este ensure es idempotente: agrega solo
// las columnas que faltan (status/alias/csr_pem/updated_at) para soportar el
// flujo de "generar CSR, subir solo CRT después".
async function ensureAfipCredentialsColumns() {
    await db.query(`
        ALTER TABLE afip_credentials
            ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active',
            ADD COLUMN IF NOT EXISTS alias VARCHAR(100),
            ADD COLUMN IF NOT EXISTS csr_pem TEXT,
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    `);

    // Para el flujo nuevo: cuando hay un CSR pendiente, crt_file_url y
    // expiration_date quedan NULL. Aseguramos que sean nullable.
    await db.query(`
        ALTER TABLE afip_credentials
            ALTER COLUMN crt_file_url DROP NOT NULL,
            ALTER COLUMN expiration_date DROP NOT NULL
    `).catch(() => { /* ya eran nullable */ });
}

// ─── Companies: columnas opcionales de contacto y branding ──────────────────
// Datos opcionales que el usuario puede completar en "Datos Fiscales" para
// luego personalizar el PDF de la factura (teléfono, email, web, logo).
// Toggles opcionales para que el cliente decida si la app puede modificar
// el item de monday. Existing rows se mantienen con el comportamiento de
// siempre (defaults TRUE). Tambien hacemos status_column_id nullable porque
// si el cliente desactiva auto_update_status no necesita mapear esa columna.
async function ensureBoardAutomationConfigsExtras() {
    await db.query(`
        ALTER TABLE board_automation_configs
            ADD COLUMN IF NOT EXISTS auto_rename_item BOOLEAN DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS auto_update_status BOOLEAN DEFAULT TRUE
    `);
    // Hacer status_column_id nullable. ALTER COLUMN no es idempotente en si
    // (no hay IF NOT NULL), pero si la columna ya es nullable no rompe nada.
    await db.query(`
        ALTER TABLE board_automation_configs
            ALTER COLUMN status_column_id DROP NOT NULL
    `).catch(() => {/* ya era nullable */});
}

async function ensureCompaniesExtraColumns() {
    await db.query(`
        ALTER TABLE companies
            ADD COLUMN IF NOT EXISTS trade_name VARCHAR(255),
            ADD COLUMN IF NOT EXISTS phone VARCHAR(50),
            ADD COLUMN IF NOT EXISTS email VARCHAR(255),
            ADD COLUMN IF NOT EXISTS website VARCHAR(500),
            ADD COLUMN IF NOT EXISTS logo_base64 TEXT,
            ADD COLUMN IF NOT EXISTS logo_mime_type VARCHAR(50),
            ADD COLUMN IF NOT EXISTS padron_condicion VARCHAR(50),
            ADD COLUMN IF NOT EXISTS padron_nombre VARCHAR(255),
            ADD COLUMN IF NOT EXISTS padron_tipo_persona VARCHAR(20),
            ADD COLUMN IF NOT EXISTS padron_domicilio VARCHAR(500),
            ADD COLUMN IF NOT EXISTS padron_fetched_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS workspace_id TEXT
    `);
    // Índice de búsqueda y UNIQUE compuesto para soportar varias empresas
    // por cuenta de monday (una por workspace). El COALESCE permite que la
    // company "legacy" (workspace_id NULL) sea única dentro de la cuenta.
    await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS companies_account_workspace_unique
        ON companies(monday_account_id, COALESCE(workspace_id, '__legacy__'))
    `);
    await db.query(`
        CREATE INDEX IF NOT EXISTS companies_lookup_idx
        ON companies(monday_account_id, workspace_id)
    `);
}

// ═══════════════════════════════════════════════════════════════════════
// CAPTURA DE INSTALACIONES — leads a tablero Monday del developer
// ═══════════════════════════════════════════════════════════════════════
// Cuando una cuenta abre la app por primera vez, detectamos que no existe
// en `installation_leads` y escribimos un item en el tablero de leads del
// developer con info de la cuenta, el usuario y el tablero donde instaló.
//
// Requiere env/secrets configurados (Monday Code Developer Center):
//   - DEV_MONDAY_TOKEN (secret) — personal API token del developer
//   - DEV_LEADS_BOARD_ID (env)  — ID del tablero de leads del developer

// Column IDs del tablero de leads del developer (mapeados manualmente).
// Si se cambian columnas en el tablero, actualizar IDs acá.
const LEADS_COLS = {
    // Identidad de cuenta + admin
    accountId:          'text_mm2eca9q',
    email:              'email_mm2e4cea',
    name:               'text_mm2e50rs',
    idAdmin:            'numeric_mm2qsc4v',   // user_id
    slug:               'text_mm2e1q62',      // account_slug
    pais:               'dropdown_mm2gt6vn',  // user_country
    producto:           'dropdown_mm2e2g97',  // user_cluster
    plan:               'dropdown_mm2ewwp6',  // account_tier (free/basic/standard/pro/enterprise)
    cantidadUsuarios:   'numeric_mm2eh07p',   // account_max_users
    // Ciclo de vida
    date:               'date_mm2er78w',      // fecha de instalación original
    ultimoEvento:       'date_mm2q4t0y',      // fecha del último evento recibido
    estado:             'color_mm2qgzh',      // Instalada/Desinstalada/Trial/Suscripto/Cancelado
    appVersion:         'text_mm2pcr2h',      // version_data.number
    // Suscripción
    planApp:            'dropdown_mm2eayn',   // subscription.plan_id (label crudo de monday)
    planAppArca:        'dropdown_mm325df0',  // plan friendly de NUESTRA app (Free/Small/Medium/Large/Enterprise)
    idPlanPago:         'text_mm2qy7m9',      // subscription.plan_id (raw)
    enTrial:            'boolean_mm2qeprp',   // subscription.is_trial
    periodoFacturacion: 'dropdown_mm2qgkm5',  // subscription.billing_period (Mensual/Anual)
    diasRestantes:      'numeric_mm2qv3va',   // subscription.days_left
    seatsPlan:          'numeric_mm2qzhb7',   // subscription.max_units
};

// Mapeo del plan_id que manda monday a nuestro nombre friendly de plan.
// Cuando configures los precios reales en monday Developer Center, los
// plan_ids ahi pueden ser distintos — actualizar este map para que matchee.
const ARCA_PLAN_LABEL = {
    free:       'Free',
    small:      'Small',
    medium:     'Medium',
    large:      'Large',
    enterprise: 'Enterprise',
};
function resolveArcaPlanLabel(rawPlanId) {
    if (!rawPlanId) return null;
    const normalized = String(rawPlanId).toLowerCase().trim();
    return ARCA_PLAN_LABEL[normalized] || null;
}

// Mapa evento → label del dropdown "Estado"
const LIFECYCLE_STATE_LABEL = {
    install:                              'Instalada',
    uninstall:                            'Desinstalada',
    app_trial_subscription_started:       'Trial',
    app_trial_subscription_ended:         'Trial terminado',
    app_subscription_created:             'Suscripto',
    app_subscription_renewed:             'Suscripto',
    app_subscription_changed:             'Suscripto',
    app_subscription_cancelled_by_user:   'Cancelación pendiente',
    app_subscription_cancelled:           'Cancelado',
    app_subscription_cancellation_revoked_by_user: 'Suscripto',
    app_subscription_renewal_attempt_failed: 'Pago fallido',
    app_subscription_renewal_failed:      'Pago fallido',
};

function billingPeriodLabel(period) {
    if (period === 'monthly') return 'Mensual';
    if (period === 'yearly')  return 'Anual';
    return period ? String(period) : '';
}

// Crea la tabla que trackea qué cuentas ya fueron notificadas al tablero de
// leads. Usamos `monday_account_id` como UNIQUE para que aunque la cuenta
// abra la app muchas veces, el item se crea una sola vez.
async function ensureInstallationLeadsTable() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS installation_leads (
            id SERIAL PRIMARY KEY,
            monday_account_id TEXT NOT NULL UNIQUE,
            notified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            lead_item_id TEXT,
            notification_error TEXT
        )
    `);
}

// ─── Subscription tracking & enforcement ────────────────────────────────────
// Requerido por monday: "Your app must verify active subscriptions at runtime.
// monday.com does not automatically restrict access when a subscription expires
// or changes."
//
// Limites preliminares por plan (ajustar cuando direccion confirme finales):
const PLAN_LIMITS = {
    free:       10,    // Free
    small:      50,    // Small
    medium:     200,   // Medium (Recomendado)
    large:      500,   // Large
    enterprise: null,  // Enterprise = ilimitado
};
const DEFAULT_PLAN_ID = 'free';

let _accountSubscriptionsTableEnsured = false;
async function ensureAccountSubscriptionsTable() {
    if (_accountSubscriptionsTableEnsured) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS account_subscriptions (
            monday_account_id TEXT PRIMARY KEY,
            plan_id           TEXT,
            monthly_limit     INTEGER,
            is_trial          BOOLEAN DEFAULT FALSE,
            days_left         INTEGER,
            billing_period    TEXT,
            status            TEXT DEFAULT 'active',
            raw_subscription  JSONB,
            created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
    _accountSubscriptionsTableEnsured = true;
}

// Resuelve el limite mensual a partir del plan_id de monday.
// Si el plan no esta en nuestra config, devuelve el default (free).
function resolveMonthlyLimit(planId) {
    if (!planId) return PLAN_LIMITS[DEFAULT_PLAN_ID];
    const normalized = String(planId).toLowerCase();
    if (normalized in PLAN_LIMITS) return PLAN_LIMITS[normalized];
    // Plan ID custom de monday — fallback al default conservador.
    return PLAN_LIMITS[DEFAULT_PLAN_ID];
}

// Upsert del estado de subscription de una cuenta. Llamado desde el handler de
// lifecycle events cuando llega un evento de subscription.
async function upsertAccountSubscription(accountId, subscriptionData, statusOverride) {
    if (!accountId) return;
    await ensureAccountSubscriptionsTable();
    const sub = subscriptionData || {};
    const planId        = sub.plan_id || DEFAULT_PLAN_ID;
    const monthlyLimit  = resolveMonthlyLimit(planId);
    const isTrial       = Boolean(sub.is_trial);
    const daysLeft      = sub.days_left != null ? Number(sub.days_left) : null;
    const billingPeriod = sub.billing_period || null;
    const status        = statusOverride || (isTrial ? 'trial' : 'active');
    await db.query(`
        INSERT INTO account_subscriptions
            (monday_account_id, plan_id, monthly_limit, is_trial, days_left, billing_period, status, raw_subscription, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, CURRENT_TIMESTAMP)
        ON CONFLICT (monday_account_id) DO UPDATE SET
            plan_id          = EXCLUDED.plan_id,
            monthly_limit    = EXCLUDED.monthly_limit,
            is_trial         = EXCLUDED.is_trial,
            days_left        = EXCLUDED.days_left,
            billing_period   = EXCLUDED.billing_period,
            status           = EXCLUDED.status,
            raw_subscription = EXCLUDED.raw_subscription,
            updated_at       = CURRENT_TIMESTAMP
    `, [String(accountId), planId, monthlyLimit, isTrial, daysLeft, billingPeriod, status, JSON.stringify(sub)]);
}

// Marca subscription como cancelada (sin borrar la fila, para historial).
async function markAccountSubscriptionStatus(accountId, status) {
    if (!accountId) return;
    await ensureAccountSubscriptionsTable();
    await db.query(`
        UPDATE account_subscriptions
           SET status = $2, updated_at = CURRENT_TIMESTAMP
         WHERE monday_account_id = $1
    `, [String(accountId), status]);
}

// Devuelve el plan actual de una cuenta. Si no hay registro, devuelve Free
// (default conservador).
async function getAccountPlan(accountId) {
    await ensureAccountSubscriptionsTable();
    const r = await db.query(
        'SELECT * FROM account_subscriptions WHERE monday_account_id = $1',
        [String(accountId)]
    );
    if (r.rows.length === 0) {
        return {
            plan_id: DEFAULT_PLAN_ID,
            monthly_limit: PLAN_LIMITS[DEFAULT_PLAN_ID],
            is_trial: false,
            status: 'active',
            days_left: null,
            billing_period: null,
        };
    }
    return r.rows[0];
}

// Cuenta facturas EMITIDAS EXITOSAMENTE en el mes calendario actual (UTC).
// Solo cuentan las que tienen status='success' — los intentos fallidos no
// consumen quota.
async function getMonthlyEmissionCount(accountId) {
    if (!accountId) return 0;
    const r = await db.query(`
        SELECT COUNT(*)::int AS n
          FROM invoice_emissions ie
          JOIN companies c ON c.id = ie.company_id
         WHERE c.monday_account_id::text = $1
           AND ie.status = 'success'
           AND ie.created_at >= date_trunc('month', CURRENT_TIMESTAMP)
    `, [String(accountId)]);
    return r.rows[0]?.n || 0;
}

// Chequea si una cuenta puede emitir una factura mas en este momento.
// Devuelve { allowed, plan, used, limit, remaining, reason }.
async function checkEmissionAllowed(accountId) {
    const plan = await getAccountPlan(accountId);
    // Cancelada o trial expirado → sin permiso
    if (plan.status === 'cancelled' || plan.status === 'trial_expired') {
        return {
            allowed: false,
            plan,
            used: 0,
            limit: plan.monthly_limit,
            remaining: 0,
            reason: 'subscription_inactive',
        };
    }
    // Plan ilimitado (Enterprise) → siempre permitido
    if (plan.monthly_limit == null) {
        return {
            allowed: true,
            plan,
            used: 0,
            limit: null,
            remaining: null,
            reason: null,
        };
    }
    const used = await getMonthlyEmissionCount(accountId);
    const remaining = Math.max(0, plan.monthly_limit - used);
    return {
        allowed: used < plan.monthly_limit,
        plan,
        used,
        limit: plan.monthly_limit,
        remaining,
        reason: used >= plan.monthly_limit ? 'monthly_limit_reached' : null,
    };
}

// Tabla del audit log: mapea (cuenta de cliente, item del cliente) -> item del
// board de auditoría de TAP. Garantiza un único item de auditoría por cada item
// del cliente: los reintentos actualizan el item existente en lugar de crear
// duplicados.
let _auditLogItemsTableEnsured = false;
async function ensureAuditLogItemsTable() {
    if (_auditLogItemsTableEnsured) return;
    await db.query(`
        CREATE TABLE IF NOT EXISTS audit_log_items (
            id SERIAL PRIMARY KEY,
            monday_account_id TEXT NOT NULL,
            client_item_id TEXT NOT NULL,
            audit_item_id TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (monday_account_id, client_item_id)
        )
    `);
    // Multi-empresa: agregamos el workspace_id y company_id de la empresa
    // que emitió la factura, para diferenciar facturas de distintas empresas
    // que viven dentro de la misma cuenta monday.
    await db.query(`
        ALTER TABLE audit_log_items
            ADD COLUMN IF NOT EXISTS workspace_id TEXT,
            ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL
    `);
    _auditLogItemsTableEnsured = true;
}

async function findAuditItemId(accountId, clientItemId) {
    if (!accountId || !clientItemId) return null;
    try {
        const r = await db.query(
            'SELECT audit_item_id FROM audit_log_items WHERE monday_account_id=$1 AND client_item_id=$2',
            [String(accountId), String(clientItemId)]
        );
        return r.rows[0]?.audit_item_id || null;
    } catch (_) { return null; }
}

async function recordAuditMapping(accountId, clientItemId, auditItemId, opts = {}) {
    if (!accountId || !clientItemId || !auditItemId) return;
    // company_id y workspace_id son opcionales (multi-empresa). Si vienen, los
    // guardamos para poder filtrar el audit log por empresa después.
    const companyId = opts.companyId || null;
    const workspaceId = opts.workspaceId || null;
    try {
        await db.query(
            `INSERT INTO audit_log_items (monday_account_id, client_item_id, audit_item_id, company_id, workspace_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (monday_account_id, client_item_id)
             DO UPDATE SET
                audit_item_id = EXCLUDED.audit_item_id,
                company_id    = COALESCE(EXCLUDED.company_id, audit_log_items.company_id),
                workspace_id  = COALESCE(EXCLUDED.workspace_id, audit_log_items.workspace_id),
                updated_at    = CURRENT_TIMESTAMP`,
            [String(accountId), String(clientItemId), String(auditItemId), companyId, workspaceId]
        );
    } catch (err) { console.warn('[audit-log] error guardando mapeo:', err.message); }
}

// Wrapper de fetch con reintentos: hasta `attempts` intentos con `delayMs` entre
// cada uno. Reintenta en errores de red (excepción) y en HTTP 5xx. NO reintenta
// en 4xx (es nuestro problema, no transient). Tiene timeout duro por intento.
async function fetchWithRetry(url, options = {}, { attempts = 2, delayMs = 3000, timeoutMs = 30000, label = 'fetch' } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            if (res.status >= 500 && res.status < 600 && i < attempts - 1) {
                console.warn(`[${label}] HTTP ${res.status} — reintento ${i + 1}/${attempts} en ${delayMs}ms`);
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }
            return res;
        } catch (err) {
            clearTimeout(timeoutId);
            lastErr = err;
            if (i < attempts - 1) {
                console.warn(`[${label}] fetch falló (${err.message}) — reintento ${i + 1}/${attempts} en ${delayMs}ms`);
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }
        }
    }
    throw lastErr || new Error(`fetchWithRetry: agotados ${attempts} intentos`);
}

// Query genérica a Monday GraphQL con un token dado.
async function mondayGql(token, query, variables = {}) {
    const res = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: {
            'Authorization': token,
            'Content-Type': 'application/json',
            'API-Version': '2024-10',
        },
        body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.errors || json.error_message) {
        throw new Error(`Monday GraphQL error: ${JSON.stringify(json.errors || json.error_message || res.status)}`);
    }
    return json.data;
}

// Arma el objeto column_values para mandar a Monday desde el payload del webhook
// lifecycle. Solo incluye campos que vinieron con valor, así los updates no pisan
// columnas con vacío cuando el evento no trae ese dato (ej: uninstall no trae
// subscription.*).
function buildLeadColumnValues(eventType, data) {
    const sub = data.subscription || {};
    const cv = {};

    // Estado según el tipo de evento
    const estado = LIFECYCLE_STATE_LABEL[eventType];
    if (estado) cv[LEADS_COLS.estado] = { label: estado };

    // Siempre setear la fecha del último evento
    cv[LEADS_COLS.ultimoEvento] = { date: new Date().toISOString().slice(0, 10) };

    // Cuenta + admin (vienen en casi todos los eventos)
    if (data.account_id != null)       cv[LEADS_COLS.accountId]        = String(data.account_id);
    if (data.account_tier)             cv[LEADS_COLS.plan]             = { labels: [String(data.account_tier)] };
    if (data.account_slug)             cv[LEADS_COLS.slug]             = String(data.account_slug);
    if (data.account_max_users != null) cv[LEADS_COLS.cantidadUsuarios] = String(data.account_max_users);
    if (data.user_country)             cv[LEADS_COLS.pais]             = { labels: [String(data.user_country)] };
    if (data.user_cluster)             cv[LEADS_COLS.producto]         = { labels: [String(data.user_cluster)] };
    if (data.user_email)               cv[LEADS_COLS.email]            = { email: data.user_email, text: data.user_email };
    if (data.user_name)                cv[LEADS_COLS.name]             = String(data.user_name);
    if (data.user_id != null)          cv[LEADS_COLS.idAdmin]          = String(data.user_id);
    if (data.version_data?.number != null) cv[LEADS_COLS.appVersion]   = String(data.version_data.number);

    // Suscripción (solo llega en eventos app_subscription_* / app_trial_*)
    if (sub.plan_id) {
        cv[LEADS_COLS.planApp]    = { labels: [String(sub.plan_id)] };
        cv[LEADS_COLS.idPlanPago] = String(sub.plan_id);
        // Tambien actualizar el dropdown de "Plan De APP" con el nombre
        // friendly de NUESTRA app (Free/Small/Medium/Large/Enterprise).
        const arcaLabel = resolveArcaPlanLabel(sub.plan_id);
        if (arcaLabel) cv[LEADS_COLS.planAppArca] = { labels: [arcaLabel] };
    } else if (eventType === 'install') {
        // Install sin subscription = cliente arranca en plan Free.
        // monday no manda subscription event hasta que el cliente elige plan
        // o paga, entonces marcamos el lead como Free para que el CRM no
        // quede vacio en esa columna.
        cv[LEADS_COLS.planAppArca] = { labels: ['Free'] };
    }
    if (sub.is_trial != null)      cv[LEADS_COLS.enTrial]            = { checked: sub.is_trial ? 'true' : 'false' };
    if (sub.billing_period)        cv[LEADS_COLS.periodoFacturacion] = { labels: [billingPeriodLabel(sub.billing_period)] };
    if (sub.days_left != null)     cv[LEADS_COLS.diasRestantes]      = String(sub.days_left);
    if (sub.max_units != null)     cv[LEADS_COLS.seatsPlan]          = String(sub.max_units);

    // Anonimización en uninstall: vaciar PII del item para cumplir con la
    // política de privacidad de monday. Conservamos account_id, plan, país y
    // fechas para métricas agregadas. En reinstall se repuebla con data fresca.
    if (eventType === 'uninstall') {
        cv[LEADS_COLS.email]   = { email: '', text: '' };
        cv[LEADS_COLS.name]    = '';
        cv[LEADS_COLS.idAdmin] = '';
    }

    return cv;
}

// Crea item nuevo en el tablero de leads. Se usa solo en el primer `install`
// de cada cuenta.
async function createLeadItem(devToken, leadsBoardId, itemName, columnValues) {
    const mutation = `
        mutation($boardId: ID!, $itemName: String!, $cv: JSON!) {
            create_item(
                board_id: $boardId,
                item_name: $itemName,
                column_values: $cv,
                create_labels_if_missing: true
            ) {
                id
            }
        }
    `;
    const data = await mondayGql(devToken, mutation, {
        boardId: String(leadsBoardId),
        itemName,
        cv: JSON.stringify(columnValues),
    });
    return data?.create_item?.id || null;
}

// Actualiza un item existente del tablero de leads. Se usa para todos los
// eventos posteriores a install (uninstall, trial, subscription, etc.).
async function updateLeadItem(devToken, leadsBoardId, itemId, columnValues) {
    const mutation = `
        mutation($boardId: ID!, $itemId: ID!, $cv: JSON!) {
            change_multiple_column_values(
                board_id: $boardId,
                item_id: $itemId,
                column_values: $cv,
                create_labels_if_missing: true
            ) {
                id
            }
        }
    `;
    await mondayGql(devToken, mutation, {
        boardId: String(leadsBoardId),
        itemId:  String(itemId),
        cv:      JSON.stringify(columnValues),
    });
}

// ─── Helpers de validación de datos de contacto (suaves) ────────────────────
const ALLOWED_LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp']);
const MAX_LOGO_BYTES = 1024 * 1024; // 1 MB

function normalizeOptionalText(value, maxLen) {
    if (value == null) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    return maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeEmail(value) {
    const trimmed = normalizeOptionalText(value, 255);
    if (!trimmed) return { value: null, error: null };
    // Regex permisivo: algo@algo.algo. No pretende ser RFC-completo.
    const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    if (!ok) return { value: null, error: 'El email no tiene un formato válido' };
    return { value: trimmed.toLowerCase(), error: null };
}

function normalizeWebsite(value) {
    const trimmed = normalizeOptionalText(value, 500);
    if (!trimmed) return { value: null, error: null };
    // Si no trae protocolo, asumimos https.
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const u = new URL(withScheme);
        if (!u.hostname.includes('.')) {
            return { value: null, error: 'La dirección web no es válida' };
        }
        return { value: withScheme, error: null };
    } catch {
        return { value: null, error: 'La dirección web no es válida' };
    }
}

function normalizePhone(value) {
    const trimmed = normalizeOptionalText(value, 50);
    return { value: trimmed, error: null };
}

// ─── Helpers de certificados ────────────────────────────────────────────────
/**
 * Valida que una clave privada y un certificado sean pareja (misma clave pública).
 * Tira Error con mensaje claro si el CRT es inválido o no matchea la KEY.
 */
function assertKeyMatchesCrt(crtPem, keyPem) {
    let cert, priv;
    try {
        cert = forge.pki.certificateFromPem(crtPem);
    } catch (err) {
        const e = new Error('El archivo .crt no es un certificado X.509 válido');
        e.code = 'INVALID_CRT';
        throw e;
    }
    try {
        priv = forge.pki.privateKeyFromPem(keyPem);
    } catch (err) {
        const e = new Error('El archivo .key no es una clave privada válida');
        e.code = 'INVALID_KEY';
        throw e;
    }
    // Para claves RSA, el par matchea si (n, e) son iguales entre public y private.
    const matches =
        cert.publicKey?.n && priv?.n &&
        cert.publicKey.n.equals(priv.n) &&
        cert.publicKey.e.equals(priv.e);
    if (!matches) {
        const e = new Error('El certificado y la clave privada no coinciden (no son pareja)');
        e.code = 'KEY_CRT_MISMATCH';
        throw e;
    }
    return { cert, priv };
}

/** Genera un par RSA 2048 de forma async (usa el thread pool de libuv). */
function generateRsaKeyPairAsync() {
    return new Promise((resolve, reject) => {
        crypto.generateKeyPair('rsa', {
            modulusLength: 2048,
            publicKeyEncoding:  { type: 'spki',  format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        }, (err, publicKey, privateKey) => {
            if (err) reject(err);
            else resolve({ publicKey, privateKey });
        });
    });
}

/**
 * Genera un CSR (PKCS#10) firmado con SHA-256 listo para subir a ARCA.
 * Subject del CSR: CN=<alias>, O=<razón social>, serialNumber="CUIT XX-XXXXXXXX-X".
 * El serialNumber con el CUIT formateado es lo que valida ARCA en el alta del alias.
 */
async function generateCsrAndKey({ alias, cuit, businessName }) {
    const { publicKey: pubPem, privateKey: keyPem } = await generateRsaKeyPairAsync();

    const pubKeyForge  = forge.pki.publicKeyFromPem(pubPem);
    const privKeyForge = forge.pki.privateKeyFromPem(keyPem);

    const cuitDigits = String(cuit || '').replace(/\D/g, '');
    const cuitSerial = cuitDigits.length === 11
        ? `CUIT ${cuitDigits.slice(0, 2)}-${cuitDigits.slice(2, 10)}-${cuitDigits.slice(10)}`
        : `CUIT ${cuitDigits}`;

    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = pubKeyForge;
    csr.setSubject([
        { name: 'commonName',       value: String(alias || '').trim() },
        { name: 'organizationName', value: String(businessName || '').trim() },
        { name: 'serialNumber',     value: cuitSerial }
    ]);
    csr.sign(privKeyForge, forge.md.sha256.create());

    return {
        csrPem: forge.pki.certificationRequestToPem(csr),
        keyPem
    };
}

async function getStoredMondayUserApiToken({ mondayAccountId }) {
    if (!mondayAccountId) return null;

    await ensureUserApiTokensV3Table();

    const result = await db.query(
        `SELECT encrypted_api_token
         FROM user_api_tokens
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

// La generación del PDF de la factura vive en ./modules/invoicePdf.js

// --- RUTAS ---

app.get('/api/health', async (req, res) => {
    try {
        await db.query('SELECT NOW()');
        res.json({ status: 'ok', message: 'Servidor y DB conectados' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Domain ownership verification para el privacy & security review de monday.
// monday hace GET a este path y verifica que el clientID coincide con el de la
// app registrada — así prueba que somos dueños del dominio.
// Docs: https://developer.monday.com/apps/docs/privacy-and-security
app.get('/monday-app-association.json', (req, res) => {
    const clientID = process.env.MONDAY_CLIENT_ID;
    if (!clientID) {
        console.warn('[monday-app-association] MONDAY_CLIENT_ID no configurado');
        return res.status(500).json({ error: 'MONDAY_CLIENT_ID env var not configured' });
    }
    res.json({ apps: [{ clientID }] });
});

// Pagina publica de "Como usar Factura ARCA" — embebible en iframe de monday.
// Requerida por el Documentation & Support checklist del review:
// "Create an instructions page... HTTPS protocol, embeddable iframe link
//  for *.monday.com domain". Va al campo "How to use Link" del form de
// submission.
app.get('/onboarding', (req, res) => {
    res.sendFile(path.join(__dirname, 'onboarding.html'));
});

// Devuelve el plan y consumo actual del mes para la cuenta autenticada.
// Lo usa el frontend para mostrar el banner de uso (X / limite facturas).
app.get('/api/usage', requireMondaySession, async (req, res) => {
    try {
        const accountId = String(req.mondayIdentity.accountId || '');
        if (!accountId) return res.status(400).json({ error: 'account_id ausente' });
        const check = await checkEmissionAllowed(accountId);
        res.json({
            plan_id: check.plan.plan_id,
            is_trial: check.plan.is_trial,
            status: check.plan.status,
            limit: check.limit,
            used: check.used,
            remaining: check.remaining,
            allowed: check.allowed,
        });
    } catch (err) {
        console.error('[usage] error:', err.message);
        res.status(500).json({ error: 'error consultando usage' });
    }
});


app.get('/api/setup/:mondayAccountId', requireMondaySession, async (req, res) => {
    const { mondayAccountId } = req.params;
    const { board_id, view_id, app_feature_id, workspace_id } = req.query;
    // workspace_id: opcional. Si llega, busca la empresa específica de ese
    // workspace; sino cae al comportamiento legacy (la primera empresa de la
    // cuenta, priorizando la de workspace_id NULL).
    const workspaceId = workspace_id ? String(workspace_id) : null;

    if (!ensureAccountMatch(req, res, mondayAccountId)) return;

    console.log('🔎 setup request', {
        mondayAccountId,
        workspace_id: workspaceId,
        board_id: board_id || null,
        view_id: view_id || null,
        app_feature_id: app_feature_id || null
    });

    // Refresh oportunista del padrón del emisor — cuando abren la app, si el
    // dato en DB tiene >18h o no existe, consultamos AFIP en background.
    // El cron diario (2am AR) cubre la mayoría de los casos; esto es backup.
    setImmediate(async () => {
        try {
            const company = await getCompanyByMondayAccountId(mondayAccountId, workspaceId);
            if (!company?.cuit) return;
            const fetchedAt = company.padron_fetched_at
                ? new Date(company.padron_fetched_at).getTime() : 0;
            const ageMs = fetchedAt ? Date.now() - fetchedAt : Infinity;
            if (company.padron_condicion && ageMs < PADRON_EMISOR_STALE_MS) return;
            console.log(`[padron-refresh] refresh oportunista CUIT ${company.cuit} (ageMs=${ageMs === Infinity ? 'null' : ageMs})`);
            await getOrRefreshEmisorPadron(company);
        } catch (err) {
            console.error('[padron-refresh] error:', err.message);
        }
    });

    // Pre-generar token WSFE en background si hay cert activo pero no hay
    // token fresco en DB. Cubre: clientes ya instalados antes del deploy de
    // esta feature, y cualquier caso borde donde el token se haya perdido.
    // Así la primera factura después de abrir la app tampoco paga el costo.
    setImmediate(async () => {
        try {
            const company = await getCompanyByMondayAccountId(mondayAccountId, workspaceId);
            if (!company?.id) return;
            await pregenerateWsfeTokenForCompanyId(company.id);
        } catch (err) {
            console.error('[wsaa-pregen setup] error:', err.message);
        }
    });

    try {
        await ensureCompaniesExtraColumns();
        let company = await getCompanyByMondayAccountId(mondayAccountId, workspaceId);

        // Fallback legacy: si la request trae workspaceId y no hay match, pero
        // existe UNA sola company legacy (workspace_id NULL) para esta cuenta
        // y ninguna otra company para otros workspaces, asumimos que es el
        // mismo cliente abriendo desde un workspace diferente al original y
        // devolvemos sus datos. El próximo POST /companies va a hacer la
        // migración via "claim on first save".
        if (!company && workspaceId) {
            const counts = await db.query(
                `SELECT
                    COUNT(*) FILTER (WHERE workspace_id IS NULL) AS legacy_count,
                    COUNT(*) FILTER (WHERE workspace_id IS NOT NULL) AS scoped_count
                   FROM companies
                  WHERE monday_account_id::text = $1`,
                [String(mondayAccountId)]
            );
            const { legacy_count, scoped_count } = counts.rows[0] || {};
            if (Number(legacy_count) === 1 && Number(scoped_count) === 0) {
                console.log(`[multi-tenant] devolviendo company legacy a workspace=${workspaceId} (single-company fallback)`);
                company = await getCompanyByMondayAccountId(mondayAccountId, null);
            }
        }

        if (!company) {
            return res.json({
                hasFiscalData: false,
                hasCertificates: false,
                certificateStatus: 'no_cert',
                fiscalData: null,
                certificates: null,
                visualMapping: null,
                boardConfig: null,
                identifiers: {
                    monday_account_id: mondayAccountId,
                    workspace_id: workspaceId,
                    board_id: board_id || null,
                    view_id: view_id || null,
                    app_feature_id: app_feature_id || null
                }
            });
        }

        await ensureAfipCredentialsColumns();
        const certResult = await db.query(
            `SELECT expiration_date, status, alias, updated_at,
                    (csr_pem IS NOT NULL) AS has_csr
             FROM afip_credentials
             WHERE company_id = $1
             LIMIT 1`,
            [company.id]
        );
        const certRow = certResult.rows[0] || null;
        const certificateStatus = certRow
            ? (certRow.status === 'pending_crt' ? 'pending_crt' : 'active')
            : 'no_cert';

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
                    `SELECT status_column_id, trigger_label, success_label, error_label,
                            required_columns_json, updated_at,
                            auto_rename_item, auto_update_status
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
                        // Default TRUE para no afectar a clientes existentes que
                        // no tienen estos flags grabados aun (NULL o no existe).
                        auto_rename_item: row.auto_rename_item !== false,
                        auto_update_status: row.auto_update_status !== false,
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
            hasCertificates: certificateStatus === 'active',
            certificateStatus, // 'no_cert' | 'pending_crt' | 'active'
            fiscalData: {
                business_name: company.business_name || '',
                nombre_fantasia: company.trade_name || '',
                cuit: company.cuit || '',
                default_point_of_sale: company.default_point_of_sale || '',
                domicilio: company.address || '',
                fecha_inicio: company.start_date || '',
                phone: company.phone || '',
                email: company.email || '',
                website: company.website || '',
                logo_data_url: (company.logo_base64 && company.logo_mime_type)
                    ? `data:${company.logo_mime_type};base64,${company.logo_base64}`
                    : null,
                has_logo: Boolean(company.logo_base64)
            },
            certificates: certRow
                ? {
                    expiration_date: certRow.expiration_date,
                    status: certRow.status,
                    alias: certRow.alias,
                    updated_at: certRow.updated_at,
                    has_csr: certRow.has_csr
                  }
                : null,
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
            `SELECT id, status_column_id, trigger_label, success_label, error_label,
                    required_columns_json, updated_at,
                    auto_rename_item, auto_update_status
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
                // Default TRUE para no afectar a clientes que no tienen estos
                // flags todavia: el comportamiento sigue siendo el de siempre.
                auto_rename_item: row.auto_rename_item !== false,
                auto_update_status: row.auto_update_status !== false,
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

app.post('/api/board-config', requireMondaySession, validateBody(BoardConfigSchema), async (req, res) => {
    const {
        monday_account_id,
        workspace_id,
        board_id,
        view_id,
        app_feature_id,
        status_column_id,
        required_columns,
        auto_rename_item,
        auto_update_status,
    } = req.body;

    const accountId = String(monday_account_id || req.mondayIdentity.accountId || '');
    const workspaceId = workspace_id ? String(workspace_id) : null;

    // Defaults TRUE para mantener el comportamiento de los clientes existentes
    // si por algun motivo no vienen estos flags en el body (ej: deploys parciales).
    const autoRenameItem    = auto_rename_item    === false ? false : true;
    const autoUpdateStatus  = auto_update_status  === false ? false : true;

    if (!accountId || !board_id) {
        return res.status(400).json({ error: 'monday_account_id y board_id son obligatorios' });
    }

    // status_column_id solo es obligatoria si auto_update_status esta activo
    if (autoUpdateStatus && !status_column_id) {
        return res.status(400).json({
            error: 'status_column_id es obligatorio cuando "Cambiar el estado del item" está activado'
        });
    }

    if (!ensureAccountMatch(req, res, accountId)) return;

    if (!Array.isArray(required_columns)) {
        return res.status(400).json({ error: 'required_columns debe ser un array' });
    }

    try {
        const company = await getCompanyByMondayAccountId(accountId, workspaceId);
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
                 workspace_id = $10,
                 auto_rename_item = $11,
                 auto_update_status = $12,
                 updated_at = CURRENT_TIMESTAMP
             WHERE company_id = $1
               AND board_id = $2
             RETURNING *`,
            [
                company.id,
                String(board_id),
                status_column_id ? String(status_column_id) : null,
                view_id || null,
                app_feature_id || null,
                COMPROBANTE_STATUS_FLOW.trigger,
                COMPROBANTE_STATUS_FLOW.success,
                COMPROBANTE_STATUS_FLOW.error,
                JSON.stringify(required_columns),
                workspaceId,
                autoRenameItem,
                autoUpdateStatus,
            ]
        );

        if (updateResult.rows.length > 0) {
            return res.json({ message: 'Configuración de tablero actualizada', config: updateResult.rows[0] });
        }

        const insertResult = await db.query(
            `INSERT INTO board_automation_configs (
                company_id,
                workspace_id,
                board_id,
                view_id,
                app_feature_id,
                status_column_id,
                trigger_label,
                success_label,
                error_label,
                required_columns_json,
                auto_rename_item,
                auto_update_status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *`,
            [
                company.id,
                workspaceId,
                String(board_id),
                view_id || null,
                app_feature_id || null,
                status_column_id ? String(status_column_id) : null,
                COMPROBANTE_STATUS_FLOW.trigger,
                COMPROBANTE_STATUS_FLOW.success,
                COMPROBANTE_STATUS_FLOW.error,
                JSON.stringify(required_columns),
                autoRenameItem,
                autoUpdateStatus,
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
             FROM user_api_tokens
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
            `INSERT INTO user_api_tokens (monday_account_id, encrypted_api_token)
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
            storage: 'user_api_tokens',
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

app.post('/api/user-api-token', requireMondaySession, validateBody(UserApiTokenSchema), saveUserApiTokenHandler);
app.post('/api/user-api-token-v2', requireMondaySession, validateBody(UserApiTokenSchema), saveUserApiTokenHandler);

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

app.post('/api/mappings', requireMondaySession, validateBody(MappingSchema), async (req, res) => {
    const {
        monday_account_id,
        workspace_id,
        board_id,
        view_id,
        app_feature_id,
        mapping,
        is_locked
    } = req.body;

    const accountId = String(monday_account_id || req.mondayIdentity.accountId || '');
    const workspaceId = workspace_id ? String(workspace_id) : null;

    if (!accountId || !board_id) {
        return res.status(400).json({ error: 'monday_account_id y board_id son obligatorios' });
    }

    if (!ensureAccountMatch(req, res, accountId)) return;

    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        return res.status(400).json({ error: 'mapping debe ser un objeto JSON valido' });
    }

    try {
        const company = await getCompanyByMondayAccountId(accountId, workspaceId);
        if (!company) {
            return res.status(404).json({ error: 'Empresa no encontrada' });
        }

        const updateResult = await db.query(
            `UPDATE visual_mappings
             SET mapping_json = $5,
                 is_locked = COALESCE($6, is_locked),
                 workspace_id = $7,
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
                typeof is_locked === 'boolean' ? is_locked : null,
                workspaceId
            ]
        );

        if (updateResult.rows.length > 0) {
            return res.json({ message: 'Mapeo visual actualizado', mapping: updateResult.rows[0] });
        }

        const insertResult = await db.query(
            `INSERT INTO visual_mappings (
                company_id,
                workspace_id,
                board_id,
                view_id,
                app_feature_id,
                mapping_json,
                is_locked
            ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
            RETURNING *`,
            [
                company.id,
                workspaceId,
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

app.post('/api/companies', requireMondaySession, validateBody(CompanySchema), async (req, res) => {
    const {
        monday_account_id, workspace_id, business_name, nombre_fantasia, cuit, default_point_of_sale, domicilio, fecha_inicio,
        phone, email, website
    } = req.body;
    const accountId = String(monday_account_id || req.mondayIdentity.accountId || '');
    // workspace_id es opcional. Si no llega, la empresa queda como "legacy"
    // (workspace_id NULL), compatible con clientes con frontend viejo.
    const workspaceId = workspace_id ? String(workspace_id) : null;

    if (!accountId) {
        return res.status(400).json({ error: 'monday_account_id es obligatorio' });
    }

    if (!ensureAccountMatch(req, res, accountId)) return;

    const tradeName = String(nombre_fantasia || '').trim();
    if (!tradeName) {
        return res.status(400).json({
            error: 'El nombre de fantasía es obligatorio',
            code: 'MISSING_TRADE_NAME'
        });
    }

    const phoneNorm = normalizePhone(phone);
    const emailNorm = normalizeEmail(email);
    const websiteNorm = normalizeWebsite(website);

    if (emailNorm.error)   return res.status(400).json({ error: emailNorm.error,   code: 'INVALID_EMAIL' });
    if (websiteNorm.error) return res.status(400).json({ error: websiteNorm.error, code: 'INVALID_WEBSITE' });

    try {
        await ensureCompaniesExtraColumns();

        // Migración self-healing para clientes legacy: si llega un workspace_id
        // y NO existe una company para (account, workspace), pero SÍ existe una
        // legacy con workspace_id=NULL, "claim" esa fila asignándole el
        // workspace actual. Así el primer save desde el frontend nuevo migra
        // automáticamente la company existente, sin perder cert ni mapeo.
        if (workspaceId) {
            const claimRes = await db.query(
                `UPDATE companies
                    SET workspace_id = $2,
                        updated_at = CURRENT_TIMESTAMP
                  WHERE monday_account_id = $1
                    AND workspace_id IS NULL
                    AND NOT EXISTS (
                        SELECT 1 FROM companies c2
                         WHERE c2.monday_account_id = $1
                           AND c2.workspace_id = $2
                    )
                  RETURNING id`,
                [accountId, workspaceId]
            );
            if (claimRes.rowCount > 0) {
                console.log(`[multi-tenant] legacy company ${claimRes.rows[0].id} migrada al workspace ${workspaceId}`);
            }
        }

        // UPSERT por (monday_account_id, workspace_id). El UNIQUE INDEX
        // companies_account_workspace_unique soporta el ON CONFLICT con la
        // expresión COALESCE para que NULL se trate de forma determinística.
        const query = `
            INSERT INTO companies (monday_account_id, workspace_id, business_name, trade_name, cuit, default_point_of_sale, address, start_date, phone, email, website)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (monday_account_id, COALESCE(workspace_id, '__legacy__'))
            DO UPDATE SET
                business_name = EXCLUDED.business_name,
                trade_name = EXCLUDED.trade_name,
                cuit = EXCLUDED.cuit,
                default_point_of_sale = EXCLUDED.default_point_of_sale,
                address = EXCLUDED.address,
                start_date = EXCLUDED.start_date,
                phone = EXCLUDED.phone,
                email = EXCLUDED.email,
                website = EXCLUDED.website,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *;
        `;
        const result = await db.query(query, [
            accountId, workspaceId, business_name, tradeName, cuit, default_point_of_sale, domicilio, fecha_inicio,
            phoneNorm.value, emailNorm.value, websiteNorm.value
        ]);
        // Datos fiscales cambiaron → invalidar cache del padrón en DB.
        if (result.rows[0]?.id) await invalidateEmisorPadronDb(result.rows[0].id);
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

// ─── Logo de la empresa (opcional, para el PDF) ─────────────────────────────
// Sube una imagen y la guarda como base64 en companies.logo_base64. Limitado a
// 500 KB y a tipos de imagen comunes. La empresa ya tiene que estar creada.
app.post('/api/companies/logo', requireMondaySession, upload.single('logo'), async (req, res) => {
    const accountId = String(req.body.monday_account_id || req.mondayIdentity.accountId || '');
    const workspaceId = req.body.workspace_id ? String(req.body.workspace_id) : null;

    if (!accountId) return res.status(400).json({ error: 'monday_account_id es obligatorio' });
    if (!ensureAccountMatch(req, res, accountId)) return;
    if (!req.file)  return res.status(400).json({ error: 'Falta el archivo de logo' });

    const { mimetype, size, buffer } = req.file;
    if (!ALLOWED_LOGO_MIME_TYPES.has(mimetype)) {
        return res.status(400).json({
            error: 'Formato de imagen no permitido. Usá PNG, JPG, SVG o WebP.',
            code: 'INVALID_LOGO_MIME'
        });
    }
    if (size > MAX_LOGO_BYTES) {
        return res.status(400).json({
            error: `El logo supera el tamaño máximo (${Math.round(MAX_LOGO_BYTES / 1024)} KB).`,
            code: 'LOGO_TOO_LARGE'
        });
    }

    try {
        await ensureCompaniesExtraColumns();
        // Multi-tenant: si viene workspace_id matcheamos por (account, workspace);
        // si NO viene (cliente legacy o app antigua) caemos al match por solo account
        // exigiendo workspace_id IS NULL para no pisar otra company.
        const result = await db.query(
            `UPDATE companies
                SET logo_base64 = $2,
                    logo_mime_type = $3,
                    updated_at = CURRENT_TIMESTAMP
              WHERE monday_account_id = $1
                AND COALESCE(workspace_id, '__legacy__') = COALESCE($4, '__legacy__')
              RETURNING id`,
            [accountId, buffer.toString('base64'), mimetype, workspaceId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Empresa no encontrada. Guardá los datos fiscales primero.' });
        }
        res.json({
            message: 'Logo guardado correctamente',
            logo_data_url: `data:${mimetype};base64,${buffer.toString('base64')}`
        });
    } catch (err) {
        console.error('❌ Error al guardar logo:', err);
        res.status(500).json({ error: 'Error al guardar el logo', details: err.message });
    }
});

app.delete('/api/companies/logo/:mondayAccountId', requireMondaySession, async (req, res) => {
    const { mondayAccountId } = req.params;
    const workspaceId = req.query.workspace_id ? String(req.query.workspace_id) : null;
    if (!ensureAccountMatch(req, res, mondayAccountId)) return;

    try {
        await ensureCompaniesExtraColumns();
        const result = await db.query(
            `UPDATE companies
                SET logo_base64 = NULL,
                    logo_mime_type = NULL,
                    updated_at = CURRENT_TIMESTAMP
              WHERE monday_account_id = $1
                AND COALESCE(workspace_id, '__legacy__') = COALESCE($2, '__legacy__')
              RETURNING id`,
            [String(mondayAccountId), workspaceId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Empresa no encontrada' });
        }
        res.json({ message: 'Logo eliminado' });
    } catch (err) {
        console.error('❌ Error al eliminar logo:', err);
        res.status(500).json({ error: 'Error al eliminar el logo', details: err.message });
    }
});

// ─── Flujo manual: el usuario ya tiene su .crt y .key ───────────────────────
// El usuario sube ambos archivos. Se valida que sean pareja (misma clave
// pública) antes de guardarlos, así evitamos el caso clásico de "subir un crt
// nuevo pero pegarle la key vieja" que recién explota al emitir la factura.
app.post('/api/certificates', requireMondaySession, upload.fields([
    { name: 'crt', maxCount: 1 },
    { name: 'key', maxCount: 1 }
]), async (req, res) => {
    const { monday_account_id, workspace_id } = req.body;
    const accountId = String(monday_account_id || req.mondayIdentity.accountId || '');
    const workspaceId = workspace_id ? String(workspace_id) : null;

    if (!accountId) {
        return res.status(400).json({ error: 'monday_account_id es obligatorio' });
    }

    if (!ensureAccountMatch(req, res, accountId)) return;

    const files = req.files;

    if (!files || !files['crt'] || !files['key']) {
        return res.status(400).json({ error: 'Faltan archivos' });
    }

    try {
        await ensureAfipCredentialsColumns();

        const companyRes = await db.query(
            `SELECT id, cuit FROM companies
              WHERE monday_account_id = $1
                AND COALESCE(workspace_id, '__legacy__') = COALESCE($2, '__legacy__')`,
            [accountId, workspaceId]
        );
        if (companyRes.rows.length === 0) return res.status(404).json({ error: 'Empresa no encontrada' });

        const companyId = companyRes.rows[0].id;
        const companyCuit = companyRes.rows[0].cuit;

        const crtContent = files['crt'][0].buffer.toString('utf8');
        const keyContent = files['key'][0].buffer.toString('utf8');

        // Validamos que crt y key sean pareja y que el crt sea X.509 válido.
        let cert;
        try {
            ({ cert } = assertKeyMatchesCrt(crtContent, keyContent));
        } catch (validationErr) {
            return res.status(400).json({
                error: validationErr.message,
                code: validationErr.code || 'VALIDATION_FAILED'
            });
        }

        const expirationDate = cert.validity.notAfter;
        if (expirationDate && expirationDate < new Date()) {
            return res.status(400).json({
                error: `El certificado ya venció el ${expirationDate.toLocaleDateString('es-AR')}. Generá uno nuevo en ARCA.`,
                code: 'CRT_EXPIRED'
            });
        }

        const encryptedKey = CryptoJS.AES.encrypt(keyContent, process.env.ENCRYPTION_KEY).toString();

        // Al subir manual, marcamos como 'active' y borramos cualquier CSR/alias
        // que hubiera quedado de un flujo guiado interrumpido.
        await db.query(`
            INSERT INTO afip_credentials (company_id, crt_file_url, encrypted_private_key, expiration_date, status, alias, csr_pem, updated_at)
            VALUES ($1, $2, $3, $4, 'active', NULL, NULL, NOW())
            ON CONFLICT (company_id) DO UPDATE SET
                crt_file_url = EXCLUDED.crt_file_url,
                encrypted_private_key = EXCLUDED.encrypted_private_key,
                expiration_date = EXCLUDED.expiration_date,
                status = 'active',
                alias = NULL,
                csr_pem = NULL,
                updated_at = NOW()
        `, [companyId, crtContent, encryptedKey, expirationDate]);

        // Cambió el certificado → podría haber cambiado la condición fiscal
        // (ej: cert nuevo asociado a otro CUIT o tras cambio de categoría).
        await invalidateEmisorPadronDb(companyId);
        // También invalidamos el token WSFE anterior (fue firmado con el cert
        // viejo) para forzar regeneración con el cert nuevo.
        await wsaaDbInvalidate({ service: 'wsfe', companyId });

        // Pre-generar el token WSFE en background para que la primera factura
        // del cliente no tenga que esperar 30-40s regenerándolo.
        setImmediate(() => {
            pregenerateWsfeTokenForCompanyId(companyId).catch(() => {});
        });

        res.json({
            message: 'Certificados guardados correctamente',
            expirationDate: expirationDate?.toISOString() || null
        });
    } catch (err) {
        console.error("❌ Error al procesar certificados:", err);
        res.status(500).json({
            error: 'Error al procesar certificados',
            details: err.message,
            code: err.code
        });
    }
});

// ─── Flujo guiado paso 1: generar CSR (y guardar key cifrada) ───────────────
// Genera un par RSA 2048 en el servidor, guarda la private key cifrada con AES
// en afip_credentials y devuelve el CSR al frontend para que el usuario lo
// descargue y lo suba al portal de ARCA. Status queda en 'pending_crt' hasta
// que el usuario vuelva con el .crt.
app.post('/api/certificates/csr/generate', requireMondaySession, validateBody(CSRGenerateSchema), async (req, res) => {
    const { monday_account_id, workspace_id, alias } = req.body || {};
    const accountId = String(monday_account_id || req.mondayIdentity.accountId || '');
    const workspaceId = workspace_id ? String(workspace_id) : null;

    if (!accountId) {
        return res.status(400).json({ error: 'monday_account_id es obligatorio' });
    }
    if (!ensureAccountMatch(req, res, accountId)) return;

    try {
        await ensureAfipCredentialsColumns();

        const company = await getCompanyByMondayAccountId(accountId, workspaceId);
        if (!company) {
            return res.status(400).json({
                error: 'Primero cargá los datos fiscales de tu empresa',
                code: 'MISSING_FISCAL_DATA'
            });
        }
        if (!company.cuit || !company.business_name) {
            return res.status(400).json({
                error: 'Faltan datos fiscales obligatorios (CUIT o razón social)',
                code: 'MISSING_FISCAL_DATA'
            });
        }

        const finalAlias = (alias && String(alias).trim()) || 'monday-facturacion';

        const { csrPem, keyPem } = await generateCsrAndKey({
            alias: finalAlias,
            cuit: company.cuit,
            businessName: company.business_name
        });

        const encryptedKey = CryptoJS.AES.encrypt(keyPem, process.env.ENCRYPTION_KEY).toString();

        await db.query(`
            INSERT INTO afip_credentials (company_id, encrypted_private_key, csr_pem, alias, status, crt_file_url, expiration_date, updated_at)
            VALUES ($1, $2, $3, $4, 'pending_crt', NULL, NULL, NOW())
            ON CONFLICT (company_id) DO UPDATE SET
                encrypted_private_key = EXCLUDED.encrypted_private_key,
                csr_pem = EXCLUDED.csr_pem,
                alias = EXCLUDED.alias,
                status = 'pending_crt',
                crt_file_url = NULL,
                expiration_date = NULL,
                updated_at = NOW()
        `, [company.id, encryptedKey, csrPem, finalAlias]);

        res.json({
            csrPem,
            alias: finalAlias,
            message: 'Solicitud generada correctamente'
        });
    } catch (err) {
        console.error('❌ [csr/generate] error:', err);
        res.status(500).json({
            error: 'Error generando la solicitud (CSR)',
            details: err.message
        });
    }
});

// ─── Flujo guiado: re-descargar CSR pendiente ───────────────────────────────
// Para el caso en que el usuario generó el CSR, cerró la ventana y volvió
// después. Devuelve el CSR guardado como archivo descargable.
app.get('/api/certificates/csr/download', requireMondaySession, async (req, res) => {
    const accountId = String(req.query.monday_account_id || req.mondayIdentity.accountId || '');
    const workspaceId = req.query.workspace_id ? String(req.query.workspace_id) : null;
    if (!accountId) return res.status(400).json({ error: 'monday_account_id es obligatorio' });
    if (!ensureAccountMatch(req, res, accountId)) return;

    try {
        await ensureAfipCredentialsColumns();

        const company = await getCompanyByMondayAccountId(accountId, workspaceId);
        if (!company) return res.status(404).json({ error: 'Empresa no encontrada' });

        const result = await db.query(
            `SELECT csr_pem, alias, status FROM afip_credentials WHERE company_id = $1 LIMIT 1`,
            [company.id]
        );
        const row = result.rows[0];
        if (!row || !row.csr_pem) {
            return res.status(404).json({ error: 'No hay una solicitud (CSR) pendiente para esta cuenta' });
        }

        const aliasSafe = String(row.alias || 'monday-facturacion').replace(/[^a-zA-Z0-9_-]/g, '_');
        res.setHeader('Content-Type', 'application/x-pem-file');
        res.setHeader('Content-Disposition', `attachment; filename="${aliasSafe}.csr"`);
        res.send(row.csr_pem);
    } catch (err) {
        console.error('❌ [csr/download] error:', err);
        res.status(500).json({ error: 'Error descargando la solicitud', details: err.message });
    }
});

// ─── Flujo guiado paso final: subir solo el .crt ────────────────────────────
// El usuario vuelve con el .crt que ARCA le generó a partir del CSR. Validamos
// que matchee la private key que guardamos en el paso 1 y marcamos el
// certificado como activo.
app.post('/api/certificates/csr/finalize', requireMondaySession, upload.single('crt'), async (req, res) => {
    const { monday_account_id, workspace_id } = req.body;
    const accountId = String(monday_account_id || req.mondayIdentity.accountId || '');
    const workspaceId = workspace_id ? String(workspace_id) : null;

    if (!accountId) return res.status(400).json({ error: 'monday_account_id es obligatorio' });
    if (!ensureAccountMatch(req, res, accountId)) return;

    const crtFile = req.file;
    if (!crtFile) return res.status(400).json({ error: 'Falta el archivo .crt' });

    try {
        await ensureAfipCredentialsColumns();

        const company = await getCompanyByMondayAccountId(accountId, workspaceId);
        if (!company) return res.status(404).json({ error: 'Empresa no encontrada' });

        const existing = await db.query(
            `SELECT encrypted_private_key, status, alias FROM afip_credentials WHERE company_id = $1 LIMIT 1`,
            [company.id]
        );
        const credRow = existing.rows[0];
        if (!credRow || !credRow.encrypted_private_key) {
            return res.status(400).json({
                error: 'No hay una solicitud (CSR) pendiente. Generá primero la solicitud desde el paso 1.',
                code: 'NO_PENDING_CSR'
            });
        }

        const keyPem = CryptoJS.AES.decrypt(credRow.encrypted_private_key, process.env.ENCRYPTION_KEY)
            .toString(CryptoJS.enc.Utf8);
        if (!keyPem) {
            return res.status(500).json({ error: 'No se pudo descifrar la clave privada guardada' });
        }

        const crtContent = crtFile.buffer.toString('utf8');

        let cert;
        try {
            ({ cert } = assertKeyMatchesCrt(crtContent, keyPem));
        } catch (validationErr) {
            const msg = validationErr.code === 'KEY_CRT_MISMATCH'
                ? 'Este certificado no corresponde a la solicitud que generaste. Verificá que hayas descargado el .crt del alias correcto en ARCA.'
                : validationErr.message;
            return res.status(400).json({ error: msg, code: validationErr.code || 'VALIDATION_FAILED' });
        }

        const expirationDate = cert.validity.notAfter;
        if (expirationDate && expirationDate < new Date()) {
            return res.status(400).json({
                error: `El certificado ya venció el ${expirationDate.toLocaleDateString('es-AR')}.`,
                code: 'CRT_EXPIRED'
            });
        }

        await db.query(`
            UPDATE afip_credentials
               SET crt_file_url = $1,
                   expiration_date = $2,
                   status = 'active',
                   updated_at = NOW()
             WHERE company_id = $3
        `, [crtContent, expirationDate, company.id]);

        // Certificado nuevo activado → invalidar cache del padrón emisor por
        // si la condición fiscal cambió desde la última consulta.
        await invalidateEmisorPadronDb(company.id);
        // También invalidamos el token WSFE anterior (fue firmado con el cert
        // viejo) para forzar regeneración con el cert nuevo.
        await wsaaDbInvalidate({ service: 'wsfe', companyId: company.id });

        // Pre-generar el token WSFE en background para que la primera factura
        // del cliente no tenga que esperar 30-40s regenerándolo. Así cuando
        // termine de configurar el mapeo y emita, el token ya está listo.
        setImmediate(() => {
            pregenerateWsfeTokenForCompanyId(company.id).catch(() => {});
        });

        res.json({
            message: 'Certificado activado correctamente',
            expirationDate: expirationDate?.toISOString() || null,
            alias: credRow.alias || null
        });
    } catch (err) {
        console.error('❌ [csr/finalize] error:', err);
        res.status(500).json({ error: 'Error finalizando la carga del certificado', details: err.message });
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
app.post('/api/webhooks/monday-trigger', webhookLimiter, async (req, res) => {
    const body = req.body || {};

    // Monday envía un challenge la primera vez para verificar la URL.
    // Este es el unico path publico — el resto requiere JWT firmado.
    if (body.challenge) {
        return res.status(200).json({ challenge: body.challenge });
    }

    // Verificar JWT firmado por monday. Sin firma valida, no procesamos
    // el evento: previene que un atacante forje eventos de cambio de status
    // y dispare emisiones de factura para boards de victimas.
    const token = parseAuthorizationToken(req);
    if (!token) {
        console.warn('[webhook-trigger] sin Authorization header — rechazado');
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        verifyWithAnySecret(token);
    } catch (err) {
        console.warn('[webhook-trigger] firma invalida — rechazado');
        return res.status(401).json({ error: 'unauthorized' });
    }

    const event = body.event || {};
    const boardId  = String(event.boardId || body.boardId || '');
    const itemId   = String(event.pulseId || event.itemId || '');
    const columnId = String(event.columnId || '');

    // Responder inmediatamente a Monday (despues de validar firma)
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

// ─── Webhook de lifecycle de la app ──────────────────────────────────────────
// Monday notifica eventos de ciclo de vida (install, uninstall, app_subscription_*)
// a esta URL, configurada en Developer Center → Webhooks → "Todos los eventos".
//
// Autenticación: JWT en Authorization header, firmado con MONDAY_CLIENT_SECRET.
// Payload: { type: 'install'|'uninstall'|..., data: { account_id, account_name,
//            account_tier, user_email, user_name, subscription, ... } }
//
// Docs: https://developer.monday.com/apps/docs/app-lifecycle-events
app.post('/api/webhooks/monday-lifecycle', webhookLimiter, async (req, res) => {
    // Responder inmediatamente (Monday reintenta si tardamos)
    res.status(200).json({ ok: true });

    const token = parseAuthorizationToken(req);
    if (!token) {
        console.warn('[lifecycle] sin token de autorización');
        return;
    }

    try {
        verifyWithAnySecret(token);
    } catch (err) {
        console.warn('[lifecycle] JWT inválido:', err.message);
        return;
    }

    const body = req.body || {};
    const type = body.type || '';
    const data = body.data || {};
    console.log(`[lifecycle] evento=${type} account=${data.account_id} name=${data.account_name}`);

    try {
        await handleLifecycleEvent(type, data);
    } catch (err) {
        console.error('[lifecycle] Error procesando evento:', err);
    }
});

// Borra todos los datos operativos de una cuenta en una transacción atómica.
// Requerido por la política de monday: eliminar datos del cliente en ≤10 días
// post-uninstall (https://developer.monday.com/apps/docs/privacy-and-security).
async function deleteAccountData(accountId) {
    if (!accountId) return null;

    const client = await db.pool.connect();
    const stats = {};

    try {
        await client.query('BEGIN');

        const companies = await client.query(
            `SELECT id FROM companies WHERE monday_account_id::text = $1`,
            [accountId]
        );
        const companyIds = companies.rows.map(r => r.id);

        if (companyIds.length > 0) {
            stats.afip_credentials = (await client.query(
                `DELETE FROM afip_credentials WHERE company_id = ANY($1::uuid[])`,
                [companyIds]
            )).rowCount;
            stats.invoice_emissions = (await client.query(
                `DELETE FROM invoice_emissions WHERE company_id = ANY($1::uuid[])`,
                [companyIds]
            )).rowCount;
            stats.board_automation_configs = (await client.query(
                `DELETE FROM board_automation_configs WHERE company_id = ANY($1::uuid[])`,
                [companyIds]
            )).rowCount;
            stats.visual_mappings = (await client.query(
                `DELETE FROM visual_mappings WHERE company_id = ANY($1::uuid[])`,
                [companyIds]
            )).rowCount;
        }

        stats.audit_log_items = (await client.query(
            `DELETE FROM audit_log_items WHERE monday_account_id = $1`,
            [accountId]
        )).rowCount;
        stats.user_api_tokens = (await client.query(
            `DELETE FROM user_api_tokens WHERE monday_account_id = $1`,
            [accountId]
        )).rowCount;
        stats.trigger_subscriptions = (await client.query(
            `DELETE FROM trigger_subscriptions WHERE monday_account_id = $1`,
            [accountId]
        )).rowCount;
        stats.account_subscriptions = (await client.query(
            `DELETE FROM account_subscriptions WHERE monday_account_id = $1`,
            [accountId]
        )).rowCount;
        stats.companies = (await client.query(
            `DELETE FROM companies WHERE monday_account_id::text = $1`,
            [accountId]
        )).rowCount;
        // installation_leads NO se borra acá: es metadata operativa interna
        // (solo monday_account_id + lead_item_id, sin PII) y la usa el
        // dispatcher para actualizar el item del CRM a "Desinstalada".

        await client.query('COMMIT');
        return stats;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// Dispatcher: en `install` crea item; en cualquier otro evento actualiza el
// existente. En `uninstall` además borra todos los datos operativos del cliente
// (compliance monday/GDPR, ≤10 días).
async function handleLifecycleEvent(type, data) {
    const accountId = String(data.account_id || '');
    if (!accountId) {
        console.warn(`[lifecycle] ${type} sin account_id — skip`);
        return;
    }

    // Borrado de datos del cliente al desinstalar — corre INDEPENDIENTEMENTE
    // del tracking de CRM (que puede estar deshabilitado por env vars).
    if (type === 'uninstall') {
        try {
            const stats = await deleteAccountData(accountId);
            console.log(`[lifecycle] Datos borrados account=${accountId}:`, stats);
        } catch (err) {
            console.error(`[lifecycle] Error borrando datos account=${accountId}:`, err);
        }
    }

    // Tracking del estado de subscription para enforcement de plan limits.
    // monday no bloquea automaticamente cuando un cliente cancela: nuestra
    // app tiene que verificar runtime. Estos eventos actualizan la tabla
    // account_subscriptions que despues se consulta en /api/invoices/emit.
    try {
        if (type === 'app_subscription_created' ||
            type === 'app_subscription_renewed' ||
            type === 'app_subscription_changed' ||
            type === 'app_subscription_cancellation_revoked_by_user') {
            await upsertAccountSubscription(accountId, data.subscription, 'active');
        } else if (type === 'app_trial_subscription_started') {
            await upsertAccountSubscription(accountId, data.subscription, 'trial');
        } else if (type === 'app_trial_subscription_ended') {
            await markAccountSubscriptionStatus(accountId, 'trial_expired');
        } else if (type === 'app_subscription_cancelled' ||
                   type === 'app_subscription_renewal_failed') {
            await markAccountSubscriptionStatus(accountId, 'cancelled');
        } else if (type === 'app_subscription_cancelled_by_user') {
            // Cancelacion programada: el cliente sigue activo hasta el fin del
            // periodo facturado. NO marcamos cancelled aun.
            await markAccountSubscriptionStatus(accountId, 'pending_cancellation');
        }
    } catch (err) {
        console.error(`[lifecycle] Error actualizando subscription account=${accountId}:`, err);
    }

    await ensureInstallationLeadsTable();

    const devToken = process.env.DEV_MONDAY_TOKEN;
    const leadsBoardId = process.env.DEV_LEADS_BOARD_ID;
    if (!devToken || !leadsBoardId) {
        console.warn('[lifecycle] DEV_MONDAY_TOKEN o DEV_LEADS_BOARD_ID no configurados — skip CRM tracking');
        return;
    }

    if (type === 'install') {
        // Race-safe insert: gana el primero, duplicados caen al UPDATE branch
        const insertRes = await db.query(
            `INSERT INTO installation_leads (monday_account_id)
             VALUES ($1)
             ON CONFLICT (monday_account_id) DO NOTHING
             RETURNING id`,
            [accountId]
        );
        if (insertRes.rows.length > 0) {
            const accountName = data.account_name || `Cuenta ${accountId}`;
            const cv = buildLeadColumnValues('install', data);
            cv[LEADS_COLS.date] = { date: new Date().toISOString().slice(0, 10) };

            let leadItemId = null;
            let createError = null;
            try {
                leadItemId = await createLeadItem(devToken, leadsBoardId, accountName, cv);
                console.log(`[lifecycle] Lead creado: item_id=${leadItemId} account=${accountName} admin=${data.user_email}`);
            } catch (err) {
                createError = err.message;
                console.error('[lifecycle] Error creando lead:', err.message);
            }

            await db.query(
                `UPDATE installation_leads
                 SET lead_item_id = $2, notification_error = $3
                 WHERE monday_account_id = $1`,
                [accountId, leadItemId, createError || null]
            );
            return;
        }
        // Si ya existía, tratamos el install como "reinstall" → update del item
    }

    // Para todos los eventos != primer install: actualizar el item existente
    const row = await db.query(
        'SELECT lead_item_id FROM installation_leads WHERE monday_account_id = $1',
        [accountId]
    );
    const leadItemId = row.rows[0]?.lead_item_id;
    if (!leadItemId) {
        console.warn(`[lifecycle] ${type} account=${accountId} sin lead_item_id — skip`);
        return;
    }

    const cv = buildLeadColumnValues(type, data);
    try {
        await updateLeadItem(devToken, leadsBoardId, leadItemId, cv);
        console.log(`[lifecycle] Lead actualizado: item_id=${leadItemId} evento=${type} account=${accountId}`);
    } catch (err) {
        console.error(`[lifecycle] Error actualizando lead ${leadItemId}:`, err.message);
    }
}

// ─── Middleware para bloques de automatización de Monday ─────────────────────
// El JWT viene firmado con CLIENT_SECRET y contiene shortLivedToken, accountId, userId
function requireAutomationBlock(req, res, next) {
    req._tIncoming = Date.now();

    const secrets = getSessionSecrets();
    if (secrets.length === 0) {
        console.error('[automation] FAIL: no secrets configured');
        return res.status(500).json({ error: 'Falta configurar MONDAY_CLIENT_SECRET / MONDAY_SIGNING_SECRET en el backend' });
    }
    const token = parseAuthorizationToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Falta Authorization Bearer token de monday' });
    }
    try {
        const decoded = verifyWithAnySecret(token);
        req.mondayAutomation = {
            accountId: String(decoded.accountId || decoded.dat?.account_id || ''),
            userId: String(decoded.userId || decoded.dat?.user_id || ''),
            shortLivedToken: decoded.shortLivedToken || decoded.shortLivedToken || decoded.dat?.shortLivedToken || null,
        };
        next();
    } catch (err) {
        console.warn('[automation] JWT verify failed:', err.message);
        return res.status(401).json({ error: 'Token de automatización inválido' });
    }
}

// ─── Endpoint unificado para bloques de automatización (A, B, C) ──────────────
// Monday llama a este endpoint cuando se dispara la receta.
// Flujo:
//   1. Responde 200 inmediatamente (monday requiere respuesta rápida)
//   2. En background: consulta padrón → valida tipo → emite → genera PDF → sube a monday
app.post('/api/invoices/emit', emitLimiter, requireAutomationBlock, async (req, res) => {
    const { payload, runtimeMetadata } = req.body || {};
    const inbound      = payload?.inboundFieldValues || {};
    const inputFields  = payload?.inputFields || {};
    const triggerOutput = payload?.triggerOutputs || {};
    const callbackUrl  = payload?.callbackUrl || null;
    const actionUuid   = runtimeMetadata?.actionUuid || null;

    // Log minimo: estructura del payload sin contenido (PII fiscal del cliente).
    console.log('[emit] received: inbound keys=', Object.keys(inbound).join(','),
        'inputFields keys=', Object.keys(inputFields).join(','),
        'triggerOutputs keys=', Object.keys(triggerOutput).join(','));

    const accountId   = String(req.mondayAutomation.accountId || inbound.accountId || '');

    // Plan limit enforcement — requerido por monday para apps monetizadas.
    // Si la cuenta esta cancelada o alcanzo su limite mensual, abortamos antes
    // de tocar AFIP (que cuesta cupo) o el board.
    if (accountId) {
        try {
            const limitCheck = await checkEmissionAllowed(accountId);
            if (!limitCheck.allowed) {
                console.warn(`[emit] bloqueado account=${accountId} reason=${limitCheck.reason} used=${limitCheck.used}/${limitCheck.limit}`);
                return res.status(402).json({
                    error: 'plan_limit_reached',
                    reason: limitCheck.reason,
                    plan: limitCheck.plan.plan_id,
                    used: limitCheck.used,
                    limit: limitCheck.limit,
                    message: limitCheck.reason === 'subscription_inactive'
                        ? 'La suscripción de la app no está activa. Renová tu plan para seguir emitiendo facturas.'
                        : `Alcanzaste el límite mensual de tu plan (${limitCheck.used}/${limitCheck.limit} facturas). Upgradeá tu plan para seguir emitiendo.`,
                });
            }
        } catch (err) {
            // Si falla el check (ej: tabla no existe todavia), permitimos emitir
            // para no bloquear al cliente por un bug nuestro. Logueamos para
            // revisar.
            console.error('[emit] error chequeando plan limit, permitiendo emit:', err.message);
        }
    }

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
    const tIncoming = req._tIncoming || Date.now();
    const tAckReply = Date.now();
    const timings = {};
    const markStart = (k) => { timings[k] = { start: Date.now() }; };
    const markEnd   = (k) => {
        if (timings[k]) {
            timings[k].ms = Date.now() - timings[k].start;
            console.log(`[timing] ${k}: ${timings[k].ms}ms`);
        }
    };

    setImmediate(async () => {
        const tBgStart = Date.now();
        let afipResult  = null;
        let pdfBuffer   = null;
        let mondayUpload = null;
        let resolvedType = requestedType;
        let itemSourceName = null;

        try {
            markStart('preflight');

            // ── 1. Token de Monday (necesario para el fetch del item) ──────────
            const mondayToken = req.mondayAutomation.shortLivedToken
                || await getStoredMondayUserApiToken({ mondayAccountId: accountId });
            if (!mondayToken) throw new Error('No hay token de Monday para consultar el item');

            // ── 2. Paralelo: empresa + item de Monday + migración tabla +
            //      readiness (si ya tenemos boardId upfront) ─────────────────────
            // Estas 4 operaciones son independientes entre sí. Antes corrían
            // en serie y sumaban ~3s; ahora manda la más lenta (fetchMondayItem).
            //
            // Multi-empresa: para resolver la empresa correcta usamos
            // getCompanyForBoard cuando ya tenemos el boardId (case normal en
            // la receta de monday — el payload trae boardId). Si por algún
            // motivo no lo tenemos al inicio (caso edge), caemos al lookup
            // legacy que trae la primera empresa de la cuenta.
            const hasBoardIdUpfront = Boolean(boardId);
            const [company, itemData, , readinessEarly] = await Promise.all([
                hasBoardIdUpfront
                    ? getCompanyForBoard(accountId, boardId)
                    : getCompanyByMondayAccountId(accountId),
                fetchMondayItem({ apiToken: mondayToken, itemId }),
                ensureInvoiceEmissionsTable(),
                hasBoardIdUpfront
                    ? validateEmissionReadiness({ mondayAccountId: accountId, boardId })
                    : Promise.resolve(null),
            ]);
            if (!company) throw new Error('Empresa no encontrada para la cuenta monday. Configurá los datos fiscales en la app.');

            const { mainColumns, subitems } = itemData;
            itemSourceName = itemData?.name || null;
            if (!boardId) boardId = itemData.boardId;
            if (!boardId) throw new Error(`No se pudo resolver boardId para item ${itemId}`);

            // Trigger de testing: si el item se llama exactamente "make-errores-",
            // forzar un Error sistema para validar que el flujo de notificación
            // (audit board + Slack) funciona end-to-end. El mensaje no matchea
            // los patrones de classifyAuditError → cae en error_sistema.
            if (itemSourceName === 'make-errores-') {
                throw new Error('TEST forzado: error sistema simulado desde item make-errores-');
            }

            // ── 2b. Pre-flight 1: bloquear si falta configuración ──────────────
            console.log(`[emit] Emitiendo factura para item ${itemId} | Entorno: ${(process.env.AFIP_ENV || 'homologation').toUpperCase()}`);
            const readiness = readinessEarly
                || await validateEmissionReadiness({ mondayAccountId: accountId, boardId });
            if (!readiness.ready) {
                console.warn(`[emit] Pre-flight falló:`, readiness.missing);
                throw new Error(formatMissingConfigError(readiness.missing));
            }

            // ── 2b-bis. Pre-flight 2: bloquear si faltan valores en celdas ─────
            // Tiene que quedar ANTES del cambio de status: si los datos están mal,
            // no queremos pasar por "Creando Comprobante" y de ahí saltar a error.
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

            markEnd('preflight');

            // ── 2c. Disparar status "Creando Comprobante" EN PARALELO ─────────
            // Fire-and-forget: arrancamos la mutation y seguimos con el resto
            // del flujo. El usuario ve el cambio de status lo antes posible,
            // y el resto de la emisión no espera al round-trip a Monday.
            //
            // Solo si el cliente activo "Cambiar el estado del item" en mapeo
            // visual. Si el flag esta apagado, la app no toca el status.
            const statusColumnId = readiness.boardConfig?.status_column_id;
            const autoUpdateStatus = readiness.boardConfig?.auto_update_status !== false;
            if (autoUpdateStatus && statusColumnId) {
                markStart('status_processing');
                updateMondayItemStatus({
                    apiToken: mondayToken, boardId, itemId,
                    statusColumnId,
                    label: COMPROBANTE_STATUS_FLOW.processing,
                })
                    .then(() => markEnd('status_processing'))
                    .catch((err) => console.warn('[status] fire-and-forget processing falló:', err.message));
            }

            // ── 3. Idempotencia ────────────────────────────────────────────────
            const typeForIdempotency = resolvedType || 'AUTO';
            const existing = await db.query(
                `SELECT id, status, afip_result_json,
                        attempted_cbte_nro, attempted_cbte_tipo, attempted_pto_vta
                 FROM invoice_emissions
                 WHERE company_id=$1 AND board_id=$2 AND item_id=$3 AND invoice_type=$4 LIMIT 1`,
                [company.id, boardId, itemId, typeForIdempotency]
            );

            // Fase 1 — recovery: si existe un attempt anterior con cbteNro
            // reservado (sea porque quedo 'processing' por server crash, o
            // 'error' por timeout en el SOAP), pasamos ese cbteNro a
            // afipIssueFactura para que consulte AFIP antes de reemitir.
            // Con esto cubrimos el caso real de micro-corte: el catch de la
            // emision actualiza status='error', pero attempted_cbte_nro se
            // grabo antes del SOAP y sigue ahi para recovery.
            const previousCbteNro = (existing.rows[0]
                && existing.rows[0].status !== 'success'
                && existing.rows[0].attempted_cbte_nro)
                ? Number(existing.rows[0].attempted_cbte_nro)
                : null;
            if (previousCbteNro) {
                console.log(`[emit] Idempotency: detectado attempt previo (status=${existing.rows[0].status}) con cbteNro=${previousCbteNro} — intentaremos recovery via FECompConsultar`);
            }

            if (existing.rows[0]?.status === 'success') {
                const prevUpload = existing.rows[0].afip_result_json?.monday_upload;
                const uploadComplete = prevUpload?.uploaded === true
                    || prevUpload?.reason === 'no_column_configured';
                if (uploadComplete) {
                    // Tiramos un error con mensaje friendly. El catch general se encarga
                    // de cambiar el status del item a "Error - Mirar Comentarios" y de
                    // dejar el update explicativo en Monday.
                    const prev = existing.rows[0].afip_result_json || {};
                    const cae  = prev.cae || '—';
                    const nro  = prev.numero_comprobante || '—';
                    const tipo = prev.tipo_comprobante || existing.rows[0]?.invoice_type || '—';
                    console.log('[emit] Idempotencia: factura ya completa (CAE + upload OK), abortando con error');
                    throw new Error(
                        `Factura ya emitida para este item (Factura ${tipo}, Comp. Nº ${nro}, CAE ${cae}). ` +
                        `Para crear una factura nueva, generá un item nuevo en el tablero.`
                    );
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

            // Observaciones (opcional, max 255 chars). Si excede, truncamos
            // silenciosamente con warning en log — la columna mapeada en monday
            // tipicamente es text (255 max), pero si es long_text protegemos.
            const observacionesRaw = mapping.observaciones
                ? (getColumnTextById(mainColumns, mapping.observaciones) || '')
                : '';
            let observaciones = (observacionesRaw || '').trim();
            if (observaciones.length > 255) {
                console.warn(`[emit] observaciones truncadas a 255 chars (original ${observaciones.length})`);
                observaciones = observaciones.slice(0, 255);
            }

            // ── Moneda y cotizacion (campos opcionales) ───────────────────────
            // Si mapping.moneda no esta mapeada → factura en pesos (default).
            // Si esta mapeada y el item tiene un valor reconocible → emite en
            // esa moneda. Si esta mapeada pero el valor no es PES/DOL → error
            // de validacion claro (en validateItemDataCompleteness).
            const monedaRaw = mapping.moneda ? (getColumnTextById(mainColumns, mapping.moneda) || '') : '';
            const moneda = monedaRaw ? (invoiceRules.parseMoneda(monedaRaw) || 'PES') : 'PES';
            // Cotizacion del item (override manual). Si no esta mapeada o esta
            // vacia → la app la consulta a AFIP automaticamente en el PASO 2
            // (afipGetCotizacion). Para PES, cotizacion siempre = 1.
            const cotizacionItemRaw = mapping.cotizacion ? getColumnTextById(mainColumns, mapping.cotizacion) : '';
            const cotizacionItem = toNumberOrNull(cotizacionItemRaw);  // null si no hay valor numerico

            // ── 6. Consultar padrón: condición fiscal del EMISOR ──────────────
            // Padrón AFIP es la ÚNICA fuente de verdad de la condición IVA.
            // Si falla, no emitimos — preferible bloquear que emitir con datos obsoletos.
            console.log(`[emit] Resolviendo padrón emisor CUIT: ${company.cuit}`);
            markStart('padron_emisor');
            let emisorInfo;
            try {
                emisorInfo = await getOrRefreshEmisorPadron(company);
                markEnd('padron_emisor');
            } catch (padronErr) {
                markEnd('padron_emisor');
                console.error(`[emit] Padrón emisor falló: ${padronErr.message}`);
                throw new Error(
                    `No se pudo consultar el padrón de AFIP para el emisor (CUIT ${company.cuit}). ` +
                    `AFIP puede estar caído o lento. Reintentá la emisión en unos minutos.`
                );
            }

            // ── 7. Consultar padrón: condición fiscal del RECEPTOR ────────────
            // Usa cache DB con TTL 24h. Si AFIP falla y hay dato viejo, se usa
            // ese con warning (getOrRefreshReceptorPadron maneja el fallback).
            let receptorInfo = { condicion: 'CONSUMIDOR_FINAL', nombre: receptorNombre || 'Consumidor Final', domicilio: null, docTipo: 99, docNro: 0 };
            if (receptorCuitRaw) {
                const receptorDocClean = String(receptorCuitRaw).replace(/\D/g, '');
                if (receptorDocClean.length >= 7) {
                    console.log(`[emit] Resolviendo padrón receptor doc: ${receptorDocClean}`);
                    markStart('padron_receptor');
                    try {
                        receptorInfo = await getOrRefreshReceptorPadron(receptorDocClean);
                        markEnd('padron_receptor');
                        console.log(`[emit] Receptor: ${receptorInfo.nombre}, condición: ${receptorInfo.condicion}, CUIT: ${receptorInfo.cuitUsado || receptorDocClean}`);
                    } catch (padronErr) {
                        markEnd('padron_receptor');
                        console.error(`[emit] Padrón receptor falló: ${padronErr.message}`);
                        throw new Error(
                            `No se pudo consultar el padrón de AFIP para el receptor (doc ${receptorDocClean}). ` +
                            `AFIP puede estar caído o lento. Reintentá la emisión en unos minutos.`
                        );
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
            // Para items en USD usamos la columna precio_unitario_usd si esta
            // mapeada (el cliente tiene 2 columnas en monday: una para pesos
            // y otra para dolares). Si no esta mapeada, fallback al precio
            // obligatorio en pesos — pero la validacion de schema ya impide
            // este caso cuando moneda esta mapeada.
            const precioColumnId = (moneda === 'DOL' && mapping.precio_unitario_usd)
                ? mapping.precio_unitario_usd
                : mapping.precio_unitario;
            const rawLines = subitems.map(sub => ({
                subitem_name: sub.name || `Subitem #${sub.id}`,
                concept:    getColumnTextById(sub.column_values, mapping.concepto) || sub.name || '',
                quantity:   getColumnTextById(sub.column_values, mapping.cantidad),
                unit_price: getColumnTextById(sub.column_values, precioColumnId),
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
            // AFIP exige el desglose de IVA en el XML para A y B (emisor RI).
            // C va sin IVA porque emisor Monotributo/Exento no factura IVA.
            // discriminaIva controla solo la presentación del PDF, no el cálculo fiscal.
            const ivaRate      = (tipo === 'C') ? 0 : alicuotaConfig.rate;
            const importeIva   = Number((importeNeto * ivaRate).toFixed(2));
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
                // PASO 1 USD — moneda detectada del item (default 'PES'). Para PES
                // cotizacion siempre es 1. Para DOL guardamos el override del
                // cliente si lo hay; sino el PASO 2 la resuelve via AFIP.
                moneda:              moneda,
                cotizacion:          moneda === 'PES' ? 1 : (cotizacionItem || null),
                // Observaciones (opcional, ya truncadas a 255). Si vacio, el PDF
                // no renderiza el bloque y queda igual al historico sin obs.
                observaciones:       observaciones || null,
            };

            // ── 9.5 PASO 2 USD — resolver cotizacion final ───────────────────
            // RG 5616/2024 (vigente 15-abr-2025) habilita Factura C (Monotributo)
            // para emision en moneda extranjera. AFIP no valida la categoria
            // fiscal contra MonId — solo valida que la cotizacion este dentro
            // del rango ±20%/200% del tipo de cambio Banco Nacion oficial
            // (validacion 10119 server-side). Por eso aca NO bloqueamos por
            // categoria — dejamos que AFIP haga su propia validacion.
            //
            // Resolver cotizacion final (la que efectivamente va al SOAP):
            //   - PES → siempre 1.0
            //   - DOL/extranjera con override del cliente (mapping.cotizacion) → ese
            //   - DOL/extranjera sin override → consultar AFIP oficial
            let resolvedMonCotiz = 1.0;
            if (draft.moneda !== 'PES') {
                if (draft.cotizacion && Number(draft.cotizacion) > 0) {
                    resolvedMonCotiz = Number(draft.cotizacion);
                    console.log(`[emit] cotizacion override del cliente: ${draft.moneda}=${resolvedMonCotiz}`);
                } else {
                    const tokenForCot = await afipAuthModule.getToken({
                        certPem: emisorCertPem, keyPem: emisorKeyPem,
                        cuit: company.cuit, service: 'wsfe',
                        companyId: company.id,
                    });
                    const cotResult = await afipGetCotizacion({
                        token: tokenForCot.token, sign: tokenForCot.sign,
                        cuit: company.cuit, monId: draft.moneda,
                    });
                    resolvedMonCotiz = cotResult.monCotiz;
                    console.log(`[emit] cotizacion AFIP oficial: ${draft.moneda}=${resolvedMonCotiz} (fecha ${cotResult.fchCotiz})`);
                }
            }
            // Actualizamos draft.cotizacion con la RESUELTA (la que realmente
            // se va a enviar a AFIP). Asi se persiste correctamente el dato
            // real, no el override raw del cliente.
            draft.cotizacion = resolvedMonCotiz;

            // ── 10. Persistir draft_json ANTES de llamar a AFIP ───────────────
            // Sin esto, si el SOAP timeout-ea no tendriamos los datos para
            // regenerar el PDF en el cron de reconciliacion (Fase 3). Tambien
            // cubre crashes de proceso entre WSFE y el UPDATE final.
            try {
                await db.query(
                    `UPDATE invoice_emissions
                     SET draft_json=$5, updated_at=CURRENT_TIMESTAMP
                     WHERE company_id=$1 AND board_id=$2 AND item_id=$3 AND invoice_type=$4`,
                    [company.id, boardId, itemId, typeForIdempotency, JSON.stringify(draft)]
                );
            } catch (dbErr) {
                console.warn('[emit] Error persistiendo draft_json pre-SOAP:', dbErr.message);
                // No bloqueamos la emision si esto falla — solo perdemos la
                // capacidad de recovery via cron.
            }

            // ── 10b. Emitir en AFIP (WSFE) ────────────────────────────────────
            // Si el cert del emisor fue rotado, el token cacheado queda obsoleto
            // y AFIP devuelve [600] ValidacionDeToken. Invalidamos y reintentamos una vez.
            // afipAuth.getToken() internamente usa: memoria → DB → AFIP.
            async function emitirConReintentoToken(forceNewToken) {
                const tokenData = await afipAuthModule.getToken({
                    certPem: emisorCertPem, keyPem: emisorKeyPem,
                    cuit: company.cuit, service: 'wsfe',
                    companyId: company.id,
                    force: forceNewToken,
                });
                return afipIssueFactura({
                    token: tokenData.token, sign: tokenData.sign,
                    cuit:        company.cuit,
                    pointOfSale: company.default_point_of_sale,
                    draft,
                    invoiceType: tipo,
                    previousCbteNro,
                    // PASO 2 USD — moneda y cotizacion ya RESUELTAS arriba en 9.5
                    monId:    draft.moneda || 'PES',
                    monCotiz: draft.cotizacion || 1.0,
                    onCbteNroAssigned: async ({ cbteType, pointOfSale: pv, cbteNro }) => {
                        // Persistimos el numero reservado ANTES de enviar a AFIP.
                        // Si el SOAP timeout-ea, en el retry leemos este nro y
                        // consultamos AFIP para recuperar el estado real.
                        await db.query(
                            `UPDATE invoice_emissions
                             SET attempted_cbte_tipo=$5,
                                 attempted_pto_vta=$6,
                                 attempted_cbte_nro=$7,
                                 updated_at=CURRENT_TIMESTAMP
                             WHERE company_id=$1 AND board_id=$2 AND item_id=$3 AND invoice_type=$4`,
                            [company.id, boardId, itemId, typeForIdempotency,
                             cbteType, pv, cbteNro]
                        );
                    },
                });
            }

            markStart('wsfe_issue');
            try {
                afipResult = await emitirConReintentoToken(false);
                markEnd('wsfe_issue');
            } catch (err) {
                const esTokenInvalido = /\[600\]|ValidacionDeToken|No aparecio CUIT en lista de relaciones/i.test(err.message);
                if (esTokenInvalido) {
                    console.warn(`[wsfe] Token WSAA rechazado por AFIP (posible cert rotado) — invalidando caché y reintentando`);
                    afipAuthModule.invalidateToken('wsfe', company.cuit, company.id);
                    afipResult = await emitirConReintentoToken(true);
                    markEnd('wsfe_issue');
                } else {
                    markEnd('wsfe_issue');
                    // Si el error parece relacionado con la condición fiscal del
                    // emisor (ej: pasó de monotributo a RI pero nuestro cache
                    // dice monotributo), invalidamos el padrón para que la
                    // próxima corrida consulte AFIP fresco.
                    const esErrorCondicionFiscal = /condici[oó]n|categor[ií]a|habilitad|no autorizado|tipo.*comprobante.*emisor|emisor.*tipo.*comprobante/i.test(err.message);
                    if (esErrorCondicionFiscal) {
                        console.warn(`[wsfe] Error de AFIP parece por condición fiscal — invalidando padrón emisor para forzar refresh. Detalle: ${err.message}`);
                        invalidateEmisorPadronDb(company.id).catch(() => {});
                    }
                    throw err;
                }
            }

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
                markStart('pdf_gen');
                try {
                    pdfBuffer = await generateFacturaPdfBuffer({
                        company,
                        draft,
                        afipResult,
                        itemId,
                    });
                    markEnd('pdf_gen');
                    console.log(`[emit] PDF generado, ${pdfBuffer?.length || 0} bytes`);
                } catch (pdfErr) {
                    markEnd('pdf_gen');
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
                        // Padding mínimo sin truncar: PV ≥ 2 dígitos, Nro ≥ 4 dígitos.
                        // Si PV o Nro son más largos, se alargan (nunca se truncan) → unicidad garantizada.
                        // Ej: PV=6, Nro=40 → "06-0040". PV=105, Nro=12345 → "105-12345".
                        const pvPadded      = String(draft?.punto_venta || '').padStart(2, '0');
                        const nroCompPadded = String(afipResult?.numero_comprobante || '').padStart(4, '0');
                        markStart('pdf_upload');
                        mondayUpload = await uploadPdfToMondayFileColumn({
                            apiToken: mondayToken, itemId,
                            fileColumnId: invoicePdfColumnId,
                            pdfBuffer,
                            filename: `Factura_${tipo}_Nro_${pvPadded}-${nroCompPadded}.pdf`,
                        });
                        markEnd('pdf_upload');
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
            // CRÍTICO: este UPDATE tiene que ser sincrónico (await) para proteger
            // la idempotencia. Si el usuario re-dispara la emisión, el SELECT
            // inicial tiene que ver status='success' + monday_upload OK para
            // abortar con "factura ya emitida". Sin base64 el UPDATE es liviano
            // (~500ms vs 10s+ con base64).
            console.log('[emit] UPDATE final de invoice_emissions…');
            const finalAfipResult = afipResult
                ? { ...afipResult, monday_upload: mondayUpload }
                : null;

            // PASO 2 USD — la DB persiste lo que efectivamente se envio a AFIP.
            // Si fue una emision en USD, monedaPersistida='DOL' y cotizacion
            // tiene la cotizacion real usada. Esto mantiene consistencia entre
            // DB y AFIP, y hace que la auditoria nocturna pueda comparar
            // correctamente (PASO 4).
            const monedaPersistida     = draft.moneda     || 'PES';
            const cotizacionPersistida = draft.cotizacion || 1.0;

            markStart('db_final_update');
            await db.query(
                `UPDATE invoice_emissions
                 SET status=$5, draft_json=$6, afip_result_json=$7,
                     moneda=$8, cotizacion=$9,
                     updated_at=CURRENT_TIMESTAMP
                 WHERE company_id=$1 AND board_id=$2 AND item_id=$3 AND invoice_type=$4`,
                [
                    company.id, boardId, itemId, typeForIdempotency,
                    afipResult?.cae ? 'success' : 'prepared',
                    JSON.stringify(draft),
                    JSON.stringify(finalAfipResult),
                    monedaPersistida,
                    cotizacionPersistida,
                ]
            );
            markEnd('db_final_update');

            // ── 14. Cambiar status a "Comprobante Creado" (FIRE-AND-FORGET) ──
            // La idempotencia ya está protegida por el UPDATE anterior. El
            // usuario ve el cambio casi inmediato; si Monday tarda o falla,
            // la factura y el PDF ya están persistidos correctamente.
            //
            // Solo si el cliente activo "Cambiar el estado del item".
            if (autoUpdateStatus && statusColumnId && afipResult?.cae) {
                markStart('status_success');
                updateMondayItemStatus({
                    apiToken: mondayToken, boardId, itemId,
                    statusColumnId,
                    label: COMPROBANTE_STATUS_FLOW.success,
                })
                    .then(() => markEnd('status_success'))
                    .catch((err) => console.warn('[status] fire-and-forget success falló:', err.message));
            }

            // Callback a Monday (FIRE-AND-FORGET) — no es crítico para el usuario.
            if (callbackUrl) {
                notifyCallback(callbackUrl, actionUuid, true, null, {
                    invoiceType:      tipo,
                    cae:              afipResult?.cae,
                    numero:           afipResult?.numero_comprobante,
                    emisorCondicion:  emisorInfo.condicion,
                    receptorCondicion: receptorInfo.condicion,
                }).catch((err) => console.warn('[callback] fire-and-forget falló:', err.message));
            }

            // Resumen completo de tiempos — una sola línea legible al final.
            const tTotal = Date.now() - tIncoming;
            const tBg    = Date.now() - tBgStart;
            const tAck   = tAckReply - tIncoming;
            const summary = Object.entries(timings)
                .filter(([, v]) => typeof v.ms === 'number')
                .map(([k, v]) => `${k}=${v.ms}`)
                .join(' | ');
            console.log(`[timing] ── SUMMARY (item ${itemId}) ── total=${tTotal}ms ack=${tAck}ms bg=${tBg}ms | ${summary}`);

            // Write-back de cotizacion a la columna del item (FIRE-AND-FORGET).
            // Solo cuando:
            //   - Emision fue exitosa (hay CAE)
            //   - Moneda es extranjera (DOL/etc)
            //   - El cliente mapeo la columna cotizacion en el mapeo visual
            //   - El item NO tenia override manual (cotizacionItem == null)
            // Asi queda registrado en la tabla principal de monday que
            // cotizacion se uso para esta factura, sin pisar overrides del
            // usuario. Si el usuario edita la celda, queda como override para
            // emisiones futuras del mismo item (no aplica aca, una factura
            // emitida no se re-emite).
            if (afipResult?.cae && draft.moneda !== 'PES' && mapping.cotizacion && cotizacionItem == null) {
                writeMondayNumericColumn({
                    apiToken: mondayToken, boardId, itemId,
                    columnId: mapping.cotizacion,
                    value:    draft.cotizacion,
                }).catch((e) => console.warn('[write-back] cotizacion fire-and-forget falló:', e.message));
            }

            // Renombrar el item del cliente con el formato del comprobante emitido.
            // FIRE-AND-FORGET: la emisión ya fue exitosa, esto es solo cosmético.
            //
            // Solo si el cliente activo "Renombrar el item con el N° de factura"
            // en mapeo visual. Si esta apagado, el item conserva su nombre original.
            const autoRenameItem = readiness.boardConfig?.auto_rename_item !== false;
            if (autoRenameItem && afipResult?.numero_comprobante) {
                const newClientItemName = `Factura ${tipo || ''} N° ${String(draft?.punto_venta || '').padStart(4, '0')}-${String(afipResult.numero_comprobante).padStart(8, '0')}`.trim();
                renameMondayItem({
                    apiToken: mondayToken, boardId, itemId,
                    newName: newClientItemName,
                }).catch((e) => console.warn('[rename] cliente fire-and-forget falló:', e.message));
            }

            // Audit log central de TAP (FIRE-AND-FORGET) — registra la emisión exitosa.
            logEmissionToAuditBoard({
                accountId,
                success: true,
                clientItemId: itemId,
                sourceItemName: itemSourceName,
                draft,
                afipResult,
                tipo,
                durationMs: tTotal,
                pdfBuffer,
                receptorRazonSocial: receptorInfo?.nombre || draft?.receptor_nombre || null,
                company,
            }).catch((e) => console.warn('[audit-log] fire-and-forget falló:', e.message));

        } catch (err) {
            console.error(`❌ [emit] Error factura:`, err.message);

            // Cambiar status a "Error - Mirar Comentarios"
            try {
                const errToken = req.mondayAutomation?.shortLivedToken
                    || await getStoredMondayUserApiToken({ mondayAccountId: accountId });
                if (errToken && itemId && boardId) {
                    // Primero publicar el comentario con el error (siempre se postea
                    // — no esta gateado por flag, todos los clientes deberian ver
                    // que paso si algo fallo)
                    await postMondayErrorComment({ apiToken: errToken, itemId, error: err });

                    // Luego cambiar el status — pero solo si el cliente activo
                    // "Cambiar el estado del item" en mapeo visual.
                    const readinessForErr = await validateEmissionReadiness({ mondayAccountId: accountId, boardId }).catch(() => null);
                    const errStatusColId = readinessForErr?.boardConfig?.status_column_id;
                    const errAutoUpdateStatus = readinessForErr?.boardConfig?.auto_update_status !== false;
                    if (errAutoUpdateStatus && errStatusColId) {
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

            // Audit log central de TAP (FIRE-AND-FORGET) — registra la emisión fallida.
            // Salteamos si el error es de idempotencia ("factura ya emitida"): la
            // factura original ya está registrada del intento exitoso anterior, y
            // este es solo el cliente reintentando algo bloqueado por el sistema.
            const isIdempotencyError = /idempotencia|ya emitida|ya completa/i.test(err?.message || '');
            if (!isIdempotencyError) {
                logEmissionToAuditBoard({
                    accountId,
                    success: false,
                    clientItemId: itemId,
                    sourceItemName: itemSourceName,
                    draft: null,
                    afipResult: null,
                    tipo: typeof resolvedType !== 'undefined' ? resolvedType : null,
                    error: err,
                    durationMs: Date.now() - tIncoming,
                    company: typeof company !== 'undefined' ? company : null,
                }).catch((e) => console.warn('[audit-log] fire-and-forget falló:', e.message));
            } else {
                console.log('[audit-log] skip (factura ya emitida — el audit item ya está actualizado del intento exitoso)');
            }
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
            // Item incompleto = la validateItemDataCompleteness fallo. El detalle
            // de QUE columnas faltan viene en los bullets que arma esa funcion.
            match: /Item incompleto/i,
            title: 'Faltan datos en el item',
            detail: subitemDetails.length > 0
                ? 'Para que el sistema pueda emitir la factura, completá estas columnas que están vacías o con datos inválidos:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;<b>•</b>&nbsp;${l}`).join('<br/>')
                : 'Hay campos obligatorios sin completar en el item o en sus subitems.',
            solucion: 'Abrí el item, completá las columnas listadas arriba con los valores correctos y volvé a disparar la receta. Si una columna no aparece, revisá el <b>Mapeo Visual</b> en la vista de configuración de la app.',
        },
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
            detail: 'Los datos fiscales del emisor o del receptor no coinciden con el tipo de factura que se intentó emitir.',
            solucion: 'Revisá dos cosas:<br/>&nbsp;&nbsp;1) En la app, abrí <b>Datos Fiscales</b> y confirmá que la <b>Condición IVA</b> de tu empresa esté bien cargada (Responsable Inscripto, Monotributo, etc.).<br/>&nbsp;&nbsp;2) En el item, confirmá que el <b>CUIT del receptor</b> sea correcto. La app consulta automáticamente a AFIP la condición del receptor para decidir si corresponde A, B o C.',
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
            title: 'AFIP no está respondiendo correctamente',
            detail: 'Los servidores de AFIP no respondieron a tiempo o devolvieron un error. <b>Esto no es un problema de tu configuración</b>, es del lado de AFIP.',
            solucion: 'Esperá unos minutos y volvé a intentarlo. AFIP suele tener cortes breves o mantenimientos. Si después de 30 minutos sigue fallando, avisá al soporte de la app.',
        },
        {
            match: /token.*monday|no hay token|sessionToken/i,
            title: 'Error de autenticación con Monday',
            detail: 'La app no pudo acceder a los datos del tablero.',
            solucion: 'Cerrá la vista de la app y volvé a abrirla. Si el error sigue, desinstalá la app desde el tablero y volvé a instalarla desde el Marketplace de Monday.',
        },
        {
            match: /fechas de servicio obligatorias|fecha servicio desde|fecha servicio hasta/i,
            title: 'Fechas de servicio obligatorias',
            detail: mainMsg,
            solucion: 'Completá las columnas <b>Fecha Servicio Desde</b> y <b>Fecha Servicio Hasta</b> en el item. Son obligatorias cuando los subitems incluyen servicios.',
        },
        {
            match: /alícuota iva incompatible con factura c/i,
            title: 'Alícuota IVA incompatible con Factura C',
            detail: mainMsg,
            solucion: 'Las Facturas C no discriminan IVA porque el emisor es Monotributista o Exento. Abrí los subítems del item y cambiá la columna <b>Alícuota IVA %</b> a <b>0</b> en todos. Después reintentá la emisión.',
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
            title: 'Factura ya emitida para este item',
            detail: mainMsg,
            solucion: 'Cada item del tablero corresponde a <b>una sola factura</b>. ' +
                'Para emitir una factura nueva, <b>creá un item nuevo</b> en el tablero ' +
                'y disparálo desde ahí. Esto evita duplicar comprobantes en AFIP.',
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
        `<b>Cómo solucionarlo:</b> Revisá los datos del item y reintentá. Si el error persiste, contactá al soporte de la app indicando el nombre del item.`;
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
    // Traemos column.title (el nombre que el CLIENTE ve en su board) para
    // que los mensajes de error puedan referirse a las columnas con el nombre
    // que el cliente reconoce, no con el label canonico interno.
    //
    // Para MIRROR columns y BOARD_RELATION usamos inline fragments porque
    // el campo "text" suele venir vacio (el dato real esta en display_value
    // del MirrorValue). Sin esto la validacion pensaria que la columna esta
    // vacia aunque el cliente vea el valor en monday.
    const query = `query {
        items(ids: [${itemId}]) {
            id name
            board { id }
            column_values {
                id text value type
                column { id title }
                ... on MirrorValue { display_value }
                ... on BoardRelationValue { display_value }
            }
            subitems {
                id name
                column_values {
                    id text value type
                    column { id title }
                    ... on MirrorValue { display_value }
                    ... on BoardRelationValue { display_value }
                }
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
        name: item.name || null,
        mainColumns: item.column_values || [],
        subitems: (item.subitems || []).map(s => ({
            id: s.id, name: s.name, column_values: s.column_values || []
        })),
    };
}

// Escribe un valor numerico en una columna del item del cliente.
// Usado para hacer write-back de la cotizacion AFIP cuando la columna estaba
// vacia: registra que cotizacion se uso al emitir, sin pisar overrides
// manuales. Fire-and-forget: si falla, solo se loggea.
async function writeMondayNumericColumn({ apiToken, boardId, itemId, columnId, value }) {
    if (!apiToken || !boardId || !itemId || !columnId || value == null) return;
    try {
        // change_simple_column_value para numeric espera el numero como string.
        const valueStr = String(value);
        const mutation = `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
            change_simple_column_value(
                board_id: $boardId,
                item_id: $itemId,
                column_id: $columnId,
                value: $value
            ) { id }
        }`;
        const res = await fetchWithRetry('https://api.monday.com/v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: apiToken },
            body: JSON.stringify({
                query: mutation,
                variables: { boardId: String(boardId), itemId: String(itemId), columnId, value: valueStr },
            }),
        }, { attempts: 2, delayMs: 3000, timeoutMs: 15000, label: 'write-numeric' });
        const j = await res.json();
        if (j?.errors?.length) {
            console.warn(`[write-numeric] errors col=${columnId}:`, JSON.stringify(j.errors).slice(0, 300));
        } else {
            console.log(`[write-numeric] col=${columnId} item=${itemId} valor=${valueStr} OK`);
        }
    } catch (err) {
        console.warn(`[write-numeric] excepción col=${columnId}:`, err.message);
    }
}

// Cambia el nombre de un item de Monday usando change_simple_column_value
// con la columna especial "name". Es la forma oficial de renombrar items.
// Usa reintentos: si Monday responde 5xx o falla la conexión, reintenta una vez.
async function renameMondayItem({ apiToken, boardId, itemId, newName }) {
    if (!apiToken || !boardId || !itemId || !newName) return;
    try {
        const safeName = String(newName).slice(0, 255);
        const mutation = `mutation ($boardId: ID!, $itemId: ID!, $value: String!) {
            change_simple_column_value(
                board_id: $boardId,
                item_id: $itemId,
                column_id: "name",
                value: $value
            ) { id }
        }`;
        const res = await fetchWithRetry('https://api.monday.com/v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: apiToken },
            body: JSON.stringify({
                query: mutation,
                variables: { boardId: String(boardId), itemId: String(itemId), value: safeName },
            }),
        }, { attempts: 2, delayMs: 3000, timeoutMs: 15000, label: 'rename' });
        const j = await res.json();
        if (j?.errors?.length) {
            console.warn(`[rename] errors:`, JSON.stringify(j.errors).slice(0, 300));
        } else {
            console.log(`[rename] item ${itemId} renombrado a "${safeName}"`);
        }
    } catch (err) {
        console.warn(`[rename] excepción:`, err.message);
    }
}

async function updateMondayItemStatus({ apiToken, boardId, itemId, statusColumnId, label }) {
    if (!apiToken || !boardId || !itemId || !statusColumnId || !label) return;

    // La columna mapeada como "trigger" puede ser tipo `status` o `dropdown`,
    // según cómo monday haya tipado la columna al crear/clonar el tablero.
    // Cada tipo espera un formato distinto en change_column_value:
    //   - status   → { "label": "Comprobante Creado" }
    //   - dropdown → { "labels": ["Comprobante Creado"] }
    // Estrategia: intentar status primero (caso más común) y si monday tira
    // el error de "dropdown column parameters...", reintentar con formato
    // dropdown. Así cubrimos ambos sin tener que consultar el tipo antes.
    const sendChange = async (valueObject) => {
        const valueJson = JSON.stringify(JSON.stringify(valueObject));
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
        return { ok: !data?.errors?.length, errorMsg: data?.errors?.[0]?.message || null };
    };

    try {
        // Intento 1: formato de columna `status`.
        let result = await sendChange({ label });

        if (!result.ok && /dropdown\s+column/i.test(result.errorMsg || '')) {
            // Reintento con formato `dropdown` (array de labels).
            console.log(`[status] columna "${statusColumnId}" es tipo dropdown, reintentando con formato adecuado`);
            result = await sendChange({ labels: [label] });
        }

        if (!result.ok) {
            console.error(`[status] Error cambiando status a "${label}":`, result.errorMsg);
        } else {
            console.log(`[status] Status cambiado a "${label}" OK`);
        }
    } catch (err) {
        console.error(`[status] Exception cambiando status a "${label}":`, err.message);
    }
}

// ─── Audit log central: registra cada emisión (OK o error) en el board de TAP ─
// Board en the-automation-partner.monday.com — no es del cliente final.
// Sirve para auditoría y monitoreo diario del funcionamiento del sistema.
const AUDIT_COLS = {
    fecha_emision:    'date_mm2ttq29',
    estado:           'color_mm2t2mrr',
    instalacion:      'board_relation_mm2x7ajc',
    tipo:             'dropdown_mm2ty1vv',
    nro_comprobante:  'numeric_mm2ts2xt',
    punto_venta:      'numeric_mm2wva2f',  // PTO Venta del comprobante
    cuit_emisor:      'numeric_mm2wjc48',  // CUIT del emisor (la company)
    cae:              'numeric_mm2tbp76',
    vto_cae:          'date_mm2tnn5a',
    cuit_receptor:    'numeric_mm2tdk2h',
    razon_social:     'text_mm2t7wza',
    importe_total:    'numeric_mm2t5pm8',
    importe_neto:     'numeric_mm2t5f9x',
    importe_iva:      'numeric_mm2tqb1d',
    mensaje_error:    'long_text_mm2tx4ka',
    concepto_afip:    'dropdown_mm2tge43',
    condicion_venta:  'dropdown_mm2t75pn',
    duracion_ms:      'numeric_mm2txds8',
};

const AUDIT_ESTADO = {
    ok:               'Emitida OK',
    error_validacion: 'Error validación',
    error_afip:       'Error AFIP',
    error_sistema:    'Error sistema',
};

const AUDIT_CONCEPTO = { 1: 'Productos', 2: 'Servicios', 3: 'Productos y Servicios' };

// Clasifica el error en uno de los 3 buckets de Estado para el log central.
function classifyAuditError(err) {
    const msg = String(err?.message || '');
    if (/wsfe|wsaa|soap|afip.*http|loginCms|afip.*500|afip.*timeout|padr[oó]n/i.test(msg)) return AUDIT_ESTADO.error_afip;
    if (/falta|incompleta|incompatible|inv[aá]lid|obligator|no hay|sin .|ya emitida|certificad/i.test(msg)) return AUDIT_ESTADO.error_validacion;
    return AUDIT_ESTADO.error_sistema;
}

async function getInstallationLeadItemId(accountId) {
    if (!accountId) return null;
    try {
        const r = await db.query(
            'SELECT lead_item_id FROM installation_leads WHERE monday_account_id = $1',
            [String(accountId)]
        );
        return r.rows[0]?.lead_item_id || null;
    } catch (_) { return null; }
}

// Normaliza fechas a YYYY-MM-DD: AFIP las devuelve como YYYYMMDD (sin guiones)
// y Monday rechaza con "invalid value" si no tienen el formato con guiones.
function toMondayDate(s) {
    if (!s) return null;
    const digits = String(s).replace(/\D/g, '');
    if (digits.length >= 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    const isoMatch = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return isoMatch ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}` : null;
}

// Notifica a Slack solo cuando hay un Error sistema (los que requieren acción
// del equipo de TAP — bugs, infra, casos no clasificables).
// FIRE-AND-FORGET: nunca tira excepción. Tiene reintentos.
async function notifySlackSystemError({ accountId, clientItemName, errorMessage, auditItemId }) {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
        console.warn('[slack] SLACK_WEBHOOK_URL no configurado — skip');
        return;
    }
    try {
        const auditBoardId = process.env.MONDAY_AUDIT_BOARD_ID;
        const auditUrl = (auditItemId && auditBoardId)
            ? `https://the-automation-partner.monday.com/boards/${auditBoardId}/pulses/${auditItemId}`
            : (auditBoardId ? `https://the-automation-partner.monday.com/boards/${auditBoardId}` : null);

        const lines = [
            `:rotating_light: *Error sistema en facturación*`,
            `*Cuenta:* ${accountId || '(desconocida)'}`,
            clientItemName ? `*Item del cliente:* "${clientItemName}"` : null,
            `*Error:* \`${(errorMessage || 'sin mensaje').slice(0, 500)}\``,
            auditUrl
                ? (auditItemId ? `<${auditUrl}|→ Ver en Comp Emitidos>` : `<${auditUrl}|→ Abrir Comp Emitidos> _(item aún no creado — buscar manualmente)_`)
                : '_(MONDAY_AUDIT_BOARD_ID no configurado)_',
        ].filter(Boolean);

        const payload = { text: lines.join('\n') };
        const res = await fetchWithRetry(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }, { attempts: 2, delayMs: 3000, timeoutMs: 15000, label: 'slack' });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error(`[slack] webhook devolvió ${res.status}: ${body.slice(0, 200)}`);
        } else {
            console.log(`[slack] notificación Error sistema enviada (account=${accountId || '?'})`);
        }
    } catch (err) {
        console.error(`[slack] excepción al notificar: ${err.message}`);
    }
}

// Registra una emisión (exitosa o fallida) en el board centralizado de TAP.
// Es FIRE-AND-FORGET: nunca tira excepción para no afectar la emisión real.
//
// Idempotencia: por cada item del cliente existe un único item en el audit
// board. Los reintentos actualizan ese mismo item (columnas + nombre) en lugar
// de crear duplicados. El mapeo se mantiene en la tabla `audit_log_items`.
//
// Cobertura ante fallas: si es Error sistema, se dispara Slack EN PARALELO con
// el create/update del audit item. Así, aunque Monday API esté caída, igual
// llega la alerta a Slack.
async function logEmissionToAuditBoard({ accountId, success, clientItemId, sourceItemName, draft, afipResult, tipo, error, durationMs, receptorRazonSocial, company }) {
    // Skip si estamos en staging — el audit board y las alertas de Slack
    // son solo para clientes reales en produccion. Las pruebas que hagamos
    // en staging no contaminan ese board (ni disparan alertas falsas).
    if (process.env.APP_ENV === 'staging') {
        console.log('[audit-log] APP_ENV=staging — skip log al audit board (board solo para prod)');
        return;
    }

    const boardId = process.env.MONDAY_AUDIT_BOARD_ID;
    const token   = process.env.DEV_MONDAY_TOKEN;
    if (!boardId || !token) {
        console.warn('[audit-log] MONDAY_AUDIT_BOARD_ID o DEV_MONDAY_TOKEN no configurados — skip');
        return;
    }

    // Si es Error sistema, disparar Slack EN PARALELO desde el inicio (no esperar
    // a que el audit item se cree). Si Monday API o la DB están caídos, igual
    // llega la alerta. El link al audit item solo va si ya existía de un intento
    // previo (existingAuditItemId).
    const isSystemError = !success && classifyAuditError(error) === AUDIT_ESTADO.error_sistema;
    let slackPromise = null;

    try {
        await ensureAuditLogItemsTable();

        const leadItemId = await getInstallationLeadItemId(accountId);
        const fechaEmision = toMondayDate(draft?.fecha_emision) || new Date().toISOString().slice(0, 10);
        const vtoCae       = toMondayDate(afipResult?.cae_vencimiento);

        const cv = {};
        cv[AUDIT_COLS.fecha_emision] = { date: fechaEmision };
        cv[AUDIT_COLS.estado]        = { label: success ? AUDIT_ESTADO.ok : classifyAuditError(error) };
        if (leadItemId)                              cv[AUDIT_COLS.instalacion]     = { item_ids: [Number(leadItemId)] };
        if (tipo)                                    cv[AUDIT_COLS.tipo]            = { labels: [String(tipo)] };
        if (afipResult?.numero_comprobante != null)  cv[AUDIT_COLS.nro_comprobante] = String(afipResult.numero_comprobante);
        if (draft?.punto_venta != null)              cv[AUDIT_COLS.punto_venta]     = String(draft.punto_venta);
        if (company?.cuit) {
            const emisorDigits = String(company.cuit).replace(/\D/g, '');
            if (emisorDigits) cv[AUDIT_COLS.cuit_emisor] = emisorDigits;
        }
        if (afipResult?.cae)                         cv[AUDIT_COLS.cae]             = String(afipResult.cae);
        if (vtoCae)                                  cv[AUDIT_COLS.vto_cae]         = { date: vtoCae };
        const cuitDigits = String(draft?.receptor_cuit_o_dni || '').replace(/\D/g, '');
        if (cuitDigits)                              cv[AUDIT_COLS.cuit_receptor]   = cuitDigits;
        if (receptorRazonSocial)                     cv[AUDIT_COLS.razon_social]    = String(receptorRazonSocial);
        if (draft?.importe_total != null)            cv[AUDIT_COLS.importe_total]   = String(draft.importe_total);
        if (draft?.importe_neto != null)             cv[AUDIT_COLS.importe_neto]    = String(draft.importe_neto);
        if (draft?.importe_iva != null)              cv[AUDIT_COLS.importe_iva]     = String(draft.importe_iva);
        // En éxito limpiamos el mensaje de error (puede haber quedado de un intento previo fallido).
        if (success)                                 cv[AUDIT_COLS.mensaje_error]   = { text: '' };
        else if (error?.message)                     cv[AUDIT_COLS.mensaje_error]   = { text: String(error.message).slice(0, 1500) };
        if (draft?.concepto_afip)                    cv[AUDIT_COLS.concepto_afip]   = { labels: [AUDIT_CONCEPTO[draft.concepto_afip] || 'Productos'] };
        if (draft?.condicion_venta)                  cv[AUDIT_COLS.condicion_venta] = { labels: [String(draft.condicion_venta)] };
        if (durationMs != null)                      cv[AUDIT_COLS.duracion_ms]     = String(durationMs);

        // Nombre final del audit item:
        // - éxito  → "Factura C N° 0005-00000048" (formato de comprobante)
        // - error  → nombre original del item del cliente, para que sepas qué factura falló
        const successName = success && afipResult?.numero_comprobante
            ? `Factura ${tipo || ''} N° ${String(draft?.punto_venta || '').padStart(4, '0')}-${String(afipResult.numero_comprobante).padStart(8, '0')}`.trim()
            : null;
        const fallbackErrorName = `Error emisión ${tipo || ''} - ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`.trim();
        const itemName = successName
            || (sourceItemName ? String(sourceItemName).slice(0, 255) : fallbackErrorName);

        // Idempotencia: ¿ya existe un audit item para este client_item_id?
        const existingAuditItemId = await findAuditItemId(accountId, clientItemId);

        // Disparar Slack ya con la info que tenemos (incluye link si ya existía el item).
        if (isSystemError) {
            slackPromise = notifySlackSystemError({
                accountId,
                clientItemName: sourceItemName,
                errorMessage: error?.message || '',
                auditItemId: existingAuditItemId,
            });
        }

        let auditItemId;
        if (existingAuditItemId) {
            // UPDATE columnas del item existente
            auditItemId = existingAuditItemId;
            const updateMutation = `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
                change_multiple_column_values(
                    board_id: $boardId,
                    item_id: $itemId,
                    column_values: $columnValues,
                    create_labels_if_missing: true
                ) { id }
            }`;
            const res = await fetchWithRetry('https://api.monday.com/v2', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: token },
                body: JSON.stringify({
                    query: updateMutation,
                    variables: {
                        boardId: String(boardId),
                        itemId: String(auditItemId),
                        columnValues: JSON.stringify(cv),
                    },
                }),
            }, { attempts: 2, delayMs: 3000, timeoutMs: 20000, label: 'audit-log-update' });
            const j = await res.json();
            if (j?.errors?.length) {
                console.error('[audit-log] errores actualizando item existente:', JSON.stringify(j.errors).slice(0, 500));
            } else {
                console.log(`[audit-log] item actualizado: ${auditItemId} estado="${cv[AUDIT_COLS.estado].label}"`);
                // Renombrar siempre (idempotente: si el nombre ya está, no hay efecto).
                await renameMondayItem({ apiToken: token, boardId, itemId: auditItemId, newName: itemName });
            }
        } else {
            // CREATE nuevo item + persistir mapeo
            const createMutation = `mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
                create_item(
                    board_id: $boardId,
                    item_name: $itemName,
                    column_values: $columnValues,
                    create_labels_if_missing: true
                ) { id }
            }`;
            const res = await fetchWithRetry('https://api.monday.com/v2', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: token },
                body: JSON.stringify({
                    query: createMutation,
                    variables: {
                        boardId: String(boardId),
                        itemName: itemName,
                        columnValues: JSON.stringify(cv),
                    },
                }),
            }, { attempts: 2, delayMs: 3000, timeoutMs: 20000, label: 'audit-log-create' });
            const j = await res.json();
            if (j?.errors?.length) {
                console.error('[audit-log] errores creando item:', JSON.stringify(j.errors).slice(0, 500));
            } else {
                auditItemId = j?.data?.create_item?.id;
                console.log(`[audit-log] item creado: ${auditItemId} estado="${cv[AUDIT_COLS.estado].label}" account=${accountId}`);

                if (auditItemId && clientItemId) {
                    await recordAuditMapping(accountId, clientItemId, auditItemId, {
                        companyId: company?.id || null,
                        workspaceId: company?.workspace_id || null,
                    });
                }
            }
        }

        // PDF: ya no se adjunta al board de auditoría (se sube solo al board del cliente).
    } catch (err) {
        console.warn('[audit-log] error registrando:', err.message);
        // Si el audit log falló pero era Error sistema y todavía no disparamos Slack
        // (porque el error fue antes de la búsqueda), disparamos ahora sin link.
        if (isSystemError && !slackPromise) {
            slackPromise = notifySlackSystemError({
                accountId,
                clientItemName: sourceItemName,
                errorMessage: error?.message || '',
                auditItemId: null,
            });
        }
    }

    // Esperar Slack al final (si se disparó). Nunca tira porque la función ya tiene
    // su propio try/catch interno.
    if (slackPromise) {
        await slackPromise.catch(() => {});
    }
}

// Servir frontend React desde public/
const publicPath = path.join(__dirname, '../public');
// Assets hasheados (Vite) pueden cachearse forever. index.html NO debe cachearse
// para que el browser siempre lea el bundle más reciente referenciado adentro.
app.use(express.static(publicPath, {
    setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (/\.(js|css|woff2?|ttf|png|jpg|svg)$/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    },
}));
app.get('/*splat', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(publicPath, 'index.html'));
});

// Migraciones idempotentes al arranque.
async function runStartupMigrations() {
    try {
        await db.query('ALTER TABLE companies DROP COLUMN IF EXISTS iva_condition');
        console.log('[migrations] companies.iva_condition dropped (o no existía)');
    } catch (err) {
        console.error('[migrations] error:', err.message);
    }
    try {
        await ensureAfipCredentialsColumns();
        console.log('[migrations] afip_credentials columnas aseguradas');
    } catch (err) {
        console.error('[migrations] afip_credentials error:', err.message);
    }
    try {
        await ensureCompaniesExtraColumns();
        console.log('[migrations] companies columnas extra (contacto/branding) aseguradas');
    } catch (err) {
        console.error('[migrations] companies extra error:', err.message);
    }
    try {
        await ensureInstallationLeadsTable();
        console.log('[migrations] installation_leads table asegurada');
    } catch (err) {
        console.error('[migrations] installation_leads error:', err.message);
    }
    try {
        await ensureAfipWsaaTokensTable();
        console.log('[migrations] afip_wsaa_tokens table asegurada');
    } catch (err) {
        console.error('[migrations] afip_wsaa_tokens error:', err.message);
    }
    try {
        await ensurePadronReceptoresCacheTable();
        console.log('[migrations] padron_receptores_cache table asegurada');
    } catch (err) {
        console.error('[migrations] padron_receptores_cache error:', err.message);
    }
    try {
        await ensureInvoiceEmissionsTable();
        console.log('[migrations] invoice_emissions table + columnas Fase 1/3/4 aseguradas');
    } catch (err) {
        console.error('[migrations] invoice_emissions error:', err.message);
    }
    try {
        await ensureBoardAutomationConfigsExtras();
        console.log('[migrations] board_automation_configs (auto_rename_item, auto_update_status) aseguradas');
    } catch (err) {
        console.error('[migrations] board_automation_configs extras error:', err.message);
    }
}

// ─── Cache de tokens WSAA en DB ─────────────────────────────────────────────
// AFIP emite tokens WSAA que duran 12h. Guardarlos en DB permite que sobrevivan
// reinicios del container (cold start, redeploy) y se compartan entre todas
// las instancias. Esto ahorra 30-40s en la primera factura después de cada
// reinicio porque no hay que volver a autenticar contra WSAA.
//
// Dos tipos de tokens:
//   - service='ws_sr_constancia_inscripcion', company_id=NULL → token del Padrón (cert Martín),
//     compartido por todo el sistema.
//   - service='wsfe', company_id=N → token de facturación, uno por empresa
//     (cada empresa firma con su propio certificado).
//
// No usamos UNIQUE con NULL (ambiguo en Postgres). Hacemos UPSERT manual:
// DELETE + INSERT dentro de una transacción.
async function ensureAfipWsaaTokensTable() {
    // company_id es TEXT porque companies.id puede ser UUID (string) o integer
    // según cómo se creó la tabla. TEXT cubre ambos casos sin romper.
    await db.query(`
        CREATE TABLE IF NOT EXISTS afip_wsaa_tokens (
            id SERIAL PRIMARY KEY,
            company_id TEXT NULL,
            service VARCHAR(50) NOT NULL,
            token TEXT NOT NULL,
            sign TEXT NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    // Si la tabla ya existía con company_id INTEGER (deploy anterior buggy),
    // migrarla a TEXT. El USING convierte cualquier valor existente a string.
    await db.query(`
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'afip_wsaa_tokens'
                  AND column_name = 'company_id'
                  AND data_type = 'integer'
            ) THEN
                ALTER TABLE afip_wsaa_tokens
                    ALTER COLUMN company_id TYPE TEXT USING company_id::text;
            END IF;
        END $$
    `);
    // Índice para búsqueda rápida. Se combinan company_id+service.
    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_afip_wsaa_tokens_lookup
        ON afip_wsaa_tokens (service, company_id)
    `);
}

// Funciones del storage DB que se inyectan a afipAuth.setDbStorage().
// La interfaz esperada por afipAuth es { load, save, invalidate }.
//
// load({service, companyId}) → busca un token válido en DB
// save({service, companyId, token, sign, expiresAt}) → persiste token nuevo
// invalidate({service, companyId}) → borra token (usado ante error de AFIP)
// Sentinel string para company_id NULL (tokens globales como el Padrón).
// Usamos un string porque company_id es TEXT — COALESCE de TEXT con INTEGER
// no funciona en Postgres.
const WSAA_GLOBAL_COMPANY = '__global__';

async function wsaaDbLoad({ service, companyId }) {
    try {
        const cid = companyId ? String(companyId) : null;
        const result = await db.query(
            `SELECT token, sign, expires_at FROM afip_wsaa_tokens
             WHERE service = $1
               AND COALESCE(company_id, $2) = COALESCE($3::text, $2)
             LIMIT 1`,
            [service, WSAA_GLOBAL_COMPANY, cid]
        );
        const row = result.rows[0];
        if (!row) return null;
        const expiresAt = new Date(row.expires_at).getTime();
        // afipAuth aplica su propio margen de 5min al leer; acá devolvemos el
        // token tal cual si no está expirado (sin aplicar refresh-ahead, eso
        // es responsabilidad del cron diario cada 8h).
        if (expiresAt <= Date.now()) return null;
        return { token: row.token, sign: row.sign, expiresAt };
    } catch (err) {
        console.warn(`[wsaa-db] error leyendo token (${service}): ${err.message}`);
        return null;
    }
}

// Guarda (o reemplaza) un token en DB. Usa DELETE+INSERT para evitar problemas
// con UNIQUE sobre NULL. No falla la emisión si la DB falla.
async function wsaaDbSave({ service, companyId, token, sign, expiresAt }) {
    try {
        const cid = companyId ? String(companyId) : null;
        await db.query('BEGIN');
        await db.query(
            `DELETE FROM afip_wsaa_tokens
             WHERE service = $1
               AND COALESCE(company_id, $2) = COALESCE($3::text, $2)`,
            [service, WSAA_GLOBAL_COMPANY, cid]
        );
        await db.query(
            `INSERT INTO afip_wsaa_tokens (company_id, service, token, sign, expires_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [cid, service, token, sign, new Date(expiresAt)]
        );
        await db.query('COMMIT');
    } catch (err) {
        try { await db.query('ROLLBACK'); } catch {}
        console.warn(`[wsaa-db] error guardando token (${service}): ${err.message}`);
    }
}

async function wsaaDbInvalidate({ service, companyId }) {
    try {
        const cid = companyId ? String(companyId) : null;
        await db.query(
            `DELETE FROM afip_wsaa_tokens
             WHERE service = $1
               AND COALESCE(company_id, $2) = COALESCE($3::text, $2)`,
            [service, WSAA_GLOBAL_COMPANY, cid]
        );
    } catch (err) {
        console.warn(`[wsaa-db] error invalidando token (${service}): ${err.message}`);
    }
}

// ─── Pre-generación de tokens WSAA ──────────────────────────────────────────
// Genera el token WSFE de una empresa y lo guarda en DB. Se dispara en
// background cuando el cliente sube su certificado (o al abrir la app si
// falta). Así para cuando emita su primera factura el token ya está listo
// y no tiene que esperar 30-40s en el peor momento (first impression).
//
// Si ya hay un token válido en DB, no hace nada.
async function pregenerateWsfeToken({ companyId, cuit, certPem, keyPem }) {
    if (!companyId || !cuit || !certPem || !keyPem) {
        console.warn('[wsaa-pregen] faltan datos — skip');
        return;
    }
    try {
        // Chequear si ya hay un token válido con >3h de vida. Si sí, no hace
        // falta regenerar.
        const existing = await wsaaDbLoad({ service: 'wsfe', companyId });
        if (existing && (existing.expiresAt - Date.now()) > 3 * 60 * 60 * 1000) {
            console.log(`[wsaa-pregen] WSFE ya fresco para company ${companyId} — skip`);
            return;
        }
        console.log(`[wsaa-pregen] generando WSFE para company ${companyId} en background`);
        await afipAuthModule.getToken({
            certPem, keyPem, cuit, service: 'wsfe',
            companyId, force: true,
        });
        console.log(`[wsaa-pregen] WSFE OK para company ${companyId} — cacheado en DB`);
    } catch (err) {
        console.warn(`[wsaa-pregen] WSFE falló para company ${companyId}: ${err.message}`);
    }
}

// Pre-genera el token del Padrón (global, cert de Martín). Se dispara al
// arrancar el server y al abrir la app. El token es compartido por todo el
// sistema, así que una vez generado sirve para cualquier cliente.
async function pregeneratePadronToken() {
    try {
        if (!process.env.PADRON_CRT || !process.env.PADRON_KEY) {
            console.log('[wsaa-pregen] PADRON_CRT/KEY no configurados — skip');
            return;
        }
        const existing = await wsaaDbLoad({ service: 'ws_sr_constancia_inscripcion', companyId: null });
        if (existing && (existing.expiresAt - Date.now()) > 3 * 60 * 60 * 1000) {
            console.log('[wsaa-pregen] Padrón global ya fresco — skip');
            return;
        }
        console.log('[wsaa-pregen] generando token del Padrón (global) en background');
        // Disparamos una consulta al padrón con el CUIT del padrón (el de
        // Martín) — una llamada liviana. Esto fuerza la generación del token
        // que queda cacheado en DB.
        const afipPadron = require('./modules/afipPadron');
        const padronCuit = require('./config').padronCuit;
        if (padronCuit) {
            await afipPadron.getCondicionFiscal({ cuitAConsultar: padronCuit });
            console.log('[wsaa-pregen] Padrón global OK — cacheado en DB');
        }
    } catch (err) {
        console.warn(`[wsaa-pregen] Padrón global falló: ${err.message}`);
    }
}

// Helper: levanta el cert del emisor y pre-genera su token. Úsalo después
// de subir un certificado o al abrir la app si hay cert activo sin token.
async function pregenerateWsfeTokenForCompanyId(companyId) {
    try {
        const certResult = await db.query(`
            SELECT c.id, c.cuit, ac.crt_file_url, ac.encrypted_private_key
            FROM companies c
            JOIN afip_credentials ac ON ac.company_id = c.id
            WHERE c.id = $1
              AND ac.status = 'active'
              AND ac.crt_file_url IS NOT NULL
              AND ac.encrypted_private_key IS NOT NULL
            LIMIT 1
        `, [companyId]);
        const row = certResult.rows[0];
        if (!row) return;
        const certPem = normalizePem(row.crt_file_url, 'CERTIFICATE');
        const decryptedKey = CryptoJS.AES.decrypt(
            row.encrypted_private_key, process.env.ENCRYPTION_KEY
        ).toString(CryptoJS.enc.Utf8);
        const keyPem = normalizePem(decryptedKey, 'PRIVATE KEY');
        await pregenerateWsfeToken({
            companyId: row.id, cuit: row.cuit, certPem, keyPem
        });
    } catch (err) {
        console.warn(`[wsaa-pregen] error cargando cert de company ${companyId}: ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 4 — Auditoria nocturna contra AFIP
// ─────────────────────────────────────────────────────────────────────────
// Cada noche a las 3 AM Argentina (6 UTC) el cron consulta AFIP para cada
// factura emitida por la app (status='success', audit_status IS NULL) y
// verifica que CAE, numero e importe coincidan. Una vez auditada, la row
// queda marcada en audit_status y no se vuelve a revisar.
//
// Si todo OK: notifica a Slack con un resumen positivo.
// Si hay discrepancias: notifica a Slack con detalle de cada caso para
// revision manual urgente.

const NIGHTLY_AUDIT_BATCH_SIZE = 500;

async function markAuditResult(rowId, status, findings) {
    await db.query(
        `UPDATE invoice_emissions
         SET audit_status=$2, audited_at=CURRENT_TIMESTAMP, audit_findings=$3
         WHERE id=$1`,
        [rowId, status, JSON.stringify(findings || {})]
    );
}

// Audita una row contra AFIP. Retorna { status, findings } sin tocar la DB.
async function auditSingleEmission({ row, company, token, sign }) {
    const afipResult = row.afip_result_json || {};
    if (!afipResult.cae) {
        return { status: 'error', findings: { error: 'sin afip_result_json o sin CAE' } };
    }

    const cbteTypeMap = { A: 1, B: 6, C: 11 };
    const cbteType = row.attempted_cbte_tipo
        || cbteTypeMap[afipResult.tipo_comprobante]
        || cbteTypeMap[row.invoice_type];
    if (!cbteType) {
        return { status: 'error', findings: { error: `cbteType no resuelto (invoice_type=${row.invoice_type})` } };
    }

    const pointOfSale = row.attempted_pto_vta
        || row.draft_json?.punto_venta
        || company.default_point_of_sale;
    const cbteNro = afipResult.numero_comprobante || row.attempted_cbte_nro;
    if (!pointOfSale || !cbteNro) {
        return { status: 'error', findings: { error: 'pointOfSale o cbteNro faltante' } };
    }

    let recovered;
    try {
        recovered = await afipConsultarComprobante({
            token, sign, cuit: company.cuit,
            pointOfSale, cbteType, cbteNro,
        });
    } catch (err) {
        return { status: 'error', findings: { error: `consulta AFIP fallo: ${err.message}` } };
    }

    if (!recovered || !recovered.cae) {
        return {
            status: 'not_found_in_afip',
            findings: {
                our_cae: afipResult.cae,
                our_cbte_nro: cbteNro,
                our_pto_vta: pointOfSale,
                our_cbte_type: cbteType,
            },
        };
    }

    const mismatches = [];
    if (recovered.cae !== afipResult.cae) {
        mismatches.push({ field: 'cae', ours: afipResult.cae, afip: recovered.cae });
    }
    if (Number(recovered.cbte_nro) !== Number(cbteNro)) {
        mismatches.push({ field: 'cbte_nro', ours: cbteNro, afip: recovered.cbte_nro });
    }
    const ourTotal = Number(
        row.draft_json?.importe_total
        || ((Number(afipResult.imp_neto) || 0) + (Number(afipResult.imp_iva) || 0))
        || 0
    );
    if (ourTotal > 0 && Math.abs(Number(recovered.imp_total) - ourTotal) > 0.01) {
        mismatches.push({ field: 'imp_total', ours: ourTotal, afip: recovered.imp_total });
    }

    if (mismatches.length === 0) {
        return { status: 'ok', findings: { afip_cae: recovered.cae, afip_cbte_nro: recovered.cbte_nro } };
    }
    return { status: 'mismatch', findings: { mismatches, afip_cae: recovered.cae } };
}

async function notifyAuditSummary({ results, ok, mismatch, notFound, errors, durationMs }) {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
        console.warn('[nightly-audit] SLACK_WEBHOOK_URL no configurado — skip notificacion');
        return;
    }

    const total = ok + mismatch + notFound + errors;
    if (total === 0) return; // nada nuevo que reportar tonight

    // Acumulado historico de toda la tabla — incluye lo que se acaba de auditar.
    // Asi el mensaje muestra "auditadas anoche: X" + "estado del sistema: Y/Z OK".
    let cum = { ok: 0, mismatch: 0, not_found: 0, errors: 0, total_success: 0 };
    try {
        const stats = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE audit_status='ok')                AS ok,
                COUNT(*) FILTER (WHERE audit_status='mismatch')          AS mismatch,
                COUNT(*) FILTER (WHERE audit_status='not_found_in_afip') AS not_found,
                COUNT(*) FILTER (WHERE audit_status='error')             AS errors,
                COUNT(*) FILTER (WHERE status='success')                 AS total_success
            FROM invoice_emissions
        `);
        const r = stats.rows[0] || {};
        cum = {
            ok: Number(r.ok || 0),
            mismatch: Number(r.mismatch || 0),
            not_found: Number(r.not_found || 0),
            errors: Number(r.errors || 0),
            total_success: Number(r.total_success || 0),
        };
    } catch (err) {
        console.warn('[nightly-audit] no se pudo obtener acumulado:', err.message);
    }

    const cumIssues = cum.mismatch + cum.not_found;
    const cumLine = cumIssues > 0
        ? `*Estado del sistema:* ${cum.ok}/${cum.total_success} OK · ${cumIssues} con discrepancia · ${cum.errors} con error tecnico`
        : (cum.errors > 0
            ? `*Estado del sistema:* ${cum.ok}/${cum.total_success} OK · ${cum.errors} con error tecnico`
            : `*Estado del sistema:* ${cum.ok}/${cum.total_success} OK :white_check_mark:`);

    // Fecha "ayer" (en UTC simplificado — 3am AR ~ 6am UTC, asi que la fecha
    // anterior representa el dia auditado).
    const auditedDate = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const hasIssues = mismatch > 0 || notFound > 0;
    const durationStr = `${(durationMs / 1000).toFixed(1)}s`;

    let text;
    if (!hasIssues && errors === 0) {
        text = [
            `:white_check_mark: *Auditoria nocturna AFIP — ${auditedDate}*`,
            ``,
            `*Auditadas esta noche:* ${total} → TODAS CORRECTAS`,
            cumLine,
            ``,
            `_Las facturas emitidas por la app coinciden 100% con AFIP (CAE, numero e importe)._`,
            `_Duracion: ${durationStr}_`,
        ].join('\n');
    } else if (!hasIssues && errors > 0) {
        text = [
            `:large_yellow_circle: *Auditoria nocturna AFIP — ${auditedDate}*`,
            ``,
            `*Auditadas esta noche:* ${total}`,
            `:white_check_mark: OK: ${ok}`,
            `:warning: Errores tecnicos (no auditables): ${errors}`,
            ``,
            cumLine,
            ``,
            `_Sin discrepancias en lo que pudimos consultar. Las ${errors} con error tecnico (cert / red / data faltante) requieren revision manual._`,
        ].join('\n');
    } else {
        const issues = results.filter(r => r.status === 'mismatch' || r.status === 'not_found_in_afip');
        const detailLines = issues.slice(0, 10).map((r, idx) => {
            const accLabel = r.company?.business_name || `account=${r.company?.monday_account_id || '?'}`;
            const afipR = r.row.afip_result_json || {};
            const ptoStr = String(r.row.attempted_pto_vta || r.row.draft_json?.punto_venta || '').padStart(2, '0');
            const nroStr = String(afipR.numero_comprobante || r.row.attempted_cbte_nro || '').padStart(8, '0');
            const tipoStr = `Factura ${r.row.invoice_type || afipR.tipo_comprobante || '?'} N° ${ptoStr}-${nroStr}`;
            const itemRef = `account=${r.company?.monday_account_id || '?'} board=${r.row.board_id} item=${r.row.item_id}`;

            if (r.status === 'not_found_in_afip') {
                return `*${idx+1}.* ${accLabel} — ${tipoStr}\n   :rotating_light: NO EXISTE EN AFIP\n   Nuestro CAE: \`${afipR.cae || '?'}\`\n   ${itemRef}`;
            }
            const mlines = (r.findings.mismatches || []).map(m =>
                `   • *${m.field}*: nuestro=\`${m.ours}\` vs AFIP=\`${m.afip}\``
            ).join('\n');
            return `*${idx+1}.* ${accLabel} — ${tipoStr}\n   :warning: Mismatch:\n${mlines}\n   ${itemRef}`;
        }).join('\n\n');

        const more = issues.length > 10
            ? `\n\n_(... y ${issues.length - 10} mas. Ver SELECT * FROM invoice_emissions WHERE audit_status IN ('mismatch','not_found_in_afip'))_`
            : '';

        text = [
            `:rotating_light: *DISCREPANCIA AFIP — Auditoria nocturna ${auditedDate}*`,
            ``,
            `*Auditadas esta noche:* ${total}`,
            `:white_check_mark: OK: ${ok}`,
            `:rotating_light: Discrepancias criticas: ${notFound + mismatch}`,
            errors > 0 ? `:warning: Errores tecnicos: ${errors}` : null,
            ``,
            cumLine,
            ``,
            `*REVISAR MANUALMENTE EN AFIP WEB:*`,
            ``,
            detailLines + more,
        ].filter(Boolean).join('\n');
    }

    try {
        const res = await fetchWithRetry(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        }, { attempts: 2, delayMs: 3000, timeoutMs: 15000, label: 'slack-audit' });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error(`[nightly-audit] slack devolvio ${res.status}: ${body.slice(0, 200)}`);
        } else {
            console.log(`[nightly-audit] resumen enviado a slack (ok=${ok}, mismatch=${mismatch}, not_found=${notFound}, errors=${errors})`);
        }
    } catch (err) {
        console.error('[nightly-audit] error notificando a slack:', err.message);
    }
}

async function runNightlyAfipAudit() {
    const startedAt = Date.now();
    console.log('[nightly-audit] iniciando…');

    let rows;
    try {
        const result = await db.query(`
            SELECT id, company_id, board_id, item_id, invoice_type, status,
                   attempted_cbte_tipo, attempted_pto_vta, attempted_cbte_nro,
                   afip_result_json, draft_json, created_at
            FROM invoice_emissions
            WHERE status='success' AND audit_status IS NULL
            ORDER BY created_at DESC
            LIMIT $1
        `, [NIGHTLY_AUDIT_BATCH_SIZE]);
        rows = result.rows;
    } catch (err) {
        console.error('[nightly-audit] error buscando rows:', err.message);
        return;
    }

    if (rows.length === 0) {
        console.log('[nightly-audit] sin facturas pendientes de auditar — skip');
        return;
    }

    console.log(`[nightly-audit] auditando ${rows.length} facturas…`);

    // Agrupar por company_id para reusar el token WSAA (uno por empresa).
    const byCompany = new Map();
    for (const row of rows) {
        if (!byCompany.has(row.company_id)) byCompany.set(row.company_id, []);
        byCompany.get(row.company_id).push(row);
    }

    const results = [];

    for (const [companyId, companyRows] of byCompany) {
        let company = null;
        let token = null;
        let sign = null;

        // Setup company + cert + token. Si falla, marcamos todas las rows de
        // esta empresa como 'error' y seguimos con la siguiente empresa.
        try {
            const compRes = await db.query(
                `SELECT id, monday_account_id, business_name, cuit, default_point_of_sale
                 FROM companies WHERE id=$1 LIMIT 1`,
                [companyId]
            );
            company = compRes.rows[0];
            if (!company) throw new Error('company no encontrada');

            const certRes = await db.query(
                'SELECT crt_file_url, encrypted_private_key FROM afip_credentials WHERE company_id=$1 LIMIT 1',
                [companyId]
            );
            if (!certRes.rows[0]) throw new Error('certs AFIP faltantes');

            const certPem = normalizePem(certRes.rows[0].crt_file_url, 'CERTIFICATE');
            const decKey  = CryptoJS.AES.decrypt(
                certRes.rows[0].encrypted_private_key, process.env.ENCRYPTION_KEY
            ).toString(CryptoJS.enc.Utf8);
            const keyPem  = normalizePem(decKey, 'PRIVATE KEY');

            const tokenData = await afipAuthModule.getToken({
                certPem, keyPem, cuit: company.cuit, service: 'wsfe',
                companyId: company.id,
            });
            token = tokenData.token;
            sign  = tokenData.sign;
        } catch (setupErr) {
            console.warn(`[nightly-audit] setup company ${companyId} fallo: ${setupErr.message} — marcando ${companyRows.length} rows como error`);
            for (const row of companyRows) {
                try {
                    await markAuditResult(row.id, 'error', { error: `setup company: ${setupErr.message}` });
                } catch (_) {}
                results.push({ row, company, status: 'error', findings: { error: setupErr.message } });
            }
            continue;
        }

        // Auditar cada row de esta empresa con el mismo token
        for (const row of companyRows) {
            let outcome;
            try {
                outcome = await auditSingleEmission({ row, company, token, sign });
            } catch (err) {
                outcome = { status: 'error', findings: { error: err.message } };
            }
            try {
                await markAuditResult(row.id, outcome.status, outcome.findings);
            } catch (dbErr) {
                console.error(`[nightly-audit] error marcando row ${row.id}:`, dbErr.message);
            }
            results.push({ row, company, status: outcome.status, findings: outcome.findings });

            // Pausa minima para no saturar AFIP (~10 reqs/seg max).
            await new Promise(r => setTimeout(r, 100));
        }
    }

    const ok       = results.filter(r => r.status === 'ok').length;
    const mismatch = results.filter(r => r.status === 'mismatch').length;
    const notFound = results.filter(r => r.status === 'not_found_in_afip').length;
    const errors   = results.filter(r => r.status === 'error').length;
    const durationMs = Date.now() - startedAt;

    console.log(`[nightly-audit] completado en ${(durationMs/1000).toFixed(1)}s — ok=${ok}, mismatch=${mismatch}, not_found=${notFound}, errors=${errors}`);

    await notifyAuditSummary({ results, ok, mismatch, notFound, errors, durationMs });
}

function scheduleNightlyAfipAudit() {
    // 3 AM Argentina (UTC-3) = 6 AM UTC.
    const utcHour = 6;
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(utcHour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delayMs = next.getTime() - now.getTime();
    console.log(`[nightly-audit] proxima corrida: ${next.toISOString()} (en ${Math.round(delayMs/1000/60)} min)`);
    setTimeout(async () => {
        try { await runNightlyAfipAudit(); }
        catch (err) { console.error('[nightly-audit] error en corrida:', err.message); }
        scheduleNightlyAfipAudit(); // re-agendar para la noche siguiente
    }, delayMs);
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 3 — Cron de reconciliacion de emisiones huerfanas
// ─────────────────────────────────────────────────────────────────────────
// Cada 5 minutos buscamos rows en invoice_emissions que quedaron stuck
// (status != 'success', tienen attempted_cbte_nro, son antiguas) y le
// preguntamos a AFIP via FECompConsultar si la factura realmente se emitio.
// Si AFIP confirma → recuperamos: actualizamos DB, regeneramos PDF, subimos
// a monday y cambiamos status. Si AFIP no la encontro → la factura nunca se
// emitio (timeout antes de llegar a AFIP), dejamos la row como esta.
//
// Esto cubre el caso donde el usuario NO reintenta manualmente despues de
// un micro-corte. La Fase 1 cubre cuando el usuario SI reintenta.

const RECONCILE_BATCH_SIZE   = 20;          // max rows por corrida
const RECONCILE_STALE_MIN    = 5;           // min de antiguedad para considerar stuck
const RECONCILE_INTERVAL_MS  = 5 * 60 * 1000;

async function reconcileSingleEmission(row) {
    const tag = `[reconcile-cron item=${row.item_id} cbteNro=${row.attempted_cbte_nro}]`;

    // 1. Resolver company
    const companyResult = await db.query(
        `SELECT id, monday_account_id, workspace_id, business_name, trade_name,
                cuit, default_point_of_sale, address, phone, email, website,
                logo_base64, logo_mime_type,
                padron_condicion, padron_nombre, padron_tipo_persona, padron_domicilio
         FROM companies WHERE id=$1 LIMIT 1`,
        [row.company_id]
    );
    const company = companyResult.rows[0];
    if (!company) {
        console.warn(`${tag} company no encontrada (id=${row.company_id}), skip`);
        return;
    }

    // 2. Certificados
    const certResult = await db.query(
        'SELECT crt_file_url, encrypted_private_key FROM afip_credentials WHERE company_id=$1 LIMIT 1',
        [company.id]
    );
    if (certResult.rows.length === 0) {
        console.warn(`${tag} sin certificados AFIP, skip`);
        return;
    }
    const certRow = certResult.rows[0];
    const emisorCertPem = normalizePem(certRow.crt_file_url, 'CERTIFICATE');
    const decryptedKey  = CryptoJS.AES.decrypt(
        certRow.encrypted_private_key, process.env.ENCRYPTION_KEY
    ).toString(CryptoJS.enc.Utf8);
    const emisorKeyPem = normalizePem(decryptedKey, 'PRIVATE KEY');

    // 3. Token WSAA
    const tokenData = await afipAuthModule.getToken({
        certPem: emisorCertPem, keyPem: emisorKeyPem,
        cuit: company.cuit, service: 'wsfe',
        companyId: company.id,
    });

    // 4. Consultar AFIP por el cbteNro reservado
    const recovered = await afipConsultarComprobante({
        token: tokenData.token, sign: tokenData.sign,
        cuit: company.cuit,
        pointOfSale: row.attempted_pto_vta || company.default_point_of_sale,
        cbteType: row.attempted_cbte_tipo,
        cbteNro: row.attempted_cbte_nro,
    });

    if (!recovered || !recovered.cae) {
        console.log(`${tag} AFIP confirma que NO se emitio — la solicitud nunca llego a procesarse. Dejando row en estado actual.`);
        return;
    }

    console.log(`${tag} AFIP confirma factura emitida (CAE=${recovered.cae}). Iniciando recovery…`);

    // 5. Construir afipResult equivalente al que devuelve afipIssueFactura
    const afipResult = {
        resultado: recovered.resultado || 'A',
        cae: recovered.cae,
        cae_vencimiento: recovered.cae_vencimiento,
        numero_comprobante: recovered.cbte_nro,
        tipo_comprobante: row.invoice_type,
        imp_neto: recovered.imp_neto,
        imp_iva: recovered.imp_iva,
        observacion: null,
        raw_xml: recovered.raw_xml_preview || '',
        recovered: true,
        recovered_by: 'cron',
        recovered_at: new Date().toISOString(),
    };

    // 6. Persistir CAE en DB lo antes posible — si despues falla PDF/upload,
    //    al menos no perdemos el registro fiscal.
    try {
        await db.query(
            `UPDATE invoice_emissions
             SET status='success', afip_result_json=$2, error_message=NULL,
                 updated_at=CURRENT_TIMESTAMP
             WHERE id=$1`,
            [row.id, JSON.stringify(afipResult)]
        );
        console.log(`${tag} DB actualizada a status='success' con CAE`);
    } catch (dbErr) {
        console.error(`${tag} error persistiendo CAE en DB:`, dbErr.message);
        return; // sin DB no tiene sentido seguir
    }

    // 7. Si no tenemos draft_json (rows viejas pre-Fase 3), no podemos
    //    regenerar PDF. CAE queda en DB pero monday no se actualiza.
    const draft = row.draft_json;
    if (!draft) {
        console.warn(`${tag} draft_json es NULL — CAE persistido pero PDF/monday no se actualizan automaticamente. El usuario puede re-disparar la receta para regenerar (Fase 1 reusara el CAE).`);
        return;
    }

    // 8. Generar PDF
    let pdfBuffer = null;
    try {
        pdfBuffer = await generateFacturaPdfBuffer({
            company, draft, afipResult, itemId: row.item_id,
        });
        console.log(`${tag} PDF generado (${pdfBuffer?.length || 0} bytes)`);
    } catch (pdfErr) {
        console.error(`${tag} error generando PDF:`, pdfErr.message);
    }

    // 9. Token de monday (usamos el stored, el del webhook ya expiro)
    let mondayToken = null;
    try {
        mondayToken = await getStoredMondayUserApiToken({
            mondayAccountId: company.monday_account_id,
        });
    } catch (_) {}
    if (!mondayToken) {
        console.warn(`${tag} no hay monday token stored — DB recuperada pero monday no se actualiza`);
        return;
    }

    // 10. Subir PDF a monday
    if (pdfBuffer) {
        try {
            const pdfColumnId = await getInvoicePdfColumnId({
                companyId: company.id, boardId: row.board_id,
            });
            if (pdfColumnId) {
                const pvPadded  = String(row.attempted_pto_vta || draft?.punto_venta || '').padStart(2, '0');
                const nroPadded = String(recovered.cbte_nro || '').padStart(4, '0');
                await uploadPdfToMondayFileColumn({
                    apiToken: mondayToken, itemId: row.item_id,
                    fileColumnId: pdfColumnId,
                    pdfBuffer,
                    filename: `Factura_${row.invoice_type}_Nro_${pvPadded}-${nroPadded}.pdf`,
                });
                console.log(`${tag} PDF subido a monday`);
            } else {
                console.warn(`${tag} no hay columna de PDF configurada en mapeo`);
            }
        } catch (upErr) {
            console.error(`${tag} error subiendo PDF a monday:`, upErr.message);
        }
    }

    // 11. Cambiar status del item a "Comprobante Creado"
    try {
        const readiness = await validateEmissionReadiness({
            mondayAccountId: company.monday_account_id, boardId: row.board_id,
        }).catch(() => null);
        const statusColId = readiness?.boardConfig?.status_column_id;
        const successLabel = readiness?.boardConfig?.success_label
            || COMPROBANTE_STATUS_FLOW.success;
        if (statusColId) {
            await updateMondayItemStatus({
                apiToken: mondayToken,
                boardId: row.board_id,
                itemId: row.item_id,
                statusColumnId: statusColId,
                label: successLabel,
            });
            console.log(`${tag} status del item cambiado a "${successLabel}"`);
        }
    } catch (statusErr) {
        console.warn(`${tag} error cambiando status en monday:`, statusErr.message);
    }

    // 12. Postear update aclaratorio en el item
    try {
        const body =
            `<b>🛠 Recuperacion automatica</b><br/><br/>` +
            `La emision anterior tuvo un timeout de red, pero la factura SI fue emitida correctamente en AFIP.<br/>` +
            `El sistema la recupero automaticamente:<br/><br/>` +
            `<b>Tipo:</b> Factura ${row.invoice_type}<br/>` +
            `<b>Nº de comprobante:</b> ${recovered.cbte_nro}<br/>` +
            `<b>CAE:</b> ${recovered.cae}<br/>` +
            `<b>Vto CAE:</b> ${recovered.cae_vencimiento || '—'}<br/>` +
            `<b>Importe:</b> $${recovered.imp_total}`;
        const mutation = `mutation { create_update(item_id: ${row.item_id}, body: ${JSON.stringify(body)}) { id } }`;
        await fetch('https://api.monday.com/v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: mondayToken },
            body: JSON.stringify({ query: mutation }),
        });
    } catch (upErr) {
        console.warn(`${tag} no se pudo postear update aclaratorio:`, upErr.message);
    }

    console.log(`${tag} ✅ recovery completo`);
}

async function reconcileStuckEmissions() {
    let rows;
    try {
        const result = await db.query(`
            SELECT id, company_id, board_id, item_id, invoice_type,
                   status, attempted_cbte_tipo, attempted_pto_vta, attempted_cbte_nro,
                   draft_json, reconciliation_attempts
            FROM invoice_emissions
            WHERE status != 'success'
              AND attempted_cbte_nro IS NOT NULL
              AND updated_at < NOW() - INTERVAL '${RECONCILE_STALE_MIN} minutes'
              AND (last_reconciliation_at IS NULL
                   OR last_reconciliation_at < NOW() - INTERVAL '${RECONCILE_STALE_MIN} minutes')
            ORDER BY updated_at ASC
            LIMIT $1
        `, [RECONCILE_BATCH_SIZE]);
        rows = result.rows;
    } catch (err) {
        console.error('[reconcile-cron] error buscando rows stuck:', err.message);
        return;
    }

    if (rows.length === 0) return;
    console.log(`[reconcile-cron] encontradas ${rows.length} emisiones stuck — procesando…`);

    for (const row of rows) {
        // Claim atomico para evitar que dos workers procesen la misma row.
        // Si otro ya la claim-eo en los ultimos RECONCILE_STALE_MIN min, skip.
        let claimed = false;
        try {
            const claim = await db.query(`
                UPDATE invoice_emissions
                SET last_reconciliation_at=CURRENT_TIMESTAMP,
                    reconciliation_attempts=COALESCE(reconciliation_attempts, 0) + 1
                WHERE id=$1
                  AND (last_reconciliation_at IS NULL
                       OR last_reconciliation_at < NOW() - INTERVAL '${RECONCILE_STALE_MIN} minutes')
                RETURNING id
            `, [row.id]);
            claimed = claim.rowCount > 0;
        } catch (err) {
            console.error(`[reconcile-cron] error claim row id=${row.id}:`, err.message);
            continue;
        }
        if (!claimed) {
            console.log(`[reconcile-cron] row id=${row.id} ya tomada por otro worker, skip`);
            continue;
        }

        try {
            await reconcileSingleEmission(row);
        } catch (err) {
            console.error(`[reconcile-cron] error procesando row id=${row.id}:`, err.message);
            console.error(err.stack?.slice(0, 600));
        }
    }
}

function scheduleReconciliationCron() {
    setInterval(() => {
        reconcileStuckEmissions().catch(err =>
            console.error('[reconcile-cron] error en corrida:', err.message)
        );
    }, RECONCILE_INTERVAL_MS);
    console.log(`[reconcile-cron] scheduled — corrida cada ${RECONCILE_INTERVAL_MS / 60000} min`);
}

// ─────────────────────────────────────────────────────────────────────────
// Endpoint admin para disparar la auditoria nocturna a demanda (testing).
// ─────────────────────────────────────────────────────────────────────────
// Auth: header `x-admin-token` debe coincidir con DEV_MONDAY_TOKEN del env.
// Corre el audit sincronicamente y devuelve el resumen en la response.
// Tambien dispara la notificacion a Slack si hay rows auditadas.
app.post('/api/admin/run-nightly-audit', async (req, res) => {
    const adminToken = process.env.DEV_MONDAY_TOKEN;
    const provided = req.headers['x-admin-token'];
    if (!adminToken) {
        return res.status(500).json({ error: 'DEV_MONDAY_TOKEN no configurado en el server' });
    }
    if (!provided || provided !== adminToken) {
        return res.status(403).json({ error: 'forbidden' });
    }

    console.log('[admin] disparando runNightlyAfipAudit a demanda');
    const startedAt = Date.now();
    try {
        // Reusa la logica del cron, incluyendo la notificacion a Slack.
        await runNightlyAfipAudit();

        // Devolver un snapshot rapido del estado de auditoria como feedback.
        const stats = await db.query(`
            SELECT
                COUNT(*) FILTER (WHERE audit_status='ok')                 AS ok,
                COUNT(*) FILTER (WHERE audit_status='mismatch')           AS mismatch,
                COUNT(*) FILTER (WHERE audit_status='not_found_in_afip')  AS not_found,
                COUNT(*) FILTER (WHERE audit_status='error')              AS errors,
                COUNT(*) FILTER (WHERE status='success' AND audit_status IS NULL) AS pending,
                COUNT(*) FILTER (WHERE status='success')                  AS total_success
            FROM invoice_emissions
        `);
        const row = stats.rows[0] || {};
        return res.status(200).json({
            status: 'completed',
            duration_ms: Date.now() - startedAt,
            audit_table_snapshot: {
                ok: Number(row.ok || 0),
                mismatch: Number(row.mismatch || 0),
                not_found_in_afip: Number(row.not_found || 0),
                errors: Number(row.errors || 0),
                pending: Number(row.pending || 0),
                total_success: Number(row.total_success || 0),
            },
            note: 'Slack notificado solo si hubo rows nuevas auditadas en esta corrida. Si pending=0 al inicio, no hay nada que reportar.',
        });
    } catch (err) {
        console.error('[admin] runNightlyAfipAudit fallo:', err.message);
        return res.status(500).json({
            status: 'failed',
            error: err.message,
            duration_ms: Date.now() - startedAt,
        });
    }
});

// Arranca el servidor (local y monday code)
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
    console.log(`Backend corriendo en puerto ${PORT} | AFIP_ENV: ${(process.env.AFIP_ENV || 'homologation').toUpperCase()}`);
    await runStartupMigrations();

    // Inyectar el storage de DB en afipAuth para que los tokens sobrevivan
    // reinicios del container. Debe ir DESPUÉS de las migrations porque la
    // tabla afip_wsaa_tokens se crea ahí.
    afipAuthModule.setDbStorage({
        load:       wsaaDbLoad,
        save:       wsaaDbSave,
        invalidate: wsaaDbInvalidate,
    });
    console.log('[wsaa] DB storage inyectado en afipAuth');

    // Warm-up pdfkit (carga fuentes Helvetica en memoria).
    warmupPdfkit();

    schedulePadronEmisorDailyRefresh();

    // Pre-generar el token del Padrón (global, cert de Martín) al arrancar.
    // Así la primera consulta a padrón (emisor o receptor) no espera los
    // 30-40s de regeneración. Background, no bloquea.
    setTimeout(() => {
        pregeneratePadronToken().catch(err =>
            console.error('[wsaa-pregen padron startup] error:', err.message));
    }, 3000);

    // Al arrancar el server (cold start / redeploy / crash recovery), disparamos
    // el refresh del padrón como red de seguridad. La función filtra por
    // fetched_at > 18h, así que si todo está fresco no hace nada.
    setTimeout(() => {
        console.log('[padron-cron startup] disparando refresh post-boot');
        runPadronEmisorDailyRefresh().catch(err =>
            console.error('[padron-cron startup] error:', err.message));
    }, 10000);

    // Cron de reconciliacion (Fase 3): cada 5 min revisa rows stuck en
    // 'error'/'processing' con attempted_cbte_nro y consulta a AFIP.
    // Tambien dispara una corrida 60s post-boot por si quedaron rows
    // huerfanas de un crash anterior.
    scheduleReconciliationCron();
    setTimeout(() => {
        console.log('[reconcile-cron startup] disparando primera corrida post-boot');
        reconcileStuckEmissions().catch(err =>
            console.error('[reconcile-cron startup] error:', err.message));
    }, 60000);

    // Cron de auditoria nocturna (Fase 4): cada noche a las 3 AM Argentina
    // verifica todas las facturas exitosas contra AFIP via FECompConsultar.
    // Marca audit_status en DB y notifica resumen a Slack.
    scheduleNightlyAfipAudit();
});

module.exports = app;
