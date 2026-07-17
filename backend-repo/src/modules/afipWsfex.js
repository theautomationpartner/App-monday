/**
 * afipWsfex.js — Comprobantes de EXPORTACIÓN (WSFEXv1).
 *
 * Servicio WSAA: 'wsfex'  ·  Endpoint: config.endpoints.wsfex
 *
 * ⚠️ Esto NO es el WSFEv1 del mercado interno. Es OTRO web service de AFIP, con
 * otros métodos, otros campos y otra autorización. La Factura E no se emite
 * agregándole una letra al flujo de A/B/C: vive acá, en un circuito paralelo.
 *
 * Tipos de comprobante (config.CBTE_TYPE_EXPO):
 *   19 = Factura E  ·  20 = Nota de Débito E  ·  21 = Nota de Crédito E
 *
 * Requisitos del lado del cliente (trámite manual, una vez por CUIT):
 *   1. Punto de venta habilitado como "Comprobantes de Exportación - Web Services".
 *      Es DISTINTO del PV de facturación local. Verificable con fexGetPtoVenta().
 *   2. El certificado digital delegado al servicio 'wsfex' (Administrador de
 *      Relaciones). Sirve el mismo cert que ya usa para wsfe, pero hay que
 *      sumarle el permiso. Sin esto, WSAA rechaza el TRA.
 *
 * Todo el contrato de abajo está verificado contra el WSDL real
 * (https://wswhomo.afip.gov.ar/wsfexv1/service.asmx?WSDL), no contra el manual:
 * el manual tiene el casing de algunos campos mal (dice ID_impositivo, el WSDL
 * dice Id_impositivo).
 *
 * Uso:
 *   const wsfex = require('./afipWsfex');
 *   const { token, sign } = await getToken({ certPem, keyPem, cuit, service: wsfex.WSFEX_SERVICE, companyId });
 *   const last = await wsfex.fexGetLastCmp({ token, sign, cuit, ptoVenta: 5, cbteTipo: 19 });
 */

'use strict';

const config = require('../config');

const WSFEX_SERVICE = 'wsfex';
const NS = 'http://ar.gov.afip.dif.fexv1/';
const SOAP_TIMEOUT_MS = 30000;

// ─── Helpers XML ─────────────────────────────────────────────────────────────

function xmlEscape(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Tolerante a namespace prefix (<ar:Cae>) y a atributos en el tag de apertura
// (<Cae xsi:nil="true">), que el extractXmlTag de server.js no maneja.
function xmlTag(xml, tag) {
    const m = String(xml || '').match(
        new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'i')
    );
    return m ? m[1].trim() : null;
}

// Devuelve el contenido de cada repetición de <tag>...</tag> (para los arrays).
function xmlTagAll(xml, tag) {
    const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(String(xml || ''))) !== null) out.push(m[1]);
    return out;
}

/** Tag opcional: se omite si el valor es null/undefined/''. */
function optTag(name, value) {
    if (value === null || value === undefined || value === '') return '';
    return `<${name}>${xmlEscape(value)}</${name}>`;
}

// ─── Errores ─────────────────────────────────────────────────────────────────

/**
 * WSFEX reporta errores distinto que WSFEv1: <FEXErr><ErrCode>/<ErrMsg> en vez de
 * <Errors><Err><Code>/<Msg>. Por eso no se puede reusar el parser de server.js.
 *
 * OJO: FEXErr viene SIEMPRE, con ErrCode=0 cuando salió todo bien — o sea que su
 * mera presencia no significa error. Solo ErrCode != 0 lo es.
 */
function parseFexErr(xml) {
    const block = xmlTag(xml, 'FEXErr');
    if (!block) return null;
    const code = Number(xmlTag(block, 'ErrCode') || 0);
    if (!code) return null;                       // 0 = OK
    const msg = xmlTag(block, 'ErrMsg') || '(sin mensaje)';
    return { code, msg };
}

/** Eventos programados (mantenimiento). Informativos: se loguean, no cortan. */
function parseFexEvents(xml) {
    const block = xmlTag(xml, 'FEXEvents');
    if (!block) return null;
    const code = Number(xmlTag(block, 'EventCode') || 0);
    if (!code) return null;
    return { code, msg: xmlTag(block, 'EventMsg') || '' };
}

function throwIfFexErr(xml, method) {
    const err = parseFexErr(xml);
    if (err) throw new Error(`[wsfex:${method}] [${err.code}] ${err.msg}`);
}

// ─── Transporte SOAP ─────────────────────────────────────────────────────────

/**
 * Ejecuta un método del WS. `inner` es el contenido del elemento del método
 * (ej. el <Auth> + <Cmp>).
 *
 * A diferencia de afipGetLastVoucher de server.js, acá SIEMPRE hay timeout y
 * SIEMPRE se chequea FEXErr antes de leer el resultado — ese es justamente el
 * bug que hace que un <Errors> con HTTP 200 se lea como "último comprobante = 0"
 * y termine emitiendo el N° 1 de la serie.
 */
async function soapCall(method, inner, { timeoutMs = SOAP_TIMEOUT_MS } = {}) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${method} xmlns="${NS}">
${inner}
    </${method}>
  </soap:Body>
</soap:Envelope>`;

    let response;
    try {
        response = await fetch(config.endpoints.wsfex, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                SOAPAction: `${NS}${method}`,
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            throw new Error(`[wsfex:${method}] timeout tras ${timeoutMs}ms`);
        }
        // El fetch de Node tira "fetch failed" a secas y mete el motivo real
        // (DNS, TLS, ECONNREFUSED…) en err.cause. Sin desenvolverlo, el error
        // que llega al log es indebuggable — pasó exactamente eso la primera vez
        // que la auditoría nocturna consultó WSFEX.
        const causa = err.cause
            ? ` (${err.cause.code || err.cause.name || ''}${err.cause.message ? ': ' + err.cause.message : ''})`
            : '';
        throw new Error(`[wsfex:${method}] error de red: ${err.message}${causa}`);
    }

    const xml = await response.text();
    if (!response.ok) {
        throw new Error(`[wsfex:${method}] HTTP ${response.status}: ${xml.slice(0, 400)}`);
    }

    const ev = parseFexEvents(xml);
    if (ev) console.warn(`[wsfex:${method}] evento AFIP [${ev.code}] ${ev.msg}`);

    throwIfFexErr(xml, method);
    return xml;
}

function authXml({ token, sign, cuit }) {
    return `      <Auth>
        <Token>${xmlEscape(token)}</Token>
        <Sign>${xmlEscape(sign)}</Sign>
        <Cuit>${xmlEscape(String(cuit).replace(/\D/g, ''))}</Cuit>
      </Auth>`;
}

// ─── Consultas ───────────────────────────────────────────────────────────────

/**
 * Último Id de requerimiento usado por este CUIT.
 *
 * El <Id> es un concepto que NO existe en WSFEv1: es la clave de idempotencia de
 * WSFEX. Si se corta la comunicación, se reenvía la MISMA solicitud con el mismo
 * Id y AFIP devuelve Reproceso='S' con el CAE original en vez de emitir otro.
 * Por eso hay que archivarlo: es el único modo de recuperar un comprobante cuya
 * respuesta se perdió.
 */
async function fexGetLastId({ token, sign, cuit }) {
    const xml = await soapCall('FEXGetLast_ID', authXml({ token, sign, cuit }));
    const raw = xmlTag(xmlTag(xml, 'FEXResultGet') || xml, 'Id');
    const id = Number(raw);
    // Sin el check de string vacío, Number('') = 0 pasaría el isFinite y
    // arrancaríamos la numeración de Id desde cero pisando requerimientos.
    if (raw === null || raw === '' || !Number.isFinite(id)) {
        throw new Error(`[wsfex:FEXGetLast_ID] respuesta sin Id legible: ${xml.slice(0, 300)}`);
    }
    return id;
}

/**
 * Último comprobante autorizado para (PV, tipo). Devuelve 0 si la serie está
 * vacía — ahí sí 0 es una respuesta legítima de AFIP, distinto del caso de error.
 *
 * ⚠️ Asimetría de AFIP: acá Pto_venta y Cbte_Tipo van DENTRO del bloque <Auth>
 * (complexType ClsFEX_LastCMP), no como hermanos. Y ojo con el casing: en este
 * método es Cbte_Tipo (T mayúscula), pero en FEXGetCMP es Cbte_tipo (minúscula).
 */
async function fexGetLastCmp({ token, sign, cuit, ptoVenta, cbteTipo }) {
    const inner = `      <Auth>
        <Token>${xmlEscape(token)}</Token>
        <Sign>${xmlEscape(sign)}</Sign>
        <Cuit>${xmlEscape(String(cuit).replace(/\D/g, ''))}</Cuit>
        <Pto_venta>${xmlEscape(ptoVenta)}</Pto_venta>
        <Cbte_Tipo>${xmlEscape(cbteTipo)}</Cbte_Tipo>
      </Auth>`;
    const xml = await soapCall('FEXGetLast_CMP', inner);
    const block = xmlTag(xml, 'FEXResult_LastCMP') || xml;
    const raw = xmlTag(block, 'Cbte_nro');
    const nro = Number(raw);
    if (raw === null || raw === '' || !Number.isFinite(nro)) {
        throw new Error(`[wsfex:FEXGetLast_CMP] respuesta sin Cbte_nro legible: ${xml.slice(0, 300)}`);
    }
    return { cbteNro: nro, cbteFecha: xmlTag(block, 'Cbte_fecha') || null };
}

/**
 * Consulta un comprobante ya autorizado.
 *
 * Devuelve el MISMO shape que afipConsultarComprobante() de server.js para que el
 * recovery, el probe anti-duplicado y la auditoría nocturna lo consuman sin
 * ramificar. Los campos que en exportación no existen (imp_neto, imp_iva,
 * doc_tipo, doc_nro) van en null — el anti-fantasma ya tolera ausencias porque
 * chequea `importeKnown && ...`.
 *
 * null = no encontrado (serie vacía o número no emitido).
 */
async function fexGetCmp({ token, sign, cuit, cbteTipo, ptoVenta, cbteNro }) {
    const inner = `${authXml({ token, sign, cuit })}
      <Cmp>
        <Cbte_tipo>${xmlEscape(cbteTipo)}</Cbte_tipo>
        <Punto_vta>${xmlEscape(ptoVenta)}</Punto_vta>
        <Cbte_nro>${xmlEscape(cbteNro)}</Cbte_nro>
      </Cmp>`;

    let xml;
    try {
        xml = await soapCall('FEXGetCMP', inner);
    } catch (err) {
        // AFIP responde con error cuando el comprobante no existe. Eso no es una
        // falla: es "todavía no se emitió". Se distingue por texto porque WSFEX
        // no tiene un código estable documentado para este caso.
        if (/no encontrado|no existe|inexistente|not found/i.test(err.message)) return null;
        throw err;
    }

    const block = xmlTag(xml, 'FEXResultGet');
    if (!block) return null;

    const cae = xmlTag(block, 'Cae');
    if (!cae) return null;

    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

    return {
        cae,
        cbtes_asoc:      xmlTagAll(xmlTag(block, 'Cmps_asoc') || '', 'Cmp_asoc').map((c) => ({
            tipo:    num(xmlTag(c, 'Cbte_tipo')),
            pto_vta: num(xmlTag(c, 'Cbte_punto_vta')),
            nro:     num(xmlTag(c, 'Cbte_nro')),
        })),
        cae_vencimiento: xmlTag(block, 'Fch_venc_Cae'),
        resultado:       xmlTag(block, 'Resultado'),
        cbte_tipo:       num(xmlTag(block, 'Cbte_tipo')),
        cbte_nro:        num(xmlTag(block, 'Cbte_nro')),
        pto_vta:         num(xmlTag(block, 'Punto_vta')),
        cbte_fecha:      xmlTag(block, 'Fecha_cbte'),
        imp_total:       num(xmlTag(block, 'Imp_total')),
        imp_neto:        null,   // exportación no discrimina IVA
        imp_iva:         null,
        doc_tipo:        null,   // el receptor del exterior no tiene CUIT argentino
        doc_nro:         null,
        raw_xml_preview: xml.slice(0, 2000),
    };
}

// ─── Emisión ─────────────────────────────────────────────────────────────────

/**
 * Autoriza un comprobante de exportación y devuelve su CAE.
 *
 * `cmp` respeta el orden EXACTO de la secuencia ClsFEXRequest del WSDL — en SOAP
 * el orden de los elementos es parte del contrato, no es cosmético.
 *
 * Para SERVICIOS (tipoExpo=2), que es el único alcance soportado hoy:
 *   - Permiso_existente va VACÍO y sin bloque <Permisos> (validación 1550/1736).
 *   - Incoterms no aplica (solo obligatorio para bienes, validación 1640).
 *   - Fecha_pago es OBLIGATORIA (validación 1672).
 *   - Forma_pago es OBLIGATORIA para Cbte_Tipo=19 (validación 1620).
 *
 * ⚠️ `Permiso_existente` se manda SIEMPRE, aunque vaya vacío — NO con optTag.
 * Para AFIP "vacío" significa `<Permiso_existente></Permiso_existente>`, no
 * "omitir el campo": si no viene el tag rechaza con
 *   [1550] Campo Permiso_existente mandatorio: Debe ser S, N o vacio (debe enviarse tag)
 * Verificado contra AFIP producción el 2026-07-16 (primer intento real de
 * emisión). El manual dice "Posibles Valores: S, N, NULL (vacío)" y se presta
 * justo a la confusión.
 */
function buildCmpXml(cmp) {
    const items = (cmp.items || []).map((it) => `          <Item>
            ${optTag('Pro_codigo', it.codigo)}
            <Pro_ds>${xmlEscape(it.descripcion)}</Pro_ds>
            <Pro_qty>${xmlEscape(it.cantidad)}</Pro_qty>
            <Pro_umed>${xmlEscape(it.unidadMedida)}</Pro_umed>
            <Pro_precio_uni>${xmlEscape(it.precioUnitario)}</Pro_precio_uni>
            <Pro_bonificacion>${xmlEscape(it.bonificacion ?? 0)}</Pro_bonificacion>
            <Pro_total_item>${xmlEscape(it.totalItem)}</Pro_total_item>
          </Item>`).join('\n');

    return `      <Cmp>
        <Id>${xmlEscape(cmp.id)}</Id>
        <Fecha_cbte>${xmlEscape(cmp.fechaCbte)}</Fecha_cbte>
        <Cbte_Tipo>${xmlEscape(cmp.cbteTipo)}</Cbte_Tipo>
        <Punto_vta>${xmlEscape(cmp.ptoVenta)}</Punto_vta>
        <Cbte_nro>${xmlEscape(cmp.cbteNro)}</Cbte_nro>
        <Tipo_expo>${xmlEscape(cmp.tipoExpo)}</Tipo_expo>
        <Permiso_existente>${xmlEscape(cmp.permisoExistente ?? '')}</Permiso_existente>
        <Dst_cmp>${xmlEscape(cmp.dstCmp)}</Dst_cmp>
        <Cliente>${xmlEscape(cmp.cliente)}</Cliente>
        ${optTag('Cuit_pais_cliente', cmp.cuitPaisCliente)}
        <Domicilio_cliente>${xmlEscape(cmp.domicilioCliente)}</Domicilio_cliente>
        ${optTag('Id_impositivo', cmp.idImpositivo)}
        <Moneda_Id>${xmlEscape(cmp.monedaId)}</Moneda_Id>
        <Moneda_ctz>${xmlEscape(cmp.monedaCtz)}</Moneda_ctz>
        ${optTag('Obs_comerciales', cmp.obsComerciales)}
        <Imp_total>${xmlEscape(cmp.impTotal)}</Imp_total>
        ${optTag('Obs', cmp.obs)}
        ${optTag('Forma_pago', cmp.formaPago)}
        ${optTag('Incoterms', cmp.incoterms)}
        ${optTag('Incoterms_Ds', cmp.incotermsDs)}
        <Idioma_cbte>${xmlEscape(cmp.idiomaCbte)}</Idioma_cbte>
        <Items>
${items}
        </Items>
        ${optTag('Fecha_pago', cmp.fechaPago)}
      </Cmp>`;
}

/**
 * @returns {Promise<{cae, cae_vencimiento, numero_comprobante, cbte_tipo_afip,
 *                    resultado, reproceso, motivos_obs, id, raw_xml}>}
 */
async function fexAuthorize({ token, sign, cuit, cmp }) {
    const inner = `${authXml({ token, sign, cuit })}
${buildCmpXml(cmp)}`;
    const xml = await soapCall('FEXAuthorize', inner);

    const block = xmlTag(xml, 'FEXResultAuth');
    if (!block) {
        throw new Error(`[wsfex:FEXAuthorize] respuesta sin FEXResultAuth: ${xml.slice(0, 400)}`);
    }

    const cae = xmlTag(block, 'Cae');
    const resultado = (xmlTag(block, 'Resultado') || '').toUpperCase();
    const motivos = xmlTag(block, 'Motivos_Obs');

    // Misma regla de oro que el flujo de WSFEv1: el CAE es la verdad. Se acepta
    // si hay CAE de 14 dígitos y Resultado='A'; se rechaza si no.
    const caeValido = cae && /^\d{14}$/.test(cae);
    if (!caeValido || resultado !== 'A') {
        throw new Error(
            `[wsfex:FEXAuthorize] AFIP rechazó el comprobante ` +
            `(Resultado=${resultado || '?'}${motivos ? `, Motivos: ${motivos}` : ''})`
        );
    }

    return {
        cae,
        cae_vencimiento:    xmlTag(block, 'Fch_venc_Cae'),
        numero_comprobante: Number(xmlTag(block, 'Cbte_nro')),
        cbte_tipo_afip:     Number(xmlTag(block, 'Cbte_tipo')),
        resultado,
        reproceso:          xmlTag(block, 'Reproceso'),   // 'S' = AFIP devolvió uno ya emitido
        motivos_obs:        motivos || null,
        id:                 Number(xmlTag(block, 'Id')),
        raw_xml:            xml.slice(0, 2000),
    };
}

// ─── Tablas de parámetros ────────────────────────────────────────────────────

// Las tablas son iguales para todos los CUIT (aunque AFIP exija un token para
// leerlas), así que el cache es global. Cambian muy de vez en cuando: TTL largo.
const PARAM_TTL_MS = 12 * 60 * 60 * 1000;
const _paramCache = {};

async function getParamTable(method, { token, sign, cuit, force = false }) {
    const hit = _paramCache[method];
    if (!force && hit && Date.now() < hit.expiresAt) return hit.rows;

    const xml = await soapCall(method, authXml({ token, sign, cuit }));
    const block = xmlTag(xml, 'FEXResultGet') || '';
    const rows = xmlTagAll(block, 'ClsFEXResponse_\\w+').map((r) => {
        const out = {};
        for (const m of r.matchAll(/<(?:\w+:)?(\w+)(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?\1>/g)) {
            out[m[1]] = m[2].trim();
        }
        return out;
    });

    _paramCache[method] = { rows, expiresAt: Date.now() + PARAM_TTL_MS };
    return rows;
}

/** Países válidos como destino. → [{ codigo, descripcion }] */
async function fexGetPaises(auth) {
    const rows = await getParamTable('FEXGetPARAM_DST_pais', auth);
    return rows.map((r) => ({ codigo: r.DST_Codigo, descripcion: r.DST_Ds }));
}

/** "CUIT país": el CUIT genérico que AFIP asigna a cada país. → [{ cuit, descripcion }] */
async function fexGetCuitPaises(auth) {
    const rows = await getParamTable('FEXGetPARAM_DST_CUIT', auth);
    return rows.map((r) => ({ cuit: r.DST_CUIT, descripcion: r.DST_Ds }));
}

async function fexGetMonedas(auth) {
    const rows = await getParamTable('FEXGetPARAM_MON', auth);
    return rows.map((r) => ({ id: r.Mon_Id, descripcion: r.Mon_Ds, vigDesde: r.Mon_vig_desde, vigHasta: r.Mon_vig_hasta }));
}

async function fexGetIdiomas(auth) {
    const rows = await getParamTable('FEXGetPARAM_Idiomas', auth);
    return rows.map((r) => ({ id: Number(r.Idi_Id), descripcion: r.Idi_Ds }));
}

async function fexGetUnidadesMedida(auth) {
    const rows = await getParamTable('FEXGetPARAM_UMed', auth);
    return rows.map((r) => ({ id: Number(r.Umed_Id), descripcion: r.Umed_Ds }));
}

async function fexGetTiposExpo(auth) {
    const rows = await getParamTable('FEXGetPARAM_Tipo_Expo', auth);
    return rows.map((r) => ({ id: Number(r.Tex_Id), descripcion: r.Tex_Ds }));
}

/** Puntos de venta habilitados para exportación. Sirve para el pre-flight. */
async function fexGetPtosVenta(auth) {
    const rows = await getParamTable('FEXGetPARAM_PtoVenta', auth);
    return rows.map((r) => ({ nro: Number(r.Pve_Nro), bloqueado: r.Pve_Bloqueado, baja: r.Pve_FchBaja }));
}

/** Tipos de entidad del receptor del exterior — el sufijo de las filas de DST_CUIT. */
const TIPO_ENTIDAD = {
    JURIDICA: 'Persona Jurídica',
    FISICA:   'Persona Física',
    OTRA:     'Otro tipo de Entidad',
};

/**
 * Resuelve el "CUIT país" a partir del código de país + el tipo de entidad del
 * cliente del exterior.
 *
 * Verificado contra la tabla REAL de AFIP (2026-07-16): las dos tablas NO son
 * 1:1 — DST_pais trae 310 países y DST_CUIT trae 917 filas, o sea ~3 por país,
 * una por tipo de entidad:
 *
 *   DST_pais : 212 -> "ESTADOS UNIDOS"
 *   DST_CUIT : 50000002124 -> "ESTADOS UNIDOS - Persona Física"
 *              55000002126 -> "ESTADOS UNIDOS - Persona Jurídica"
 *              51600002124 -> "ESTADOS UNIDOS - Otro tipo de Entidad"
 *
 * Por eso el CUIT país NO se puede resolver solo con el país: hace falta saber
 * si el cliente es empresa, persona u otra cosa. Confirmado contra una Factura E
 * real emitida por AFIP: el receptor "M&P CONSULTING SERVICES LLC." figura con
 * CUIT País 55000002126 = "ESTADOS UNIDOS - Persona Jurídica" — la misma fila.
 *
 * El match es contra la descripción COMPLETA ("<PAIS> - <TIPO>") y no por
 * igualdad con el país solo: hay países cuya descripción ya incluye guiones
 * ("ZF Colonia - URUGUAY") y no todos tienen los 3 tipos (4 países tienen 2,
 * uno tiene 5).
 *
 * AFIP exige informar al menos uno entre Cuit_pais_cliente e Id_impositivo
 * (validación 1580) -> si esto devuelve null, el caller tiene que exigir
 * Id_impositivo.
 *
 * @param {string|number} codigoPais  código de DST_pais
 * @param {object} auth               { token, sign, cuit }
 * @param {string} tipoEntidad        uno de TIPO_ENTIDAD. Default: Persona
 *                                    Jurídica, el caso normal de exportación B2B.
 * @returns {Promise<string|null>}
 */
async function fexResolveCuitPais(codigoPais, auth, tipoEntidad = TIPO_ENTIDAD.JURIDICA) {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();

    const paises = await fexGetPaises(auth);
    const pais = paises.find((p) => String(p.codigo) === String(codigoPais));
    if (!pais) return null;

    const cuits = await fexGetCuitPaises(auth);
    const buscado = norm(`${pais.descripcion} - ${tipoEntidad}`);
    const hit = cuits.find((c) => norm(c.descripcion) === buscado);
    return hit ? String(hit.cuit) : null;
}

/** Chequeo de infraestructura del WS (no requiere auth). */
async function fexDummy() {
    const xml = await soapCall('FEXDummy', '', { timeoutMs: 15000 });
    return {
        appServer: xmlTag(xml, 'AppServer'),
        dbServer:  xmlTag(xml, 'DbServer'),
        authServer: xmlTag(xml, 'AuthServer'),
    };
}

module.exports = {
    WSFEX_SERVICE,
    TIPO_ENTIDAD,
    fexDummy,
    fexGetLastId,
    fexGetLastCmp,
    fexGetCmp,
    fexAuthorize,
    fexGetPaises,
    fexGetCuitPaises,
    fexGetMonedas,
    fexGetIdiomas,
    fexGetUnidadesMedida,
    fexGetTiposExpo,
    fexGetPtosVenta,
    fexResolveCuitPais,
};
