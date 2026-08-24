/**
 * ¿Sumamos bien una nota en pesos contra una factura en dólares?
 *
 *     node backend-repo/test/moneda-conversion.test.js
 *
 * AFIP permite emitir una Nota de Crédito en PESOS aunque la factura sea en
 * dólares — es como se documenta una diferencia de tipo de cambio. Confirmado
 * el 20/08/2026: TAP SA emitió una NC A en pesos contra la Factura A
 * 0001-00000019 (USD 907,50) y AFIP le dio el CAE 86349121352630.
 *
 * El control de saldo tiene que sumar esas notas entre sí para no acreditar más
 * de lo facturado. Y para sumarlas hay que llevarlas todas a una misma moneda.
 *
 * El bug que este test congela ya se cometió una vez, en el circuito de
 * exportación: convertir la nota en pesos usando la cotización DE LA NOTA. Una
 * nota en pesos tiene cotización 1 (pesos a pesos), así que dividir por ella no
 * convierte nada — hacía leer ARS 8.976 como USD 8.976, casi mil veces menos
 * saldo consumido del que correspondía. La conversión va con la cotización de
 * la FACTURA, que es a la que se valuó lo que se está acreditando.
 *
 * Los casos de abajo con cotización 0 / null / basura importan tanto como los
 * de arriba: una división por cero acá se llevaría puesto el control de saldo.
 */
const { convertirAMonedaFactura } = require('../src/modules/invoiceRules');

const casos = [
    // ── Misma moneda: no se toca nada ───────────────────────────────────────
    ['nota PES sobre factura PES',
        { importe: 1000, monedaNota: 'PES', ctzNota: 1, monedaFactura: 'PES', ctzFactura: 1 }, 1000],
    ['nota DOL sobre factura DOL (ignora las cotizaciones)',
        { importe: 100, monedaNota: 'DOL', ctzNota: 1300, monedaFactura: 'DOL', ctzFactura: 1550 }, 100],

    // ── El caso real: diferencia de cambio ──────────────────────────────────
    ['nota PES sobre factura DOL — el caso de TAP SA del 20/08/2026',
        { importe: 27225, monedaNota: 'PES', ctzNota: 1, monedaFactura: 'DOL', ctzFactura: 1550 }, 27225 / 1550],
    ['la nota en PES NO se convierte con SU cotización (el bug de ARS leído como USD)',
        { importe: 8976, monedaNota: 'PES', ctzNota: 1, monedaFactura: 'DOL', ctzFactura: 1000 }, 8.976],

    // ── El inverso ──────────────────────────────────────────────────────────
    ['nota DOL sobre factura PES — acá sí manda la cotización de la nota',
        { importe: 100, monedaNota: 'DOL', ctzNota: 1300, monedaFactura: 'PES', ctzFactura: 1 }, 130000],

    // ── Bordes: nada de esto puede romper el control de saldo ───────────────
    ['cotización de la factura en 0 — no divide por cero',
        { importe: 1000, monedaNota: 'PES', ctzNota: 1, monedaFactura: 'DOL', ctzFactura: 0 }, 1000],
    ['cotización de la factura null (facturas viejas, antes de la migración USD)',
        { importe: 1000, monedaNota: 'PES', ctzNota: 1, monedaFactura: 'DOL', ctzFactura: null }, 1000],
    ['cotización de la nota null en el caso inverso',
        { importe: 100, monedaNota: 'DOL', ctzNota: null, monedaFactura: 'PES', ctzFactura: 1 }, 100],
    ['importe no numérico → 0, no NaN',
        { importe: 'abc', monedaNota: 'PES', ctzNota: 1, monedaFactura: 'PES', ctzFactura: 1 }, 0],
    ['importe undefined → 0',
        { importe: undefined, monedaNota: 'DOL', ctzNota: 1, monedaFactura: 'DOL', ctzFactura: 1 }, 0],

    // ── Normalización ───────────────────────────────────────────────────────
    ['minúsculas',
        { importe: 100, monedaNota: 'dol', ctzNota: 1300, monedaFactura: 'pes', ctzFactura: 1 }, 130000],
    ['moneda de la factura ausente → se asume PES',
        { importe: 100, monedaNota: 'PES', ctzNota: 1, monedaFactura: undefined, ctzFactura: 1 }, 100],
    ['nota SIN moneda (draft viejo) sobre factura DOL → hereda, NO convierte',
        { importe: 100, monedaNota: null, ctzNota: null, monedaFactura: 'DOL', ctzFactura: 1550 }, 100],
    ['nota SIN moneda sobre factura PES',
        { importe: 100, monedaNota: '', ctzNota: 1, monedaFactura: 'PES', ctzFactura: 1 }, 100],
];

let fallos = 0;
console.log(`\n${casos.length} conversiones`);
console.log('─'.repeat(78));
for (const [desc, args, esperado] of casos) {
    const got = convertirAMonedaFactura(args);
    const ok = Number.isFinite(got) && Math.abs(got - esperado) < 0.000001;
    if (!ok) {
        fallos++;
        console.log(`  FALLA │ ${desc}`);
        console.log(`        │ esperaba ${esperado}, dio ${got}`);
    } else {
        console.log(`  ok    │ ${desc}`);
    }
}
console.log('─'.repeat(78));

// El saldo se calcula sumando notas previas: una sola que dé NaN envenena el
// total y a partir de ahí ninguna comparación tiene sentido.
const total = casos.reduce((acc, [, args]) => acc + convertirAMonedaFactura(args), 0);
if (!Number.isFinite(total)) {
    fallos++;
    console.log('\nFALLA: la suma acumulada dio NaN — el control de saldo quedaría roto.');
}

if (fallos > 0) {
    console.log(`\nFALLA: ${fallos} comprobación(es).`);
    process.exit(1);
}
console.log('\nOK — una nota en pesos se mide contra la cotización de la factura, y ningún borde rompe la suma.');
