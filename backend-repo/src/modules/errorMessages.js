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

function buildErrorComment(err, displayKind = 'comprobante', language = 'es') {
    const msg = err?.message || 'Error desconocido';
    const kind = (displayKind && typeof displayKind === 'string') ? displayKind : 'comprobante';

    // Extraer detalle de subitems si viene en el mensaje (líneas con "•")
    const lines = msg.split('\n');
    const mainMsg = lines[0];
    const subitemDetails = lines.filter(l => l.startsWith('•'));

    const KNOWN_ERRORS = [
        {
            // Item incompleto = validateItemDataCompleteness (o el ruteo) falló.
            // El detalle de QUÉ columnas faltan viene en los bullets del mensaje.
            match: /Item incompleto/i,
            title: 'Faltan datos en el item',
            detail: subitemDetails.length > 0
                ? 'Completá estas columnas (vacías o con datos inválidos) y volvé a disparar la receta:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>')
                : 'Hay campos obligatorios sin completar en el item o en sus subitems.',
            solucion: 'Abrí el item, completá las columnas marcadas con ❌ y reintentá. Si una columna no aparece, revisá el <b>Mapeo Visual</b> en la vista de configuración de la app.',
        },
        {
            match: /falta.*mapeo|falta.*configurar.*mapeo|falta.*mapping/i,
            title: 'Falta configurar el mapeo de columnas',
            detail: 'El tablero no tiene configurado qué columna corresponde a cada campo de la factura.',
            solucion: 'Abrí la vista de la app → sección <b>Mapeo Visual</b> → seleccioná las columnas y guardá.',
        },
        {
            match: /no hay.*subitems|no hay líneas|sin.*subitems|validLines.*0/i,
            title: 'Subitems incompletos o faltantes',
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
            match: /importes de bonificaci[oó]n/i,
            title: 'Problemas con la bonificación de los subitems',
            detail: subitemDetails.length > 0
                ? 'Revisá estos subitems:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>')
                : 'Alguno de los subitems tiene un importe de bonificación inválido.',
            solucion: 'La bonificación es un <b>importe</b> (no un porcentaje), se aplica al <b>total de la línea</b> (cantidad × precio) y va en la <b>misma moneda que el precio unitario</b>. No puede ser negativa ni superar el total de la línea.',
        },
        {
            match: /bonificaciones se comieron/i,
            title: 'El comprobante quedó en cero',
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
            detail: 'El certificado que tenés cargado ya venció, y ARCA no acepta comprobantes firmados con un certificado vencido.',
            solucion: 'Hay que sacar uno nuevo: es el mismo trámite que hiciste la primera vez, y el paso a paso está en la vista de la app → <b>Certificados ARCA</b>. Cuando lo termines de subir, volvé a disparar la receta. Hasta entonces reintentar no sirve.',
        },
        {
            // Errores crudos de la libreria de criptografia cuando el .crt o la .key
            // estan danados, cruzados de distinto tramite, o pegados mal. Llegaban al
            // usuario TAL CUAL, en ingles y sin decir de que hablan:
            //     "Invalid PEM formatted message. Revisá los datos del item"
            // Medido el 2026-08-05 con un certificado invalido a proposito. El item
            // estaba perfecto; el problema era el certificado.
            match: /invalid pem|pem formatted|too few bytes to parse DER|Cannot read.*ASN\.1|invalid.*private key|error de firma/i,
            title: 'El certificado de ARCA no se puede leer',
            detail: 'El archivo del certificado o el de la clave están dañados, o no son del mismo trámite. <b>No es un problema de los datos del item.</b>',
            solucion: 'Volvé a subir el par completo en la vista de la app → <b>Certificados ARCA</b>. Tienen que ser los dos archivos que se generaron juntos: la clave (.key) y el certificado que te descargó ARCA (.crt) — uno de un trámite y otro de otro no funciona. Si no los encontrás, sacá un certificado nuevo y subí los dos.',
        },
        {
            match: /faltan? (los )?certificados?|falta subir el certificado|certificate not uploaded|certificados?.*afip|falta.*crt|falta.*key/i,
            title: 'Falta subir el certificado de ARCA',
            detail: 'No hay ningún certificado cargado para esta empresa, y sin él la app no se puede identificar ante ARCA.',
            solucion: 'Abrí la vista de la app → sección <b>Certificados ARCA</b> → subí el certificado (.crt) y la clave (.key). Si todavía no los sacaste, el paso a paso está en esa misma pantalla: se hace una sola vez y dura dos años.',
        },
        {
            match: /Configuración incompleta/i,
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
            detail: mainMsg,
            solucion: 'Revisá dos cosas:<br/>&nbsp;&nbsp;1) En la app, abrí <b>Datos Fiscales</b> y confirmá que la <b>Condición IVA</b> de tu empresa esté bien cargada (Responsable Inscripto, Monotributo, etc.).<br/>&nbsp;&nbsp;2) En el item, confirmá que el <b>CUIT del receptor</b> sea correcto. La app consulta automáticamente a AFIP la condición del receptor para decidir si corresponde A, B o C.',
        },
        {
            // B2: guardia "un item = un solo comprobante" — cubre las 3 variantes
            // que dispara la guardia cross-tipo (factura sobre item con NC/ND
            // y viceversa): "ya emitió", "está emitiendo" (concurrente), y
            // "tiene una ... con número reservado en AFIP pero sin confirmar".
            match: /este item (ya emiti[oó]|est[aá] emitiendo|tiene.*n[uú]mero reservado)/i,
            title: 'Este item ya tiene un comprobante',
            detail: mainMsg,
            solucion: 'Cada item corresponde a <b>un solo comprobante</b>. Para emitir otro — o la Nota de Crédito de esta factura — creá un <b>item nuevo</b> en el tablero. La NC referencia la factura por su CAE.',
        },
        {
            match: /cuit.*inválido|cuit.*invalido|cuit.*vac|receptor_cuit.*null/i,
            title: 'CUIT / DNI del receptor inválido',
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
            detail: mainMsg,
            solucion: 'Abrí el item y revisá el CUIT del cliente: son 11 dígitos, sin puntos ni guiones. Un solo dígito cambiado alcanza para que AFIP no lo encuentre. Corregilo y volvé a poner el estado que dispara la emisión.',
        },
        {
            match: /padrón.*error|padron.*error|padrón.*falló|padron.*fallo/i,
            title: 'Error consultando el Padrón AFIP',
            detail: mainMsg,
            solucion: 'Si el mensaje de arriba señala un problema puntual del CUIT (inactivo, con requerimientos pendientes, etc.), lo tiene que resolver el titular de ese CUIT directamente con AFIP — reintentar no alcanza. Si no da mayor detalle, puede ser una caída temporal de AFIP: esperá unos minutos y reintentá.',
        },
        {
            match: /empresa no encontrada|no encontrada.*cuenta/i,
            title: 'Empresa no configurada',
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
            detail: 'Fue un corte de red, no un problema de tus datos. El comprobante <b>no se emitió</b> (no hay duplicado).',
            solucion: 'Volvé a disparar la receta. Si sigue fallando, esperá unos minutos y reintentá.',
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
            detail: 'AFIP respondió, pero no aceptó el comprobante. <b>No se emitió</b> (no hay número quemado).<br/><br/>' +
                'Lo que dijo AFIP:<br/>' +
                `&nbsp;&nbsp;❌&nbsp;&nbsp;${mainMsg.replace(/^\[wsfex:\w+\]\s*/, '')}`,
            solucion: 'Si el mensaje menciona un dato del item (país de destino, fecha de pago, domicilio del cliente), corregilo y volvé a disparar la receta. Si no le encontrás sentido, pasale este mensaje al soporte de la app.',
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
            detail: 'La app le preguntó a AFIP por los datos del cliente y AFIP no respondió. <b>No es un problema del dato que cargaste</b>: el número está bien formado, el que no contesta es AFIP.',
            solucion: 'Esperá unos minutos y volvé a disparar la receta sin tocar nada del item. Si a la media hora sigue igual, avisá al soporte de la app.',
        },
        {
            match: /no autorizado a acceder al servicio|computador no autorizado/i,
            title: 'Falta habilitar la facturación en AFIP',
            detail: 'AFIP reconoce tu certificado, pero todavía no le diste permiso para emitir comprobantes. <b>No es una caída de AFIP: esperar no lo arregla.</b> Es un trámite de una sola vez.',
            solucion: 'Entrá a afip.gob.ar con tu clave fiscal → <b>Administrador de Relaciones de Clave Fiscal</b> → Nueva Relación. En "Servicio" seguí este camino: AFIP → WebServices → <b>Facturación Electrónica</b> (está escrito así, mitad en inglés, porque es el nombre que le puso AFIP). En "Representante" elegí el certificado que ya cargaste en la app. Confirmá y volvé a disparar la receta.',
        },
        {
            // AFIP rechazó el comprobante y dijo por qué, con un código entre corchetes.
            // Antes esto caía al fallback y mostraba el texto crudo de AFIP en mayúsculas
            // + "Revisá los datos del item", que no dice qué revisar.
            // Ojo: también va ANTES del comodín, porque el texto de AFIP suele traer
            // importes y CUITs con un "500" adentro que disparaban el /afip.*500/.
            match: /AFIP rechaz[oó] (la factura|el comprobante|la Nota).*\[\d{4,5}\]/i,
            title: 'AFIP rechazó el comprobante',
            detail: 'AFIP contestó y no lo aceptó. <b>No se emitió nada</b> y no se gastó ningún número.<br/><br/>Lo que dijo AFIP:<br/>' +
                `&nbsp;&nbsp;❌&nbsp;&nbsp;${mainMsg.replace(/^AFIP rechaz[oó] [^:]*:\s*/i, '')}`,
            solucion: 'Esto no es una caída de AFIP: es una regla suya. Si el mensaje menciona el punto de venta, revisá que esté dado de alta en AFIP para facturación electrónica. Si menciona el CUIT, revisá qué comprobantes tenés habilitados en afip.gob.ar → Comprobantes en línea. Si menciona IVA o importes, revisá los subítems. Reintentar sin cambiar nada va a dar lo mismo.',
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
            detail: 'Los servidores de AFIP no respondieron a tiempo o devolvieron un error. <b>Esto no es un problema de tu configuración</b>, es del lado de AFIP.',
            solucion: 'Esperá unos minutos y volvé a intentarlo. AFIP suele tener cortes breves o mantenimientos. Si después de 30 minutos sigue fallando, avisá al soporte de la app.',
        },
        // ── Ultima tanda: los que quedaban sin mensaje propio ────────────────
        {
            match: /^No se pudo leer la Fecha de Pago|^La Fecha de Pago .* es anterior/i,
            title: 'Revisá la Fecha de Pago',
            detail: mainMsg,
            solucion: 'Esa columna tiene que ser de tipo Fecha y llevar una fecha de hoy en adelante: es la fecha en la que esperás cobrar, no la de la venta. AFIP la exige en toda Factura E de servicios y no acepta una fecha pasada.',
        },
        {
            match: /^La fecha de la .* es anterior a la de la factura referenciada/i,
            title: 'La nota no puede tener fecha anterior a la factura',
            detail: mainMsg,
            solucion: 'Cambiá la Fecha de Emisión del item para que sea igual o posterior a la de la factura que estás anulando. AFIP no acepta una nota fechada antes que su factura.',
        },
        {
            match: /^La unidad de medida ".*" no es una de las de AFIP/i,
            title: 'Esa unidad de medida no existe en AFIP',
            detail: mainMsg,
            solucion: 'En la Factura E la unidad tiene que ser una de la lista de AFIP: <b>unidades</b>, <b>kilogramos</b>, <b>metros</b>, <b>litros</b>, <b>horas</b>, <b>docenas</b>, <b>toneladas</b>. En las facturas A, B y C esta columna es texto libre y solo se imprime en el PDF, por eso ahí no molesta.',
        },
        {
            match: /hay que mapear la columna que tiene el CAE de la factura de exportaci[oó]n/i,
            title: 'Falta emparejar la columna del CAE',
            detail: 'Para anular una Factura E, la app necesita saber en qué columna del tablero está el CAE de la factura que se ajusta.',
            solucion: 'Abrí la vista de la app → <b>Mapeo Visual</b> → en <b>Factura de referencia</b> elegí la columna donde ponés el CAE, y guardá. Después volvé al item y disparalo de nuevo.',
        },
        {
            match: /AFIP no tiene un "?CUIT pa[ií]s"?/i,
            title: 'AFIP no tiene CUIT para ese país',
            detail: mainMsg,
            solucion: 'Completá la columna <b>ID impositivo del cliente</b> del item con el número de identificación fiscal que use tu cliente en su país. Cuando AFIP no tiene un CUIT genérico para ese destino, ese dato pasa a ser obligatorio.',
        },
        {
            match: /^Esta es la instancia de PRUEBA \(staging\)/i,
            title: 'Es un problema nuestro de configuración',
            detail: 'La emisión entró por una copia de la app que no emite comprobantes fiscales.',
            solucion: 'Ya nos llegó el aviso y lo destrabamos en el momento. Hasta que te confirmemos no vuelvas a intentarlo: va a dar el mismo error. Si necesitás emitir hoy, escribinos a <b>arca@theautomationpartner.com</b>.',
        },
        {
            match: /^TEST forzado: error sistema simulado/i,
            title: 'Ese nombre de item está reservado',
            detail: 'El item se llama igual que el nombre que usamos internamente para probar los avisos de error, así que la app cortó a propósito.',
            solucion: 'Cambiale el nombre al item por cualquier otro y volvé a poner el estado que dispara la emisión.',
        },
        {
            match: /^El Punto de Venta ".*" no es v[aá]lido|punto de venta habilitado en AFIP para web/i,
            title: 'No pudimos leer el punto de venta',
            detail: mainMsg,
            solucion: 'En esa columna va solamente el número del punto de venta (1, 5, 0005). Si querés seguir viendo el nombre del local en el tablero, dejá el número ahí y usá otra columna aparte para el nombre.',
        },
        {
            // La NC/ND tiene que salir del MISMO punto de venta que la factura que
            // anula: AFIP lleva la numeracion por punto de venta.
            match: /pero esta .* anula la Factura .* que es del Punto de Venta|se emite desde el MISMO/i,
            title: 'La nota tiene que salir del mismo punto de venta que la factura',
            detail: mainMsg,
            solucion: 'Cambiá el punto de venta del item para que coincida con el de la factura que estás anulando, o dejá esa columna vacía y la app usa el correcto sola.',
        },
        {
            match: /no tiene los datos completos \(CAE|no se pudo determinar la letra de la factura original|le faltan tipo \/ punto de venta \/ n[uú]mero/i,
            title: 'A la factura referenciada le faltan datos',
            detail: 'La factura que estás anulando quedó guardada sin todos los datos que AFIP pide para vincularla (CAE, número, tipo o punto de venta).',
            solucion: 'Revisá que el CAE que pusiste sea el de una factura emitida por la app desde este mismo tablero. Si es la correcta y aun así falla, escribinos a <b>arca@theautomationpartner.com</b>: lo tenemos que destrabar nosotros.',
        },
        {
            match: /Una Nota de D[eé]bito E solo puede referenciar|no es una exportaci[oó]n de servicios/i,
            title: 'Esa nota no puede referenciar ese comprobante',
            detail: mainMsg,
            solucion: 'Revisá el CAE que cargaste: tiene que ser el de una Factura E de servicios, no el de otra nota ni el de una exportación de bienes.',
        },
        {
            match: /^No se puede emitir(?: la Factura E)?[^:]*:\s*•/i,
            title: 'Faltan datos para este comprobante',
            detail: subitemDetails.length > 0
                ? 'Completá esto y volvé a intentar:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>')
                : mainMsg,
            solucion: 'Corregí en el item lo que está marcado con ❌ y volvé a poner el estado que dispara la emisión.',
        },
        {
            match: /AFIP no devolvi[oó] CAE para/i,
            title: 'AFIP no devolvió el número del comprobante',
            detail: 'AFIP contestó, pero sin el CAE. <b>No se emitió nada</b>: sin CAE no hay comprobante.',
            solucion: 'Volvé a poner el estado que dispara la emisión. Si falla tres veces seguidas, esperá 15 minutos y probá otra vez. Si a la hora sigue igual, escribinos a <b>arca@theautomationpartner.com</b>.',
        },
        {
            match: /^Item \d+ no encontrado en Monday|^company no encontrada|^certs AFIP faltantes/i,
            title: 'No encontramos el item o la empresa',
            detail: 'La app no pudo leer el item, o la empresa que factura no está cargada.',
            solucion: 'Fijate si el item sigue en el tablero (mirá también la papelera de monday). Si está, revisá que la empresa esté cargada en la app → <b>Datos Fiscales</b>, con su certificado en <b>Certificados ARCA</b>.',
        },
        {
            match: /^Padr[oó]n HTTP|^No se pudo consultar el padr[oó]n para el DNI/i,
            title: 'AFIP no contestó sobre ese documento',
            detail: 'La app le preguntó a AFIP por los datos del cliente y no obtuvo respuesta. <b>No es un problema del número que cargaste.</b>',
            solucion: 'Esperá unos minutos y volvé a poner el estado que dispara la emisión, sin tocar nada del item. Si a la media hora sigue igual, escribinos.',
        },
        {
            match: /^Tipo de comprobante inv[aá]lido/i,
            title: 'No reconocemos ese tipo de comprobante',
            detail: mainMsg,
            solucion: 'En la columna Tipo de Comprobante dejá exactamente uno de estos, con el nombre completo: Factura, Nota de Crédito, Nota de Débito, Factura E, Nota de Crédito E o Nota de Débito E. Las abreviaturas (NC, ND, Fact) no las tomamos.',
        },
        {
            // Bugs o estados raros NUESTROS. La persona no puede hacer nada con el
            // detalle tecnico ("rowCount=0", "no hay secretos configurados"): solo la
            // asusta. Le decimos que es nuestro y que no toque nada. El detalle va al
            // log, que es donde sirve.
            // VA DESPUES de las reglas especificas: es una red, no un atajo.
            match: /rowCount|no impact[oó] la fila|no se pudo serializar|RESERVA_FALLIDA|lock qued[oó]|secretos configurados|MONDAY_CLIENT_SECRET|no se pudo resolver boardId|La empresa no tiene CUIT configurado|Documento inv[aá]lido para consultar padr[oó]n|Tipo de (factura )?\w* ?no soportado|devolvio cotizacion invalida|respuesta sin \w+ legible|sin FEXResultAuth|RECOVERY_MISMATCH/i,
            title: 'Es un problema nuestro',
            detail: 'La app se trabó por algo de nuestro lado. <b>No es un dato que hayas cargado mal</b>, así que revisar el item no lo va a resolver.',
            solucion: 'No toques nada ni vuelvas a intentarlo: ya nos llegó el aviso y lo estamos viendo. Si necesitás emitir hoy, escribinos a <b>arca@theautomationpartner.com</b>.',
        },
        {
            match: /token.*monday|no hay token|sessionToken/i,
            title: 'Error de autenticación con Monday',
            detail: 'La app no pudo acceder a los datos del tablero.',
            solucion: 'Cerrá la vista de la app y volvé a abrirla. Si el error sigue, desinstalá la app desde el tablero y volvé a instalarla desde el Marketplace de Monday.',
        },
        {
            match: /fechas de servicio obligatorias|fecha servicio desde|fecha servicio hasta/i,
            title: 'Fechas de servicio obligatorias',
            detail: mainMsg,
            solucion: 'Completá las columnas <b>Fecha Servicio Desde</b> y <b>Fecha Servicio Hasta</b> en el item. Son obligatorias cuando los subitems incluyen servicios.',
        },
        {
            match: /alícuota iva incompatible con factura c|nota de crédito c no lleva iva/i,
            title: 'El comprobante C no lleva IVA',
            detail: mainMsg,
            solucion: 'Los comprobantes C (Factura o Nota de Crédito) no discriminan IVA porque el emisor es Monotributista o Exento. Abrí los subítems del item y poné la columna <b>Alícuota IVA %</b> en <b>0</b> en todos. Después reintentá.',
        },
        {
            match: /alícuotas? iva diferentes|alícuotas? iva faltante|alícuota iva no válida/i,
            title: 'Alícuota IVA inválida',
            detail: subitemDetails.length > 0
                ? 'Los subitems tienen alícuotas IVA diferentes:<br/>' +
                  subitemDetails.map(l => l.replace('•', '').trim()).map(l => `&nbsp;&nbsp;- ${l}`).join('<br/>')
                : mainMsg,
            solucion: 'Todos los subitems de una factura deben tener la <b>misma alícuota IVA</b>. Revisá la columna Alícuota IVA % y asegurate de que todos los subitems tengan el mismo valor (0, 2.5, 5, 10.5, 21 o 27).',
        },
        {
            match: /tipo de comprobante no reconocido/i,
            title: 'Tipo de Comprobante no reconocido',
            detail: mainMsg,
            solucion: 'La columna <b>Tipo de Comprobante</b> del item tiene que decir <b>Factura</b>, <b>Nota de Crédito</b> o <b>Nota de Débito</b>. Corregí el valor y volvé a disparar la receta.',
        },
        {
            // Errores de la columna del CAE de referencia (Nota de Crédito).
            match: /cae de referencia|columna del cae|no se encontró ninguna factura/i,
            title: 'No se pudo identificar la factura a anular',
            detail: mainMsg,
            solucion: 'En el item de la Nota de Crédito, pegá en la columna del <b>CAE</b> el código de 14 dígitos de la factura que querés anular. Lo sacás del PDF de esa factura o del comentario que dejó la app cuando se emitió.',
        },
        {
            match: /item de nota de (cr[eé]dito|d[eé]bito) no tiene sub[ií]tems/i,
            title: 'La Nota de Crédito no tiene líneas para acreditar',
            detail: mainMsg,
            solucion: 'Agregá como <b>subítems</b> del item lo que querés acreditar — cada línea con Concepto, Cantidad y Precio. La Nota de Crédito se emite por la suma de esos subítems.',
        },
        {
            match: /supera el saldo disponible de la factura/i,
            title: 'La Nota de Crédito supera el saldo de la factura',
            detail: mainMsg,
            solucion: 'No se puede acreditar más de lo que se facturó. Bajá los importes de los subítems para que el total no supere el <b>saldo disponible</b> indicado arriba.',
        },
        {
            match: /alícuota iva de la nota de crédito.*no coincide/i,
            title: 'La alícuota IVA de la Nota de Crédito no coincide con la factura',
            detail: mainMsg,
            solucion: 'La Nota de Crédito se acredita con el mismo IVA que se facturó. Ajustá la columna <b>Alícuota IVA %</b> de los subítems para que coincida con la de la factura original.',
        },
        {
            match: AFIP_IDEMPOTENT_ERROR_PATTERN,
            title: 'Ya se emitió un comprobante para este item',
            detail: mainMsg,
            solucion: 'Cada item del tablero corresponde a <b>un solo comprobante</b>. ' +
                'Para emitir otro, <b>creá un item nuevo</b> en el tablero y disparálo ' +
                'desde ahí. Esto evita duplicar comprobantes en AFIP.',
        },
    ];

    // Versión en inglés de KNOWN_ERRORS para boards en inglés. MISMOS `match`
    // (la app tira los errores en español, así que el regex matchea igual); solo
    // cambia el texto user-facing. Las partes dinámicas (mainMsg, subitemDetails)
    // se reusan tal cual.
    const KNOWN_ERRORS_EN = [
        {
            match: /Item incompleto/i,
            title: 'Missing item data',
            detail: subitemDetails.length > 0
                ? 'Fill in these columns (empty or with invalid data) and trigger the recipe again:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>')
                : 'There are required fields missing in the item or its subitems.',
            solucion: "Open the item, fill in the columns marked with ❌ and retry. If a column is missing, check the <b>Visual Mapping</b> in the app's configuration view.",
        },
        {
            match: /falta.*mapeo|falta.*configurar.*mapeo|falta.*mapping/i,
            title: 'Column mapping not configured',
            detail: "The board doesn't have configured which column corresponds to each invoice field.",
            solucion: "Open the app's view → <b>Visual Mapping</b> section → select the columns and save.",
        },
        {
            // Espejo de la entrada en español: sin esto el comentario muestra solo
            // la primera línea y se pierde el detalle por subítem.
            match: /discount amounts/i,
            title: 'Problems with the subitem discounts',
            detail: subitemDetails.length > 0
                ? 'Check these subitems:<br/><br/>' +
                  subitemDetails.map(l => l.replace(/^•\s*/, '').trim()).map(l => `&nbsp;&nbsp;❌&nbsp;&nbsp;${l}`).join('<br/>')
                : 'One of the subitems has an invalid discount amount.',
            solucion: 'The discount is an <b>amount</b> (not a percentage), applies to the <b>whole line</b> (quantity × price) and uses the <b>same currency as the unit price</b>. It cannot be negative or exceed the line total.',
        },
        {
            match: /discounts consumed the entire/i,
            title: 'The voucher total came out as zero',
            detail: mainMsg,
            solucion: 'Lower the discount amounts so the total is above zero — AFIP rejects vouchers with a total of zero or less.',
        },
        {
            match: /no hay.*subitems|no hay líneas|sin.*subitems|validLines.*0|no valid lines/i,
            title: 'Incomplete or missing subitems',
            detail: subitemDetails.length > 0
                ? 'The following subitems have empty or invalid fields:<br/>' +
                  subitemDetails.map(l => l.replace('•', '').trim()).map(l => `&nbsp;&nbsp;- ${l}`).join('<br/>')
                : 'No subitems found with Description, Quantity and Unit Price filled in.',
            solucion: 'Check each subitem and fill in the required fields: <b>Description</b>, <b>Quantity</b> (number) and <b>Unit Price</b> (number). If there are none, create at least one.',
        },
        {
            match: /Configuración incompleta|incomplete configuration/i,
            title: 'Incomplete configuration',
            detail: mainMsg,
            solucion: "Open the app's view → complete the pending steps in <b>Visual Mapping</b>. Make sure to map all required columns.",
        },
        {
            match: /faltan? (los )?certificados?|falta subir el certificado|certificate not uploaded|certificados?.*afip|falta.*crt|falta.*key/i,
            title: 'Missing AFIP certificates',
            detail: 'No digital certificates were found to authenticate with AFIP.',
            solucion: "Open the app's view → <b>ARCA Certificates</b> section → upload the .crt file and the private key (.key).",
        },
        {
            // OJO: antes era /certificados.*expirados|expir/i. El "expir" suelto se
            // robaba "el token expiró", "el CAE expiró" y "fecha de expiración" — y
            // encima NO agarraba el mensaje real, que dice "Certificados AFIP vencidos".
            // Estaba al revés. Ahora se exige la palabra certificado cerca.
            // El comodín va ACOTADO: .{0,30} no puede cruzar de una oración a otra
            // (y el . no matchea saltos de línea). Es la diferencia entre "cerca de
            // la palabra certificado" y "en cualquier parte del mensaje".
            match: /certificados?.{0,30}(vencid|expirad|expir[oó])|certificate.{0,20}expired/i,
            title: 'AFIP certificates expired',
            detail: 'The digital certificates are expired and AFIP rejects the authentication.',
            solucion: "Generate new certificates in AFIP/ARCA and upload them in the app's view → <b>ARCA Certificates</b> section.",
        },
        {
            match: /tipo de factura incorrecto/i,
            title: 'Incorrect invoice type',
            detail: mainMsg,
            solucion: "Check two things:<br/>&nbsp;&nbsp;1) In the app, open <b>Tax Details</b> and confirm your company's <b>VAT Condition</b> is set correctly (Registered, Monotributo, etc.).<br/>&nbsp;&nbsp;2) In the item, confirm the <b>recipient CUIT</b> is correct. The app automatically asks AFIP for the recipient's condition to decide whether A, B or C applies.",
        },
        {
            match: /este item (ya emiti[oó]|est[aá] emitiendo|tiene.*n[uú]mero reservado)|this item (already issued|is currently issuing|has a .*number reserved)/i,
            title: 'This item already has a voucher',
            detail: mainMsg,
            solucion: 'Each item corresponds to <b>a single voucher</b>. To issue another — or the Credit Note for this invoice — create a <b>new item</b> on the board. The Credit Note references the invoice by its CAE.',
        },
        {
            match: /cuit.*inválido|cuit.*invalido|cuit.*vac|receptor_cuit.*null/i,
            title: 'Invalid recipient CUIT / DNI',
            detail: mainMsg,
            solucion: 'Fill in the <b>Recipient CUIT / DNI</b> column of the item with an <b>11-digit CUIT</b> (e.g. 20327446348) or a <b>7 or 8-digit DNI</b>. No dashes or spaces. If the sale is to an unidentified final consumer, leave the column <b>empty</b>.',
        },
        {
            // OJO con el orden: gana la PRIMERA regla que matchea. La de "ese CUIT
            // no existe" tiene que ir arriba de esta, porque su mensaje también
            // contiene "Padrón AFIP" y esta genérica se lo comería.
            match: /no existe persona con ese id|ese cuit no existe en afip/i,
            title: 'Ese CUIT no existe en AFIP',
            detail: mainMsg,
            solucion: 'Abrí el item y revisá el CUIT del cliente: son 11 dígitos, sin puntos ni guiones. Un solo dígito cambiado alcanza para que AFIP no lo encuentre. Corregilo y volvé a poner el estado que dispara la emisión.',
        },
        {
            match: /padrón.*error|padron.*error|padrón.*falló|padron.*fallo/i,
            title: 'Error querying the AFIP registry',
            detail: mainMsg,
            solucion: "If the message above points to a specific problem with the CUIT (inactive, pending requirements, etc.), the owner of that CUIT has to resolve it directly with AFIP — retrying won't help. If it doesn't give more detail, it may be a temporary AFIP outage: wait a few minutes and retry.",
        },
        {
            match: /empresa no encontrada|no encontrada.*cuenta/i,
            title: 'Company not configured',
            detail: 'The tax data of the issuing company was not found.',
            solucion: "Open the app's view → <b>Tax Details</b> section → fill in Legal Name, CUIT, Point of Sale and save.",
        },
        {
            match: /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|network.*error|terminated/i,
            title: 'Temporary connection failure with AFIP',
            detail: 'It was a network glitch, not a problem with your data. The voucher was <b>not issued</b> (no duplicate).',
            solucion: 'Trigger the recipe again. If it keeps failing, wait a few minutes and retry.',
        },
        {
            // Espejo del de KNOWN_ERRORS: AFIP contestó y rechazó. Va ANTES del
            // genérico porque "[wsfex:...]" matchea /wsfe/.
            match: /\[wsfex:\w+\]\s*\[\d+\]/i,
            title: 'AFIP rejected the Factura E',
            detail: 'AFIP responded, but did not accept the voucher. It <b>was not issued</b> (no number was burned).<br/><br/>' +
                'What AFIP said:<br/>' +
                `&nbsp;&nbsp;❌&nbsp;&nbsp;${mainMsg.replace(/^\[wsfex:\w+\]\s*/, '')}`,
            solucion: "If the message mentions an item field (destination country, payment date, client's address), fix it and re-trigger the recipe. If it doesn't make sense to you, pass this message to the app's support.",
        },
        {
            match: /wsfe|wsaa|soap|afip.*http|loginCms|afip.*500|afip.*timeout/i,
            title: 'AFIP is not responding correctly',
            detail: "AFIP's servers didn't respond in time or returned an error. <b>This is not a configuration problem on your end</b>, it's on AFIP's side.",
            solucion: "Wait a few minutes and try again. AFIP usually has brief outages or maintenance. If it's still failing after 30 minutes, contact the app's support.",
        },
        {
            match: /token.*monday|no hay token|sessionToken/i,
            title: 'monday authentication error',
            detail: "The app couldn't access the board data.",
            solucion: "Close the app's view and reopen it. If the error persists, uninstall the app from the board and reinstall it from the monday Marketplace.",
        },
        {
            match: /fechas de servicio obligatorias|fecha servicio desde|fecha servicio hasta|missing required service dates/i,
            title: 'Service dates required',
            detail: mainMsg,
            solucion: 'Fill in the <b>Service Date From</b> and <b>Service Date To</b> columns in the item. They are required when the subitems include services.',
        },
        {
            match: /alícuota iva incompatible con factura c|nota de crédito c no lleva iva|vat rate incompatible with invoice c/i,
            title: "C voucher doesn't carry VAT",
            detail: mainMsg,
            solucion: "C vouchers (Invoice or Credit Note) don't break out VAT because the issuer is Monotributo or Exempt. Open the item's subitems and set the <b>VAT Rate %</b> column to <b>0</b> on all of them. Then retry.",
        },
        {
            match: /alícuotas? iva diferentes|alícuotas? iva faltante|alícuota iva no válida|missing vat rate|different vat rates|invalid vat rate/i,
            title: 'Invalid VAT rate',
            detail: subitemDetails.length > 0
                ? 'The subitems have different VAT rates:<br/>' +
                  subitemDetails.map(l => l.replace('•', '').trim()).map(l => `&nbsp;&nbsp;- ${l}`).join('<br/>')
                : mainMsg,
            solucion: 'All subitems of an invoice must have the <b>same VAT rate</b>. Check the VAT Rate % column and make sure all subitems have the same value (0, 2.5, 5, 10.5, 21 or 27).',
        },
        {
            match: /tipo de comprobante no reconocido|voucher type not recognized/i,
            title: 'Voucher Type not recognized',
            detail: mainMsg,
            solucion: "The item's <b>Voucher Type</b> column must say <b>Invoice</b>, <b>Credit Note</b> or <b>Debit Note</b>. Fix the value and trigger the recipe again.",
        },
        {
            match: /cae de referencia|columna del cae|no se encontró ninguna factura|reference cae|no invoice.*found with cae/i,
            title: "Couldn't identify the invoice to cancel",
            detail: mainMsg,
            solucion: "In the Credit Note item, paste the 14-digit <b>CAE</b> of the invoice you want to cancel into the CAE column. You get it from that invoice's PDF or from the comment the app left when it was issued.",
        },
        {
            match: /(credit|debit) note item has no subitems/i,
            title: 'The Credit Note has no lines to credit',
            detail: mainMsg,
            solucion: 'Add what you want to credit as <b>subitems</b> of the item — each line with Description, Quantity and Price. The Credit Note is issued for the sum of those subitems.',
        },
        {
            match: /exceeds the available invoice balance/i,
            title: 'The Credit Note exceeds the invoice balance',
            detail: mainMsg,
            solucion: "You can't credit more than what was invoiced. Lower the subitem amounts so the total doesn't exceed the <b>available balance</b> shown above.",
        },
        {
            match: /vat rate.*doesn't match the invoice/i,
            title: "The Credit Note's VAT rate doesn't match the invoice",
            detail: mainMsg,
            solucion: 'The Credit Note is credited with the same VAT that was invoiced. Adjust the <b>VAT Rate %</b> column of the subitems to match the original invoice.',
        },
        {
            match: AFIP_IDEMPOTENT_ERROR_PATTERN,
            title: 'A voucher was already issued for this item',
            detail: mainMsg,
            solucion: 'Each board item corresponds to <b>a single voucher</b>. To issue another, <b>create a new item</b> on the board and trigger it from there. This avoids duplicating vouchers in AFIP.',
        },
    ];

    const isEn = language === 'en';
    const errorsArr = isEn ? KNOWN_ERRORS_EN : KNOWN_ERRORS;
    const known = errorsArr.find(e => e.match.test(msg));
    const A = isEn
        ? { issue: "Couldn't issue", cause: 'Cause:', fix: 'How to fix it:',
            fallback: "Review the item data and retry. If the error persists, contact the app's support with the item name." }
        : { issue: 'No se pudo emitir', cause: 'Causa:', fix: 'Cómo solucionarlo:',
            fallback: 'Revisá los datos del item y reintentá. Si el error persiste, contactá al soporte de la app indicando el nombre del item.' };

    if (known) {
        return `<b>❌ ${A.issue} ${kindArticle(kind, language)}</b><br/><br/>` +
            `<b>${A.cause}</b> ${known.title}<br/>${known.detail}<br/><br/>` +
            `<b>${A.fix}</b> ${known.solucion}`;
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
    const IMPERATIVO = isEn
        ? /\b(Open|Go to|Check|Fix|Set|Enter|Write|Upload|Complete|Retry|Choose|Make sure)(?=\s)/
        : /(^|[\s.—–-])(Abr[ií]|And[aá]|Revis[aá]|Correg[ií]|Pon[eé]|Escrib[ií]|Sub[ií]|Complet[aá]|Reintent[aá]|Eleg[ií]|Carg[aá]|Fijate|Verific[aá]|Cambi[aá]|Dale de alta|Consult[aá]|Ped[ií]|Volv[eé] a|Asegurate|Tild[aá]|Us[aá]|Copi[aá]|Borr[aá]|Cre[aá]|Configur[aá]|Sac[aá]|Dej[aá]|Mir[aá]|Segu[ií])(l[oa]s?|le|nos)?(?=[\s,.])/;

    // El mensaje completo, no solo la primera línea: la instrucción suele venir
    // después del punto o en la línea siguiente.
    const completo = String(msg).trim();
    const corte = completo.search(IMPERATIVO);
    if (corte > 0) {
        const causa = completo.slice(0, corte).trim().replace(/[\s—–-]+$/, '');
        const comoSe = completo.slice(corte).trim();
        // Solo si las dos partes tienen sustancia; si no, se muestra entero.
        if (causa.length > 12 && comoSe.length > 12) {
            return `<b>❌ ${A.issue} ${kindArticle(kind, language)}</b><br/><br/>` +
                `<b>${A.cause}</b> ${causa}<br/><br/>` +
                `<b>${A.fix}</b> ${comoSe}`;
        }
    }

    return `<b>❌ ${A.issue} ${kindArticle(kind, language)}</b><br/><br/>` +
        `<b>${A.cause}</b> ${mainMsg}<br/><br/>` +
        `<b>${A.fix}</b> ${A.fallback}`;
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

module.exports = { buildErrorComment, kindArticle, AFIP_IDEMPOTENT_ERROR_PATTERN };
