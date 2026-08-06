/**
 * afipPadron.js — Consulta de constancia de inscripción AFIP (Padrón A5).
 *
 * Servicio: ws_sr_constancia_inscripcion
 * Endpoint: PadronA5Service
 *
 * Permite saber si un CUIT es RI, Monotributista, Exento o CF.
 * Los certificados para consultar son los de Martín, cargados como env var/secret
 * en Monday Code (PADRON_CRT y PADRON_KEY).
 *
 * Uso:
 *   const { getCondicionFiscal } = require('./afipPadron');
 *   const info = await getCondicionFiscal({ cuitAConsultar: '20XXXXXXXXX' });
 *   // info.condicion === 'RESPONSABLE_INSCRIPTO' | 'MONOTRIBUTO' | 'EXENTO' | 'CONSUMIDOR_FINAL'
 */

'use strict';

const { getToken, invalidateToken } = require('./afipAuth');
const config = require('../config');

const PADRON_SERVICE = 'ws_sr_constancia_inscripcion';

// IDs de impuesto del padrón que sabemos traducir a una condición frente al IVA.
// 20=Monotributo, 30=Responsable Inscripto, 32=Exento, 34=No Alcanzado.
// Si aparece un impuesto de IVA fuera de esta lista, parseCondicionFiscal lo
// reporta en `ivaSinMapear` para que se avise (ver el final de esa función).
const KNOWN_IVA_IMPUESTOS = new Set(['20', '30', '32', '34']);

// ─── Helpers de PEM ──────────────────────────────────────────────────────────

function normalizePem(raw, type) {
    if (!raw) return null;
    let clean = raw
        .replace(/-----BEGIN [^-]+-----/g, '')
        .replace(/-----END [^-]+-----/g, '')
        .replace(/[\r\n\s]/g, '');
    const lines = clean.match(/.{1,64}/g) || [];
    return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----`;
}

// ─── Cargar certificados de entorno ──────────────────────────────────────────

/**
 * Carga certPem y keyPem desde env var (PADRON_CRT) y secret (PADRON_KEY).
 * El .crt de Martín es público; el .key es sensible y va como secret.
 */
function loadPadronCredentials() {
    const crtRaw = config.padronCrt;
    const keyRaw = config.padronKey;

    if (!crtRaw) {
        throw new Error(
            'Falta PADRON_CRT en variables de entorno. ' +
            'Cargá el contenido del .crt de Martín en el Developer Center de Monday Code.'
        );
    }
    if (!keyRaw) {
        throw new Error(
            'Falta PADRON_KEY en secrets. ' +
            'Cargá el contenido del .key de Martín como secret en el Developer Center de Monday Code.'
        );
    }

    return {
        certPem: normalizePem(crtRaw, 'CERTIFICATE'),
        keyPem:  normalizePem(keyRaw, 'PRIVATE KEY'),
    };
}

// ─── SOAP: consultar padrón ───────────────────────────────────────────────────

function buildGetPersonaSoap({ token, sign, cuitRepresentada, idPersona }) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:a5="http://a5.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <a5:getPersona_v2>
      <token>${token}</token>
      <sign>${sign}</sign>
      <cuitRepresentada>${cuitRepresentada}</cuitRepresentada>
      <idPersona>${idPersona}</idPersona>
    </a5:getPersona_v2>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/** Extrae texto de un tag XML (primer match) */
function xmlTag(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? m[1].trim() : null;
}

/**
 * Determina la condición IVA a partir del XML de respuesta del padrón (getPersona_v2).
 *
 * Respuesta v2 incluye:
 *   - <persona><idPersona>, <nombre>/<apellido>/<razonSocial>, <tipoPersona>, <estadoClave>
 *   - <persona><categoriasMonotributo> o <persona><categoriaMonotributo>  (monotributistas)
 *   - <persona><impuesto><idImpuesto>20</idImpuesto>  (20 = Monotributo)
 *   - <persona><impuesto><idImpuesto>30</idImpuesto>  (30 = IVA Responsable Inscripto)
 *   - <persona><impuesto><idImpuesto>32</idImpuesto>  (32 = IVA Exento)
 *   - <persona><impuesto><idImpuesto>34</idImpuesto>  (34 = IVA No Alcanzado)
 *
 * Lógica de prioridad:
 *   1. errorConstancia != 0  → throw
 *   2. estadoClave != ACTIVO → throw (CUIT inactivo)
 *   3. impuesto id=20 activo → MONOTRIBUTO
 *   4. impuesto id=30 activo → RESPONSABLE_INSCRIPTO
 *   5. impuesto id=32 activo → EXENTO
 *   6. impuesto id=34 activo → NO_ALCANZADO
 *   7. categoriasMonotributo presente → MONOTRIBUTO (fallback)
 *   8. default                         → CONSUMIDOR_FINAL
 */
function parseCondicionFiscal(xml) {
    const { IVA_CONDITION } = config;

    // ── Chequeo errorConstancia ─────────────────────────────────────────────
    // AFIP puede devolver <errorConstancia> con:
    //   - Apellido "OBSERV" = CUIT observado (tiene datos parciales, no es error fatal)
    //   - <error> con mensajes de observación (domicilio fiscal, actividades, etc.)
    //   - Sin bloque <persona> separado (los datos básicos vienen dentro de errorConstancia)
    const errorConstanciaBlock = xml.match(/<errorConstancia>([\s\S]*?)<\/errorConstancia>/i);
    let isObservado = false;
    let errorNombre = null;
    let errorApellido = null;

    if (errorConstanciaBlock) {
        const ecContent = errorConstanciaBlock[1];
        errorApellido = xmlTag(ecContent, 'apellido');
        errorNombre   = xmlTag(ecContent, 'nombre');

        if (errorApellido && errorApellido.toUpperCase() === 'OBSERV') {
            // CUIT observado: no es error fatal, extraer datos parciales
            isObservado = true;
            console.log(`[padron] CUIT observado — nombre: ${errorNombre}, observaciones presentes`);
        } else {
            // Error real del servicio
            const errorMsg = xmlTag(xml, 'errorMsgConstancia')
                || xmlTag(ecContent, 'error')
                || ecContent;
            // B12: classify para que el caller pueda distinguir entre CUIT
            // inactivo (mensaje "no figura inscripto", "sin actividad") vs CUIT
            // malformado / inexistente. Sin chips el mensaje generico llega al
            // usuario como "padron error" sin diferenciacion.
            const lower = String(errorMsg || '').toLowerCase();
            const looksInactive = /sin\s+actividad|no\s+figura\s+inscript|inactiv|cancelad/i.test(lower);
            const err = new Error(`Padrón AFIP error: ${errorMsg}`);
            err.errorType = looksInactive ? 'CUIT_INACTIVO' : 'CONSTANCIA_ERROR';
            err.padronRaw = errorMsg;
            throw err;
        }
    }

    // Nombre: v2 usa razonSocial (jurídica) o nombre+apellido (física)
    const razonSocial = xmlTag(xml, 'razonSocial');
    const nombreField = xmlTag(xml, 'nombre');
    const apellido    = xmlTag(xml, 'apellido');

    let nombre;
    if (razonSocial) {
        nombre = razonSocial;
    } else if (isObservado) {
        // Para CUITs observados, el nombre viene dentro de errorConstancia
        // El apellido es "OBSERV" (status marker), no un apellido real
        nombre = errorNombre || nombreField || 'SIN NOMBRE';
    } else {
        nombre = [nombreField, apellido].filter(Boolean).join(' ').trim()
            || xmlTag(xml, 'denominacion')
            || 'SIN NOMBRE';
    }

    const tipoPersona = (xmlTag(xml, 'tipoPersona') || 'FISICA').toUpperCase();

    // Estado de la clave fiscal (ACTIVO / INACTIVO)
    const estadoClave = (xmlTag(xml, 'estadoClave') || '').toUpperCase();
    if (estadoClave && estadoClave !== 'ACTIVO' && !isObservado) {
        // B12: tag explicito de "CUIT existe pero no esta activo" para que el
        // caller no lo trate igual que un CUIT mal formado.
        const err = new Error(`CUIT con estado ${estadoClave} en padrón AFIP`);
        err.errorType = 'CUIT_INACTIVO';
        err.estadoClave = estadoClave;
        throw err;
    }

    // ── Chequeo impuestos activos ─────────────────────────────────────────
    const impuestoBlocks = xml.match(/<impuesto>([\s\S]*?)<\/impuesto>/gi) || [];
    const activos = new Set();
    const detalleImpuestos = [];
    for (const block of impuestoBlocks) {
        const id     = xmlTag(block, 'idImpuesto');
        const estado = (xmlTag(block, 'estado') || 'ACTIVO').toUpperCase();
        if (id && estado === 'ACTIVO') activos.add(id);
        // El estado real viene en <estadoImpuesto> (AC / EX / NA). Se guarda solo
        // para poder informarlo en la alerta de abajo: la clasificación sigue
        // usando `activos` tal como venía, para no cambiar comportamiento.
        if (id) {
            detalleImpuestos.push({
                id,
                desc:   xmlTag(block, 'descripcionImpuesto') || '',
                estado: xmlTag(block, 'estadoImpuesto') || '?',
            });
        }
    }

    const domicilio = parseDomicilio(xml);

    // 20 = Monotributo
    if (activos.has('20')) {
        return { condicion: IVA_CONDITION.MONOTRIBUTO, nombre, tipoPersona, domicilio, raw: xml };
    }
    // 30 = IVA Responsable Inscripto
    if (activos.has('30')) {
        return { condicion: IVA_CONDITION.RI, nombre, tipoPersona, domicilio, raw: xml };
    }
    // 32 = IVA Exento
    if (activos.has('32')) {
        return { condicion: IVA_CONDITION.EXENTO, nombre, tipoPersona, domicilio, raw: xml };
    }
    // 34 = IVA NO ALCANZADO. Va DESPUES de 20/30/32: si el CUIT tuviera ademas
    // una inscripcion real de IVA, esa manda. Sin este caso el receptor caia al
    // default CONSUMIDOR_FINAL del final de la funcion — que es lo que pasaba
    // con los organismos publicos (municipios, etc.): se les emitia la factura
    // como "Consumidor Final" y AFIP la registraba con CondicionIVAReceptorId=5,
    // por lo que el organismo la rechazaba y no podia procesar el pago.
    if (activos.has('34')) {
        return { condicion: IVA_CONDITION.NO_ALCANZADO, nombre, tipoPersona, domicilio, raw: xml };
    }

    // Fallback: si trae bloques de monotributo pero ningún impuesto id=20 activo
    if (xml.includes('<categoriasMonotributo>') || xml.includes('<categoriaMonotributo>')) {
        return { condicion: IVA_CONDITION.MONOTRIBUTO, nombre, tipoPersona, domicilio, raw: xml };
    }

    // Fallback final: condicionIva directo (versiones antiguas del WS)
    const condIva = (xmlTag(xml, 'condicionIva') || xmlTag(xml, 'condIva') || '').toUpperCase();
    if (condIva.includes('INSCRIPTO') || condIva.includes('RESPONSABLE')) {
        return { condicion: IVA_CONDITION.RI, nombre, tipoPersona, domicilio, raw: xml };
    }
    if (condIva.includes('MONOTRIBUT')) {
        return { condicion: IVA_CONDITION.MONOTRIBUTO, nombre, tipoPersona, domicilio, raw: xml };
    }
    if (condIva.includes('EXENTO')) {
        return { condicion: IVA_CONDITION.EXENTO, nombre, tipoPersona, domicilio, raw: xml };
    }

    // Para CUITs observados sin impuestos activos, usar CONSUMIDOR_FINAL
    if (isObservado) {
        console.log(`[padron] CUIT observado sin impuestos activos → CONSUMIDOR_FINAL`);
    }

    // Llegar acá significa que NINGUNO de los impuestos que sabemos mapear
    // (20/30/32/34) está activo, así que la condición se resuelve por descarte
    // como CONSUMIDOR_FINAL. Eso es correcto para un consumidor final de verdad
    // (solo Ganancias, Bienes Personales, etc.), pero fue exactamente lo que
    // hizo que a un municipio se le facturara como "Consumidor Final": tenía el
    // impuesto 34 (IVA No Alcanzado), que entonces no estaba mapeado.
    //
    // Se reporta el dato para que el caller pueda avisar. NO se lanza error ni
    // se cambia la condición: la emisión sigue funcionando igual que siempre.
    // Solo se marca cuando hay algo con pinta de IVA/Monotributo sin mapear —
    // un CF legítimo no trae nada de eso, así que no genera ruido. Los regímenes
    // de retención (SIRE-IVA, faena bovino) solo aparecen acá si el receptor
    // además no tiene ningún impuesto conocido.
    const ivaSinMapear = detalleImpuestos.filter(
        i => /\bIVA\b|MONOTRIBUT/i.test(i.desc) && !KNOWN_IVA_IMPUESTOS.has(i.id)
    );

    return {
        condicion: IVA_CONDITION.CF,
        nombre, tipoPersona, domicilio, raw: xml,
        ivaSinMapear: ivaSinMapear.length ? ivaSinMapear : undefined,
    };
}

/** Extrae domicilio fiscal del XML de getPersona_v2 */
function parseDomicilio(xml) {
    // El padrón devuelve el domicilio en <domicilioFiscal> (v2 actual).
    // Mantenemos <domicilio> como fallback por compatibilidad.
    const domBlocks = [
        ...(xml.match(/<domicilioFiscal>([\s\S]*?)<\/domicilioFiscal>/gi) || []),
        ...(xml.match(/<domicilio>([\s\S]*?)<\/domicilio>/gi) || []),
    ];
    let fiscal = null;
    let primero = null;
    for (const block of domBlocks) {
        const tipo = (xmlTag(block, 'tipoDomicilio') || '').toUpperCase();
        const dir  = xmlTag(block, 'direccion') || '';
        const loc  = xmlTag(block, 'localidad') || '';
        const prov = xmlTag(block, 'descripcionProvincia') || xmlTag(block, 'idProvincia') || '';
        const full = [dir, loc, prov].filter(Boolean).join(', ').toUpperCase();
        if (!primero && full) primero = full;
        if (tipo === 'FISCAL AFIP' || tipo === 'FISCAL' || tipo.includes('FISCAL')) {
            fiscal = full;
            break;
        }
    }
    return fiscal || primero || null;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Consulta la condición fiscal de un CUIT usando el servicio de padrón de AFIP.
 *
 * @param {object} opts
 * @param {string}  opts.cuitAConsultar - CUIT a consultar (emisor o receptor)
 * @param {string}  [opts.certPem]      - Certificado PEM (override; si no se pasa, se carga de env)
 * @param {string}  [opts.keyPem]       - Clave privada PEM (override)
 *
 * @returns {Promise<{
 *   condicion: string,
 *   nombre: string,
 *   tipoPersona: string,
 *   raw: string
 * }>}
 */
async function getCondicionFiscal({ cuitAConsultar, certPem, keyPem }) {
    const cuit = String(cuitAConsultar).replace(/\D/g, '');
    if (!cuit || cuit.length < 11) {
        throw new Error(`CUIT inválido para consultar padrón: "${cuitAConsultar}"`);
    }

    // Cargar certs si no se proveyeron directamente
    if (!certPem || !keyPem) {
        const creds = loadPadronCredentials();
        certPem = creds.certPem;
        keyPem  = creds.keyPem;
    }

    const padronCuit = config.padronCuit;

    // Obtener token (con caché)
    let tokenData;
    try {
        tokenData = await getToken({ certPem, keyPem, cuit: padronCuit, service: PADRON_SERVICE });
    } catch (err) {
        throw new Error(`Error autenticando en WSAA para padrón: ${err.message}`);
    }

    const soapBody = buildGetPersonaSoap({
        token:           tokenData.token,
        sign:            tokenData.sign,
        cuitRepresentada: padronCuit,
        idPersona:       cuit,
    });

    const response = await fetch(config.endpoints.padron, {
        method:  'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction:     '',
        },
        body: soapBody,
    });

    const xmlText = await response.text();

    if (!response.ok) {
        // Si el token expiró, invalidar caché y reintentar una vez
        if (response.status === 401 || xmlText.includes('Token expirado') || xmlText.includes('CMSError')) {
            invalidateToken(PADRON_SERVICE, padronCuit);
            tokenData = await getToken({ certPem, keyPem, cuit: padronCuit, service: PADRON_SERVICE, force: true });
            const retryBody = buildGetPersonaSoap({
                token: tokenData.token, sign: tokenData.sign,
                cuitRepresentada: padronCuit, idPersona: cuit,
            });
            const retry = await fetch(config.endpoints.padron, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'urn:PadronA5SoapIFace#getPersona' },
                body: retryBody,
            });
            return parseCondicionFiscal(await retry.text());
        }
        // AFIP responde los CUIT inexistentes con HTTP 500 + SOAP Fault, NO con un
        // 200 + errorConstancia. Sin clasificar acá, el error llegaba pelado a
        // server.js y caía en la rama del genérico "AFIP puede estar caído o lento,
        // reintentá" — o sea, le echábamos la culpa a AFIP de un CUIT mal tipeado.
        //
        // Es el caso Polifroni: su CUIT tenía el dígito verificador mal, AFIP
        // contestó "No existe persona con ese Id", y al cliente le dijimos que
        // esperara a que AFIP se recuperara. Esperó, nunca se arregló, y terminó
        // facturando a mano.
        //
        // El marcador confiable es SRValidationException: AFIP lo usa para los
        // errores de DATO (el id no existe / no es válido), no para sus propias
        // caídas. Si viene eso, el problema es el número que cargó el usuario y
        // reintentar no lo arregla nunca.
        const faultString = xmlTag(xmlText, 'faultstring');
        const esErrorDeDato = /SRValidationException/i.test(xmlText)
            || /no existe persona|id.*no.*v[aá]lid|persona.*no.*encontrad/i.test(faultString || '');
        if (faultString && esErrorDeDato) {
            const err = new Error(`Padrón AFIP: ${faultString}`);
            err.errorType = 'CUIT_INEXISTENTE';
            err.padronRaw = faultString;
            throw err;
        }
        // Sin fault de validación → sí es un problema del lado de AFIP y ahí el
        // genérico "reintentá en unos minutos" es el mensaje correcto.
        throw new Error(`Padrón HTTP ${response.status}: ${xmlText.substring(0, 300)}`);
    }

    return parseCondicionFiscal(xmlText);
}

// ─── DNI → CUIT (Módulo 11 de AFIP) ─────────────────────────────────────────

/**
 * Dado un DNI (7-8 dígitos), genera los posibles CUITs válidos
 * probando prefijos 20 (M), 27 (F), 23, 24 con dígito verificador Módulo 11.
 */
function dniToPossibleCuits(dni) {
    const doc = String(dni).replace(/\D/g, '');
    if (doc.length === 11) return [doc]; // ya es CUIT
    if (doc.length < 7 || doc.length > 8) return [doc];

    function calcularCuit(d, prefijo) {
        const base = prefijo.toString() + d.padStart(8, '0');
        const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
        let suma = 0;
        for (let i = 0; i < 10; i++) suma += parseInt(base[i]) * mult[i];
        const resto = suma % 11;
        let dv = 11 - resto;
        if (dv === 11) dv = 0;
        if (dv === 10) return null;
        return base + dv.toString();
    }

    const results = [];
    for (const p of [20, 27, 23, 24]) {
        const cuit = calcularCuit(doc, p);
        if (cuit) results.push(cuit);
    }
    return results;
}

// El dígito verificador se calcula sin red — por eso vive en un módulo que no
// importa nada, y por eso se puede probar en el CI sin instalar dependencias.
// Se re-exporta desde acá para no cambiarle el import a quien ya lo usa.
const { cuitDvValido } = require('./documentoReceptor');

/**
 * Dado un DNI o CUIT, intenta obtener la condición fiscal.
 * Si es DNI, prueba cada CUIT posible contra el padrón hasta encontrar uno válido.
 */
/**
 * Un fallo de probe es "el CUIT no existe / no esta inscripto" (esperable: se
 * prueban 4 prefijos y 3 fallan) o un fallo de INFRAESTRUCTURA (red, WSAA,
 * HTTP 5xx). Solo el primero habilita el fallback a Consumidor Final.
 * parseCondicionFiscal ya etiqueta los errores propios del padrón con errorType.
 */
function esPadronNotFound(err) {
    // CUIT_INEXISTENTE va acá también: cuando se prueban los 4 prefijos de un DNI,
    // que 3 no existan es lo normal y NO es una caída de AFIP. Sin esto, el primer
    // prefijo inexistente se tomaba como fallo de infraestructura y abortaba la
    // búsqueda antes de llegar al prefijo bueno.
    return err?.errorType === 'CONSTANCIA_ERROR'
        || err?.errorType === 'CUIT_INACTIVO'
        || err?.errorType === 'CUIT_INEXISTENTE';
}

async function getCondicionFiscalByDoc({ documento, certPem, keyPem }) {
    const doc = String(documento).replace(/\D/g, '');

    // Validación de forma ANTES de consultar. Sin esto un número malformado
    // (typo, columna truncada: 9, 10 o 12+ dígitos) se colaba hasta el fallback
    // del final y la factura salía como CONSUMIDOR_FINAL sin avisar nada — con
    // el CAE ya quemado y la letra posiblemente equivocada. Preferimos trabar la
    // emisión y que el usuario corrija el dato.
    if (doc.length !== 11 && (doc.length < 7 || doc.length > 8)) {
        const err = new Error(
            `CUIT/DNI del receptor inválido: "${documento}" (${doc.length} dígitos). ` +
            `Tiene que ser un CUIT de 11 dígitos o un DNI de 7 u 8.`
        );
        err.errorType = 'DOC_INVALIDO';
        throw err;
    }

    // Si es CUIT directo (11 dígitos), consultar directamente
    if (doc.length === 11) {
        const result = await getCondicionFiscal({ cuitAConsultar: doc, certPem, keyPem });
        return { ...result, docTipo: 80, docNro: doc, cuitUsado: doc };
    }

    // Es DNI: probar posibles CUITs
    const posibles = dniToPossibleCuits(doc);
    let infraError = null;
    for (const cuit of posibles) {
        try {
            const result = await getCondicionFiscal({ cuitAConsultar: cuit, certPem, keyPem });
            console.log(`[padron] DNI ${doc} → CUIT ${cuit} encontrado: ${result.nombre}`);
            return { ...result, docTipo: 80, docNro: cuit, cuitUsado: cuit };
        } catch (err) {
            // Este CUIT no existe → probar el siguiente. Pero si el padrón está
            // caído no sabemos la condición real: asumir CF podría emitir con la
            // letra equivocada, así que se propaga.
            if (!esPadronNotFound(err)) infraError = err;
        }
    }
    if (infraError) {
        throw new Error(`No se pudo consultar el padrón para el DNI ${doc}: ${infraError.message}`);
    }

    // Ningún CUIT existe → es realmente un consumidor final identificado por DNI.
    console.warn(`[padron] DNI ${doc}: ningún CUIT válido encontrado, usando como CF`);
    return {
        condicion: config.IVA_CONDITION.CF,
        nombre: null,
        tipoPersona: 'FISICA',
        domicilio: null,
        docTipo: 96, // 96 = DNI
        docNro: doc,
        cuitUsado: null,
    };
}

module.exports = { getCondicionFiscal, getCondicionFiscalByDoc, dniToPossibleCuits, cuitDvValido };
