/**
 * Los mensajes de error que ve el usuario en el comentario del item.
 *
 * Vive aparte de server.js por una razon concreta: server.js corre app.listen()
 * al importarlo, asi que no habia forma de llamar a buildErrorComment desde un
 * test. Cada mensaje habia que probarlo creando un item en monday y disparando
 * la receta — 12 segundos por caso. Aca adentro es texto-entra/texto-sale y los
 * 126 errores se prueban de un saque en menos de un segundo.
 *
 * Extraido de server.js sin tocar una linea de logica (2026-08-05).
 *
 * COMO SE ELIGE EL MENSAJE: se recorre KNOWN_ERRORS en orden y GANA LA PRIMERA
 * regla cuyo regex matchea. Por eso el orden importa tanto como el regex: una
 * regla generica arriba de una especifica se come a la especifica.
 *
 * AL AGREGAR O TOCAR UNA REGLA, correr:  node backend-repo/test/mensajes.test.js
 */

// M5: patron unificado para detectar "ya emitido" (idempotencia AFIP / local).
// Lo usan: comprobanteHandler (factura), emitNotaHandler (NC/ND), y la entrada
// de KNOWN_ERRORS de buildErrorComment. Mantener UNA sola fuente de verdad
// — si AFIP cambia el mensaje, se actualiza acá y aplica en los 3 lugares.
const AFIP_IDEMPOTENT_ERROR_PATTERN = /idempotencia|ya\s+emitida|ya\s+completa|ya\s+se\s+emiti[oó]/i;

// Bugs o estados rotos NUESTROS: la persona del otro lado no puede hacer nada.
//
// UNA sola fuente de verdad, usada en los DOS lados de la misma promesa:
//   - buildErrorComment      → le dice al usuario "es nuestro, ya nos llegó el aviso"
//   - classifyAuditError     → es quien realmente dispara ese aviso a Slack
//
// Estaban separadas y habían derivado: 12 errores le decían al usuario que ya
// nos habíamos enterado cuando Slack no sonaba. El usuario esperaba sentado y
// nosotros ni sabíamos que existía el problema. Si agregás un error interno,
// agregalo acá y los dos lados quedan de acuerdo solos.
const INTERNAL_ERROR_PATTERN = /rowCount|no impact[oó] la fila|no se pudo serializar|RESERVA_FALLIDA|lock qued[oó]|secretos configurados|MONDAY_CLIENT_SECRET|Falta PADRON_(CRT|KEY)|no se pudo resolver boardId|La empresa no tiene CUIT configurado|Documento inv[aá]lido para consultar padr[oó]n|Tipo de (factura )?\w* ?no soportado|devolvio cotizacion invalida|respuesta sin \w+ legible|sin FEXResultAuth|RECOVERY_MISMATCH|instancia de PRUEBA \(staging\)/i;

// Crashes crudos de JavaScript. NO son throws nuestros: son bugs que revientan en
// runtime, y por eso no tienen mensaje escrito por nadie — le llega al usuario el
// texto del motor tal cual. Medido el 2026-08-05 en staging: un item de Nota de
// Crédito devolvió, en el comentario, textualmente
//
//     Causa: Cannot read properties of null (reading 'id')
//     Cómo solucionarlo: Revisá los datos del item y reintentá.
//
// Dos mentiras en tres líneas: no hay ningún dato del item que arregle eso, y
// reintentar da lo mismo. Esta clase entera se le habia escapado al banco de
// pruebas porque el corpus se armó buscando `throw new Error('texto')` — un crash
// no tiene texto que buscar.
const RUNTIME_CRASH_PATTERN = /cannot read propert|reading '|of undefined|of null|is not a function|is not defined|is not iterable|TypeError|ReferenceError|SyntaxError|RangeError|unexpected token|in JSON at position|JSON\.parse|Maximum call stack|Converting circular|Assignment to constant|Invalid array length/i;

// Infraestructura NUESTRA rota: la base de datos, el disco del servidor, la
// cadena de certificados de salida. Nada de esto lo escribimos nosotros — lo
// tiran pg, el sistema de archivos o TLS — y por eso ninguno estaba cubierto:
// los 8 caían al genérico y le decían "revisá los datos del item" a alguien
// cuyo item estaba perfecto y cuyo problema era que se nos agotó el pool.
const INFRA_NUESTRA_PATTERN = /timeout exceeded when trying to connect|deadlock detected|duplicate key value|violates .{0,20}constraint|relation .{0,40}does not exist|column .{0,30}does not exist|Connection terminated|too many clients|ENOENT|EACCES|EMFILE|ENOSPC|unable to verify the first certificate|self.signed certificate|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED/i;

// La red final: los estados rotos que sí declaramos, los crashes que no, y la
// infraestructura nuestra. Las tres cosas terminan en el mismo mensaje, porque
// para la persona del otro lado son lo mismo: algo se rompió acá y no hay nada
// que pueda hacer.
const NUESTRO_PATTERN = new RegExp(
    `${INTERNAL_ERROR_PATTERN.source}|${RUNTIME_CRASH_PATTERN.source}|${INFRA_NUESTRA_PATTERN.source}`, 'i');

/**
 * Rellena los huecos ${...} de un mensaje con los datos reales del tablero.
 *
 * La regla de oro acá es NO INVENTAR. Si no sabemos cómo se llama la columna de
 * estado en ESE tablero, decimos "la columna de estado" y no "la columna Estado":
 * el cliente pudo haberla renombrado, y mandarlo a una columna que no existe es
 * exactamente el tipo de mensaje que estuvimos sacando todo el día. El nombre
 * exacto se usa solo cuando lo leímos del tablero.
 *
 * Un hueco sin dato se borra junto con el espacio que lo precede, así no quedan
 * frases con un agujero en el medio.
 */
// Nombres genéricos para cuando NO leímos el nombre real de la columna en ese
// tablero. Decir "la columna del CUIT" siempre es cierto; decir "la columna CUIT
// Receptor" cuando el cliente la renombró manda a buscar algo que no existe.
const NOMBRE_GENERICO = {
    es: {
        columna_estado: 'la columna de estado',
        columna_cuit: 'la columna del CUIT',
        columna_pv: 'la columna del Punto de Venta',
        columna_punto_venta: 'la columna del Punto de Venta',
        columna_fecha_pago: 'la columna de Fecha de Pago',
        columna_tipo: 'la columna de Tipo de Comprobante',
        columna_letra: 'la columna de Letra',
        columna_alicuota: 'la columna de Alícuota IVA',
    },
    en: {
        columna_estado: 'the status column',
        columna_cuit: 'the CUIT column',
        columna_pv: 'the Point of Sale column',
        columna_punto_venta: 'the Point of Sale column',
        columna_fecha_pago: 'the Payment Date column',
        columna_tipo: 'the Voucher Type column',
        columna_letra: 'the Letter column',
        columna_alicuota: 'the VAT Rate column',
    },
};

function rellenarDatos(texto, meta = {}, language = 'es') {
    const isEn = language === 'en';
    const gen = NOMBRE_GENERICO[isEn ? 'en' : 'es'];

    // Las columnas se muestran en negrita SOLO cuando tenemos el nombre real.
    const valores = { ...meta };
    for (const clave of Object.keys(gen)) {
        valores[clave] = meta[clave]
            ? (isEn ? `the <b>${meta[clave]}</b> column` : `la columna <b>${meta[clave]}</b>`)
            : gen[clave];
    }
    valores.estado_disparo = meta.estado_disparo || (isEn ? 'Create Voucher' : 'Crear Comprobante');

    // Se trabaja oración por oración: si a UNA le falta un dato, se cae esa sola y
    // el resto del mensaje se entiende igual. Reemplazar el hueco por nada dejaría
    // frases mutiladas ("Revisá el CUIT  en la columna : son 11 dígitos"), que es
    // peor que no decir la frase.
    return String(texto)
        .split('\n')
        .map(parrafo => parrafo
            .split(/(?<=[.:»])\s+/)
            .filter(oracion => {
                const huecos = oracion.match(/\$\{(\w+)\}/g) || [];
                return huecos.every(h => {
                    const v = valores[h.slice(2, -1)];
                    return v !== undefined && v !== null && v !== '';
                });
            })
            .join(' '))
        .filter(p => p.trim())
        .join('<br/>')
        .replace(/\$\{(\w+)\}/g, (_, clave) => valores[clave]);
}

/**
 * Saca del propio texto del error los datos que el mensaje necesita nombrar.
 *
 * Es más confiable que pasarlos desde el handler: el mensaje ya los tiene (AFIP
 * los devolvió ahí) y no hay que plomearlos por cinco funciones para que lleguen.
 * Lo que no aparezca queda sin definir y su oración se descarta sola.
 */
function derivarDatosDelError(msg) {
    const t = String(msg || '');
    const d = {};
    const cuitRec = t.match(/\((?:doc|CUIT)\s+(\d{7,11})\)/i);
    if (cuitRec) d.doc_receptor = cuitRec[1];
    const cuitEmi = t.match(/cuit=(\d{11})/i);
    if (cuitEmi) d.cuit_emisor = cuitEmi[1];
    // El motivo que dio AFIP, sin el prefijo nuestro ni el CUIT del final.
    const motivo = t.match(/^Padr[oó]n AFIP(?: error)?:\s*([^\n(]+?)\s*(?:\(|$)/i);
    if (motivo) d.motivo_afip = motivo[1].trim();
    const pv = t.match(/^El Punto de Venta "([^"]*)"|^The Point of Sale "([^"]*)"/);
    if (pv) d.pv_raw = pv[1] || pv[2];
    return d;
}

// El pie que va en TODOS los comentarios.
//
// Antes la dirección aparecía solo en 11 de 73 mensajes: los que declaraban un
// bloque de soporte. La idea era no invitar a escribir cuando la persona podía
// resolverlo sola. Pero eso deja a alguien trabado sin saber a dónde preguntar
// justo en los casos que no previmos — y el que puede resolverlo solo, lo
// resuelve igual: la instrucción está tres renglones más arriba.
//
// Va en gris y al final, separado, para que se lea como un pie y no como
// "dejá de intentar y escribinos".
const PIE = (isEn) => '<br/><br/><span style="color:#888">' +
    (isEn ? 'Any questions, write to us at ' : 'Cualquier duda, escribinos a ') +
    '<b>arca@theautomationpartner.com</b></span>';

function buildErrorComment(err, displayKind = 'comprobante', language = 'es', meta = {}) {
    const msg = err?.message || 'Error desconocido';
    const kind = (displayKind && typeof displayKind === 'string') ? displayKind : 'comprobante';

    // Extraer detalle de subitems si viene en el mensaje (líneas con "•")
    const lines = msg.split('\n');
    const mainMsg = lines[0];
    const subitemDetails = lines.filter(l => l.startsWith('•'));

    // Lo que la app reportó como faltante de configuración, ya separado en items.
    // formatMissingConfigError los une con ' · '; acá se vuelven a partir para
    // poder mostrarlos como checklist en vez de como una frase larga.
    const faltantesConfig = /^(Configuraci[oó]n incompleta|Incomplete configuration)/.test(mainMsg)
        ? mainMsg.replace(/^.*?(?:Falta|Missing):\s*/i, '').split(' · ').map(x => x.trim()).filter(Boolean)
        : [];

    const KNOWN_ERRORS = [
        {
            // Faltan VARIAS cosas de configuración. La app ya arma la lista completa
            // ('Falta: Certificados AFIP · Mapeo visual · Columna de estado') pero se
            // perdía: ganaba la primera regla específica que matcheara y el usuario
            // veía UNA. Arreglaba esa, reintentaba, y recién ahí se enteraba de la
            // siguiente. Tres cosas faltantes eran tres viajes.
            // El '·' es el separador que usa formatMissingConfigError, así que exigirlo
            // es exigir que haya dos o más. Con una sola falta siguen ganando las
            // reglas de abajo, que dicen exactamente qué hacer con esa.
            match: /^Configuraci[oó]n incompleta\. Falta:[^\n]* · |^Incomplete configuration\. Missing:[^\n]* · /,
            title: 'Falta terminar de configurar la app',
            accion: "Abrí la app parado en este tablero y completá los pasos pendientes en <b>Mapeo Visual</b> y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            // El número sale de contar la lista, no fijo: decir "estas tres cosas"
            // cuando son dos es exactamente el tipo de detalle que hace desconfiar
            // del resto del mensaje.
            accion: `Completá ${faltantesConfig.length > 1 ? `estas ${faltantesConfig.length} cosas` : 'esto'} en la app y volvé a poner \${columna_estado} en "\${estado_disparo}".`,
            estado: faltantesConfig.map(x => `&nbsp;&nbsp;❌&nbsp;&nbsp;${x}`).join('<br/>') +
                '<br/><br/>No se emitió nada.',
            detalle: 'Están todas en la vista de la app: los datos de la empresa y el certificado en <b>Datos Fiscales</b> y <b>Certificados ARCA</b>, y las columnas en <b>Mapeo Visual</b>.',
            detail: mainMsg,
            solucion: 'Abrí la vista de la app y completá lo que falta.',
        },
        {
            // Item incompleto = validateItemDataCompleteness (o el ruteo) falló.
            // El detalle de QUÉ columnas faltan viene en los bullets del mensaje.
            match: /Item incompleto|Item incomplete/i,
            title: 'Faltan datos en el item',
            // Forma nueva (aprobada): la acción primero. Es el error más frecuente
            // que medimos — 47 veces — y el que más se beneficia de que la primera
            // línea diga qué hacer en vez de por qué falló.
            accion: 'Completá lo que está marcado con ❌ acá abajo y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: subitemDetails.length > 0
                ? subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>') +
                  '<br/><br/>No se emitió nada.'
                : 'Hay campos obligatorios sin completar en el item o en sus subitems.<br/><br/>No se emitió nada.',
            detalle: 'Si alguna de esas columnas no te aparece en el item, revisá el <b>Mapeo Visual</b> en la vista de la app.',
            detail: subitemDetails.length > 0
                ? 'Completá estas columnas (vacías o con datos inválidos) y volvé a poner el estado que dispara la emisión:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>')
                : 'Hay campos obligatorios sin completar en el item o en sus subitems.',
            solucion: 'Abrí el item, completá las columnas marcadas con ❌ y reintentá. Si una columna no aparece, revisá el <b>Mapeo Visual</b> en la vista de configuración de la app.',
        },
        {
            match: /falta.*mapeo|falta.*configurar.*mapeo|falta.*mapping/i,
            title: 'Falta configurar el mapeo de columnas',
            accion: 'Abrí la app parado en este tablero → <b>Mapeo Visual</b>, emparejá cada dato con tu columna, guardá y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada.',
            detalle: 'Si el tablero lo armaste con la plantilla de Factura ARCA, el mapeo se completa solo: entrá igual, revisá que esté todo en verde y guardá.',
            detail: 'El tablero no tiene configurado qué columna corresponde a cada campo de la factura.',
            solucion: 'Abrí la vista de la app → sección <b>Mapeo Visual</b> → seleccioná las columnas y guardá.',
        },
        {
            match: /no hay.*subitems|no hay líneas|sin.*subitems|validLines.*0|no valid lines in the subitems/i,
            title: 'Subitems incompletos o faltantes',
            accion: "Completá en cada subítem el <b>Concepto</b>, la <b>Cantidad</b> y el <b>Precio Unitario</b> y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "Si el item no tiene ningún subítem, creá al menos uno: cada subítem es una línea del comprobante.",
            detail: subitemDetails.length > 0
                ? 'Los siguientes subitems tienen campos vacíos o inválidos:<br/>' +
                  subitemDetails.map(l => l.replace('•', '').trim()).map(l => `&nbsp;&nbsp;- ${l}`).join('<br/>')
                : 'No se encontraron subitems con Concepto, Cantidad y Precio Unitario completos.',
            solucion: 'Revisá cada subitem del item y completá los campos obligatorios: <b>Concepto</b>, <b>Cantidad</b> (número) y <b>Precio Unitario</b> (número). Si no hay subitems, creá al menos uno.',
        },
        {
            // La validación de bonificación arma un bullet por subítem con problema.
            // Sin esta entrada el comentario cae al fallback, que muestra SOLO la
            // primera línea del mensaje y se come el detalle — que es justamente
            // lo único que le sirve al usuario para saber dónde tocar.
            match: /importes de bonificaci[oó]n|discount amounts/i,
            title: 'Problemas con la bonificación de los subitems',
            accion: "Corregí la bonificación de los subítems marcados y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            detalle: "La bonificación es un <b>importe</b>, no un porcentaje. Se aplica al <b>total de la línea</b> (cantidad × precio) y va en la <b>misma moneda que el precio unitario</b>. No puede ser negativa ni superar el total de la línea.",
            detail: subitemDetails.length > 0
                ? 'Revisá estos subitems:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>')
                : 'Alguno de los subitems tiene un importe de bonificación inválido.',
            solucion: 'La bonificación es un <b>importe</b> (no un porcentaje), se aplica al <b>total de la línea</b> (cantidad × precio) y va en la <b>misma moneda que el precio unitario</b>. No puede ser negativa ni superar el total de la línea.',
        },
        {
            match: /bonificaciones se comieron|discounts consumed the entire/i,
            title: 'El comprobante quedó en cero',
            accion: "Bajá los importes de bonificación para que el total quede arriba de cero y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "AFIP rechaza los comprobantes con total cero o negativo.",
            detail: mainMsg,
            solucion: 'Bajá los importes de bonificación para que el total sea mayor a cero — AFIP rechaza los comprobantes con total cero o negativo.',
        },
        // ── ORDEN IMPORTANTE ────────────────────────────────────────────────
        // Estas tres reglas se pisan: "Configuración incompleta. Falta: Certificados
        // AFIP vencidos" matchea las tres. Antes ganaba la genérica y le decía al
        // usuario "completá el Mapeo Visual" cuando su problema era el certificado
        // — una pantalla donde el certificado ni siquiera está.
        // Van de la MÁS específica a la más general: vencido → falta → genérica.
        {
            // El comodín va ACOTADO: .{0,30} no cruza de una oración a otra (y el .
            // no matchea saltos de línea). Antes era /certificados.*expirados|expir/i:
            // el "expir" suelto se robaba "el token expiró", "el CAE expiró" y "fecha
            // de expiración", y encima NO agarraba el mensaje real. Estaba al revés.
            match: /certificados?.{0,30}(vencid|expirad|expir[oó])|certificate.{0,20}expired/i,
            title: 'Se te venció el certificado de ARCA',
            accion: 'Sacá un certificado nuevo, subilo en la app → <b>Certificados ARCA</b> y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada. Hasta que lo subas, reintentar no sirve.',
            detalle: 'Es el mismo trámite de la primera vez, y el paso a paso está en esa pantalla.',
            soporte: 'Si te trabás con el trámite en ARCA,',
            detail: 'El certificado que tenés cargado ya venció, y ARCA no acepta comprobantes firmados con un certificado vencido.',
            solucion: 'Hay que sacar uno nuevo: es el mismo trámite que hiciste la primera vez, y el paso a paso está en la vista de la app → <b>Certificados ARCA</b>. Cuando lo termines de subir, volvé a poner el estado que dispara la emisión. Hasta entonces reintentar no sirve.',
        },
        {
            // Errores crudos de la libreria de criptografia cuando el .crt o la .key
            // estan danados, cruzados de distinto tramite, o pegados mal. Llegaban al
            // usuario TAL CUAL, en ingles y sin decir de que hablan:
            //     "Invalid PEM formatted message. Revisá los datos del item"
            // Medido el 2026-08-05 con un certificado invalido a proposito. El item
            // estaba perfecto; el problema era el certificado.
            // Se suman las firmas crudas de OpenSSL, que es lo que sale cuando el
            // archivo no es un PEM: subir el .csr en vez del .crt, o un .txt que el
            // Bloc de notas guardó con basura adelante.
            match: /invalid pem|pem formatted|too few bytes to parse DER|Cannot read.*ASN\.1|invalid.*private key|error de firma|PEM routines|no start line|asn1 encoding routines/i,
            title: 'El certificado de ARCA no se puede leer',
            accion: "Volvé a subir el par completo en la app → <b>Certificados ARCA</b> y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada. <b>No es un problema de los datos del item.</b>",
            detalle: "Tienen que ser los dos archivos que se generaron juntos: la clave (.key) y el certificado que te descargó ARCA (.crt). Uno de un trámite y otro de otro no funciona. Si no los encontrás, sacá un certificado nuevo y subí los dos.",
            detail: 'El archivo del certificado o el de la clave están dañados, o no son del mismo trámite. <b>No es un problema de los datos del item.</b>',
            solucion: 'Volvé a subir el par completo en la vista de la app → <b>Certificados ARCA</b>. Tienen que ser los dos archivos que se generaron juntos: la clave (.key) y el certificado que te descargó ARCA (.crt) — uno de un trámite y otro de otro no funciona. Si no los encontrás, sacá un certificado nuevo y subí los dos.',
        },
        {
            // El certificado esta cargado y AFIP lo reconoce, pero no esta delegado
            // al servicio de EXPORTACION (wsfex), que es un tramite aparte del de
            // facturacion comun. Tiene que ir ANTES de la regla del certificado: si
            // no, esa le dice "subi el certificado" y el usuario lo sube de nuevo
            // veinte veces sin que cambie nada, porque el certificado nunca fue el
            // problema.
            match: /acceso al web service de exportaci[oó]n|no est[aá] delegado a ese servicio|access to the export web service|not delegated to that service/i,
            title: 'Falta habilitar la facturación de exportación en AFIP',
            accion: 'Tenés que darle a tu certificado el permiso de exportación en AFIP. Es un trámite aparte del de facturación común, de una sola vez.',
            pasos: [
                'Entrá a afip.gob.ar con tu clave fiscal → <b>Administrador de Relaciones de Clave Fiscal</b> → Nueva Relación.',
                'En "Servicio": AFIP → WebServices → <b>"ws - Facturación Electrónica de Exportación"</b>.',
                'En "Representante" elegí el mismo certificado que ya usás para las facturas comunes.',
                'Confirmá y volvé a poner ${columna_estado} en "${estado_disparo}".',
            ],
            estado: 'No se emitió nada.',
            detalle: 'No hace falta subir el certificado de nuevo: es el mismo, le falta el permiso.',
            detail: 'AFIP reconoce tu certificado para las facturas comunes, pero la <b>exportación es un permiso aparte</b> que todavía no está dado. <b>No hace falta subir el certificado de nuevo</b>: es el mismo, le falta el permiso.',
            solucion: 'Entrá a afip.gob.ar con tu clave fiscal → <b>Administrador de Relaciones de Clave Fiscal</b> → Nueva Relación → Servicio → AFIP → WebServices → <b>"ws - Facturación Electrónica de Exportación"</b>. En "Representante" elegí el mismo certificado que ya usás para las facturas comunes. Confirmá y volvé a intentar.',
        },
        {
            // Falta la configuración de exportación en Datos Fiscales. Son tres
            // faltantes distintos (el toggle, el punto de venta de exportación y la
            // forma de pago) y los tres se arreglan en la misma pantalla, así que
            // van juntos: lo que cambia es cuál falta, y eso lo dice el propio
            // mensaje. Apareció corriendo los 35 casos — no tenía regla y lo salvaba
            // el partidor del fallback, que lo mostraba bien pero con la forma vieja.
            match: /no tiene habilitada la facturaci[oó]n de exportaci[oó]n|Falta configurar (el punto de venta|la forma de pago) de exportaci[oó]n|doesn.t have export invoicing enabled|The export (point of sale|payment method) is not configured/i,
            title: 'Falta configurar la exportación en Datos Fiscales',
            accion: 'Abrí la app → <b>Datos Fiscales</b>, completá lo de exportación y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada.',
            detalle: 'Ahí van las tres cosas que AFIP pide para las Facturas E: tildar que emitís exportación, el punto de venta de exportación (es uno propio, distinto del de mercado interno) y la forma de pago.',
            detail: mainMsg,
            solucion: 'Abrí la app → <b>Datos Fiscales</b> y completá los datos de exportación.',
        },
        {
            // Sin `falta.*crt|falta.*key`: ese comodin se comia "Falta PADRON_CRT en
            // variables de entorno", que es una env var NUESTRA que falta en el
            // servidor. Al usuario le decia que subiera su certificado — algo que no
            // podia arreglar y que ademas no era lo que estaba roto.
            match: /faltan? (los )?certificados?|falta subir el certificado|certificate not uploaded|certificados?.*afip/i,
            title: 'Falta subir el certificado de ARCA',
            accion: 'Subí el certificado (.crt) y la clave (.key) en la app → <b>Certificados ARCA</b>, y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada.',
            detalle: 'No hay ningún certificado cargado para esta empresa. El paso a paso para sacarlos está en esa misma pantalla: se hace una sola vez y dura dos años.',
            detail: 'No hay ningún certificado cargado para esta empresa, y sin él la app no se puede identificar ante ARCA.',
            solucion: 'Abrí la vista de la app → sección <b>Certificados ARCA</b> → subí el certificado (.crt) y la clave (.key). Si todavía no los sacaste, el paso a paso está en esa misma pantalla: se hace una sola vez y dura dos años.',
        },
        {
            match: /Configuración incompleta|incomplete configuration/i,
            title: 'Falta terminar de configurar la app',
            detail: mainMsg,
            solucion: 'Abrí la vista de la app → completá los pasos pendientes en <b>Mapeo Visual</b>. Asegurate de mapear todas las columnas obligatorias.',
        },
        {
            // Solo el mensaje real de resolveInvoiceType ("Tipo de factura
            // incorrecto: solicitaste X pero corresponde Y"). Antes la regex
            // tenía alternativas flojas (corresponde.*[ABC]) que con el flag /i
            // matcheaban cualquier mensaje con "corresponde" + una a/b/c suelta.
            match: /tipo de factura incorrecto/i,
            title: 'Tipo de factura incorrecto',
            accion: "Revisá la <b>Condición IVA</b> de tu empresa en la app → <b>Datos Fiscales</b>, y el CUIT del cliente en el item y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "La app le pregunta a AFIP la condición del cliente para decidir si corresponde A, B o C. Si alguno de esos dos datos está mal, sale la letra equivocada.",
            detail: mainMsg,
            solucion: 'Revisá dos cosas:<br/>&nbsp;&nbsp;1) En la app, abrí <b>Datos Fiscales</b> y confirmá que la <b>Condición IVA</b> de tu empresa esté bien cargada (Responsable Inscripto, Monotributo, etc.).<br/>&nbsp;&nbsp;2) En el item, confirmá que el <b>CUIT del receptor</b> sea correcto. La app consulta automáticamente a AFIP la condición del receptor para decidir si corresponde A, B o C.',
        },
        {
            // B2: guardia "un item = un solo comprobante" — cubre las 3 variantes
            // que dispara la guardia cross-tipo (factura sobre item con NC/ND
            // y viceversa): "ya emitió", "está emitiendo" (concurrente), y
            // "tiene una ... con número reservado en AFIP pero sin confirmar".
            // Antes esta regla juntaba TRES situaciones con acciones opuestas: el
            // item que ya emitió (crear uno nuevo), el que está emitiendo ahora
            // mismo (esperar y no tocar nada) y el que tiene un número reservado sin
            // confirmar (esperar la reconciliación). Decirle "creá un item nuevo" a
            // los dos últimos es la peor respuesta posible: sale un comprobante de
            // más. Las otras dos tienen su regla más abajo, así que ésta se queda
            // solo con la suya.
            match: /este item ya emiti[oó]|this item already issued/i,
            title: 'Este item ya tiene un comprobante',
            accion: "Creá un <b>item nuevo</b> en el tablero y poné ${columna_estado} en \"${estado_disparo}\" ahí.",
            estado: "No se emitió otro, a propósito: cada item corresponde a un solo comprobante.",
            detalle: "Si lo que querés es la Nota de Crédito de esta factura, también va en un item nuevo: se referencia por el CAE.",
            detail: mainMsg,
            solucion: 'Cada item corresponde a <b>un solo comprobante</b>. Para emitir otro — o la Nota de Crédito de esta factura — creá un <b>item nuevo</b> en el tablero. La NC referencia la factura por su CAE.',
        },
        {
            match: /cuit.*inválido|cuit.*invalido|cuit.*vac|receptor_cuit.*null/i,
            title: 'CUIT / DNI del receptor inválido',
            accion: "Completá ${columna_cuit} con un <b>CUIT de 11 dígitos</b> o un <b>DNI de 7 u 8</b>, sin guiones ni espacios y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "Si la venta es a consumidor final sin identificar, dejá esa columna <b>vacía</b> y se emite igual.",
            detail: mainMsg,
            solucion: 'Completá la columna <b>CUIT / DNI Receptor</b> del item con un <b>CUIT de 11 dígitos</b> (ej: 20327446348) o un <b>DNI de 7 u 8</b>. Sin guiones ni espacios. Si la operación es a consumidor final sin identificar, dejá la columna <b>vacía</b>.',
        },
        {
            // Antes esta regla tapaba el mensaje real con un generico fijo — el
            // mismo problema que se arreglo en el catch de padron_emisor/receptor
            // (server.js), pero en esta capa: aunque el error ya trajera el motivo
            // puntual de AFIP (ej. "CUIT con requerimientos pendientes"), acá se
            // perdia y se mostraba siempre "puede ser caida temporal, reintenta".
            // Ahora se muestra el mensaje real (mainMsg) tal cual llego.
            // OJO con el orden: gana la PRIMERA regla que matchea. La de "ese CUIT
            // no existe" tiene que ir arriba de esta, porque su mensaje también
            // contiene "Padrón AFIP" y esta genérica se lo comería.
            match: /no existe persona con ese id|ese cuit no existe en afip/i,
            title: 'Ese CUIT no existe en AFIP',
            accion: "Revisá el CUIT del cliente en ${columna_cuit}: son 11 dígitos, sin puntos ni guiones y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "Un solo dígito cambiado alcanza para que AFIP no lo encuentre.",
            detail: mainMsg,
            solucion: 'Abrí el item y revisá el CUIT del cliente: son 11 dígitos, sin puntos ni guiones. Un solo dígito cambiado alcanza para que AFIP no lo encuentre. Corregilo y volvé a poner el estado que dispara la emisión.',
        },
        {
            match: /padrón.*error|padron.*error|padrón.*falló|padron.*fallo/i,
            title: 'Error consultando el Padrón AFIP',
            // Forma nueva (aprobada). 22 veces medido. El CUIT y el motivo salen del
            // propio mensaje (derivarDatosDelError): AFIP los manda ahí adentro.
            accion: 'Revisá el CUIT ${doc_receptor} en ${columna_cuit}: son 11 dígitos, sin puntos ni guiones. Corregilo y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada.',
            detalle: 'AFIP contestó: «${motivo_afip}». Si el número está bien escrito, lo tiene que regularizar tu cliente.\n' +
                'Si la venta es a consumidor final sin identificar, dejá ${columna_cuit} vacía y emitís igual. Ojo: sale otro comprobante y tu cliente no lo va a poder usar para descargar IVA.',
            detail: mainMsg,
            solucion: 'Si el mensaje de arriba señala un problema puntual del CUIT (inactivo, con requerimientos pendientes, etc.), lo tiene que resolver el titular de ese CUIT directamente con AFIP — reintentar no alcanza. Si no da mayor detalle, puede ser una caída temporal de AFIP: esperá unos minutos y reintentá.',
        },
        {
            match: /empresa no encontrada|no encontrada.*cuenta/i,
            title: 'Empresa no configurada',
            accion: 'Cargá tu empresa en la app → <b>Datos Fiscales</b>, subí el certificado en <b>Certificados ARCA</b>, y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada.',
            detail: 'No se encontraron los datos fiscales de la empresa emisora.',
            solucion: 'Abrí la vista de la app → sección <b>Datos Fiscales</b> → completá Razón Social, CUIT, Punto de Venta y guardá.',
        },
        {
            // Errores de red transitorios de Node (undici/fetch). "fetch failed"
            // es el mensaje crudo que tira fetch cuando el socket se cae antes de
            // recibir respuesta (ECONNRESET / ETIMEDOUT / socket hang up / EAI_AGAIN).
            // Casi siempre es un micro-corte hablando con AFIP. Va ANTES del patrón
            // genérico de AFIP para darle un mensaje propio cuando llega pelado.
            match: /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|network.*error|terminated/i,
            title: 'Falla de conexión temporal con AFIP',
            accion: 'Volvé a poner ${columna_estado} en "${estado_disparo}". Fue un corte de red, no un problema de tus datos.',
            estado: 'No se emitió nada, así que no hay riesgo de duplicado.',
            detalle: 'Si sigue fallando, esperá unos minutos y probá de nuevo.',
            detail: 'Fue un corte de red, no un problema de tus datos. El comprobante <b>no se emitió</b> (no hay duplicado).',
            solucion: 'Volvé a poner el estado que dispara la emisión. Si sigue fallando, esperá unos minutos y reintentá.',
        },
        {
            // AFIP CONTESTÓ y rechazó el comprobante de exportación por una
            // validación suya (trae código: "[wsfex:FEXAuthorize] [1550] ...").
            // Va ANTES del patrón genérico de abajo porque ese matchea /wsfe/ y
            // "[wsfex:...]" lo contiene → si no, esto sale como "AFIP no está
            // respondiendo", que es mentira y manda al usuario a esperar 30
            // minutos al pedo en vez de mirar el dato que está mal.
            // Dos formatos de rechazo de exportacion, y antes solo se cubria el primero:
            //   [wsfex:FEXAuthorize] [2053] Cotizacion informada no valida
            //   [wsfex:FEXAuthorize] AFIP rechazó el comprobante (Resultado=R, Motivos: ...)
            // El segundo no trae codigo entre corchetes, asi que caia en el comodin y
            // le decia al usuario "AFIP no esta respondiendo, espera 30 minutos" — cuando
            // AFIP habia contestado perfecto y con los motivos del rechazo.
            match: /\[wsfex:\w+\]\s*\[\d+\]|\[wsfex:\w+\]\s*AFIP rechaz[oó]/i,
            title: 'AFIP rechazó la Factura E',
            accion: "Corregí en el item el dato que menciona AFIP acá abajo y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: 'No se emitió nada: AFIP contestó y no lo aceptó, así que no hay número quemado.<br/><br/>Lo que dijo AFIP:<br/>' +
                `&nbsp;&nbsp;❌&nbsp;&nbsp;${mainMsg.replace(/^\[wsfex:\w+\]\s*/, '')}`,
            detalle: 'Suele ser el país de destino, la fecha de pago o el domicilio del cliente.',
            soporte: "Si el mensaje de AFIP no te dice nada,",
            detail: 'AFIP respondió, pero no aceptó el comprobante. <b>No se emitió</b> (no hay número quemado).<br/><br/>' +
                'Lo que dijo AFIP:<br/>' +
                `&nbsp;&nbsp;❌&nbsp;&nbsp;${mainMsg.replace(/^\[wsfex:\w+\]\s*/, '')}`,
            solucion: 'Si el mensaje menciona un dato del item (país de destino, fecha de pago, domicilio del cliente), corregilo y volvé a poner el estado que dispara la emisión. Si no le encontrás sentido, pasale este mensaje al soporte de la app.',
        },
        {
            // AFIP contesta "Computador no autorizado a acceder al servicio" cuando el
            // certificado NO está asociado al servicio de facturación en Administrador
            // de Relaciones. Es un trámite del cliente, de una sola vez, y esperar no
            // lo arregla NUNCA. Pasó 13 veces en producción cayendo en el comodín de
            // abajo, que le decía "esperá 30 minutos y reintentá".
            // VA ANTES del comodín: gana la primera regla que matchea.
            // El padrón no contestó (caída real de AFIP). Distinto del CUIT que no
            // existe, que ya tiene su propia regla arriba. Antes caía en el comodín
            // solo si el CUIT del cliente tenía un "500" adentro; si no, al texto
            // crudo. Ahora los dos casos van al mismo lugar, que es lo correcto.
            match: /^No se pudo consultar el padr[oó]n de AFIP para el (receptor|emisor) \(/i,
            title: 'AFIP no contestó sobre ese CUIT',
            // Forma nueva (aprobada). 22 veces medido.
            accion: 'Esperá unos minutos y volvé a poner ${columna_estado} en "${estado_disparo}" sin tocar nada más. AFIP no contestó.',
            estado: 'No se emitió nada.',
            detalle: 'No toques ${columna_cuit}: el dato del cliente está bien, el que no contesta es AFIP.',
            soporte: 'Si a la media hora sigue sin salir,',
            detail: 'La app le preguntó a AFIP por los datos del cliente y AFIP no respondió. <b>No es un problema del dato que cargaste</b>: el número está bien formado, el que no contesta es AFIP.',
            solucion: 'Esperá unos minutos y volvé a poner el estado que dispara la emisión, sin tocar nada del item. Si a la media hora sigue igual, avisá al soporte de la app.',
        },
        {
            match: /no autorizado a acceder al servicio|computador no autorizado/i,
            title: 'Falta habilitar la facturación en AFIP',
            // Forma nueva (aprobada). 13 veces medido, y las 13 leyendo "AFIP no está
            // respondiendo, esperá 30 minutos" cuando esperar no lo arregla nunca.
            accion: 'Tenés que darle permiso al certificado en AFIP. Es un trámite de una sola vez y esperar no lo arregla.',
            pasos: [
                'Entrá a afip.gob.ar con tu clave fiscal → <b>Administrador de Relaciones de Clave Fiscal</b> → Nueva Relación.',
                'En "Servicio" seguí este camino: AFIP → WebServices → <b>Facturación Electrónica</b>. Está escrito así, mitad en inglés, porque lo nombró AFIP.',
                'En "Representante" elegí el certificado que ya cargaste en la app.',
                'Confirmá y volvé a poner ${columna_estado} en "${estado_disparo}".',
            ],
            estado: 'No se emitió nada.',
            detalle: 'Si tu certificado no aparece en esa lista de AFIP, revisá con qué CUIT lo generaste. Tiene que ser el ${cuit_emisor}.',
            detail: 'AFIP reconoce tu certificado, pero todavía no le diste permiso para emitir comprobantes. <b>No es una caída de AFIP: esperar no lo arregla.</b> Es un trámite de una sola vez.',
            solucion: 'Entrá a afip.gob.ar con tu clave fiscal → <b>Administrador de Relaciones de Clave Fiscal</b> → Nueva Relación. En "Servicio" seguí este camino: AFIP → WebServices → <b>Facturación Electrónica</b> (está escrito así, mitad en inglés, porque es el nombre que le puso AFIP). En "Representante" elegí el certificado que ya cargaste en la app. Confirmá y volvé a poner el estado que dispara la emisión.',
        },
        {
            // AFIP [10070]: falta la alicuota IVA en algun subitem. Va antes de la
            // generica de rechazo porque la accion es concreta y esta en el item.
            match: /AFIP rechaz[oó] (la factura|el comprobante|la Nota)[^\n]*\[10070\]/i,
            title: 'Falta la alícuota IVA en algún subítem',
            accion: 'Revisá que TODOS los subítems tengan cargada ${columna_alicuota} y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada.',
            detalle: 'Alcanza con que uno solo quede vacío para que AFIP rechace el comprobante entero.',
            soporte: 'Si todos ya la tienen cargada, es un problema nuestro:',
            detail: 'AFIP no aceptó el comprobante porque el detalle de IVA venía incompleto.',
            solucion: 'Revisá que todos los subítems tengan cargada la columna de alícuota IVA.',
        },
        {
            // AFIP [10005]: el punto de venta no esta dado de alta. Es un alta que
            // hace el cliente en AFIP — reintentar no la crea nunca.
            match: /AFIP rechaz[oó] (la factura|el comprobante|la Nota)[^\n]*\[10005\]|punto de venta no se encuentra (autorizado|habilitad)/i,
            title: 'Ese punto de venta no está dado de alta en AFIP',
            accion: 'Tenés que dar de alta el punto de venta en AFIP. Es un alta que hacés vos: reintentar no la crea.',
            pasos: [
                'Entrá a afip.gob.ar con tu clave fiscal → <b>Administración de puntos de venta y domicilios</b> → A/B/M de puntos de venta → Alta.',
                'Creá el número que estás usando en el item. Te va a pedir elegir un sistema de una lista.',
                'Si sos monotributista elegí <b>"Factura Electrónica - Monotributo - Web Services"</b>. Si sos responsable inscripto, <b>"RECE - Facturación Electrónica - Web Services"</b>. Están escritos así de raro por AFIP, no por nosotros.',
                'Esperá un minuto y volvé a poner ${columna_estado} en "${estado_disparo}".',
            ],
            estado: 'No se emitió nada.',
            detalle: 'Si querías facturar desde otro punto de venta, corregí ${columna_pv} del item.',
            detail: 'AFIP no reconoce ese punto de venta para facturación electrónica.',
            solucion: 'Dalo de alta en afip.gob.ar → Administración de puntos de venta y domicilios.',
        },
        {
            // AFIP [10000]: el CUIT no esta autorizado a emitir ESA letra. Casi
            // siempre es un monotributista intentando emitir A o B.
            match: /AFIP rechaz[oó] (la factura|el comprobante|la Nota)[^\n]*\[10000\]/i,
            title: 'Tu CUIT no está autorizado a emitir ese comprobante',
            accion: 'Revisá la letra del comprobante: AFIP dice que tu CUIT no está autorizado a emitir esa.',
            pasos: [
                'Fijate qué letra tiene el item. Si sos monotributista, solo podés emitir Factura C.',
                'Para ver qué letras tenés habilitadas, entrá a afip.gob.ar → <b>Comprobantes en línea</b>.',
                'Corregí la letra y volvé a poner ${columna_estado} en "${estado_disparo}".',
            ],
            estado: 'No se emitió nada.',
            detalle: 'Reintentar sin cambiar la letra va a dar lo mismo.',
            detail: 'AFIP no tiene tu CUIT habilitado para el tipo de comprobante que se intentó emitir.',
            solucion: 'Revisá la letra del comprobante y qué tenés habilitado en afip.gob.ar → Comprobantes en línea.',
        },
        {
            // Emision EN CURSO. Separada de "ya tiene un comprobante" porque la accion
            // es la contraria: aca hay que esperar, no crear un item nuevo.
            match: /este item est[aá] emitiendo|this item is (currently )?issuing/i,
            title: 'Este item ya está emitiendo',
            accion: 'No toques nada por un minuto. Este item ya está emitiendo y el resultado va a aparecer acá solo.',
            estado: 'Si volvés a poner ${columna_estado} en "${estado_disparo}" ahora, podrían salir dos comprobantes.',
            detail: 'Hay una emisión en curso para este item.',
            solucion: 'Esperá a que termine: el resultado aparece en este mismo item.',
        },
        {
            // Numero reservado sin confirmar (timeout con AFIP). La reconciliacion
            // corre sola cada 5 minutos, asi que la accion es esperar.
            match: /n[uú]mero reservado en AFIP|number reserved at AFIP/i,
            title: 'Quedó un intento anterior sin cerrar',
            accion: 'Esperá. La app le vuelve a preguntar a AFIP sola y escribe acá qué pasó, siempre dentro de los 5 minutos.',
            estado: 'Quedó un número reservado en AFIP de un intento anterior que no llegó a confirmarse.',
            detalle: 'Recién si pasados los 5 minutos el item sigue sin comprobante, volvé a poner ${columna_estado} en "${estado_disparo}". Antes no la toques: podrían salir dos.',
            detail: 'Un intento anterior reservó el número en AFIP pero no llegó a confirmarse.',
            solucion: 'Esperá unos minutos: la app lo resuelve sola.',
        },
        {
            // Ya estaba emitida. No es una falla: el comprobante existe y esta bien.
            // La accion es NO hacer nada, que es lo contrario de lo que sugiere un error.
            match: /^(Factura|Nota de Cr[eé]dito|Nota de D[eé]bito)[^\n]* ya emitida para este item \(/i,
            title: 'Ya estaba emitida',
            accion: 'No tenés que hacer nada: ya estaba hecha.',
            estado: 'No se emitió otra, a propósito.',
            detalle: 'Para facturar otra cosa, creá un item nuevo y poné ${columna_estado} en "${estado_disparo}" ahí.',
            detail: 'El comprobante de este item ya existe.',
            solucion: 'Para emitir otro, creá un item nuevo en el tablero.',
        },
        {
            // AFIP rechazó el comprobante y dijo por qué, con un código entre corchetes.
            // Antes esto caía al fallback y mostraba el texto crudo de AFIP en mayúsculas
            // + "Revisá los datos del item", que no dice qué revisar.
            // Ojo: también va ANTES del comodín, porque el texto de AFIP suele traer
            // importes y CUITs con un "500" adentro que disparaban el /afip.*500/.
            match: /AFIP rechaz[oó] (la factura|el comprobante|la Nota).*\[\d{4,5}\]/i,
            title: 'AFIP rechazó el comprobante',
            accion: "Corregí lo que menciona AFIP acá abajo. <b>No es una caída suya: es una regla, y reintentar sin cambiar nada va a dar lo mismo.</b>",
            // El texto de AFIP va en el `estado`, no en el `detalle`, para que quede
            // pegado a la acción: si la acción dice "lo que menciona AFIP acá abajo",
            // abajo tiene que estar AFIP y no nuestra explicación.
            estado: 'No se emitió nada y no se gastó ningún número.<br/><br/>Lo que dijo AFIP:<br/>' +
                `&nbsp;&nbsp;❌&nbsp;&nbsp;${mainMsg.replace(/^AFIP rechaz[oó] [^:]*:\s*/i, '')}`,
            detalle: "Si habla del punto de venta, revisá que esté dado de alta en AFIP para facturación electrónica. Si habla del CUIT, mirá qué comprobantes tenés habilitados en afip.gob.ar → Comprobantes en línea. Si habla de IVA o de importes, revisá los subítems.",
            detail: 'AFIP contestó y no lo aceptó. <b>No se emitió nada</b> y no se gastó ningún número.<br/><br/>Lo que dijo AFIP:<br/>' +
                `&nbsp;&nbsp;❌&nbsp;&nbsp;${mainMsg.replace(/^AFIP rechaz[oó] [^:]*:\s*/i, '')}`,
            solucion: 'Esto no es una caída de AFIP: es una regla suya. Si el mensaje menciona el punto de venta, revisá que esté dado de alta en AFIP para facturación electrónica. Si menciona el CUIT, revisá qué comprobantes tenés habilitados en afip.gob.ar → Comprobantes en línea. Si menciona IVA o importes, revisá los subítems. Reintentar sin cambiar nada va a dar lo mismo.',
        },
        {
            // El pais de destino no esta en la lista de AFIP, o coincide con varios.
            // Antes decia "escribilo como lo nombra AFIP" sin decir en que columna.
            match: /pa[ií]s de destino "[^"]*" (no est[aá] en la lista|es ambiguo)|destination country "[^"]*" is (not in|ambiguous)/i,
            title: "Ese país no está en la lista de AFIP",
            accion: "En la columna <b>País de Destino</b> del item escribí el país como lo nombra AFIP, y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "AFIP tiene su propia lista de nombres y no acepta variantes. Abajo está lo que contestó — si te ofrece opciones parecidas, copiá una tal cual.",
            detail: mainMsg,
            solucion: "Escribí el país como lo nombra AFIP en la columna País de Destino.",
        },
        {
            // La moneda no esta en la lista de AFIP, o coincide con varias. Ojo que los
            // codigos de AFIP NO son los ISO — el euro no es "EUR".
            match: /moneda "[^"]*" (no est[aá] en la lista|es ambigua)|currency "[^"]*" is (not in|ambiguous)|tabla de monedas de AFIP no trae|currency table doesn.t include/i,
            title: "Esa moneda no está en la lista de AFIP",
            accion: "En la columna <b>Moneda</b> del item escribí la moneda como la publica AFIP, y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "Ojo: los códigos de AFIP <b>no son los ISO</b> — el euro no es \"EUR\". Abajo está lo que contestó AFIP; si te ofrece opciones, copiá una tal cual.",
            detail: mainMsg,
            solucion: "Escribí la moneda como la publica AFIP en la columna Moneda.",
        },
        {
            // COMODÍN, ahora acotado. La versión vieja era
            //   /wsfe|wsaa|soap|afip.*http|loginCms|afip.*500|afip.*timeout/i
            // y tenía dos defectos graves, los dos medidos:
            //   1. Los .* cruzaban oraciones enteras: "afip.*500" matcheaba el "500" que
            //      venía DENTRO de un importe ($1500) o de un CUIT (20215005962). O sea,
            //      el MISMO error caía en reglas distintas según los dígitos del cliente.
            //   2. "wsfe", "wsaa" y "soap" sueltos agarraban cualquier mensaje que los
            //      mencionara, incluidos los que ya tenían su propio mensaje bueno.
            // Ahora se exige el formato REAL con el que llegan las fallas de infra.
            // Cada alternativa exige adyacencia real, sin .* que crucen oraciones:
            //   ^WSAA HTTP nnn (service=   → el formato exacto de una falla de WSAA
            //   HTTP 5xx pegado            → un 5xx de verdad, no un "500" suelto
            //   loginCms / FEDummy         → nombres propios de AFIP, inconfundibles
            //   ETIMEDOUT y compañía       → códigos de red de Node
            //   "timeout tras Nms"         → el formato que arma afipWsfex
            // Se suman los nombres de los metodos SOAP de AFIP: cuando fallan, el
            // mensaje arranca con el nombre del metodo y no matcheaba ninguna de las
            // otras alternativas.
            match: /^WSAA\b|^Error autenticando en WSAA|^WSFE \w+ falló tras|^\[wsfex:|^(FECompUltimoAutorizado|FECompConsultar|FEParamGetCotizacion|FECAESolicitar|FEParamGet\w+)\b|^No se pudo obtener [uú]ltimo comprobante|^AFIP rechazo cotizacion|\bHTTP\s+5\d\d\b|\bloginCms\b|\bFEDummy\b|\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b|\btimeout tras \d+\s*ms\b|\bSOAP fault\b/i,
            title: 'AFIP no está respondiendo correctamente',
            accion: "Esperá unos minutos y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada. <b>No es un problema de tu configuración</b>, es del lado de AFIP.",
            detalle: "AFIP suele tener cortes breves o mantenimientos.",
            soporte: "Si a la media hora sigue igual,",
            detail: 'Los servidores de AFIP no respondieron a tiempo o devolvieron un error. <b>Esto no es un problema de tu configuración</b>, es del lado de AFIP.',
            solucion: 'Esperá unos minutos y volvé a intentarlo. AFIP suele tener cortes breves o mantenimientos. Si después de 30 minutos sigue fallando, avisá al soporte de la app.',
        },
        // ── Ultima tanda: los que quedaban sin mensaje propio ────────────────
        {
            match: /^No se pudo leer la Fecha de Pago|^La Fecha de Pago .* es anterior|^Couldn.t read the Payment Date|^The Payment Date .* is earlier/i,
            title: 'Revisá la Fecha de Pago',
            accion: 'Poné en ${columna_fecha_pago} una fecha de hoy en adelante y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada.',
            detalle: 'Ahí va la fecha en la que esperás cobrar. AFIP no acepta una Factura E con fecha de pago anterior a la de emisión.',
            detail: mainMsg,
            solucion: 'Esa columna tiene que ser de tipo Fecha y llevar una fecha de hoy en adelante: es la fecha en la que esperás cobrar, no la de la venta. AFIP la exige en toda Factura E de servicios y no acepta una fecha pasada.',
        },
        {
            match: /^La fecha de la .* es anterior a la de la factura referenciada|^The .{0,24} date .* is earlier than the referenced invoice/i,
            title: 'La nota no puede tener fecha anterior a la factura',
            accion: "Cambiá la Fecha de Emisión del item para que sea igual o posterior a la de la factura que estás anulando y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "AFIP no acepta una nota fechada antes que su factura.",
            detail: mainMsg,
            solucion: 'Cambiá la Fecha de Emisión del item para que sea igual o posterior a la de la factura que estás anulando. AFIP no acepta una nota fechada antes que su factura.',
        },
        {
            match: /^La unidad de medida ".*" no es una de las de AFIP|^The unit of measure ".*" is not one of AFIP/i,
            title: 'Esa unidad de medida no existe en AFIP',
            accion: "Poné en la unidad de medida una de las que acepta AFIP y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "Son estas: <b>unidades</b>, <b>kilogramos</b>, <b>metros</b>, <b>litros</b>, <b>horas</b>, <b>docenas</b>, <b>toneladas</b>. En las facturas A, B y C esta columna es texto libre y solo se imprime en el PDF, por eso ahí no molesta.",
            detail: mainMsg,
            solucion: 'En la Factura E la unidad tiene que ser una de la lista de AFIP: <b>unidades</b>, <b>kilogramos</b>, <b>metros</b>, <b>litros</b>, <b>horas</b>, <b>docenas</b>, <b>toneladas</b>. En las facturas A, B y C esta columna es texto libre y solo se imprime en el PDF, por eso ahí no molesta.',
        },
        {
            match: /hay que mapear la columna que tiene el CAE de la factura de exportaci[oó]n|you must map the column that holds the CAE/i,
            title: 'Falta emparejar la columna del CAE',
            accion: "Abrí la app → <b>Mapeo Visual</b> → en <b>Factura de referencia</b> elegí la columna donde ponés el CAE, guardá y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "Para anular una Factura E, la app necesita saber en qué columna está el CAE de la factura que se ajusta.",
            detail: 'Para anular una Factura E, la app necesita saber en qué columna del tablero está el CAE de la factura que se ajusta.',
            solucion: 'Abrí la vista de la app → <b>Mapeo Visual</b> → en <b>Factura de referencia</b> elegí la columna donde ponés el CAE, y guardá. Después volvé al item y poné de nuevo el estado que dispara la emisión.',
        },
        {
            match: /AFIP no tiene un "?CUIT pa[ií]s"?|AFIP has no "?country CUIT"?/i,
            title: 'AFIP no tiene CUIT para ese país',
            accion: "Completá la columna <b>ID impositivo del cliente</b> con el número fiscal que use tu cliente en su país y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "Cuando AFIP no tiene un CUIT genérico para ese destino, ese dato pasa a ser obligatorio.",
            detail: mainMsg,
            solucion: 'Completá la columna <b>ID impositivo del cliente</b> del item con el número de identificación fiscal que use tu cliente en su país. Cuando AFIP no tiene un CUIT genérico para ese destino, ese dato pasa a ser obligatorio.',
        },
        {
            match: /^Esta es la instancia de PRUEBA \(staging\)/i,
            title: 'Es un problema nuestro de configuración',
            accion: 'No vuelvas a intentarlo hasta que te confirmemos: va a dar el mismo error. Ya nos llegó el aviso y lo estamos destrabando.',
            estado: 'No se emitió nada.',
            detalle: 'La emisión entró por una copia de la app que no emite comprobantes fiscales.',
            soporte: 'Si necesitás emitir hoy,',
            detail: 'La emisión entró por una copia de la app que no emite comprobantes fiscales.',
            solucion: 'Ya nos llegó el aviso y lo destrabamos en el momento. Hasta que te confirmemos no vuelvas a intentarlo: va a dar el mismo error. Si necesitás emitir hoy, escribinos a <b>arca@theautomationpartner.com</b>.',
        },
        {
            match: /^TEST forzado: error sistema simulado/i,
            title: 'Ese nombre de item está reservado',
            accion: 'Cambiale el nombre al item y volvé a poner ${columna_estado} en "${estado_disparo}". Ese nombre lo usamos internamente para probar.',
            estado: 'No se emitió nada.',
            soporte: 'Si vos no le pusiste ese nombre, o se repite con el nombre nuevo,',
            detail: 'El item se llama igual que el nombre que usamos internamente para probar los avisos de error, así que la app cortó a propósito.',
            solucion: 'Cambiale el nombre al item por cualquier otro y volvé a poner el estado que dispara la emisión.',
        },
        {
            match: /^El Punto de Venta ".*" no es v[aá]lido|punto de venta habilitado en AFIP para web|^The Point of Sale ".*" is not valid|point-of-sale number enabled in AFIP/i,
            title: 'No pudimos leer el punto de venta',
            accion: 'En ${columna_pv} dice "${pv_raw}" y ahí va solo el número. Corregilo y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada.',
            detalle: 'Si querés seguir viendo el nombre del local en el tablero, dejá el número en esa columna y usá otra aparte para el nombre.',
            detail: mainMsg,
            solucion: 'En esa columna va solamente el número del punto de venta (1, 5, 0005). Si querés seguir viendo el nombre del local en el tablero, dejá el número ahí y usá otra columna aparte para el nombre.',
        },
        {
            // La NC/ND tiene que salir del MISMO punto de venta que la factura que
            // anula: AFIP lleva la numeracion por punto de venta.
            match: /pero esta .* anula la Factura .* que es del Punto de Venta|se emite desde el MISMO/i,
            title: 'La nota tiene que salir del mismo punto de venta que la factura',
            accion: "Cambiá el punto de venta del item para que coincida con el de la factura que estás anulando, o dejá esa columna vacía y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "Si la dejás vacía, la app usa el correcto sola. AFIP lleva la numeración por punto de venta, por eso la nota tiene que salir del mismo.",
            detail: mainMsg,
            solucion: 'Cambiá el punto de venta del item para que coincida con el de la factura que estás anulando, o dejá esa columna vacía y la app usa el correcto sola.',
        },
        {
            match: /no tiene los datos completos \(CAE|no se pudo determinar la letra de la factura original|le faltan tipo \/ punto de venta \/ n[uú]mero|is missing its type \/ point of sale \/ number/i,
            title: 'A la factura referenciada le faltan datos',
            accion: "Revisá que el CAE que pusiste sea el de una factura emitida por la app desde este mismo tablero y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "La factura que estás anulando quedó guardada sin todos los datos que AFIP pide para vincularla (CAE, número, tipo o punto de venta).",
            soporte: "Si es la correcta y aun así falla, lo tenemos que destrabar nosotros:",
            detail: 'La factura que estás anulando quedó guardada sin todos los datos que AFIP pide para vincularla (CAE, número, tipo o punto de venta).',
            solucion: 'Revisá que el CAE que pusiste sea el de una factura emitida por la app desde este mismo tablero. Si es la correcta y aun así falla, escribinos a <b>arca@theautomationpartner.com</b>: lo tenemos que destrabar nosotros.',
        },
        {
            match: /Una Nota de D[eé]bito E solo puede referenciar|no es una exportaci[oó]n de servicios|An Export Debit Note can only reference|is not a services export/i,
            title: 'Esa nota no puede referenciar ese comprobante',
            accion: "Revisá el CAE que cargaste: tiene que ser el de una Factura E de servicios y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "No sirve el de otra nota ni el de una exportación de bienes.",
            detail: mainMsg,
            solucion: 'Revisá el CAE que cargaste: tiene que ser el de una Factura E de servicios, no el de otra nota ni el de una exportación de bienes.',
        },
        {
            match: /^No se puede emitir(?: la Factura E)?[^:]*:\s*•|^Can.t issue(?: the Export Invoice)?[^:]*:\s*•/i,
            title: 'Faltan datos para este comprobante',
            accion: "Corregí en el item lo que está marcado con ❌ acá abajo y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            detail: subitemDetails.length > 0
                ? 'Completá esto y volvé a intentar:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>')
                : mainMsg,
            solucion: 'Corregí en el item lo que está marcado con ❌ y volvé a poner el estado que dispara la emisión.',
        },
        {
            match: /AFIP no devolvi[oó] CAE para/i,
            title: 'AFIP no devolvió el número del comprobante',
            accion: "Volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada: AFIP contestó, pero sin el CAE, y sin CAE no hay comprobante.",
            detalle: "Si falla tres veces seguidas, esperá 15 minutos y probá otra vez.",
            soporte: "Si a la hora sigue igual,",
            detail: 'AFIP contestó, pero sin el CAE. <b>No se emitió nada</b>: sin CAE no hay comprobante.',
            solucion: 'Volvé a poner el estado que dispara la emisión. Si falla tres veces seguidas, esperá 15 minutos y probá otra vez. Si a la hora sigue igual, escribinos a <b>arca@theautomationpartner.com</b>.',
        },
        {
            match: /^Item \d+ no encontrado en Monday|^company no encontrada|^certs AFIP faltantes/i,
            title: 'No encontramos el item o la empresa',
            accion: 'El item ya no está en el tablero. Buscalo en la papelera de monday, restauralo y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada.',
            detalle: 'Si lo moviste a otro tablero, ese tablero también tiene que estar configurado en la app.',
            detail: 'La app no pudo leer el item, o la empresa que factura no está cargada.',
            solucion: 'Fijate si el item sigue en el tablero (mirá también la papelera de monday). Si está, revisá que la empresa esté cargada en la app → <b>Datos Fiscales</b>, con su certificado en <b>Certificados ARCA</b>.',
        },
        {
            match: /^Padr[oó]n HTTP|^No se pudo consultar el padr[oó]n para el DNI/i,
            title: 'AFIP no contestó sobre ese documento',
            accion: "Esperá unos minutos y volvé a poner ${columna_estado} en \"${estado_disparo}\" sin tocar nada del item.",
            estado: "No se emitió nada. <b>No es un problema del número que cargaste.</b>",
            soporte: "Si a la media hora sigue igual,",
            detail: 'La app le preguntó a AFIP por los datos del cliente y no obtuvo respuesta. <b>No es un problema del número que cargaste.</b>',
            solucion: 'Esperá unos minutos y volvé a poner el estado que dispara la emisión, sin tocar nada del item. Si a la media hora sigue igual, escribinos.',
        },
        {
            match: /^Tipo de comprobante inv[aá]lido/i,
            title: 'No reconocemos ese tipo de comprobante',
            accion: 'En ${columna_tipo} escribí el nombre completo del comprobante y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada.',
            detalle: 'Los que aceptamos son: Factura, Nota de Crédito, Nota de Débito, Factura E, Nota de Crédito E y Nota de Débito E.\nLas abreviaturas no las tomamos: NC, ND, Fact, N/C.',
            detail: mainMsg,
            solucion: 'En la columna Tipo de Comprobante dejá exactamente uno de estos, con el nombre completo: Factura, Nota de Crédito, Nota de Débito, Factura E, Nota de Crédito E o Nota de Débito E. Las abreviaturas (NC, ND, Fact) no las tomamos.',
        },
        {
            // monday nos corto por limite de consultas. Es transitorio y se pasa solo;
            // la accion es esperar, no tocar el item.
            // Se suma "Internal server error" y compañía: son las caídas genéricas
            // de cualquier servicio externo (monday o AFIP). No dicen de quién es la
            // culpa, pero la acción es la misma —esperar y reintentar— y eso es lo
            // único que la persona necesita saber. Era el último que caía al
            // genérico y le decía "revisá los datos del item".
            match: /complexity budget|rate limit|too many requests|429|Internal server error|Bad Gateway|Gateway Time-?out|Service Unavailable/i,
            title: "monday nos frenó por exceso de consultas",
            accion: "Esperá un par de minutos y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada. <b>No es un problema de tus datos</b>: monday nos limitó la cantidad de consultas por minuto.",
            detalle: "Suele pasar cuando se disparan muchos comprobantes juntos. Se destraba solo.",
            detail: "monday limitó temporalmente las consultas de la app.",
            solucion: "Esperá unos minutos y reintentá.",
        },
        {
            // El permiso de monday se venció o se revoco. Reintentar no sirve: hay que
            // renovar el acceso reabriendo la app.
            match: /not authenticated|unauthorized|invalid token|token.{0,20}(expired|inv[aá]lid)/i,
            title: "Se venció el permiso de la app en monday",
            accion: "Abrí la vista de la app desde el tablero. Con eso se renueva el permiso solo.",
            estado: "No se emitió nada.",
            detalle: "Si después de abrirla sigue igual, desinstalá la app del tablero y volvé a instalarla desde el Marketplace de monday. No se pierde nada de lo configurado.",
            detail: "El token de acceso a monday no es válido.",
            solucion: "Abrí la vista de la app para renovar el permiso.",
        },
        {
            // monday dice que el item o la columna no existen. Casi siempre es que se
            // borro algo despues de configurar el mapeo.
            match: /ResourceNotFoundException|ColumnValueException|column does not exist|item not found/i,
            title: "monday no encuentra el item o una columna",
            accion: "Fijate si el item sigue en el tablero y si no borraste alguna columna de las que usa la app.",
            estado: "No se emitió nada.",
            detalle: "Si borraste una columna, volvé a emparejarla en la app → <b>Mapeo Visual</b>. Si el item no está, revisá la papelera de monday.",
            detail: "monday respondió que el recurso no existe.",
            solucion: "Revisá que el item y las columnas mapeadas sigan existiendo.",
        },
        {
            // AFIP contesto algo que no es una respuesta: una pagina de error, un XML
            // cortado. Es una caida suya disfrazada.
            match: /<html|Service Unavailable|Unexpected close tag|Non-whitespace before first tag|Invalid XML|mismatched tag/i,
            title: "AFIP contestó algo que no se entiende",
            accion: "Esperá unos minutos y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada. <b>No es un problema de tus datos</b>: AFIP devolvió una respuesta rota, que es lo que pasa cuando su servicio se está cayendo.",
            soporte: "Si a la media hora sigue igual,",
            detail: "AFIP devolvió una respuesta que no se pudo interpretar.",
            solucion: "Esperá unos minutos y reintentá.",
        },
        {
            // La clave privada del certificado tiene contraseña. La app no puede usarla:
            // el usuario tiene que generar una sin contraseña.
            match: /DECODER routines|bad decrypt|unsupported.{0,20}(cipher|algorithm)|passphrase|bad password read/i,
            title: "La clave del certificado tiene contraseña",
            accion: "Generá el certificado de nuevo desde la app → <b>Certificados ARCA</b>, sin ponerle contraseña a la clave.",
            estado: "No se emitió nada.",
            detalle: "La app firma sola cada comprobante, así que no puede escribir una contraseña. Si el asistente de la app te genera la solicitud, la clave sale sin contraseña y este problema no aparece.",
            detail: "La clave privada está protegida con contraseña y la app no puede usarla.",
            solucion: "Generá un certificado nuevo desde el asistente de la app.",
        },
        {
            // Bugs o estados raros NUESTROS. La persona no puede hacer nada con el
            // detalle tecnico ("rowCount=0", "no hay secretos configurados"): solo la
            // asusta. Le decimos que es nuestro y que no toque nada. El detalle va al
            // log, que es donde sirve.
            // VA DESPUES de las reglas especificas: es una red, no un atajo.
            match: NUESTRO_PATTERN,
            title: 'Es un problema nuestro',
            accion: 'No toques nada ni vuelvas a intentarlo: ya nos llegó el aviso y lo estamos viendo.',
            estado: 'No se emitió nada. No es un dato que hayas cargado mal, así que revisar el item no lo va a resolver.',
            soporte: 'Si necesitás emitir hoy,',
            detail: 'La app se trabó por algo de nuestro lado. <b>No es un dato que hayas cargado mal</b>, así que revisar el item no lo va a resolver.',
            solucion: 'No toques nada ni vuelvas a intentarlo: ya nos llegó el aviso y lo estamos viendo. Si necesitás emitir hoy, escribinos a <b>arca@theautomationpartner.com</b>.',
        },
        {
            match: /token.*monday|no hay token|sessionToken/i,
            title: 'Error de autenticación con Monday',
            accion: "Cerrá la vista de la app y volvé a abrirla.",
            estado: "No se emitió nada.",
            detalle: "Si el error sigue, desinstalá la app desde el tablero y volvé a instalarla desde el Marketplace de monday.",
            detail: 'La app no pudo acceder a los datos del tablero.',
            solucion: 'Cerrá la vista de la app y volvé a abrirla. Si el error sigue, desinstalá la app desde el tablero y volvé a instalarla desde el Marketplace de Monday.',
        },
        {
            match: /fechas de servicio obligatorias|fecha servicio desde|fecha servicio hasta|missing required service dates/i,
            title: 'Fechas de servicio obligatorias',
            accion: "Completá las columnas <b>Fecha Servicio Desde</b> y <b>Fecha Servicio Hasta</b> del item y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "Son obligatorias cuando los subítems incluyen servicios.",
            detail: mainMsg,
            solucion: 'Completá las columnas <b>Fecha Servicio Desde</b> y <b>Fecha Servicio Hasta</b> en el item. Son obligatorias cuando los subitems incluyen servicios.',
        },
        {
            match: /alícuota iva incompatible con factura c|nota de crédito c no lleva iva|vat rate incompatible with invoice c/i,
            title: 'El comprobante C no lleva IVA',
            accion: "Poné ${columna_alicuota} en <b>0</b> en todos los subítems y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "Los comprobantes C no discriminan IVA porque el emisor es Monotributista o Exento.",
            detail: mainMsg,
            solucion: 'Los comprobantes C (Factura o Nota de Crédito) no discriminan IVA porque el emisor es Monotributista o Exento. Abrí los subítems del item y poné la columna <b>Alícuota IVA %</b> en <b>0</b> en todos. Después reintentá.',
        },
        {
            match: /alícuotas? iva diferentes|alícuotas? iva faltante|alícuota iva no válida|different vat rates|missing vat rate|invalid vat rate/i,
            title: 'Alícuota IVA inválida',
            accion: "Poné la <b>misma</b> alícuota IVA en todos los subítems y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            detalle: "Los valores que acepta AFIP son 0, 2.5, 5, 10.5, 21 y 27. Un comprobante no puede mezclar alícuotas.",
            detail: subitemDetails.length > 0
                ? 'Los subitems tienen alícuotas IVA diferentes:<br/>' +
                  subitemDetails.map(l => l.replace('•', '').trim()).map(l => `&nbsp;&nbsp;- ${l}`).join('<br/>')
                : mainMsg,
            solucion: 'Todos los subitems de una factura deben tener la <b>misma alícuota IVA</b>. Revisá la columna Alícuota IVA % y asegurate de que todos los subitems tengan el mismo valor (0, 2.5, 5, 10.5, 21 o 27).',
        },
        {
            match: /tipo de comprobante no reconocido|voucher type not recognized/i,
            title: 'Tipo de Comprobante no reconocido',
            accion: 'En ${columna_tipo} poné <b>Factura</b>, <b>Nota de Crédito</b> o <b>Nota de Débito</b>, y volvé a poner ${columna_estado} en "${estado_disparo}".',
            estado: 'No se emitió nada.',
            detail: mainMsg,
            solucion: 'La columna <b>Tipo de Comprobante</b> del item tiene que decir <b>Factura</b>, <b>Nota de Crédito</b> o <b>Nota de Débito</b>. Corregí el valor y volvé a poner el estado que dispara la emisión.',
        },
        {
            // Errores de la columna del CAE de referencia (Nota de Crédito).
            match: /cae de referencia|columna del cae|no se encontró ninguna factura|reference CAE (column )?is (empty|missing)|no invoice.{0,20}found with cae/i,
            title: 'No se pudo identificar la factura a anular',
            accion: "Pegá en la columna del <b>CAE</b> el código de 14 dígitos de la factura que querés anular y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "Lo sacás del PDF de esa factura o del comentario que dejó la app cuando se emitió.",
            detail: mainMsg,
            solucion: 'En el item de la Nota de Crédito, pegá en la columna del <b>CAE</b> el código de 14 dígitos de la factura que querés anular. Lo sacás del PDF de esa factura o del comentario que dejó la app cuando se emitió.',
        },
        {
            match: /item de nota de (cr[eé]dito|d[eé]bito) no tiene sub[ií]tems|(credit|debit) note item has no subitems/i,
            title: 'La Nota de Crédito no tiene líneas para acreditar',
            accion: "Agregá como <b>subítems</b> del item lo que querés acreditar, cada línea con Concepto, Cantidad y Precio y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "La Nota de Crédito se emite por la suma de esos subítems.",
            detail: mainMsg,
            solucion: 'Agregá como <b>subítems</b> del item lo que querés acreditar — cada línea con Concepto, Cantidad y Precio. La Nota de Crédito se emite por la suma de esos subítems.',
        },
        {
            match: /supera el saldo disponible de la factura|exceeds the (invoice.{0,3}s )?available (invoice )?balance/i,
            title: 'La Nota de Crédito supera el saldo de la factura',
            accion: "Bajá los importes de los subítems para que el total no supere el saldo disponible y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "No se puede acreditar más de lo que se facturó. El saldo que te queda disponible está más abajo.",
            detail: mainMsg,
            solucion: 'No se puede acreditar más de lo que se facturó. Bajá los importes de los subítems para que el total no supere el <b>saldo disponible</b> indicado arriba.',
        },
        {
            match: /alícuota iva de la nota de crédito.*no coincide|vat rate.{0,20}doesn.t match the invoice/i,
            title: 'La alícuota IVA de la Nota de Crédito no coincide con la factura',
            accion: "Ajustá ${columna_alicuota} de los subítems para que coincida con la de la factura original y volvé a poner ${columna_estado} en \"${estado_disparo}\".",
            estado: "No se emitió nada.",
            detalle: "La Nota de Crédito se acredita con el mismo IVA que se facturó.",
            detail: mainMsg,
            solucion: 'La Nota de Crédito se acredita con el mismo IVA que se facturó. Ajustá la columna <b>Alícuota IVA %</b> de los subítems para que coincida con la de la factura original.',
        },
        {
            match: AFIP_IDEMPOTENT_ERROR_PATTERN,
            title: 'Ya se emitió un comprobante para este item',
            accion: "Creá un <b>item nuevo</b> en el tablero y poné ${columna_estado} en \"${estado_disparo}\" ahí.",
            estado: "No se emitió otro, a propósito: cada item corresponde a un solo comprobante.",
            detalle: "Es lo que evita duplicar comprobantes en AFIP.",
            detail: mainMsg,
            solucion: 'Cada item del tablero corresponde a <b>un solo comprobante</b>. ' +
                'Para emitir otro, <b>creá un item nuevo</b> en el tablero y disparálo ' +
                'desde ahí. Esto evita duplicar comprobantes en AFIP.',
        },
    ];

    // ── El texto en inglés ───────────────────────────────────────────────────
    //
    // Esto ANTES era una segunda lista completa, KNOWN_ERRORS_EN, con sus propios
    // `match` y su propio orden. La idea era que fueran espejos. No lo fueron: la
    // de arriba creció a 49 reglas y la inglesa se quedó en 24, con 13 de esos 24
    // ya divergidos en el patrón. Un tablero en inglés leía "AFIP is not responding"
    // cuando el problema era que le faltaba delegar el certificado, y el rechazo de
    // AFIP con código caía al genérico. Era el mismo bug del comodín que habíamos
    // arreglado en español, intacto del otro lado, porque nadie tenía por qué
    // acordarse de tocar los dos.
    //
    // Ahora hay UNA sola lista —la de arriba— y esto es solo el texto. El orden y
    // los `match` no pueden diferir porque ya no existen dos veces. La clave es el
    // título en español (los 49 son únicos; el test lo verifica).
    //
    // Los `match` siguen siendo los españoles a propósito: la app tira casi todos
    // los errores en español sin importar el idioma del tablero (solo 46 throws
    // usan el helper de traducción), así que lo que hay que matchear es el español.
    // Lo que cambia es lo que lee la persona.
    //
    // Si una entrada no define `detail`, se hereda el de arriba. Eso es lo correcto
    // cuando el detail es `mainMsg`: ahí va el texto crudo de AFIP, que viene en
    // español de AFIP mismo y no hay nada que traducir.
    const EN_TEXT = {
        'Faltan datos en el item': {
            accion: 'Fill in what is marked with ❌ below and set ${columna_estado} back to "${estado_disparo}".',
            // El `estado` de esta regla lleva los bullets del propio error, así que
            // se arma igual que el español pero con el cierre en inglés.
            estado: subitemDetails.length > 0
                ? subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>') +
                  '<br/><br/>Nothing was issued.'
                : 'There are required fields missing in the item or its subitems.<br/><br/>Nothing was issued.',
            detalle: 'If one of those columns doesn\'t show up on the item, check the <b>Visual Mapping</b> in the app\'s view.',
            title: 'Missing item data',
            detail: subitemDetails.length > 0
                ? 'Fill in these columns (empty or with invalid data) and try again:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>')
                : 'There are required fields missing in the item or its subitems.',
            solucion: "Open the item, fill in the columns marked with ❌ and set the status that starts the issuing again. If a column is missing, check the <b>Visual Mapping</b> in the app's configuration view.",
        },
        'Falta configurar el mapeo de columnas': {
            accion: 'Open the app from this board → <b>Visual Mapping</b>, match each field to your column, save, and set ${columna_estado} back to "${estado_disparo}".',
            estado: 'Nothing was issued.',
            detalle: 'If you built the board from the Factura ARCA template, the mapping fills itself in: open it anyway, check everything is green and save.',
            title: 'Column mapping not configured',
            detail: "The board doesn't have configured which column corresponds to each invoice field.",
            solucion: "Open the app's view → <b>Visual Mapping</b> section → select the columns and save.",
        },
        'Subitems incompletos o faltantes': {
            title: "Incomplete or missing subitems",
            accion: "Fill in the <b>Description</b>, <b>Quantity</b> and <b>Unit Price</b> on every subitem and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "If the item has no subitems at all, create at least one: each subitem is a line of the voucher.",
            title: 'Incomplete or missing subitems',
            detail: subitemDetails.length > 0
                ? 'The following subitems have empty or invalid fields:<br/>' +
                  subitemDetails.map(l => l.replace('•', '').trim()).map(l => `&nbsp;&nbsp;- ${l}`).join('<br/>')
                : 'No subitems found with Description, Quantity and Unit Price filled in.',
            solucion: 'Check each subitem and fill in the required fields: <b>Description</b>, <b>Quantity</b> (number) and <b>Unit Price</b> (number). If there are none, create at least one.',
        },
        'Problemas con la bonificación de los subitems': {
            title: "Problems with the subitem discounts",
            accion: "Fix the discount on the subitems marked below and set ${columna_estado} back to \"${estado_disparo}\".",
            detalle: "The discount is an <b>amount</b>, not a percentage. It applies to the <b>whole line</b> (quantity × price) and uses the <b>same currency as the unit price</b>. It cannot be negative or exceed the line total.",
            title: 'Problems with the subitem discounts',
            detail: subitemDetails.length > 0
                ? 'Check these subitems:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>')
                : 'One of the subitems has an invalid discount amount.',
            solucion: 'The discount is an <b>amount</b> (not a percentage), applies to the <b>whole line</b> (quantity × price) and uses the <b>same currency as the unit price</b>. It cannot be negative or exceed the line total.',
        },
        'El comprobante quedó en cero': {
            title: "The voucher total came out as zero",
            accion: "Lower the discount amounts so the total is above zero and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "AFIP rejects vouchers with a total of zero or less.",
            title: 'The voucher total came out as zero',
            solucion: 'Lower the discount amounts so the total is above zero — AFIP rejects vouchers with a total of zero or less.',
        },
        'Se te venció el certificado de ARCA': {
            accion: 'Get a new certificate, upload it in the app → <b>ARCA Certificates</b> and set ${columna_estado} back to "${estado_disparo}".',
            estado: 'Nothing was issued. Until you upload it, retrying will not help.',
            detalle: 'It is the same procedure as the first time, and the step by step is on that screen.',
            soporte: 'If you get stuck with the ARCA procedure,',
            title: 'Your ARCA certificate expired',
            detail: 'The certificate you have uploaded has expired, and ARCA does not accept vouchers signed with an expired certificate.',
            solucion: "You need to issue a new one: it's the same procedure you did the first time, and the step by step is in the app's view → <b>ARCA Certificates</b>. Once you finish uploading it, start the issuing again. Until then, retrying won't help.",
        },
        'El certificado de ARCA no se puede leer': {
            title: "The ARCA certificate can't be read",
            accion: "Upload the complete pair again in the app → <b>ARCA Certificates</b> and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued. <b>This is not a problem with the item data.</b>",
            detalle: "They have to be the two files that were generated together: the key (.key) and the certificate ARCA gave you (.crt). One from one procedure and one from another will not work. If you cannot find them, get a new certificate and upload both.",
            title: "The ARCA certificate can't be read",
            detail: 'The certificate file or the key file is damaged, or they are not from the same procedure. <b>This is not a problem with the item data.</b>',
            solucion: "Upload the complete pair again in the app's view → <b>ARCA Certificates</b>. They have to be the two files that were generated together: the key (.key) and the certificate ARCA gave you (.crt) — one from one procedure and one from another will not work. If you can't find them, issue a new certificate and upload both.",
        },
        'Falta habilitar la facturación de exportación en AFIP': {
            accion: 'You need to grant your certificate the export permission in AFIP. It is separate from the regular invoicing one, and done once.',
            pasos: [
                'Go to afip.gob.ar with your tax key → <b>Administrador de Relaciones de Clave Fiscal</b> → Nueva Relación.',
                'Under "Servicio": AFIP → WebServices → <b>"ws - Facturación Electrónica de Exportación"</b>.',
                'Under "Representante" pick the same certificate you already use for regular invoices.',
                'Confirm and set ${columna_estado} back to "${estado_disparo}".',
            ],
            estado: 'Nothing was issued.',
            detalle: 'You do not need to upload the certificate again: it is the same one, it is missing the permission.',
            title: 'Export invoicing is not enabled in AFIP yet',
            detail: 'AFIP recognises your certificate for regular invoices, but <b>export is a separate permission</b> that has not been granted yet. <b>You do not need to upload the certificate again</b>: it is the same one, it is missing the permission.',
            solucion: 'Go to afip.gob.ar with your tax key → <b>Administrador de Relaciones de Clave Fiscal</b> → Nueva Relación → Servicio → AFIP → WebServices → <b>"ws - Facturación Electrónica de Exportación"</b>. Under "Representante" pick the same certificate you already use for regular invoices. Confirm and try again.',
        },
        'Falta subir el certificado de ARCA': {
            accion: 'Upload the certificate (.crt) and the key (.key) in the app → <b>ARCA Certificates</b>, and set ${columna_estado} back to "${estado_disparo}".',
            estado: 'Nothing was issued.',
            detalle: 'There is no certificate loaded for this company. The step by step to get them is on that same screen: it is done once and lasts two years.',
            title: 'The ARCA certificate has not been uploaded',
            detail: "There is no certificate loaded for this company, and without it the app can't identify itself to ARCA.",
            solucion: "Open the app's view → <b>ARCA Certificates</b> section → upload the certificate (.crt) and the key (.key). If you haven't issued them yet, the step by step is on that same screen: it's done once and lasts two years.",
        },
        'Falta terminar de configurar la app': {
            // Esta entrada sirve a DOS reglas: la de "faltan varias cosas" (que trae
            // la lista) y la genérica de configuración incompleta. Cuando hay lista,
            // se muestra como checklist; cuando no, la instrucción sola.
            accion: faltantesConfig.length > 1
                ? `Complete these ${faltantesConfig.length} things in the app and set \${columna_estado} back to "\${estado_disparo}".`
                : 'Open the app from this board and complete the pending steps in <b>Visual Mapping</b> and set ${columna_estado} back to "${estado_disparo}".',
            estado: faltantesConfig.length > 1
                ? faltantesConfig.map(x => `&nbsp;&nbsp;❌&nbsp;&nbsp;${x}`).join('<br/>') + '<br/><br/>Nothing was issued.'
                : 'Nothing was issued.',
            detalle: 'They are all in the app view: the company details and the certificate under <b>Tax Details</b> and <b>ARCA Certificates</b>, and the columns under <b>Visual Mapping</b>.',
            title: 'The app setup is not finished',
            solucion: "Open the app's view → complete the pending steps in <b>Visual Mapping</b>. Make sure to map all required columns.",
        },
        'Tipo de factura incorrecto': {
            title: "Incorrect invoice type",
            accion: "Check your company's <b>VAT Condition</b> in the app → <b>Tax Details</b>, and the client's CUIT on the item and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "The app asks AFIP for the client's condition to decide whether A, B or C applies. If either of those two is wrong, the wrong letter comes out.",
            title: 'Incorrect invoice type',
            solucion: "Check two things:<br/>&nbsp;&nbsp;1) In the app, open <b>Tax Details</b> and confirm your company's <b>VAT Condition</b> is set correctly (Registered, Monotributo, etc.).<br/>&nbsp;&nbsp;2) In the item, confirm the <b>recipient CUIT</b> is correct. The app automatically asks AFIP for the recipient's condition to decide whether A, B or C applies.",
        },
        'Este item ya tiene un comprobante': {
            title: "This item already has a voucher",
            accion: "Create a <b>new item</b> on the board and set ${columna_estado} to \"${estado_disparo}\" there.",
            estado: "Another one was not issued, on purpose: each item corresponds to a single voucher.",
            detalle: "If what you want is the Credit Note for this invoice, that also goes on a new item: it references the invoice by its CAE.",
            title: 'This item already has a voucher',
            solucion: 'Each item corresponds to <b>a single voucher</b>. To issue another — or the Credit Note for this invoice — create a <b>new item</b> on the board. The Credit Note references the invoice by its CAE.',
        },
        'CUIT / DNI del receptor inválido': {
            title: "Invalid recipient CUIT / DNI",
            accion: "Fill in ${columna_cuit} with an <b>11-digit CUIT</b> or a <b>7 or 8-digit DNI</b>, no dashes or spaces and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "If the sale is to an unidentified final consumer, leave that column <b>empty</b> and it will go through.",
            title: 'Invalid recipient CUIT / DNI',
            solucion: 'Fill in the <b>Recipient CUIT / DNI</b> column of the item with an <b>11-digit CUIT</b> (e.g. 20327446348) or a <b>7 or 8-digit DNI</b>. No dashes or spaces. If the sale is to an unidentified final consumer, leave the column <b>empty</b>.',
        },
        'Ese CUIT no existe en AFIP': {
            title: "That CUIT doesn't exist in AFIP",
            accion: "Check the client's CUIT in ${columna_cuit}: it is 11 digits, no dots or dashes and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "A single wrong digit is enough for AFIP not to find it.",
            title: "That CUIT doesn't exist in AFIP",
            solucion: "Open the item and check the client's CUIT: it's 11 digits, no dots or dashes. A single wrong digit is enough for AFIP not to find it. Fix it and set the status that starts the issuing again.",
        },
        'Error consultando el Padrón AFIP': {
            accion: 'Check CUIT ${doc_receptor} in ${columna_cuit}: it is 11 digits, no dots or dashes. Fix it and set ${columna_estado} back to "${estado_disparo}".',
            estado: 'Nothing was issued.',
            detalle: 'AFIP answered: «${motivo_afip}». If the number is written correctly, your client has to sort it out with AFIP.\nIf the sale is to an unidentified final consumer, leave ${columna_cuit} empty and it will go through. Note: a different voucher type comes out and your client will not be able to use it to claim VAT.',
            title: 'Error querying the AFIP registry',
            solucion: "If the message above points to a specific problem with the CUIT (inactive, pending requirements, etc.), the owner of that CUIT has to resolve it directly with AFIP — retrying won't help. If it doesn't give more detail, it may be a temporary AFIP outage: wait a few minutes and retry.",
        },
        'Empresa no configurada': {
            accion: 'Set up your company in the app → <b>Tax Details</b>, upload the certificate in <b>ARCA Certificates</b>, and set ${columna_estado} back to "${estado_disparo}".',
            estado: 'Nothing was issued.',
            title: 'Company not configured',
            detail: 'The tax data of the issuing company was not found.',
            solucion: "Open the app's view → <b>Tax Details</b> section → fill in Legal Name, CUIT, Point of Sale and save.",
        },
        'Falla de conexión temporal con AFIP': {
            accion: 'Set ${columna_estado} back to "${estado_disparo}". It was a network glitch, not a problem with your data.',
            estado: 'Nothing was issued, so there is no risk of a duplicate.',
            detalle: 'If it keeps failing, wait a few minutes and try again.',
            title: 'Temporary connection failure with AFIP',
            detail: 'It was a network glitch, not a problem with your data. The voucher was <b>not issued</b> (no duplicate).',
            solucion: 'Start the issuing again. If it keeps failing, wait a few minutes and retry.',
        },
        'AFIP rechazó la Factura E': {
            estado: "Nothing was issued: AFIP answered and did not accept it, so no number was burned.<br/><br/>What AFIP said:<br/>" +
                `&nbsp;&nbsp;❌&nbsp;&nbsp;${mainMsg.replace(/^[wsfex:w+]s*/, "")}`,
            detalle: "It is usually the destination country, the payment date or the client address.",
            title: "AFIP rejected the Factura E",
            accion: "Fix the field AFIP mentions below on the item and set ${columna_estado} back to \"${estado_disparo}\".",
            soporte: "If AFIP's message doesn't make sense to you,",
            title: 'AFIP rejected the Factura E',
            detail: 'AFIP responded, but did not accept the voucher. It <b>was not issued</b> (no number was burned).<br/><br/>' +
                'What AFIP said:<br/>' +
                `&nbsp;&nbsp;❌&nbsp;&nbsp;${mainMsg.replace(/^\[wsfex:\w+\]\s*/, '')}`,
            solucion: "If the message mentions an item field (destination country, payment date, client's address), fix it and try again. If it doesn't make sense to you, pass this message to the app's support.",
        },
        'AFIP no contestó sobre ese CUIT': {
            accion: 'Wait a few minutes and set ${columna_estado} back to "${estado_disparo}" without touching anything else. AFIP did not answer.',
            estado: 'Nothing was issued.',
            detalle: 'Don\'t touch ${columna_cuit}: the client\'s data is fine, it\'s AFIP that isn\'t answering.',
            soporte: 'If it still doesn\'t go through after half an hour,',
            title: "AFIP didn't answer about that CUIT",
            detail: "The app asked AFIP for the client's details and AFIP didn't respond. <b>This is not a problem with the data you entered</b>: the number is well formed, it's AFIP that isn't answering.",
            solucion: "Wait a few minutes and set the status that starts the issuing again, without touching anything on the item. If it's still the same after half an hour, contact the app's support.",
        },
        'Falta habilitar la facturación en AFIP': {
            accion: 'You need to grant your certificate permission in AFIP. It is a one-time procedure and waiting will not fix it.',
            pasos: [
                'Go to afip.gob.ar with your tax key → <b>Administrador de Relaciones de Clave Fiscal</b> → Nueva Relación.',
                'Under "Servicio" follow this path: AFIP → WebServices → <b>Facturación Electrónica</b>. It is written that way, half in English, because AFIP named it.',
                'Under "Representante" pick the certificate you already uploaded in the app.',
                'Confirm and set ${columna_estado} back to "${estado_disparo}".',
            ],
            estado: 'Nothing was issued.',
            detalle: 'If your certificate doesn\'t show up in that AFIP list, check which CUIT you generated it with. It has to be ${cuit_emisor}.',
            title: 'Electronic invoicing is not enabled in AFIP yet',
            detail: "AFIP recognises your certificate, but you haven't granted it permission to issue vouchers yet. <b>This is not an AFIP outage: waiting will not fix it.</b> It's a one-time procedure.",
            solucion: 'Go to afip.gob.ar with your tax key → <b>Administrador de Relaciones de Clave Fiscal</b> → Nueva Relación. Under "Servicio" follow this path: AFIP → WebServices → <b>Facturación Electrónica</b>. Under "Representante" pick the certificate you already uploaded in the app. Confirm and start the issuing again.',
        },
        'AFIP rechazó el comprobante': {
            estado: "Nothing was issued and no number was used up.<br/><br/>What AFIP said:<br/>" +
                `&nbsp;&nbsp;❌&nbsp;&nbsp;${mainMsg.replace(/^AFIP rechaz[oó] [^:]*:s*/i, "")}`,
            title: "AFIP rejected the voucher",
            accion: "Fix what AFIP mentions below. <b>This is not an outage on their side: it is a rule, and retrying without changing anything will give the same result.</b>",
            detalle: "If it mentions the point of sale, check that it is registered in AFIP for electronic invoicing. If it mentions the CUIT, look at which vouchers you are authorised to issue at afip.gob.ar → Comprobantes en línea. If it mentions VAT or amounts, check the subitems.",
            title: 'AFIP rejected the voucher',
            detail: 'AFIP answered and did not accept it. <b>Nothing was issued</b> and no number was used up.<br/><br/>What AFIP said:<br/>' +
                `&nbsp;&nbsp;❌&nbsp;&nbsp;${mainMsg.replace(/^AFIP rechaz[oó] [^:]*:\s*/i, '')}`,
            solucion: "This is not an AFIP outage: it's a rule of theirs. If the message mentions the point of sale, check that it is registered in AFIP for electronic invoicing. If it mentions the CUIT, check which vouchers you are authorised to issue at afip.gob.ar → Comprobantes en línea. If it mentions VAT or amounts, check the subitems. Retrying without changing anything will give the same result.",
        },
        'AFIP no está respondiendo correctamente': {
            title: "AFIP is not responding correctly",
            accion: "Wait a few minutes and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued. <b>This is not a problem with your configuration</b>, it is on AFIP's side.",
            detalle: "AFIP usually has brief outages or maintenance windows.",
            soporte: "If it is still the same after half an hour,",
            title: 'AFIP is not responding correctly',
            detail: "AFIP's servers didn't respond in time or returned an error. <b>This is not a configuration problem on your end</b>, it's on AFIP's side.",
            solucion: "Wait a few minutes and try again. AFIP usually has brief outages or maintenance. If it's still failing after 30 minutes, contact the app's support.",
        },
        'Revisá la Fecha de Pago': {
            accion: 'Set ${columna_fecha_pago} to a date from today onwards and set ${columna_estado} back to "${estado_disparo}".',
            estado: 'Nothing was issued.',
            detalle: 'That is the date you expect to get paid. AFIP does not accept a Factura E with a payment date earlier than the issue date.',
            title: 'Check the Payment Date',
            solucion: "That column has to be a Date column and hold a date from today onwards: it's the date you expect to get paid, not the date of the sale. AFIP requires it on every Factura E for services and does not accept a past date.",
        },
        'La nota no puede tener fecha anterior a la factura': {
            title: "The note can't be dated before the invoice",
            accion: "Change the item's Issue Date so it is the same as or later than the invoice you are cancelling and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "AFIP does not accept a note dated before its invoice.",
            title: "The note can't be dated before the invoice",
            solucion: "Change the item's Issue Date so it is the same as or later than the invoice you are cancelling. AFIP does not accept a note dated before its invoice.",
        },
        'Esa unidad de medida no existe en AFIP': {
            title: "That unit of measure doesn't exist in AFIP",
            accion: "Set the unit of measure to one of the ones AFIP accepts and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "These are the ones: <b>units</b>, <b>kilograms</b>, <b>metres</b>, <b>litres</b>, <b>hours</b>, <b>dozens</b>, <b>tonnes</b>. On A, B and C invoices this column is free text and is only printed on the PDF, which is why it does not matter there.",
            title: "That unit of measure doesn't exist in AFIP",
            solucion: "On a Factura E the unit has to be one from AFIP's list: <b>units</b>, <b>kilograms</b>, <b>metres</b>, <b>litres</b>, <b>hours</b>, <b>dozens</b>, <b>tonnes</b>. On A, B and C invoices this column is free text and is only printed on the PDF, which is why it doesn't matter there.",
        },
        'Falta emparejar la columna del CAE': {
            title: "The CAE column has not been mapped",
            accion: "Open the app → <b>Visual Mapping</b> → under <b>Reference invoice</b> pick the column where you put the CAE, save and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "To cancel a Factura E, the app needs to know which column holds the CAE of the invoice being adjusted.",
            title: 'The CAE column has not been mapped',
            detail: 'To cancel a Factura E, the app needs to know which board column holds the CAE of the invoice being adjusted.',
            solucion: "Open the app's view → <b>Visual Mapping</b> → under <b>Reference invoice</b> pick the column where you put the CAE, and save. Then go back to the item and start it again.",
        },
        'AFIP no tiene CUIT para ese país': {
            title: "AFIP has no CUIT for that country",
            accion: "Fill in the <b>Client tax ID</b> column with the tax number your client uses in their country and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "When AFIP has no generic CUIT for that destination, that field becomes required.",
            title: "AFIP has no CUIT for that country",
            solucion: "Fill in the item's <b>Client tax ID</b> column with the tax identification number your client uses in their country. When AFIP has no generic CUIT for that destination, that field becomes required.",
        },
        'Es un problema nuestro de configuración': {
            accion: 'Don\'t retry until we confirm: it will give the same error. We\'ve already been alerted and we\'re unblocking it.',
            estado: 'Nothing was issued.',
            detalle: 'The issuing went through a copy of the app that does not issue tax vouchers.',
            soporte: 'If you need to issue today,',
            title: "This one's on us — a setup problem",
            detail: 'The issuing went through a copy of the app that does not issue tax vouchers.',
            solucion: "We've already been alerted and we're unblocking it right now. Don't try again until we confirm: it will give the same error. If you need to issue today, write to us at <b>arca@theautomationpartner.com</b>.",
        },
        'Ese nombre de item está reservado': {
            accion: 'Rename the item and set ${columna_estado} back to "${estado_disparo}". We use that name internally for testing.',
            estado: 'Nothing was issued.',
            soporte: 'If you didn\'t give it that name, or it happens again with the new one,',
            title: 'That item name is reserved',
            detail: 'The item is named exactly like the name we use internally to test the error notices, so the app stopped on purpose.',
            solucion: 'Rename the item to anything else and set the status that starts the issuing again.',
        },
        'No pudimos leer el punto de venta': {
            accion: '${columna_pv} says "${pv_raw}" and only the number goes there. Fix it and set ${columna_estado} back to "${estado_disparo}".',
            estado: 'Nothing was issued.',
            detalle: 'If you want to keep seeing the shop name on the board, leave the number in that column and use a separate one for the name.',
            title: "We couldn't read the point of sale",
            solucion: 'That column takes only the point of sale number (1, 5, 0005). If you want to keep seeing the shop name on the board, leave the number there and use a separate column for the name.',
        },
        'La nota tiene que salir del mismo punto de venta que la factura': {
            title: "The note has to come from the same point of sale as the invoice",
            accion: "Change the item's point of sale so it matches the invoice you are cancelling, or leave that column empty and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "If you leave it empty, the app uses the right one on its own. AFIP numbers vouchers per point of sale, which is why the note has to come from the same one.",
            title: 'The note has to come from the same point of sale as the invoice',
            solucion: "Change the item's point of sale so it matches the invoice you are cancelling, or leave that column empty and the app will use the right one on its own.",
        },
        'A la factura referenciada le faltan datos': {
            title: "The referenced invoice is missing data",
            accion: "Check that the CAE you entered belongs to an invoice issued by the app from this same board and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "The invoice you are cancelling was stored without all the fields AFIP requires to link it (CAE, number, type or point of sale).",
            soporte: "If it is the right one and it still fails, we have to unblock it ourselves:",
            title: 'The referenced invoice is missing data',
            detail: 'The invoice you are cancelling was stored without all the fields AFIP requires to link it (CAE, number, type or point of sale).',
            solucion: 'Check that the CAE you entered belongs to an invoice issued by the app from this same board. If it is the right one and it still fails, write to us at <b>arca@theautomationpartner.com</b>: we have to unblock it ourselves.',
        },
        'Esa nota no puede referenciar ese comprobante': {
            title: "That note can't reference that voucher",
            accion: "Check the CAE you entered: it has to belong to a Factura E for services and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "Another note or an export of goods will not work.",
            title: "That note can't reference that voucher",
            solucion: 'Check the CAE you entered: it has to belong to a Factura E for services, not to another note or to an export of goods.',
        },
        'Faltan datos para este comprobante': {
            title: "Missing data for this voucher",
            accion: "Fix what is marked with ❌ below on the item and set ${columna_estado} back to \"${estado_disparo}\".",
            title: 'Missing data for this voucher',
            detail: subitemDetails.length > 0
                ? 'Fill this in and try again:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>')
                : mainMsg,
            solucion: 'Fix what is marked with ❌ on the item and set the status that starts the issuing again.',
        },
        'AFIP no devolvió el número del comprobante': {
            title: "AFIP didn't return the voucher number",
            accion: "Set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued: AFIP answered, but without the CAE, and without a CAE there is no voucher.",
            detalle: "If it fails three times in a row, wait 15 minutes and try again.",
            soporte: "If it is still the same after an hour,",
            title: "AFIP didn't return the voucher number",
            detail: 'AFIP answered, but without the CAE. <b>Nothing was issued</b>: without a CAE there is no voucher.',
            solucion: 'Set the status that starts the issuing again. If it fails three times in a row, wait 15 minutes and try again. If it is still the same after an hour, write to us at <b>arca@theautomationpartner.com</b>.',
        },
        'No encontramos el item o la empresa': {
            accion: 'The item is no longer on the board. Look for it in monday\'s recycle bin, restore it and set ${columna_estado} back to "${estado_disparo}".',
            estado: 'Nothing was issued.',
            detalle: 'If you moved it to another board, that board also has to be set up in the app.',
            title: "We couldn't find the item or the company",
            detail: "The app couldn't read the item, or the invoicing company is not set up.",
            solucion: "Check whether the item is still on the board (look in monday's recycle bin too). If it is, check that the company is set up in the app → <b>Tax Details</b>, with its certificate in <b>ARCA Certificates</b>.",
        },
        'AFIP no contestó sobre ese documento': {
            title: "AFIP didn't answer about that document",
            accion: "Wait a few minutes and set ${columna_estado} back to \"${estado_disparo}\" without touching anything on the item.",
            estado: "Nothing was issued. <b>This is not a problem with the number you entered.</b>",
            soporte: "If it is still the same after half an hour,",
            title: "AFIP didn't answer about that document",
            detail: "The app asked AFIP for the client's details and got no response. <b>This is not a problem with the number you entered.</b>",
            solucion: 'Wait a few minutes and set the status that starts the issuing again, without touching anything on the item. If it is still the same after half an hour, write to us.',
        },
        'No reconocemos ese tipo de comprobante': {
            accion: 'In ${columna_tipo} write the full name of the voucher and set ${columna_estado} back to "${estado_disparo}".',
            estado: 'Nothing was issued.',
            detalle: 'The ones we accept are: Factura, Nota de Crédito, Nota de Débito, Factura E, Nota de Crédito E and Nota de Débito E.\nWe do not take abbreviations: NC, ND, Fact, N/C.',
            title: "We don't recognise that voucher type",
            solucion: 'In the Voucher Type column leave exactly one of these, with the full name: Factura, Nota de Crédito, Nota de Débito, Factura E, Nota de Crédito E or Nota de Débito E. We do not accept abbreviations (NC, ND, Fact).',
        },
        'Es un problema nuestro': {
            accion: 'Don\'t touch anything and don\'t retry: we\'ve already been alerted and we\'re looking at it.',
            estado: 'Nothing was issued. It\'s not data you entered wrong, so checking the item won\'t resolve it.',
            soporte: 'If you need to issue today,',
            title: "This one's on us",
            detail: "The app got stuck on something on our side. <b>It's not data you entered wrong</b>, so checking the item won't resolve it.",
            solucion: "Don't touch anything and don't retry: we've already been alerted and we're looking at it. If you need to issue today, write to us at <b>arca@theautomationpartner.com</b>.",
        },
        'Error de autenticación con Monday': {
            title: "monday authentication error",
            accion: "Close the app's view and open it again.",
            estado: "Nothing was issued.",
            detalle: "If the error persists, uninstall the app from the board and reinstall it from the monday Marketplace.",
            title: 'monday authentication error',
            detail: "The app couldn't access the board data.",
            solucion: "Close the app's view and reopen it. If the error persists, uninstall the app from the board and reinstall it from the monday Marketplace.",
        },
        'Fechas de servicio obligatorias': {
            title: "Service dates required",
            accion: "Fill in the <b>Service Date From</b> and <b>Service Date To</b> columns on the item and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "They are required when the subitems include services.",
            title: 'Service dates required',
            solucion: 'Fill in the <b>Service Date From</b> and <b>Service Date To</b> columns in the item. They are required when the subitems include services.',
        },
        'El comprobante C no lleva IVA': {
            title: "C voucher doesn't carry VAT",
            accion: "Set ${columna_alicuota} to <b>0</b> on every subitem and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "C vouchers do not break out VAT because the issuer is Monotributo or Exempt.",
            title: "C voucher doesn't carry VAT",
            solucion: "C vouchers (Invoice or Credit Note) don't break out VAT because the issuer is Monotributo or Exempt. Open the item's subitems and set the <b>VAT Rate %</b> column to <b>0</b> on all of them. Then retry.",
        },
        'Alícuota IVA inválida': {
            title: "Invalid VAT rate",
            accion: "Set the <b>same</b> VAT rate on every subitem and set ${columna_estado} back to \"${estado_disparo}\".",
            detalle: "The values AFIP accepts are 0, 2.5, 5, 10.5, 21 and 27. A voucher cannot mix rates.",
            title: 'Invalid VAT rate',
            detail: subitemDetails.length > 0
                ? 'The subitems have different VAT rates:<br/>' +
                  subitemDetails.map(l => l.replace('•', '').trim()).map(l => `&nbsp;&nbsp;- ${l}`).join('<br/>')
                : mainMsg,
            solucion: 'All subitems of an invoice must have the <b>same VAT rate</b>. Check the VAT Rate % column and make sure all subitems have the same value (0, 2.5, 5, 10.5, 21 or 27).',
        },
        'Tipo de Comprobante no reconocido': {
            accion: 'In ${columna_tipo} put <b>Invoice</b>, <b>Credit Note</b> or <b>Debit Note</b>, and set ${columna_estado} back to "${estado_disparo}".',
            estado: 'Nothing was issued.',
            title: 'Voucher Type not recognized',
            solucion: "The item's <b>Voucher Type</b> column must say <b>Invoice</b>, <b>Credit Note</b> or <b>Debit Note</b>. Fix the value and start the issuing again.",
        },
        'No se pudo identificar la factura a anular': {
            title: "Couldn't identify the invoice to cancel",
            accion: "Paste the 14-digit <b>CAE</b> of the invoice you want to cancel into the CAE column and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "You get it from that invoice's PDF or from the comment the app left when it was issued.",
            title: "Couldn't identify the invoice to cancel",
            solucion: "In the Credit Note item, paste the 14-digit <b>CAE</b> of the invoice you want to cancel into the CAE column. You get it from that invoice's PDF or from the comment the app left when it was issued.",
        },
        'La Nota de Crédito no tiene líneas para acreditar': {
            title: "The Credit Note has no lines to credit",
            accion: "Add what you want to credit as <b>subitems</b> of the item, each line with Description, Quantity and Price and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "The Credit Note is issued for the sum of those subitems.",
            title: 'The Credit Note has no lines to credit',
            solucion: 'Add what you want to credit as <b>subitems</b> of the item — each line with Description, Quantity and Price. The Credit Note is issued for the sum of those subitems.',
        },
        'La Nota de Crédito supera el saldo de la factura': {
            title: "The Credit Note exceeds the invoice balance",
            accion: "Lower the subitem amounts so the total does not exceed the available balance and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "You cannot credit more than what was invoiced. The balance you have left is shown below.",
            title: 'The Credit Note exceeds the invoice balance',
            solucion: "You can't credit more than what was invoiced. Lower the subitem amounts so the total doesn't exceed the <b>available balance</b> shown above.",
        },
        'La alícuota IVA de la Nota de Crédito no coincide con la factura': {
            title: "The Credit Note's VAT rate doesn't match the invoice",
            accion: "Adjust ${columna_alicuota} on the subitems to match the original invoice and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "The Credit Note is credited with the same VAT that was invoiced.",
            title: "The Credit Note's VAT rate doesn't match the invoice",
            solucion: 'The Credit Note is credited with the same VAT that was invoiced. Adjust the <b>VAT Rate %</b> column of the subitems to match the original invoice.',
        },
        'Ya se emitió un comprobante para este item': {
            title: "A voucher was already issued for this item",
            accion: "Create a <b>new item</b> on the board and set ${columna_estado} to \"${estado_disparo}\" there.",
            estado: "Another one was not issued, on purpose: each item corresponds to a single voucher.",
            detalle: "That is what avoids duplicating vouchers in AFIP.",
            title: 'A voucher was already issued for this item',
            solucion: 'Each board item corresponds to <b>a single voucher</b>. To issue another, <b>create a new item</b> on the board and start it from there. This avoids duplicating vouchers in AFIP.',
        },
        "Falta la alícuota IVA en algún subítem": {
            title: "A subitem is missing its VAT rate",
            accion: "Check that ALL subitems have ${columna_alicuota} filled in and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued.",
            detalle: "One empty cell is enough for AFIP to reject the whole voucher.",
            soporte: "If they all have it filled in already, it's on us:",
        },
        "Ese punto de venta no está dado de alta en AFIP": {
            title: "That point of sale is not registered in AFIP",
            accion: "You need to register the point of sale in AFIP. It is something you do yourself: retrying will not create it.",
            pasos: [
                "Go to afip.gob.ar with your tax key → <b>Administración de puntos de venta y domicilios</b> → A/B/M de puntos de venta → Alta.",
                "Create the number you are using on the item. It will ask you to pick a system from a list.",
                "If you are a monotributista pick <b>\"Factura Electrónica - Monotributo - Web Services\"</b>. If you are responsable inscripto, <b>\"RECE - Facturación Electrónica - Web Services\"</b>. They are written that oddly by AFIP, not by us.",
                "Wait a minute and set ${columna_estado} back to \"${estado_disparo}\".",
            ],
            estado: "Nothing was issued.",
            detalle: "If you meant to invoice from a different point of sale, fix ${columna_pv} on the item.",
        },
        "Tu CUIT no está autorizado a emitir ese comprobante": {
            title: "Your CUIT is not authorised to issue that voucher",
            accion: "Check the voucher letter: AFIP says your CUIT is not authorised to issue that one.",
            pasos: [
                "Look at which letter the item has. If you are a monotributista, you can only issue Factura C.",
                "To see which letters you have enabled, go to afip.gob.ar → <b>Comprobantes en línea</b>.",
                "Fix the letter and set ${columna_estado} back to \"${estado_disparo}\".",
            ],
            estado: "Nothing was issued.",
            detalle: "Retrying without changing the letter will give the same result.",
        },
        "Este item ya está emitiendo": {
            title: "This item is already issuing",
            accion: "Don't touch anything for a minute. This item is already issuing and the result will show up here on its own.",
            estado: "If you set ${columna_estado} back to \"${estado_disparo}\" now, two vouchers could come out.",
        },
        "Quedó un intento anterior sin cerrar": {
            title: "A previous attempt was left open",
            accion: "Wait. The app asks AFIP again on its own and writes the outcome here, always within 5 minutes.",
            estado: "A number was left reserved at AFIP by an attempt that never confirmed.",
            detalle: "Only if the item still has no voucher after those 5 minutes, set ${columna_estado} back to \"${estado_disparo}\". Before that, leave it alone: two could come out.",
        },
        "Ya estaba emitida": {
            title: "It was already issued",
            accion: "You do not need to do anything: it was already done.",
            estado: "Another one was not issued, on purpose.",
            detalle: "To invoice something else, create a new item and set ${columna_estado} to \"${estado_disparo}\" there.",
        },

        'Falta configurar la exportación en Datos Fiscales': {
            title: "Export settings are missing in Tax Details",
            accion: 'Open the app → <b>Tax Details</b>, complete the export settings and set  back to "".',
            estado: "Nothing was issued.",
            detalle: "That is where the three things AFIP requires for Factura E live: ticking that you issue exports, the export point of sale (a separate one from the domestic one) and the payment method.",
        },
        "monday nos frenó por exceso de consultas": {
            title: "monday throttled us for too many requests",
            accion: "Wait a couple of minutes and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued. <b>This is not a problem with your data</b>: monday limited how many requests the app can make per minute.",
            detalle: "It usually happens when many vouchers are triggered at once. It clears on its own.",
        },
        "Se venció el permiso de la app en monday": {
            title: "The app's monday permission expired",
            accion: "Open the app's view from the board. That renews the permission on its own.",
            estado: "Nothing was issued.",
            detalle: "If it is still the same afterwards, uninstall the app from the board and reinstall it from the monday Marketplace. Nothing you configured is lost.",
        },
        "monday no encuentra el item o una columna": {
            title: "monday can't find the item or a column",
            accion: "Check whether the item is still on the board, and whether you deleted any of the columns the app uses.",
            estado: "Nothing was issued.",
            detalle: "If you deleted a column, map it again in the app → <b>Visual Mapping</b>. If the item is gone, look in monday's recycle bin.",
        },
        "AFIP contestó algo que no se entiende": {
            title: "AFIP answered something we couldn't read",
            accion: "Wait a few minutes and set ${columna_estado} back to \"${estado_disparo}\".",
            estado: "Nothing was issued. <b>This is not a problem with your data</b>: AFIP returned a broken response, which is what happens when their service is going down.",
            soporte: "If it is still the same after half an hour,",
        },
        "La clave del certificado tiene contraseña": {
            title: "The certificate key is password-protected",
            accion: "Generate the certificate again from the app → <b>ARCA Certificates</b>, without setting a password on the key.",
            estado: "Nothing was issued.",
            detalle: "The app signs every voucher on its own, so it can't type a password. If you let the app's wizard generate the request, the key comes out without one and this doesn't happen.",
        },

        "Ese país no está en la lista de AFIP": {
            title: "That country is not in AFIP list",
            accion: 'In the item’s <b>Destination Country</b> column write the country the way AFIP names it, and set ${columna_estado} back to "${estado_disparo}".',
            estado: "Nothing was issued.",
            detalle: "AFIP has its own list of names and does not accept variants. Below is what it answered — if it offers similar options, copy one exactly.",
        },
        "Esa moneda no está en la lista de AFIP": {
            title: "That currency is not in AFIP list",
            accion: 'In the item’s <b>Currency</b> column write the currency the way AFIP publishes it, and set ${columna_estado} back to "${estado_disparo}".',
            estado: "Nothing was issued.",
            detalle: 'Careful: AFIP codes are <b>not</b> the ISO ones — the euro is not "EUR". Below is what AFIP answered; if it offers options, copy one exactly.',
        },
    };


    const isEn = language === 'en';
    // Una sola lista, un solo orden, un solo juego de regex. En inglés se le pisa
    // encima el texto de EN_TEXT; lo que esa entrada no define (tipicamente el
    // `detail`, que suele ser el texto crudo de AFIP) se hereda en español, que es
    // el idioma en el que AFIP contesta.
    const reglaES = KNOWN_ERRORS.find(e => e.match.test(msg));
    const known = (isEn && reglaES && EN_TEXT[reglaES.title])
        ? { ...reglaES, ...EN_TEXT[reglaES.title] }
        : reglaES;
    const A = isEn
        ? { issue: "Couldn't issue", cause: 'Cause:', fix: 'How to fix it:',
            fallback: "Review the item data and retry. If the error persists, contact the app's support with the item name." }
        : { issue: 'No se pudo emitir', cause: 'Causa:', fix: 'Cómo solucionarlo:',
            fallback: 'Revisá los datos del item y reintentá. Si el error persiste, contactá al soporte de la app indicando el nombre del item.' };

    // ── Forma nueva: la acción primero ──────────────────────────────────────
    // La forma vieja abre con la causa y deja la instrucción al final. La persona
    // que abre el item quiere saber QUÉ HACER; el por qué es secundario y muchas
    // veces ni le interesa. Si solo lee el primer renglón, con la forma nueva ya
    // puede resolver.
    //
    // Convive con la vieja a propósito: una regla se pasa a la forma nueva cuando
    // tiene su texto escrito y aprobado. Las que no lo tienen siguen como estaban
    // — que es correcto, solo que ordenado al revés. Nunca hay dos listas: es la
    // MISMA regla, con más campos.
    // Lo que viene del handler manda; lo que se saca del texto del error rellena
    // los huecos que quedaron.
    const datos = known ? { ...derivarDatosDelError(msg), ...meta } : {};
    const V = (t) => rellenarDatos(t, datos, language);

    // Si a la acción le faltan tantos datos que se quedó sin oraciones, el mensaje
    // se quedaría sin encabezado — que es lo único que la persona lee seguro. En
    // ese caso vale más la forma vieja completa que la nueva mutilada.
    // Mayúscula inicial: varios mensajes arrancan con un dato interpolado ("the
    // Point of Sale column says...") y quedaban en minúscula al principio de la
    // frase. Se saltean las etiquetas HTML de apertura para no romper el <b>.
    const mayusculaInicial = (t) => t.replace(/^((?:<[^>]+>)*\s*)(\p{Ll})/u, (_, pre, letra) => pre + letra.toUpperCase());
    const accion = known && known.accion ? mayusculaInicial(V(known.accion).trim()) : '';
    if (known && accion.length > 12) {
        let html = `<b>❌ ${accion}</b>`;

        if (known.pasos && known.pasos.length) {
            html += '<br/><br/>' + known.pasos
                .map((p, i) => `&nbsp;&nbsp;<b>${i + 1}.</b>&nbsp;&nbsp;${V(p)}`)
                .join('<br/><br/>');
        }
        // El estado va SIEMPRE: "no se emitió nada" es lo primero que se pregunta
        // el que ve un error de facturación, y no decirlo lo obliga a ir a AFIP a
        // fijarse.
        html += `<br/><br/>${V(known.estado || (isEn ? 'Nothing was issued.' : 'No se emitió nada.'))}`;
        if (known.detalle) html += `<br/><br/>${V(known.detalle)}`;

        // Lo que dijo el sistema, si no se mostró ya.
        //
        // La forma vieja tenía `detail: mainMsg` en muchas reglas, así que el texto
        // crudo —el código de AFIP, el saldo disponible, la alícuota que no coincide—
        // se veía siempre. Al pasarlas a la forma nueva ese texto se perdió en 11
        // reglas, y varias siguen diciendo "corregí lo que menciona AFIP acá abajo"
        // con nada abajo. Una instrucción que apunta al vacío es peor que no decir
        // nada: la persona lo lee tres veces buscando dónde está.
        //
        // Va acá y no regla por regla porque acordarse en cada una es exactamente lo
        // que ya falló. Se muestra solo si NO está ya en el mensaje.
        const yaEstaElDetalle = (t) => !t || html.includes(t.trim()) || t.trim().length < 4;
        const bullets = subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).filter(l => !yaEstaElDetalle(l));
        if (bullets.length) {
            html += '<br/><br/>' + bullets.map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>');
        } else if (!yaEstaElDetalle(mainMsg) && known.detail === mainMsg) {
            html += `<br/><br/><i>${isEn ? 'What the system said' : 'Lo que dijo el sistema'}:</i><br/>` +
                `&nbsp;&nbsp;${mainMsg}`;
        }
        // El soporte va SOLO donde está declarado. Ofrecerlo cuando la persona
        // puede resolverlo sola le da permiso para no intentarlo.
        // La línea de soporte CONDICIONAL: "si a la media hora sigue igual, …".
        // Solo va donde tiene sentido esperar antes de escribir. La dirección no
        // se repite acá — la lleva el pie, que va en todos.
        if (known.soporte) {
            html += `<br/><br/>${V(known.soporte)} ${isEn ? 'let us know.' : 'avisanos.'}`;
        }
        html += PIE(isEn);
        return html;
    }

    if (known) {
        return `<b>❌ ${A.issue} ${kindArticle(kind, language)}</b><br/><br/>` +
            `<b>${A.cause}</b> ${known.title}<br/>${known.detail}<br/><br/>` +
            `<b>${A.fix}</b> ${known.solucion}` + PIE(isEn);
    }

    // ── Fallback ────────────────────────────────────────────────────────────
    // Antes esto pegaba SIEMPRE "Revisá los datos del item y reintentá", incluso
    // cuando el mensaje ya traía su propia instrucción. Quedaban comentarios que
    // se contradecían a sí mismos:
    //
    //   Causa: Esta empresa no tiene habilitada la facturación de exportación.
    //          Abrí la app → Datos Fiscales, tildá "Emite Factura E" y guardá.
    //   Cómo solucionarlo: Revisá los datos del item y reintentá.
    //
    // Dos instrucciones distintas, y la de abajo manda al lugar equivocado.
    // Muchos de los throw del código ya vienen con la solución escrita adentro;
    // el problema era que ninguna regla los agarraba y el genérico se los pisaba.
    //
    // Ahora: si el mensaje trae una instrucción (un verbo en imperativo), se parte
    // en causa + instrucción y se muestra la propia. Si no trae, recién ahí va el
    // genérico. Es lo que convierte 66 mensajes mudos en 66 que dicen algo.
    // OJO con el \b final: en JavaScript NO funciona después de una vocal acentuada.
    // "Abrí " no tiene frontera de palabra entre la "í" y el espacio, porque \w es
    // solo [A-Za-z0-9_] y la í queda afuera. Por eso se usa (?=\s) — el verbo tiene
    // que venir seguido de un espacio, que es lo que pasa siempre en una instrucción.
    // El sufijo (l[oa]s?|le|nos)? cubre los enclíticos del imperativo rioplatense:
    // "Escribilo", "Cargala", "Configuralas", "Corregilo", "Pedile". Sin eso, media
    // docena de mensajes que YA traían su instrucción seguían cayendo al genérico.
    const IMPERATIVO_ES = /(^|[\s.—–-])(Abr[ií]|And[aá]|Revis[aá]|Correg[ií]|Pon[eé]|Escrib[ií]|Sub[ií]|Complet[aá]|Reintent[aá]|Eleg[ií]|Carg[aá]|Fijate|Verific[aá]|Cambi[aá]|Dale de alta|Consult[aá]|Ped[ií]|Volv[eé] a|Asegurate|Tild[aá]|Us[aá]|Copi[aá]|Borr[aá]|Cre[aá]|Configur[aá]|Sac[aá]|Dej[aá]|Mir[aá]|Segu[ií])(l[oa]s?|le|nos)?(?=[\s,.])/;
    // La lista corta de antes (Open|Go to|Check|Fix|Set|Enter|Write|Upload|Complete|
    // Retry|Choose|Make sure) dejaba afuera los verbos con los que arrancan la mitad
    // de nuestras instrucciones en inglés: Add, Paste, Try again, Wait, Lower, Adjust.
    // Un mensaje que decía "Add the services you're exporting as subitems" caía al
    // genérico igual que si no dijera nada.
    const IMPERATIVO_EN = /\b(Open|Go to|Check|Fix|Set|Enter|Write|Upload|Complete|Retry|Try again|Choose|Make sure|Add|Paste|Wait|Lower|Adjust|Change|Pick|Rename|Contact|Copy|Create|Leave|Look|Fill|Use|Configure|Remove|Review|Trigger|Ask)(?=\s)/;

    // El mensaje completo, no solo la primera línea: la instrucción suele venir
    // después del punto o en la línea siguiente.
    const completo = String(msg).trim();

    // En un tablero en inglés se prueban LOS DOS, y el español no es un descuido:
    // la mayoría de los throw del código tiran el texto en español sin importar el
    // idioma del tablero (solo 46 pasan por el helper de traducción). Buscando solo
    // verbos ingleses, 20 mensajes que YA traían su instrucción —el país exacto que
    // AFIP no reconoce, la moneda, el punto de venta de exportación que falta— se
    // caían al genérico y el usuario leía "Review the item data", que no dice qué
    // dato. Mostrarle la instrucción en español no es lo ideal, pero le dice dónde
    // tocar; el genérico no le dice nada. Lo definitivo es traducir esos throw en el
    // origen (envolverlos en el helper L, como los otros 46).
    let corte = completo.search(isEn ? IMPERATIVO_EN : IMPERATIVO_ES);
    if (isEn && corte < 0) corte = completo.search(IMPERATIVO_ES);
    if (corte > 0) {
        const causa = completo.slice(0, corte).trim().replace(/[\s—–-]+$/, '');
        const comoSe = completo.slice(corte).trim();
        // Solo si las dos partes tienen sustancia; si no, se muestra entero.
        if (causa.length > 12 && comoSe.length > 12) {
            // La MISMA forma que las reglas: acción primero, después el estado del
            // comprobante, y al final el por qué. Antes esto salía con la forma
            // vieja, así que 31 errores —casi todos de Factura E— se leían distinto
            // del resto sin ninguna razón: son los que no tienen regla propia, pero
            // eso es un detalle nuestro, no algo que la persona tenga por qué notar.
            const inicial = comoSe.replace(/^(\p{Ll})/u, (c) => c.toUpperCase());
            return `<b>❌ ${inicial}</b><br/><br/>` +
                `${isEn ? 'Nothing was issued.' : 'No se emitió nada.'}<br/><br/>` +
                `${causa}` + PIE(isEn);
        }
    }

    return `<b>❌ ${A.issue} ${kindArticle(kind, language)}</b><br/><br/>` +
        `<b>${A.cause}</b> ${mainMsg}<br/><br/>` +
        `<b>${A.fix}</b> ${A.fallback}` + PIE(isEn);
}

function kindArticle(kind, language = 'es') {
    const k = String(kind || 'comprobante').trim();
    if (language === 'en') {
        if (/^factura/i.test(k)) return 'the invoice';
        if (/cr[eé]dito/i.test(k)) return 'the credit note';
        if (/d[eé]bito/i.test(k)) return 'the debit note';
        return 'the voucher';
    }
    if (/^factura/i.test(k) || /^nota de/i.test(k)) return `la ${k}`;
    return `el ${k}`;
}

module.exports = { buildErrorComment, kindArticle, AFIP_IDEMPOTENT_ERROR_PATTERN, INTERNAL_ERROR_PATTERN, RUNTIME_CRASH_PATTERN };
