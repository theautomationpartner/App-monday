#!/usr/bin/env node
/**
 * One-off: rellena en los ITEMS de un board las columnas de información del
 * comprobante que quedaron VACÍAS en emisiones viejas (anteriores a tener esas
 * columnas mapeadas). NO consulta AFIP: usa lo que ya se guardó en el draft_json
 * de cada emisión exitosa (invoice_emissions) — la misma fuente que la app
 * escribió al emitir.
 *
 * Columnas que completa (solo las que el board tenga mapeadas):
 *   - razon_social_receptor   (texto)    ← draft.receptor_nombre  (Title Case)
 *   - condicion_iva_receptor  (dropdown) ← condicionLabel(draft.receptorCondicion)
 *   - cae_comprobante         (texto/num)← afip_result_json.cae
 *   - letra_comprobante       (dropdown) ← letra del comprobante (A/B/C)
 *   - nro_factura             (texto)    ← "PPPP-NNNNNNNN"
 *   - nro_comprobante         (texto/num)← número
 *
 * REGLA DE ORO: NO pisa. Solo escribe en una columna del item si está VACÍA.
 * Si ya tiene un valor (cargado a mano o por la app), lo respeta.
 *
 * SEGURIDAD: por defecto corre en DRY-RUN (no escribe nada, solo reporta qué
 * haría). Para escribir de verdad, pasar --apply.
 *
 * Uso (desde el droplet, board de PROD):
 *   set -a; . /opt/apps/App-monday/backend-repo/.env; set +a   # token + defaultdb
 *   node scripts/backfill-item-columns.js --board=18411065225            # dry-run
 *   node scripts/backfill-item-columns.js --board=18411065225 --apply    # escribe
 */
const db = require('../src/db');
const invoiceRules = require('../src/modules/invoiceRules');

// Token de la cuenta DEL BOARD (no el de TAP). El board de cada cliente vive en
// su propia cuenta de monday, así que para leer/escribir sus items hace falta el
// token de ESA cuenta. Se pasa por BACKFILL_MONDAY_TOKEN (no se hardcodea).
// Fallback a DEV_MONDAY_TOKEN solo sirve para boards de la cuenta de TAP.
const TOKEN  = process.env.BACKFILL_MONDAY_TOKEN || process.env.DEV_MONDAY_TOKEN;
const MONDAY = 'https://api.monday.com/v2';

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const boardArg = args.find((a) => a.startsWith('--board='));
const BOARD_ID = boardArg ? boardArg.split('=')[1] : null;

if (!TOKEN)    { console.error('Falta DEV_MONDAY_TOKEN en el entorno.'); process.exit(1); }
if (!BOARD_ID) { console.error('Falta --board=<id>. Ej: --board=18411065225'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad   = (v, n) => String(v ?? '').replace(/\D/g, '').padStart(n, '0');

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

// Lee los column_values de un item; devuelve { colId: textValue }.
// Para mirror/board-relation pide display_value (text viene vacío) — igual que
// fetchMondayItem en server.js.
async function getItemColumns(itemId) {
    const q = `query ($itemId: [ID!]) {
        items (ids: $itemId) {
            id
            column_values {
                id
                text
                ... on MirrorValue { display_value }
                ... on BoardRelationValue { display_value }
            }
        }
    }`;
    const d = await gql(q, { itemId: [String(itemId)] });
    const item = d?.items?.[0];
    // CRÍTICO: si la API no devuelve el item (sin acceso con este token, item
    // borrado, etc.) NO podemos asumir que las columnas están vacías — devolver
    // null para que el caller SALTE el item en vez de escribir a ciegas.
    if (!item) return null;
    const map = {};
    for (const cv of (item.column_values || [])) {
        const val = (cv.display_value != null && cv.display_value !== '') ? cv.display_value : cv.text;
        map[cv.id] = (val == null ? '' : String(val)).trim();
    }
    return map;
}

// ¿La columna del item está vacía?
function isEmpty(itemCols, colId) {
    if (!colId) return false; // columna no mapeada → no aplica
    return !itemCols[colId] || itemCols[colId] === '';
}

async function writeSimple(itemId, columnId, value) {
    const mutation = `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value, create_labels_if_missing: true) { id }
    }`;
    await gql(mutation, { boardId: String(BOARD_ID), itemId: String(itemId), columnId, value: String(value) });
}

// Resuelve la letra A/B/C del comprobante desde el draft o el invoice_type.
function resolveLetra(row) {
    const fromDraft = row.draft_json?.tipo_comprobante;
    if (['A', 'B', 'C'].includes(fromDraft)) return fromDraft;
    if (['A', 'B', 'C'].includes(row.invoice_type)) return row.invoice_type;
    return null; // NC/ND/AUTO sin letra resoluble → no escribimos letra
}

async function main() {
    console.log(`\n=== Backfill columnas de item — board ${BOARD_ID} ===`);
    console.log(APPLY ? '*** MODO APPLY: se van a ESCRIBIR cambios ***' : '--- DRY-RUN: no se escribe nada (pasá --apply para ejecutar) ---');

    // 1) Mapeo del board
    const mapRes = await db.query(
        `SELECT mapping_json FROM visual_mappings WHERE board_id=$1 LIMIT 1`, [String(BOARD_ID)]
    );
    if (mapRes.rows.length === 0) { console.error('El board no tiene mapeo en visual_mappings.'); process.exit(1); }
    const M = mapRes.rows[0].mapping_json || {};
    // Columnas candidatas. nro_factura se incluye/excluye según INCLUDE_NROFAC
    // (env var): en Polifroni se dejó fuera; para diagnosticar otros boards se
    // puede prender y ver si corresponde completarla.
    const cols = {
        razon: M.razon_social_receptor,
        cond:  M.condicion_iva_receptor,
        cae:   M.cae_comprobante,
        letra: M.letra_comprobante,
        nrocomp:M.nro_comprobante,
    };
    if (process.env.INCLUDE_NROFAC === '1') cols.nrofac = M.nro_factura;
    console.log('Columnas mapeadas:', JSON.stringify(cols));

    // 2) Emisiones exitosas del board
    const emis = await db.query(
        `SELECT item_id, invoice_type, draft_json, afip_result_json
           FROM invoice_emissions
          WHERE board_id=$1 AND status='success'
          ORDER BY created_at ASC`, [String(BOARD_ID)]
    );
    console.log(`Emisiones exitosas: ${emis.rows.length}\n`);

    let touched = 0, wouldWrite = 0, skipped = 0, notRead = 0;
    for (const row of emis.rows) {
        const itemId = row.item_id;
        let itemCols;
        try { itemCols = await getItemColumns(itemId); }
        catch (e) { console.warn(`  item ${itemId}: no se pudo leer (${e.message}) — skip`); continue; }
        await sleep(350); // rate-limit monday
        // Guarda anti-falso-positivo: si no se pudo leer el item (null), NO
        // escribimos nada — saltamos. Evita backfillear a ciegas sobre columnas
        // que en realidad podrían tener datos.
        if (itemCols === null) {
            console.warn(`  item ${itemId}: la API no devolvió el item (sin acceso o borrado) — SKIP`);
            notRead++;
            continue;
        }

        // Valores candidatos desde la emisión guardada
        const razon = row.draft_json?.receptor_nombre
            ? invoiceRules.toTitleCase(String(row.draft_json.receptor_nombre)) : null;
        const cond = row.draft_json?.receptorCondicion
            ? invoiceRules.toTitleCase(invoiceRules.condicionLabel(row.draft_json.receptorCondicion)) : null;
        const cae = row.afip_result_json?.cae || null;
        const letra = resolveLetra(row);
        const nro = row.afip_result_json?.numero_comprobante || row.draft_json?.numero_comprobante || null;
        const pv  = row.draft_json?.punto_venta || null;
        const nroFac = (pv && nro) ? `${pad(pv,4)}-${pad(nro,8)}` : null;

        // Plan: (columna, valor, condición de vacío). Solo estas 5 columnas (por
        // pedido): CAE, letra, N° comprobante, razón social, condición IVA. NO se
        // toca nro_factura (Pto-Nro) ni ninguna otra.
        const plan = [];
        if (cols.razon  && razon  && isEmpty(itemCols, cols.razon))  plan.push(['razon', cols.razon, razon]);
        if (cols.cond   && cond   && isEmpty(itemCols, cols.cond))   plan.push(['cond', cols.cond, cond]);
        if (cols.cae    && cae    && isEmpty(itemCols, cols.cae))    plan.push(['cae', cols.cae, String(cae)]);
        if (cols.letra  && letra  && isEmpty(itemCols, cols.letra))  plan.push(['letra', cols.letra, letra]);
        if (cols.nrocomp&& nro    && isEmpty(itemCols, cols.nrocomp))plan.push(['nro_comprobante', cols.nrocomp, String(nro).replace(/\D/g,'')]);
        if (cols.nrofac && nroFac && isEmpty(itemCols, cols.nrofac)) plan.push(['nro_factura', cols.nrofac, nroFac]);

        if (plan.length === 0) { skipped++; continue; }

        console.log(`  item ${itemId} (${row.invoice_type}) — ${plan.length} campo(s) a completar:`);
        for (const [name, colId, val] of plan) {
            console.log(`      ${name.padEnd(16)} [${colId}] ← "${val}"`);
            if (APPLY) {
                try { await writeSimple(itemId, colId, val); await sleep(350); wouldWrite++; }
                catch (e) { console.warn(`      ⚠️ falló escribir ${name}: ${e.message}`); }
            } else { wouldWrite++; }
        }
        touched++;
    }

    console.log(`\n=== Resumen ===`);
    console.log(`Items con algo para completar: ${touched}`);
    console.log(`Items ya completos (sin cambios): ${skipped}`);
    console.log(`Items NO leídos (saltados, sin escribir): ${notRead}`);
    console.log(`Escrituras ${APPLY ? 'realizadas' : 'que se harían'}: ${wouldWrite}`);
    if (!APPLY) console.log('\n→ Revisá el plan. Si está OK, re-corré con --apply.');
    await db.pool?.end?.();
    process.exit(0);
}

main().catch((e) => { console.error('Error fatal:', e); process.exit(1); });
