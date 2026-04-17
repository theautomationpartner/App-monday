/**
 * afipAuth.js — Autenticación WSAA con caché de tokens.
 *
 * - Un token WSAA dura 12 horas. Lo cacheamos en memoria para no re-autenticar
 *   en cada factura.
 * - Soporta múltiples servicios ('wsfe', 'ws_sr_constancia_inscripcion', etc.)
 * - La firma del TRA usa node-forge (ya instalado).
 */

'use strict';

const forge = require('node-forge');
const config = require('../config');

// ─── Caché en memoria: { [cacheKey]: { token, sign, expiresAt } } ─────────────
const _cache = {};

/** Devuelve la clave de caché para un servicio + CUIT emisor */
function cacheKey(service, cuit) {
    return `${service}::${cuit}`;
}

/** Genera el XML del Ticket de Requerimiento de Acceso (TRA).
 *  AFIP acepta ISO 8601 en UTC (sufijo Z). Usamos UTC para evitar bugs de timezone. */
function buildTra(service) {
    const now    = new Date();
    const genDt  = new Date(now.getTime() - 10 * 60 * 1000);
    const expDt  = new Date(now.getTime() + 10 * 60 * 1000);

    // Formato ISO 8601 sin milisegundos, con Z (UTC)
    const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

    return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId>
    <generationTime>${fmt(genDt)}</generationTime>
    <expirationTime>${fmt(expDt)}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>`;
}

/**
 * Firma el TRA con el certificado y clave privada del emisor.
 * Devuelve el CMS firmado en Base64 (lo que WSAA espera en loginCms).
 */
function signTra(traXml, certPem, keyPem) {
    const cert    = forge.pki.certificateFromPem(certPem);
    const privKey = forge.pki.privateKeyFromPem(keyPem);

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(traXml, 'utf8');
    p7.addCertificate(cert);
    p7.addSigner({
        key:         privKey,
        certificate: cert,
        digestAlgorithm: forge.pki.oids.sha256,
        authenticatedAttributes: [
            { type: forge.pki.oids.contentType,   value: forge.pki.oids.data },
            { type: forge.pki.oids.messageDigest             },
            { type: forge.pki.oids.signingTime,   value: new Date() },
        ],
    });
    p7.sign({ detached: false });

    const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
    return forge.util.encode64(der);
}

/** Decodifica entidades HTML básicas (&lt; &gt; &amp; &quot; &apos;) */
function decodeHtmlEntities(s) {
    return s
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g,  '&');
}

/** Parsea la respuesta SOAP de WSAA y extrae token + sign.
 *  AFIP devuelve el loginTicketResponse escapado dentro de <loginCmsReturn>,
 *  así que primero decodificamos las entidades HTML antes de buscar token/sign. */
function parseLoginResponse(xmlText) {
    // Extraer el contenido de <loginCmsReturn> (puede tener namespace)
    const returnMatch = xmlText.match(/<(?:\w+:)?loginCmsReturn[^>]*>([\s\S]*?)<\/(?:\w+:)?loginCmsReturn>/i);
    const innerEscaped = returnMatch ? returnMatch[1] : xmlText;
    const inner = decodeHtmlEntities(innerEscaped);

    const tokenMatch = inner.match(/<token>([\s\S]*?)<\/token>/i);
    const signMatch  = inner.match(/<sign>([\s\S]*?)<\/sign>/i);

    if (!tokenMatch || !signMatch) {
        throw new Error('WSAA no devolvió token/sign válidos. Respuesta: ' + xmlText.substring(0, 500));
    }
    return {
        token: tokenMatch[1].trim(),
        sign:  signMatch[1].trim(),
    };
}

/**
 * Obtiene (o reutiliza del caché) un token WSAA para el servicio indicado.
 *
 * @param {object} opts
 * @param {string} opts.certPem   - Certificado X.509 en PEM
 * @param {string} opts.keyPem    - Clave privada RSA en PEM
 * @param {string} opts.cuit      - CUIT del emisor (para el caché)
 * @param {string} opts.service   - Servicio AFIP ('wsfe', 'ws_sr_constancia_inscripcion', …)
 * @param {boolean} [opts.force]  - Forzar re-autenticación aunque el caché sea válido
 *
 * @returns {Promise<{token: string, sign: string}>}
 */
async function getToken({ certPem, keyPem, cuit, service = 'wsfe', force = false }) {
    const key = cacheKey(service, cuit);
    const cached = _cache[key];

    // Reutilizar si queda más de 5 minutos de vida
    if (!force && cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
        return { token: cached.token, sign: cached.sign };
    }

    const tra    = buildTra(service);
    const cmsB64 = signTra(tra, certPem, keyPem);

    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ar="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:loginCms>
      <ar:in0>${cmsB64}</ar:in0>
    </ar:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

    const response = await fetch(config.endpoints.wsaa, {
        method:  'POST',
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction:     'http://wsaa.view.sua.dvadac.desein.afip.gov/loginCms',
        },
        body: soapBody,
    });

    const xmlText = await response.text();
    if (!response.ok) {
        // Extraer faultstring o mensaje del SOAP fault, que es lo que realmente explica el error
        const faultMatch = xmlText.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
        const detailMatch = xmlText.match(/<detail[^>]*>([\s\S]*?)<\/detail>/i);
        const reason = faultMatch?.[1]?.trim()
            || detailMatch?.[1]?.trim()
            || xmlText.substring(0, 500);
        throw new Error(
            `WSAA HTTP ${response.status} (service=${service}, cuit=${cuit}, env=${config.afipEnv}): ${reason}`
        );
    }

    const { token, sign } = parseLoginResponse(xmlText);

    // El token dura 12 horas; cacheamos por 11 para estar seguros
    _cache[key] = {
        token,
        sign,
        expiresAt: Date.now() + 11 * 60 * 60 * 1000,
    };

    return { token, sign };
}

/** Invalida el caché de un servicio (por ej. si AFIP devuelve error de token expirado) */
function invalidateToken(service, cuit) {
    delete _cache[cacheKey(service, cuit)];
}

module.exports = { getToken, invalidateToken, buildTra, signTra };
