/**
 * Banco de pruebas de los mensajes de error.
 *
 *     node backend-repo/test/mensajes.test.js
 *
 * Corre TODOS los errores que la app puede tirar contra buildErrorComment y avisa
 * si alguno cambió de mensaje, si alguno quedó sin regla, o si alguno le echa la
 * culpa a AFIP cuando no corresponde.
 *
 * Tarda menos de un segundo. No necesita monday, ni AFIP, ni base de datos: la
 * función es texto-entra / texto-sale. Antes de que existiera este archivo, probar
 * un solo mensaje costaba 12 segundos (crear un item en monday, disparar la receta,
 * esperar el comentario), así que en la práctica no se probaba nunca.
 *
 * CUÁNDO CORRERLO: cada vez que toques KNOWN_ERRORS o un `throw new Error()` que
 * le llegue al usuario. Si cambiaste un mensaje a propósito, actualizá el corpus:
 *
 *     node backend-repo/test/mensajes.test.js --actualizar
 */
const fs = require('fs');
const path = require('path');
const { buildErrorComment } = require('../src/modules/errorMessages');

const CORPUS = path.join(__dirname, 'errores-corpus.json');
const actualizar = process.argv.includes('--actualizar');

// El texto genérico: lo que se muestra cuando NINGUNA regla matcheó. Cada error
// que cae acá es un usuario leyendo "revisá los datos" sin saber cuáles.
const GENERICO = /Revisá los datos del item y reintentá|Review the item data and retry/;
const CULPA_AFIP = /AFIP no está respondiendo correctamente/;

// Errores que SÍ son caídas de infraestructura: acá "AFIP no responde" es correcto.
const INFRA_LEGITIMA = /^WSAA|^Error autenticando en WSAA|^WSFE \w+ falló tras|^\[wsfex:|HTTP\s+5\d\d|loginCms|FEDummy|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|timeout tras|SOAP fault/i;

const causaDe = (html) => {
    const m = html.match(/Causa:<\/b>\s*([^<]*)/) || html.match(/Cause:<\/b>\s*([^<]*)/);
    if (m) return m[1].trim();
    const b = html.match(/<b>([^<]*)<\/b>/);
    return b ? b[1].trim() : '';
};

const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const t0 = Date.now();

let regresiones = 0, sinRegla = 0, culpaMal = 0;
const detalleRegresion = [], detalleSinRegla = [], detalleCulpaMal = [];

for (const c of corpus) {
    const msg = c.mensaje.replace(/…/g, '12345');
    const html = buildErrorComment(new Error(msg), 'Factura', 'es');
    const causa = causaDe(html);

    if (actualizar) { c.esperado = causa; continue; }

    if (causa !== c.esperado) {
        regresiones++;
        detalleRegresion.push({ origen: c.origen, antes: c.esperado, ahora: causa, msg });
    }
    if (GENERICO.test(html)) {
        sinRegla++;
        detalleSinRegla.push({ origen: c.origen, msg: msg.slice(0, 74) });
    }
    if (CULPA_AFIP.test(html) && !INFRA_LEGITIMA.test(msg)) {
        culpaMal++;
        detalleCulpaMal.push({ origen: c.origen, msg: msg.slice(0, 74) });
    }
}

if (actualizar) {
    fs.writeFileSync(CORPUS, JSON.stringify(corpus, null, 1));
    console.log(`corpus actualizado: ${corpus.length} errores`);
    process.exit(0);
}

const ms = Date.now() - t0;
console.log(`\n${corpus.length} errores probados en ${ms}ms\n`);

if (detalleRegresion.length) {
    console.log('─'.repeat(76));
    console.log(`CAMBIARON DE MENSAJE (${detalleRegresion.length})`);
    console.log('  Si fue a propósito, corré con --actualizar. Si no, es una regresión.');
    console.log('─'.repeat(76));
    for (const d of detalleRegresion) {
        console.log(`\n  ${d.origen}`);
        console.log(`     "${d.msg.slice(0, 68)}"`);
        console.log(`     antes: ${d.antes}`);
        console.log(`     ahora: ${d.ahora}`);
    }
    console.log('');
}

console.log('─'.repeat(76));
console.log('COBERTURA');
console.log('─'.repeat(76));
console.log(`  con mensaje propio ......... ${corpus.length - sinRegla} de ${corpus.length}`);
console.log(`  caen al genérico ........... ${sinRegla}`);
console.log(`  culpan a AFIP sin motivo ... ${culpaMal}`);

if (detalleSinRegla.length) {
    console.log('\n  LOS QUE CAEN AL GENÉRICO (el usuario lee "revisá los datos" sin saber cuáles):');
    detalleSinRegla.slice(0, 40).forEach(d => console.log(`     ${d.origen.padEnd(34)} "${d.msg}"`));
    if (detalleSinRegla.length > 40) console.log(`     ... y ${detalleSinRegla.length - 40} más`);
}
if (detalleCulpaMal.length) {
    console.log('\n  LOS QUE CULPAN A AFIP SIN MOTIVO:');
    detalleCulpaMal.forEach(d => console.log(`     ${d.origen.padEnd(34)} "${d.msg}"`));
}

console.log('');
if (regresiones > 0) {
    console.log(`FALLA: ${regresiones} mensaje(s) cambiaron sin querer.`);
    process.exit(1);
}
if (culpaMal > 0) {
    console.log(`FALLA: ${culpaMal} error(es) le echan la culpa a AFIP y no corresponde.`);
    process.exit(1);
}
console.log('OK — ningún mensaje cambió y ninguno culpa a AFIP de más.');
