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
// OJO con el \b: en JavaScript NO funciona después de una vocal acentuada, porque
// \w es solo [A-Za-z0-9_] y la í queda afuera. Con /\bSubí\b/ este chequeo no
// matcheaba NUNCA — y por eso dejó pasar que un tablero en inglés recibiera todo
// el mensaje en español. Es la misma trampa que está documentada en el módulo, y
// la pisé igual acá. Se usa (?=\s) o (?=[\s,.:]).
const NUESTRO_EN_ESPANOL = /(^|[\s>])(Abr[ií]|Revis[aá]|Complet[aá]|Correg[ií]|Volv[eé]|Cambi[aá]|Fijate|Escribinos|Pon[eé]|Sub[ií]|Dej[aá]|Carg[aá]|Asegurate|Tenés que|No toques|No se emitió|Sacá)(l[oa]s?|le)?(?=[\s,.:])/;

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
    // El extractor no llegó a aplanar la concatenación del template y dejó el
    // código JS crudo en el texto. En la app real el mensaje son los bullets.
    [/^Can't issue the Export Invoice:/, "Can't issue the Export Invoice:\n• Destination Country is empty"],
    [/^No se puede emitir la Factura E:/, 'No se puede emitir la Factura E:\n• Falta el País de Destino'],
];
const rellenar = (texto) => {
    for (const [re, real] of REALISTA) if (re.test(texto)) return real;
    return texto.replace(/…/g, '12345');
};

// Lo que identifica al mensaje, para congelarlo y detectar cambios.
// En la forma vieja es la línea de "Causa:"; en la nueva, la acción del encabezado.
// OJO: la acción suele llevar un <b> anidado ("→ <b>Datos Fiscales</b>"), así que
// buscar `<b>([^<]*)</b>` devolvía "Datos Fiscales" — el texto de adentro, no el
// del encabezado. Con eso dos mensajes distintos congelaban igual y el test dejaba
// de ver los cambios. Se corta en el primer <br/>, que es donde termina el título.
const causaDe = (html) => {
    const m = html.match(/Causa:<\/b>\s*([^<]*)/) || html.match(/Cause:<\/b>\s*([^<]*)/);
    if (m) return m[1].trim();
    return html.split('<br/>')[0].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
};

const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const t0 = Date.now();

let regresiones = 0, sinRegla = 0, culpaMal = 0, sinReglaEn = 0, espanolEnIngles = 0, huecos = 0, datoPerdido = 0;
const detalleHuecos = [];
const detalleDato = [];

// Los datos que el handler pasa cuando pudo leer el tablero. Los nombres van a
// propósito DISTINTOS de los de la plantilla: si el código asumiera el nombre por
// defecto en vez de usar el real del cliente, acá se vería.
const META_COMPLETA = {
    columna_estado: 'Estado del Comprobante',
    estado_disparo: 'Crear Comprobante',
    columna_cuit: 'CUIT / DNI Receptor',
};
const detalleRegresion = [], detalleSinRegla = [], detalleCulpaMal = [];
const detalleSinReglaEn = [], detalleEspanol = [];

for (const c of corpus) {
    const msg = rellenar(c.mensaje);
    // Cada entrada se rinde en SU idioma. Las marcadas 'en' son el texto que el
    // código tira de verdad en un tablero en inglés — no la traducción del
    // español. Es la diferencia entre medir la app y medir una hipótesis.
    const idioma = c.idioma || 'es';
    const html = buildErrorComment(new Error(msg), 'Factura', idioma);
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

    // ¿Sobrevive el dato que trae el error?
    //
    // Muchos mensajes mandan a mirar algo concreto: "corregí lo que menciona AFIP
    // acá abajo", "el saldo disponible está más abajo". Si ese dato no se muestra,
    // la instrucción apunta al vacío y la persona lo lee tres veces buscándolo.
    // Pasó de verdad: al pasar 31 reglas a la forma nueva, 11 se comieron el texto
    // del error y este test no lo veía, porque solo miraba la línea de identidad.
    // Se detecta metiendo una marca en el mensaje y viendo si sale del otro lado.
    // Solo se exige cuando el mensaje PROMETE mostrar algo. Los errores de sistema
    // esconden el detalle técnico a propósito ("es un problema nuestro, no toques
    // nada"): ahí mostrar "Cannot read properties of null" sería justo lo contrario
    // de lo que queremos. La regla es simple: si lo prometés, mostralo.
    const PROMETE = /ac[aá] abajo|m[aá]s abajo|menciona AFIP|dijo AFIP|marcado con ❌|mentions below|marked with ❌|said:|dijo el sistema/i;
    if (!c.mensaje.includes('…')) {
        const conMarca = msg.replace(/(\w{6,})/, 'ZQMARCA$1');
        if (conMarca !== msg) {
            const h = buildErrorComment(new Error(conMarca), 'Factura', idioma, META_COMPLETA);
            if (PROMETE.test(h) && !h.includes('ZQMARCA')) {
                datoPerdido++;
                detalleDato.push({ origen: c.origen, causa: causaDe(h) });
            }
        }
    }

    // La forma nueva escribe el nombre real de la columna adentro de la frase. Si
    // un dato no llega, el hueco NO puede quedar a la vista: un comentario que
    // diga «poné ${columna_estado} en...» es peor que cualquier error.
    // Se prueban los dos extremos — con todos los datos y sin ninguno — porque el
    // segundo es el que ocurre cuando la config del tablero está rota, que es
    // justo cuando más se lee el comentario.
    for (const [nombre, datos] of [['con datos', META_COMPLETA], ['sin datos', {}]]) {
        const h = buildErrorComment(new Error(msg), 'Factura', idioma, datos);
        if (/\$\{/.test(h)) {
            huecos++;
            detalleHuecos.push({ origen: c.origen, nombre, trozo: (h.match(/.{0,40}\$\{\w+\}.{0,20}/) || [''])[0] });
        }
    }

    // Los mensajes en español TAMBIÉN llegan a tableros en inglés: solo 42 de los
    // ~126 throws pasan por el helper de traducción, el resto tira español sin
    // importar el idioma del board. Así que un board en inglés ve las dos cosas y
    // hay que probar las dos.
    // `tiene_traduccion` marca los throws que el código ya tira en inglés cuando el
    // board está en inglés (los que pasan por el helper L o por un ternario de
    // idioma). Para esos, renderizar el texto ESPAÑOL en un board inglés es un caso
    // que no ocurre nunca — medirlo daba 11 falsos positivos y tapaba los reales.
    const htmlEn = idioma === 'en' ? html
        : (c.tiene_traduccion ? null : buildErrorComment(new Error(msg), 'Factura', 'en'));
    if (htmlEn) {
        if (GENERICO_EN.test(htmlEn)) {
            sinReglaEn++;
            detalleSinReglaEn.push({ origen: c.origen, msg: msg.slice(0, 74) });
        }
        // Todo el mensaje MENOS lo que vino del error. El texto crudo de AFIP viene
        // en español porque AFIP contesta en español: eso no es un descuido nuestro
        // y no se puede traducir. Se filtra comparando contra el mensaje original,
        // que es la única forma confiable de separar "lo que escribimos" de "lo que
        // nos dijeron".
        const nuestro = htmlEn
            .split(/<br\/>/)
            .map(l => l.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim())
            .filter(l => l && !msg.includes(l.replace(/^❌\s*/, '').slice(0, 40)))
            .join(' | ');
        if (NUESTRO_EN_ESPANOL.test(nuestro)) {
            espanolEnIngles++;
            detalleEspanol.push({ origen: c.origen, causa: causaDe(htmlEn) });
        }
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
console.log('');
console.log(`  huecos sin rellenar a la vista ... ${huecos}`);
console.log(`  se comen el dato del error ....... ${datoPerdido}`);

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
if (detalleHuecos.length) {
    console.log('\n  MENSAJES CON UN HUECO A LA VISTA DEL USUARIO:');
    detalleHuecos.forEach(d => console.log(`     [${d.nombre}] ${d.origen.padEnd(30)} "...${d.trozo}..."`));
}
if (detalleDato.length) {
    console.log("\n  SE COMEN EL DATO QUE TRAE EL ERROR (la instrucción apunta al vacío):");
    detalleDato.slice(0, 20).forEach(d => console.log(`     ${d.origen.padEnd(30)} ${d.causa.slice(0, 62)}`));
}
if (datoPerdido > 0) {
    console.log(`FALLA: ${datoPerdido} mensaje(s) se comen el dato que trae el error.`);
    process.exit(1);
}
if (huecos > 0) {
    console.log(`FALLA: ${huecos} mensaje(s) le dejan un hueco sin rellenar a la vista del usuario.`);
    process.exit(1);
}
if (espanolEnIngles > 0) {
    console.log(`FALLA: ${espanolEnIngles} mensaje(s) le muestran texto nuestro en español a un tablero en inglés.`);
    console.log('       Agregá la entrada que falta en EN_TEXT, con el título en español como clave.');
    process.exit(1);
}
console.log('OK — ningún mensaje cambió, ninguno culpa a AFIP de más, y el inglés está al día.');
