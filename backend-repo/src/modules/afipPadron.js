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
 *
 * Lógica de prioridad:
 *   1. errorConstancia != 0  → throw
 *   2. estadoClave != ACTIVO → throw (CUIT inactivo)
 *   3. impuesto id=20 activo → MONOTRIBUTO
 *   4. impuesto id=30 activo → RESPONSABLE_INSCRIPTO
 *   5. impuesto id=32 activo → EXENTO
 *   6. categoriasMonotributo presente → MONOTRIBUTO (fallback)
 *   7. default                         → CONSUMIDOR_FINAL
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
            throw new Error(`Padrón AFIP error: ${errorMsg}`);
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
        throw new Error(`CUIT con estado ${estadoClave} en padrón AFIP`);
    }

    // ── Chequeo impuestos activos ─────────────────────────────────────────
    const impuestoBlocks = xml.match(/<impuesto>([\s\S]*?)<\/impuesto>/gi) || [];
    const activos = new Set();
    for (const block of impuestoBlocks) {
        const id     = xmlTag(block, 'idImpuesto');
        const estado = (xmlTag(block, 'estado') || 'ACTIVO').toUpperCase();
        if (id && estado === 'ACTIVO') activos.add(id);
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

    return { condicion: IVA_CONDITION.CF, nombre, tipoPersona, domicilio, raw: xml };
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

/**
 * Dado un DNI o CUIT, intenta obtener la condición fiscal.
 * Si es DNI, prueba cada CUIT posible contra el padrón hasta encontrar uno válido.
 */
async function getCondicionFiscalByDoc({ documento, certPem, keyPem }) {
    const doc = String(documento).replace(/\D/g, '');

    // Si es CUIT directo (11 dígitos), consultar directamente
    if (doc.length === 11) {
        const result = await getCondicionFiscal({ cuitAConsultar: doc, certPem, keyPem });
        return { ...result, docTipo: 80, docNro: doc, cuitUsado: doc };
    }

    // Es DNI: probar posibles CUITs
    const posibles = dniToPossibleCuits(doc);
    for (const cuit of posibles) {
        try {
            const result = await getCondicionFiscal({ cuitAConsultar: cuit, certPem, keyPem });
            console.log(`[padron] DNI ${doc} → CUIT ${cuit} encontrado: ${result.nombre}`);
            return { ...result, docTipo: 80, docNro: cuit, cuitUsado: cuit };
        } catch {
            // Este CUIT no existe, probar el siguiente
        }
    }

    // Ningún CUIT funcionó: devolver como consumidor final con DNI
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

module.exports = { getCondicionFiscal, getCondicionFiscalByDoc, dniToPossibleCuits };
