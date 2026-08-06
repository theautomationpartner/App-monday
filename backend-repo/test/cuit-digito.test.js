/**
 * ¿Sabemos que un CUIT está mal escrito sin preguntarle a AFIP?
 *
 *     node backend-repo/test/cuit-digito.test.js
 *
 * El caso que da origen a esto es real. Un ítem traía el CUIT 20215005962,
 * que no existe — su dígito verificador termina en 2 y debería ser 9. El
 * padrón de AFIP no contestó, así que no supimos distinguir "CUIT mal escrito"
 * de "AFIP caído", y le dijimos al cliente lo segundo:
 *
 *     "AFIP puede estar caído o lento. Reintentá en unos minutos."
 *
 * Reintentó nueve veces en dos días. Después se fue a emitir la factura desde
 * el portal de AFIP, a mano. La perdimos.
 *
 * El dígito verificador se calcula acá, sin red. Es lo único que se puede
 * afirmar de un CUIT cuando AFIP no responde — y alcanza para este caso.
 *
 * La mitad de abajo importa más que la de arriba: rechazar un CUIT bueno
 * frenaría una factura legítima. Por eso la función devuelve `null` ("no
 * opino") en todo lo que no sea un 11 dígitos concluyente, y `null` nunca
 * rechaza nada.
 */
const { cuitDvValido } = require('../src/modules/documentoReceptor');
const { buildErrorComment } = require('../src/modules/errorMessages');

const casos = [
    // ── Mal escritos: tiene que decir false ─────────────────────────────────
    ['20215005962', false, 'el CUIT real del incidente (termina en 2, debería ser 9)'],
    ['20327446341', false, 'un dígito verificador cambiado'],
    ['30637662750', false, 'otro dígito verificador cambiado'],

    // ── Buenos: NUNCA pueden dar false ──────────────────────────────────────
    ['20327446348', true,  'CUIT real del emisor de pruebas'],
    ['30637662755', true,  'CUIT real de un cliente'],
    ['30708007613', true,  'CUIT real de un receptor (AGROLUCIA S.A.)'],
    ['30717423867', true,  'CUIT real y bien formado, aunque AFIP lo rechace por otro motivo'],
    ['20-32744634-8', true, 'con guiones, como lo puede escribir el usuario'],

    // ── No se puede opinar: tiene que decir null ────────────────────────────
    ['12345678',   null, 'un DNI no tiene dígito verificador'],
    ['1234567',    null, 'DNI de 7'],
    ['',           null, 'vacío'],
    [null,         null, 'sin dato'],
    ['123',        null, 'basura corta'],
    ['203274463480', null, '12 dígitos, no es un CUIT'],
];

let fallos = 0;
console.log(`\n${casos.length} CUITs\n` + '─'.repeat(74));

for (const [entrada, esperado, porque] of casos) {
    const dio = cuitDvValido(entrada);
    const ok = dio === esperado;
    if (!ok) fallos++;
    const etiqueta = esperado === false ? 'mal escrito' : esperado === true ? 'bien       ' : 'no opinar  ';
    console.log(`${ok ? '  ok  ' : ' FALLA'} │ ${etiqueta} │ ${String(entrada).padEnd(14)} ${porque}`);
    if (!ok) console.log(`       │             │   → devolvió ${JSON.stringify(dio)}`);
}

// Ningún CUIT bueno puede dar false. Es la mitad que importa: un false de más
// frena una factura que hoy sale bien.
const buenosRechazados = casos.filter(([e, esp]) => esp === true && cuitDvValido(e) === false);
if (buenosRechazados.length) {
    fallos++;
    console.log(`\nFALLA: rechazaría CUITs válidos: ${buenosRechazados.map(c => c[0]).join(', ')}`);
}

// El mensaje que le llega al usuario tiene que ser el nuevo, no el genérico
// ni el de "AFIP está caído".
console.log('\n' + '─'.repeat(74));
console.log('EL MENSAJE AL USUARIO');
console.log('─'.repeat(74));
const err = new Error(
    'El CUIT del receptor (doc 20215005962) está mal escrito: no pasa el dígito verificador de AFIP. ' +
    'Corregilo en la columna del item. Reintentar sin cambiarlo va a dar lo mismo.');
const limpio = (h) => String(h).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').trim();

for (const lang of ['es', 'en']) {
    const txt = limpio(buildErrorComment(err, 'Factura', lang, { columna_cuit: 'Cuit a Fact' }));
    console.log(`\n[${lang}]\n${txt}\n`);
    const problemas = [];
    if (/AFIP puede estar ca|AFIP may be down/i.test(txt)) problemas.push('le echa la culpa a AFIP');
    if (/Revisá los datos del item y reintentá|Check the item data and retry/i.test(txt)) problemas.push('cae al mensaje genérico');
    if (/\$\{/.test(txt)) problemas.push('quedó un hueco sin rellenar');
    if (!/arca@theautomationpartner\.com/.test(txt)) problemas.push('sin el mail de soporte');
    if (lang === 'en' && /Corregí|Después|dígito/.test(txt)) problemas.push('se le escapó español');
    if (problemas.length) { fallos++; console.log(`   FALLA: ${problemas.join(' | ')}`); }
    else console.log('   ok — dice que el CUIT está mal, no que AFIP se cayó.');
}

if (fallos > 0) {
    console.log(`\nFALLA: ${fallos} comprobación(es).`);
    process.exit(1);
}
console.log('\nOK — un CUIT mal escrito se detecta sin AFIP, y ninguno bueno se rechaza.');
