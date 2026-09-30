/**
 * datosArca.js — Receta "Completar datos de ARCA".
 *
 * El usuario escribe un CUIT o DNI en una columna y la receta le completa, en las
 * columnas que eligió al armarla, la razón social y la condición frente al IVA que
 * figuran en el padrón de ARCA. Sin vista de mapeo: las columnas vienen en la
 * propia frase de la receta.
 *
 * Acá vive solo lo que no necesita red (qué documento se escribió, qué valor va en
 * cada columna, qué mensaje se le muestra al usuario), para poder probarlo sin ARCA
 * ni monday: test/datos-arca.test.js. La consulta al padrón y la escritura en
 * monday están en server.js (completarDatosArcaHandler), que reusa la caché de
 * receptores de la emisión.
 */
const { cuitDvValido } = require('./documentoReceptor');
const { toTitleCase, condicionLabel } = require('./invoiceRules');
const { IVA_CONDITION } = require('../config');

// Los campos de columna de una receta llegan distinto según cómo se armó el
// campo en el Centro de Desarrollo: un string ("text_mm12"), o un objeto
// ({ columnId } / { id } / { value }). Se aceptan todos.
function leerColumnaId(v) {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
    if (typeof v === 'object') return String(v.columnId || v.id || v.value || '').trim();
    return '';
}

/**
 * Lo que el usuario escribió en la columna → documento a consultar.
 *   { doc }                    listo para consultar
 *   { vacio: true }            columna vacía (la borró): no se hace nada
 *   { error: 'forma', ... }    ni CUIT (11) ni DNI (7-8)
 *   { error: 'digito', ... }   11 dígitos con el verificador mal: CUIT mal escrito
 */
function leerDocumento(texto) {
    const crudo = String(texto ?? '').trim();
    if (!crudo) return { vacio: true };
    const doc = crudo.replace(/\D/g, '');
    if (doc.length !== 11 && (doc.length < 7 || doc.length > 8)) {
        return { error: 'forma', crudo, digitos: doc.length };
    }
    // Sin red: si el dígito verificador no cierra, no existe. No se le pregunta a
    // ARCA (y no se gasta una consulta) por un número que ya sabemos que está mal.
    if (doc.length === 11 && cuitDvValido(doc) === false) {
        return { error: 'digito', crudo };
    }
    return { doc };
}

/**
 * Datos del padrón → qué se escribe en cada columna elegida.
 * info = lo que devuelve getOrRefreshReceptorPadron: { condicion, nombre, ... }.
 * Devuelve [{ campo, columnId, valor }] — solo lo que tiene valor y columna.
 */
function valoresParaColumnas({ info, columnas = {}, language = 'es' }) {
    const out = [];
    const nombre = String(info?.nombre || '').trim();
    // DNI sin CUIT: ARCA no tiene nombre para esa persona. La razón social se deja
    // como estaba en vez de escribir "SIN NOMBRE" o borrar lo que cargó el usuario.
    if (columnas.razonSocial && nombre && nombre !== 'SIN NOMBRE') {
        out.push({ campo: 'razonSocial', columnId: columnas.razonSocial, valor: toTitleCase(nombre) });
    }
    if (columnas.condicionIva && info?.condicion) {
        out.push({
            campo: 'condicionIva',
            columnId: columnas.condicionIva,
            valor: toTitleCase(condicionLabel(info.condicion, language)),
        });
    }
    // Domicilio fiscal, en partes: cada una a su columna, y solo si ARCA la trajo
    // (un DNI sin CUIT no tiene domicilio, y vaciar lo que cargó el usuario sería peor).
    const dom = info?.domicilioPartes || {};
    for (const [campo, valor] of [['domicilio', dom.direccion], ['localidad', dom.localidad], ['provincia', dom.provincia]]) {
        if (columnas[campo] && valor) out.push({ campo, columnId: columnas[campo], valor: toTitleCase(String(valor)) });
    }
    return out;
}

// Error del padrón (errorType que ya etiqueta afipPadron.js) → caso de mensaje.
function casoDeError(err) {
    switch (err?.errorType) {
        case 'DOC_INVALIDO':     return 'forma';
        case 'CUIT_INEXISTENTE': return 'inexistente';
        case 'CUIT_INACTIVO':    return 'inactivo';
        case 'CONSTANCIA_ERROR': return 'constancia';
        default:                 return 'arcaCaido';
    }
}

// Comentario que se deja en el ítem. Solo cuando algo NO se pudo completar: si
// salió bien, las columnas llenas son la respuesta y un comentario sería ruido.
function mensaje(caso, language = 'es', v = {}) {
    const en = language === 'en';
    const doc = v.crudo ? `"${v.crudo}"` : (en ? 'the number' : 'el número');
    const textos = {
        forma: en
            ? `⚠️ Couldn't look up ${doc} in ARCA: it has ${v.digitos} digits. Write an 11-digit CUIT or a 7 or 8-digit DNI.`
            : `⚠️ No se pudo buscar ${doc} en ARCA: tiene ${v.digitos} dígitos. Escribí un CUIT de 11 dígitos o un DNI de 7 u 8.`,
        digito: en
            ? `⚠️ The CUIT ${doc} is mistyped: its check digit doesn't match, so it can't exist. Check the number and write it again.`
            : `⚠️ El CUIT ${doc} está mal escrito: el dígito verificador no cierra, así que no puede existir. Revisá el número y escribilo de nuevo.`,
        inexistente: en
            ? `⚠️ ARCA has no taxpayer registered with ${doc}. Check the number.`
            : `⚠️ ARCA no tiene ningún contribuyente inscripto con ${doc}. Revisá el número.`,
        inactivo: en
            ? `⚠️ The CUIT ${doc} exists but is inactive in ARCA, so its details weren't loaded.`
            : `⚠️ El CUIT ${doc} existe pero figura inactivo en ARCA, así que no se cargaron sus datos.`,
        constancia: en
            ? `⚠️ ARCA doesn't show the registration details for ${doc}.${v.detalle ? ` ARCA says: "${v.detalle}"` : ''}`
            : `⚠️ ARCA no muestra la constancia de inscripción de ${doc}.${v.detalle ? ` ARCA dice: "${v.detalle}"` : ''}`,
        arcaCaido: en
            ? `⚠️ ARCA isn't responding right now, so the details for ${doc} couldn't be loaded. Write the number again in a few minutes.`
            : `⚠️ ARCA no está respondiendo, así que no se pudieron cargar los datos de ${doc}. Volvé a escribir el número en unos minutos.`,
        sinColumnas: en
            ? '⚠️ The automation has no column to fill. Edit it and choose where the business name and the VAT condition go.'
            : '⚠️ La automatización no tiene ninguna columna para completar. Editala y elegí dónde van la razón social y la condición IVA.',
        escritura: en
            ? `⚠️ ARCA returned the details but they couldn't be written in: ${v.columnas}. Use a text, status or dropdown column.`
            : `⚠️ ARCA devolvió los datos pero no se pudieron escribir en: ${v.columnas}. Usá una columna de texto, de estado o desplegable.`,
    };
    return textos[caso] || textos.arcaCaido;
}

module.exports = { leerColumnaId, leerDocumento, valoresParaColumnas, casoDeError, mensaje, IVA_CONDITION };
