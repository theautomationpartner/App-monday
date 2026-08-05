/**
 * Revisa TODOS los textos que le llegan al usuario, no solo los de error.
 *
 *     node backend-repo/test/textos-al-usuario.test.js
 *
 * El otro banco de pruebas (mensajes.test.js) cubre lo que pasa por
 * buildErrorComment: los errores. Pero hay tres funciones que publican en el item
 * y solo una es esa:
 *
 *     postMondayErrorComment   los errores          ← cubierto por el otro test
 *     postMondayUpdate         éxitos y avisos      ← cubierto por ESTE
 *     el cron de recuperación  cuando rescata una   ← cubierto por ESTE
 *
 * Los de éxito los ve MÁS gente y más seguido: es lo que se lee cada vez que se
 * factura bien. Y nunca se habían revisado — tenían el aviso de recuperación
 * entero sin acentos y cinco lugares en inglés diciendo "recipe", una palabra de
 * monday que el usuario no conoce.
 *
 * Esto no renderiza nada: lee el código y busca problemas en los textos. Es lo
 * único que se puede hacer con mensajes armados a mano en 7 lugares distintos.
 */
const fs = require('fs');
const path = require('path');

const ARCHIVOS = [
    'src/server.js',
    'src/modules/afipWsfex.js',
    'src/modules/afipPadron.js',
    'src/modules/afipAuth.js',
];

// Palabras que existen en castellano CON acento y aparecen seguido sin él.
// Solo se busca dentro de textos que van al usuario, no en comentarios ni logs.
const SIN_ACENTO = /\b(emision|Emision|recuperacion|Recuperacion|automatica|Automatica|recupero|numero(?!s?_)|Numero|comprobacion|informacion|configuracion|Configuracion|facturacion|Facturacion|codigo|Codigo|credito|Credito|debito|Debito|electronica|Electronica|dias|periodo|ultimo|Ultimo|mas\b)\b/;

// Jerga de monday que el usuario no conoce.
const JERGA = /\brecipe\b|\breceta\b/i;

const problemas = [];
let revisados = 0;

for (const rel of ARCHIVOS) {
    const F = path.join(__dirname, '..', rel);
    if (!fs.existsSync(F)) continue;
    const lineas = fs.readFileSync(F, 'utf8').replace(/\r\n/g, '\n').split('\n');

    for (let i = 0; i < lineas.length; i++) {
        const l = lineas[i];
        // Solo líneas que forman parte de un texto para el usuario: las que están
        // dentro de un template y llevan HTML o emoji, o las que se pasan como body.
        const esTextoUsuario = /(<br\/>|<b>|✅|⏳|⚠️|🛠|🎉|❌)/.test(l) && /[`'"]/.test(l);
        if (!esTextoUsuario) continue;
        // Descartar comentarios del código
        if (/^\s*(\/\/|\*)/.test(l)) continue;
        revisados++;

        const texto = l.replace(/<[^>]*>/g, ' ').replace(/\$\{[^}]*\}/g, ' ');
        const m1 = texto.match(SIN_ACENTO);
        if (m1) problemas.push({ rel, linea: i + 1, tipo: 'sin acento', que: m1[0], l: l.trim().slice(0, 88) });
        const m2 = texto.match(JERGA);
        if (m2) problemas.push({ rel, linea: i + 1, tipo: 'jerga de monday', que: m2[0], l: l.trim().slice(0, 88) });
    }
}

console.log(`\n${revisados} líneas de texto al usuario revisadas\n`);
console.log('─'.repeat(76));
console.log(`  sin acento donde corresponde ... ${problemas.filter(p => p.tipo === 'sin acento').length}`);
console.log(`  con jerga de monday ............ ${problemas.filter(p => p.tipo === 'jerga de monday').length}`);
console.log('─'.repeat(76));

if (problemas.length) {
    console.log('');
    for (const p of problemas) {
        console.log(`  ${p.rel}:${p.linea}  [${p.tipo}: «${p.que}»]`);
        console.log(`     ${p.l}`);
    }
    console.log(`\nFALLA: ${problemas.length} problema(s) en textos que ve el usuario.`);
    process.exit(1);
}
console.log('\nOK — ningún texto al usuario tiene jerga ni le faltan acentos.');
