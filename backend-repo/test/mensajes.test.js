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

// Los tableros en inglés usan las MISMAS reglas (los errores llegan en español)
// y solo cambia el texto, que sale de EN_TEXT, colgado del título en español.
// Antes de eso había una segunda lista completa que se quedó en 24 reglas contra
// 49, así que un tablero en inglés leía "AFIP is not responding" cuando lo que
// pasaba era que faltaba delegar el certificado. Estas dos comprobaciones son
// para que no vuelva a pasar en silencio:
//   1) toda regla tiene su texto inglés  → si agregás una y te olvidás, falla acá
//   2) el texto que escribimos nosotros (título y solución) no sale en español
const GENERICO_EN = /Review the item data and retry/;
const NUESTRO_EN_ESPANOL = /\b(Abrí|Revisá|Completá|Corregí|Volvé|Cambiá|Fijate|Escribinos|Poné|Subí|Dejá|Cargá|Asegurate)\b/;

// Errores que SÍ son caídas de infraestructura: acá "AFIP no responde" es correcto.
// Incluye los nombres de los métodos SOAP de AFIP (FECompUltimoAutorizado y
// compañía): cuando fallan, el mensaje arranca con el nombre del método. Revisé los
// 8 uno por uno el 2026-08-05 — son HTTP 5xx o errores que devuelve AFIP, ninguno
// depende de un dato que haya cargado el usuario.
const INFRA_LEGITIMA = /^WSAA|^Error autenticando en WSAA|^WSFE \w+ falló tras|^\[wsfex:|^(FECompUltimoAutorizado|FECompConsultar|FEParamGet\w+|FECAESolicitar)\b|^No se pudo obtener [uú]ltimo comprobante|^AFIP rechazo cotizacion|HTTP\s+5\d\d|loginCms|FEDummy|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|timeout tras|SOAP fault/i;

// Los mensajes del corpus traen "…" donde el código pone una variable. Para
// probarlos hay que rellenarlo con algo. "12345" alcanza casi siempre, pero en
// unos pocos produce un mensaje que en la vida real no existe — por ejemplo
// "AFIP rechazó la factura: 12345", cuando AFIP siempre manda el código entre
// corchetes. Ahí se usa un ejemplo de verdad, si no el test mide una ficción.
const REALISTA = [
    [/^AFIP rechaz[oó] la factura: …$/, 'AFIP rechazó la factura: [10016] El numero o fecha del comprobante no se corresponde con el siguiente a registrar'],
];
const rellenar = (texto) => {
    for (const [re, real] of REALISTA) if (re.test(texto)) return real;
    return texto.replace(/…/g, '12345');
};

const causaDe = (html) => {
    const m = html.match(/Causa:<\/b>\s*([^<]*)/) || html.match(/Cause:<\/b>\s*([^<]*)/);
    if (m) return m[1].trim();
    const b = html.match(/<b>([^<]*)<\/b>/);
    return b ? b[1].trim() : '';
};

const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const t0 = Date.now();

let regresiones = 0, sinRegla = 0, culpaMal = 0, sinReglaEn = 0, espanolEnIngles = 0;
const detalleRegresion = [], detalleSinRegla = [], detalleCulpaMal = [];
const detalleSinReglaEn = [], detalleEspanol = [];

for (const c of corpus) {
    const msg = rellenar(c.mensaje);
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

    // El mismo error, pero pedido como lo pediría un tablero en inglés.
    const htmlEn = buildErrorComment(new Error(msg), 'Factura', 'en');
    if (GENERICO_EN.test(htmlEn)) {
        sinReglaEn++;
        detalleSinReglaEn.push({ origen: c.origen, msg: msg.slice(0, 74) });
    }
    // Solo se mira lo que escribimos nosotros: el encabezado y el bloque de la
    // solución. El detalle puede traer el texto crudo de AFIP, que viene en
    // español porque AFIP contesta en español — eso no es un error nuestro.
    const nuestro = (htmlEn.match(/<b>❌[^<]*<\/b>/) || [''])[0] +
        ' ' + (htmlEn.split(/<b>How to fix it:<\/b>/)[1] || '');
    if (NUESTRO_EN_ESPANOL.test(nuestro)) {
        espanolEnIngles++;
        detalleEspanol.push({ origen: c.origen, causa: causaDe(htmlEn) });
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
console.log('');
console.log('  en un tablero en INGLÉS:');
console.log(`    con mensaje propio ....... ${corpus.length - sinReglaEn} de ${corpus.length}`);
console.log(`    caen al genérico ......... ${sinReglaEn}`);
console.log(`    con español escapado ..... ${espanolEnIngles}`);

if (detalleSinRegla.length) {
    console.log('\n  LOS QUE CAEN AL GENÉRICO (el usuario lee "revisá los datos" sin saber cuáles):');
    detalleSinRegla.slice(0, 40).forEach(d => console.log(`     ${d.origen.padEnd(34)} "${d.msg}"`));
    if (detalleSinRegla.length > 40) console.log(`     ... y ${detalleSinRegla.length - 40} más`);
}
if (detalleCulpaMal.length) {
    console.log('\n  LOS QUE CULPAN A AFIP SIN MOTIVO:');
    detalleCulpaMal.forEach(d => console.log(`     ${d.origen.padEnd(34)} "${d.msg}"`));
}
if (detalleEspanol.length) {
    console.log('\n  EN INGLÉS PERO CON TEXTO NUESTRO EN ESPAÑOL (falta la entrada en EN_TEXT):');
    detalleEspanol.forEach(d => console.log(`     ${d.origen.padEnd(34)} ${d.causa}`));
}
if (detalleSinReglaEn.length) {
    console.log('\n  AL GENÉRICO SOLO EN INGLÉS:');
    detalleSinReglaEn.slice(0, 20).forEach(d => console.log(`     ${d.origen.padEnd(34)} "${d.msg}"`));
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
if (espanolEnIngles > 0) {
    console.log(`FALLA: ${espanolEnIngles} mensaje(s) le muestran texto nuestro en español a un tablero en inglés.`);
    console.log('       Agregá la entrada que falta en EN_TEXT, con el título en español como clave.');
    process.exit(1);
}
console.log('OK — ningún mensaje cambió, ninguno culpa a AFIP de más, y el inglés está al día.');
