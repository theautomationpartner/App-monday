/**
 * ¿Adoptaríamos el CAE de la factura de otro?
 *
 *     node backend-repo/test/recovery-ajeno.test.js
 *
 * El caso que da origen a esto es real y está reproducido abajo con los números
 * exactos: el 05/08/2026 la Factura A 0007-00000177 de un cliente quedó marcada
 * como emitida con el CAE de la factura de OTRO receptor, por $1.069.942,50 en
 * lugar de $259.163,85. Su factura verdadera nunca se emitió.
 *
 * El sistema lo había detectado. Dejó escrito, textual:
 *
 *     [FASE2_MISMATCH] importe: esperado=259163.85 vs afip=1069942.5
 *     imp_total_match: false
 *
 * ...y marcó la emisión como exitosa igual. Por eso este banco de pruebas no
 * mira si el mismatch se detecta, sino si BLOQUEA.
 *
 * La otra mitad importa igual: los casos que NO tienen que bloquear. Rechazar
 * un comprobante que sí era nuestro nos hace re-emitirlo y duplicarlo en AFIP,
 * y eso se arregla con una nota de crédito. Por eso hay tantos casos de "no
 * bloquear" como de "bloquear".
 */
const { motivosDeComprobanteAjeno } = require('../src/modules/recoveryGuard');

const casos = [
    // ── Tiene que BLOQUEAR ───────────────────────────────────────────────────
    {
        nombre: 'el caso real: Factura A 177, importe y receptor de otro',
        bloquea: true,
        args: {
            recovered: { cae: '86317006468462', cbte_nro: 177, imp_total: 1069942.5, doc_nro: 30708007613 },
            expectedTotal: 259163.85,
            expectedDocNro: '20308008453',
        },
    },
    {
        nombre: 'mismo importe por casualidad, pero otro receptor',
        bloquea: true,
        args: {
            recovered: { cae: 'X', imp_total: 4522500, doc_nro: 30111111119 },
            expectedTotal: 4522500,
            expectedDocNro: 20222222229,
        },
    },
    {
        nombre: 'mismo receptor, importe distinto',
        bloquea: true,
        args: {
            recovered: { cae: 'X', imp_total: 999, doc_nro: 20308008453 },
            expectedTotal: 500,
            expectedDocNro: 20308008453,
        },
    },
    {
        nombre: 'NC que anula OTRA factura (el incidente de la NC 0007-00000002)',
        bloquea: true,
        args: {
            recovered: { cae: 'X', imp_total: 1000, doc_nro: 0, cbtes_asoc: [{ tipo: 1, pto_vta: 7, nro: 99 }] },
            expectedTotal: 1000,
            expectedCbtesAsoc: [{ tipo: 1, ptoVta: 7, nro: 2 }],
        },
    },
    {
        nombre: 'NC que anula MAS facturas de las nuestras',
        bloquea: true,
        args: {
            recovered: { cae: 'X', cbtes_asoc: [{ tipo: 1, pto_vta: 7, nro: 2 }, { tipo: 1, pto_vta: 7, nro: 3 }] },
            expectedCbtesAsoc: [{ tipo: 1, ptoVta: 7, nro: 2 }],
        },
    },

    // ── NO tiene que bloquear ────────────────────────────────────────────────
    {
        nombre: 'todo coincide — es nuestro',
        bloquea: false,
        args: {
            recovered: { cae: 'X', imp_total: 259163.85, doc_nro: 20308008453 },
            expectedTotal: 259163.85,
            expectedDocNro: '20308008453',
        },
    },
    {
        nombre: 'diferencia de 1 centavo — es redondeo, no otro comprobante',
        bloquea: false,
        args: {
            recovered: { cae: 'X', imp_total: 259163.86, doc_nro: 20308008453 },
            expectedTotal: 259163.85,
            expectedDocNro: 20308008453,
        },
    },
    {
        nombre: 'consumidor final: docNro 0 de los dos lados, no se compara',
        bloquea: false,
        args: {
            recovered: { cae: 'X', imp_total: 1000, doc_nro: 0 },
            expectedTotal: 1000,
            expectedDocNro: 0,
        },
    },
    {
        nombre: 'AFIP no devolvio importe — no se puede comparar, no se bloquea',
        bloquea: false,
        args: {
            recovered: { cae: 'X', imp_total: 0, doc_nro: 20308008453 },
            expectedTotal: 259163.85,
            expectedDocNro: 20308008453,
        },
    },
    {
        nombre: 'no tenemos draft (emision vieja sin importe guardado)',
        bloquea: false,
        args: {
            recovered: { cae: 'X', imp_total: 1069942.5, doc_nro: 30708007613 },
            expectedTotal: 0,
            expectedDocNro: null,
        },
    },
    {
        nombre: 'factura normal: AFIP no devuelve cbtes_asoc y nosotros tampoco',
        bloquea: false,
        args: {
            recovered: { cae: 'X', imp_total: 1000, doc_nro: 20308008453, cbtes_asoc: [] },
            expectedTotal: 1000,
            expectedDocNro: 20308008453,
            expectedCbtesAsoc: null,
        },
    },
    {
        nombre: 'NC contra la MISMA factura, en otro orden',
        bloquea: false,
        args: {
            recovered: { cae: 'X', cbtes_asoc: [{ tipo: 1, pto_vta: 7, nro: 3 }, { tipo: 1, pto_vta: 7, nro: 2 }] },
            expectedCbtesAsoc: [{ tipo: 1, ptoVta: 7, nro: 2 }, { tipo: 1, ptoVta: 7, nro: 3 }],
        },
    },
    {
        nombre: 'docNro como string vs number — es el mismo CUIT',
        bloquea: false,
        args: {
            recovered: { cae: 'X', doc_nro: 20308008453 },
            expectedDocNro: '20308008453',
        },
    },
    {
        nombre: 'AFIP no contesto nada',
        bloquea: false,
        args: { recovered: null, expectedTotal: 1000, expectedDocNro: 123 },
    },
];

let fallos = 0;
console.log(`\n${casos.length} situaciones de recuperación\n`);
console.log('─'.repeat(76));

for (const caso of casos) {
    const motivos = motivosDeComprobanteAjeno(caso.args);
    const bloqueo = motivos.length > 0;
    const ok = bloqueo === caso.bloquea;
    if (!ok) fallos++;
    const marca = ok ? '  ok  ' : ' FALLA';
    const esperado = caso.bloquea ? 'bloquear' : 'adoptar ';
    console.log(`${marca} │ ${esperado} │ ${caso.nombre}`);
    if (!ok) {
        console.log(`       │          │   → dio: ${bloqueo ? motivos.join(' | ') : 'sin motivos (adoptaría)'}`);
    }
}

console.log('─'.repeat(76));

// El caso real, además, tiene que decir POR QUÉ — el motivo va al mensaje de
// error, a Slack y al audit board. Un bloqueo sin motivo no se puede
// investigar seis meses después.
const real = motivosDeComprobanteAjeno(casos[0].args);
const explicaImporte  = real.some(m => m.includes('259163.85') && m.includes('1069942.5'));
const explicaReceptor = real.some(m => m.includes('20308008453') && m.includes('30708007613'));
if (!explicaImporte || !explicaReceptor) {
    fallos++;
    console.log(`\nFALLA: el motivo no dice qué no coincidió. Dio: ${JSON.stringify(real)}`);
} else {
    console.log(`\nEl caso real explica los dos motivos:`);
    for (const m of real) console.log(`   • ${m}`);
}

if (fallos > 0) {
    console.log(`\nFALLA: ${fallos} de ${casos.length + 1} comprobaciones.`);
    process.exit(1);
}
console.log(`\nOK — no adoptaríamos un CAE ajeno, y no rechazaríamos uno propio.`);
