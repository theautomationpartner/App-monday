#!/usr/bin/env node
/**
 * One-off: sincroniza el board "Comp Emitidos" con TODAS las emisiones
 * EXITOSAS de la base apuntada por DATABASE_URL.
 *
 *  - Si el CAE de la emisión NO está en el board → crea el item.
 *  - Si el CAE YA está en el board → actualiza ese item, completando los
 *    datos que falten (ej. columnas nuevas Tipo de Comprobante / Moneda).
 *  - Si dentro de la misma corrida aparece un CAE repetido, el item nuevo se
 *    crea con "(duplicada)" en el nombre — así no se pierde nada.
 *  - Registra cada item creado en audit_log_items, para que el cron de
 *    backfill normal no lo vuelva a agregar.
 *
 * Idempotente: re-correrlo solo refresca/agrega, nunca duplica.
 *
 * Correr UNA vez por base, SIEMPRE con MONDAY_AUDIT_BOARD_ID = board de prod:
 *   set -a; . .env; set +a            # carga board + token (+ defaultdb)
 *   node scripts/backfill-audit-board.js                       # → defaultdb
 *   DATABASE_URL="<url stagingdb>" node scripts/backfill-audit-board.js   # → stagingdb
 */
const db = require('../src/db');

const BOARD_ID = process.env.MONDAY_AUDIT_BOARD_ID;
const TOKEN    = process.env.DEV_MONDAY_TOKEN;
const MONDAY   = 'https://api.monday.com/v2';

// IDs de columna del board "Comp Emitidos" (espejo de AUDIT_COLS en server.js).
const COL = {
    fecha_emision:    'date_mm2ttq29',
    estado:           'color_mm2t2mrr',
    empresa_emisora:  'dropdown_mm3hfsrw',
    tipo_comprobante: 'dropdown_mm3kepzs',
    tipo:             'dropdown_mm2ty1vv',
    moneda:           'dropdown_mm3kw6n6',
    nro_comprobante:  'numeric_mm2ts2xt',
    punto_venta:      'numeric_mm2wva2f',
    cuit_emisor:      'numeric_mm2wjc48',
    cae:              'numeric_mm2tbp76',
    vto_cae:          'date_mm2tnn5a',
    cuit_receptor:    'numeric_mm2tdk2h',
    razon_social:     'text_mm2t7wza',
    importe_total:    'numeric_mm2t5pm8',
    importe_neto:     'numeric_mm2t5f9x',
    importe_iva:      'numeric_mm2tqb1d',
    concepto_afip:    'dropdown_mm2tge43',
    condicion_venta:  'dropdown_mm2t75pn',
    instalacion:      'board_relation_mm2x7ajc',
};
const CONCEPTO = { 1: 'Productos', 2: 'Servicios', 3: 'Productos y Servicios' };

async function gql(query, variables) {
    const res = await fetch(MONDAY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: TOKEN },
        body: JSON.stringify({ query, variables }),
    });
    const j = await res.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
    return j.data;
}

// Normaliza una fecha a 'YYYY-MM-DD' (acepta ISO o YYYYMMDD); null si no se puede.
function ymd(v) {
    if (!v) return null;
    const s = String(v);
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.replace(/\D/g, '').match(/^(\d{4})(\d{2})(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
}
const pad   = (v, n) => String(v ?? '').padStart(n, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lee los items del board: devuelve Map(CAE → itemId).
async function getBoardItems() {
    const byCae = new Map();
    let cursor = null;
    do {
        const data = await gql(`
            query ($b: ID!, $c: String) {
              boards(ids: [$b]) {
                items_page(limit: 450, cursor: $c) {
                  cursor
                  items { id column_values(ids: ["${COL.cae}"]) { text } }
                }
              }
            }`, { b: String(BOARD_ID), c: cursor });
        const page = data?.boards?.[0]?.items_page;
        for (const it of (page?.items || [])) {
            const t = (it.column_values?.[0]?.text || '').replace(/\D/g, '');
            if (t && !byCae.has(t)) byCae.set(t, it.id);
        }
        cursor = page?.cursor || null;
    } while (cursor);
    return byCae;
}

function buildColumnValues(row) {
    const d = row.draft_json || {};
    const a = row.afip_result_json || {};
    const esNC = row.invoice_type === 'NC';
    const cv = {};
    const fe = ymd(d.fecha_emision);                 if (fe) cv[COL.fecha_emision] = { date: fe };
    cv[COL.estado] = { label: 'Emitida OK' };
    cv[COL.tipo_comprobante] = { labels: [esNC ? 'Nota de Crédito' : 'Factura'] };
    const letra = a.tipo_comprobante || d.tipo_comprobante;
    if (letra)                                        cv[COL.tipo] = { labels: [String(letra)] };
    cv[COL.moneda] = { labels: [d.moneda === 'DOL' ? 'Dólares' : 'Pesos'] };
    if (a.numero_comprobante != null)                 cv[COL.nro_comprobante] = String(a.numero_comprobante);
    if (d.punto_venta != null)                        cv[COL.punto_venta]     = String(d.punto_venta);
    const ce = String(row.cuit || '').replace(/\D/g, '');
    if (ce)                                           cv[COL.cuit_emisor]     = ce;
    if (row.business_name)                            cv[COL.empresa_emisora] = { labels: [String(row.business_name)] };
    if (a.cae)                                        cv[COL.cae]             = String(a.cae);
    const vto = ymd(a.cae_vencimiento);               if (vto) cv[COL.vto_cae] = { date: vto };
    const cr = String(d.receptor_cuit_o_dni || '').replace(/\D/g, '');
    if (cr)                                           cv[COL.cuit_receptor]   = cr;
    if (d.receptor_nombre)                            cv[COL.razon_social]    = String(d.receptor_nombre);
    if (d.importe_total != null)                      cv[COL.importe_total]   = String(d.importe_total);
    if (d.importe_neto != null)                       cv[COL.importe_neto]    = String(d.importe_neto);
    if (d.importe_iva != null)                        cv[COL.importe_iva]     = String(d.importe_iva);
    if (d.concepto_afip)                              cv[COL.concepto_afip]   = { labels: [CONCEPTO[d.concepto_afip] || 'Productos'] };
    if (d.condicion_venta)                            cv[COL.condicion_venta] = { labels: [String(d.condicion_venta)] };
    // Instalación: connect al lead de la cuenta (board de leads compartido). El
    // lead_item_id viene del JOIN a installation_leads. La duración NO se backfillea
    // (no se persiste en invoice_emissions; solo existe en el log en vivo).
    if (row.lead_item_id)                             cv[COL.instalacion]     = { item_ids: [Number(row.lead_item_id)] };
    return cv;
}

function buildName(row, esDup) {
    const d = row.draft_json || {};
    const a = row.afip_result_json || {};
    const esNC = row.invoice_type === 'NC';
    const letra = a.tipo_comprobante || d.tipo_comprobante || '';
    const base = `${esNC ? 'Nota de Crédito' : 'Factura'} ${letra} N° ${pad(d.punto_venta, 4)}-${pad(a.numero_comprobante, 8)}`
        .replace(/\s+/g, ' ').trim();
    return esDup ? `${base} (duplicada)` : base;
}

async function main() {
    if (!BOARD_ID || !TOKEN) {
        console.error('Falta MONDAY_AUDIT_BOARD_ID o DEV_MONDAY_TOKEN en el entorno.');
        process.exit(1);
    }

    // La tabla de mapeo puede no existir en stagingdb (staging nunca loguea al
    // board) — la creamos para poder registrar lo que insertamos.
    await db.query(`
        CREATE TABLE IF NOT EXISTS audit_log_items (
            id SERIAL PRIMARY KEY,
            monday_account_id TEXT NOT NULL,
            client_item_id TEXT NOT NULL,
            audit_item_id TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            workspace_id TEXT,
            company_id UUID,
            UNIQUE (monday_account_id, client_item_id)
        )
    `);

    console.log('[backfill] leyendo items que ya están en el board…');
    const boardByCae = await getBoardItems();
    console.log(`[backfill] el board ya tiene ${boardByCae.size} comprobante(s).`);

    const { rows } = await db.query(`
        SELECT ie.item_id, ie.invoice_type, ie.draft_json, ie.afip_result_json,
               ie.company_id, c.monday_account_id, c.workspace_id,
               c.business_name, c.cuit, il.lead_item_id
          FROM invoice_emissions ie
          JOIN companies c ON c.id = ie.company_id
          LEFT JOIN installation_leads il ON il.monday_account_id = c.monday_account_id
         WHERE ie.status = 'success'
         ORDER BY ie.created_at ASC
    `);
    console.log(`[backfill] ${rows.length} emisión(es) exitosa(s) en la base.`);

    const seen = new Set(boardByCae.keys());
    let creadas = 0, actualizadas = 0, dups = 0, salteadas = 0, errores = 0;

    for (const row of rows) {
        const a = row.afip_result_json || {};
        const cae = a.cae ? String(a.cae).replace(/\D/g, '') : null;
        if (!cae) { salteadas++; continue; }   // sin CAE → no es emisión válida

        try {
            const cv = buildColumnValues(row);

            if (boardByCae.has(cae)) {
                // Ya está en el board → actualizar/completar sus columnas.
                await gql(`
                    mutation ($b: ID!, $i: ID!, $cv: JSON!) {
                      change_multiple_column_values(
                        board_id: $b, item_id: $i, column_values: $cv, create_labels_if_missing: true
                      ) { id }
                    }`, { b: String(BOARD_ID), i: String(boardByCae.get(cae)), cv: JSON.stringify(cv) });
                actualizadas++;
                console.log(`[backfill] ↻ ${buildName(row, false)}  (CAE ${cae})`);
            } else {
                // Nuevo → crear item + registrar el mapeo.
                const esDup = seen.has(cae);
                const name = buildName(row, esDup);
                const data = await gql(`
                    mutation ($b: ID!, $n: String!, $cv: JSON!) {
                      create_item(board_id: $b, item_name: $n, column_values: $cv, create_labels_if_missing: true) { id }
                    }`, { b: String(BOARD_ID), n: name, cv: JSON.stringify(cv) });
                const auditItemId = data?.create_item?.id;
                if (!auditItemId) throw new Error('create_item no devolvió id');

                const clientItemId = row.invoice_type === 'NC' ? `${row.item_id}:NC` : String(row.item_id);
                await db.query(`
                    INSERT INTO audit_log_items (monday_account_id, client_item_id, audit_item_id, workspace_id, company_id)
                    VALUES ($1,$2,$3,$4,$5)
                    ON CONFLICT (monday_account_id, client_item_id) DO NOTHING
                `, [String(row.monday_account_id), clientItemId, String(auditItemId),
                    row.workspace_id ? String(row.workspace_id) : null, row.company_id]);

                seen.add(cae);
                boardByCae.set(cae, auditItemId);
                if (esDup) { dups++; } else { creadas++; }
                console.log(`[backfill] ✓ ${name}  (CAE ${cae})`);
            }
            await sleep(150);   // no saturar la API de monday
        } catch (err) {
            errores++;
            console.error(`[backfill] ✗ item ${row.item_id}: ${err.message}`);
        }
    }

    console.log(`\n[backfill] LISTO — creadas=${creadas}  actualizadas=${actualizadas}  ` +
        `duplicadas=${dups}  salteadas(sin CAE)=${salteadas}  errores=${errores}`);
    process.exit(0);
}

main().catch((err) => { console.error('[backfill] fatal:', err.message); process.exit(1); });
