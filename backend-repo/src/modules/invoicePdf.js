/**
 * invoicePdf.js — Generación del PDF de la factura replicando el diseño oficial de ARCA.
 *
 * Diferencias clave por tipo de comprobante:
 *  - Factura A (RG 1415 Anexo II Ap. A.IV.a): discrimina IVA → suma columnas
 *    "Alícuota IVA" y "Subtotal c/IVA" en la grilla, y desglosa Neto Gravado +
 *    IVA por alícuota (27/21/10.5/5/2.5/0) en el pie.
 *  - Factura B/C: layout sin discriminación (IVA incluido o no aplicable).
 *  - Factura E (exportación): layout PROPIO, en generateFacturaEPdfBuffer() al
 *    final del archivo. No comparte la función de A/B/C a propósito — ver el
 *    comentario de esa función.
 */

'use strict';

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const invoiceRules = require('./invoiceRules');
const config = require('../config');

// Códigos AFIP de comprobante (siempre 2 dígitos en el cabezal según ARCA).
// E = 19 (Factura de Exportación): no es una "letra" más, es otra serie y otro
// web service (WSFEX), pero en el cabezal se imprime igual — "E" + "COD. 19".
const TIPO_COD = { A: '01', B: '06', C: '11', E: '19' };
const TIPO_CBTE_NUM = { A: 1, B: 6, C: 11, E: 19 };

// Alícuotas de IVA habilitadas por AFIP (RG 4291 / WSFEv1).
const ALICUOTAS_IVA = ['27', '21', '10.5', '5', '2.5', '0'];

function fmtCuit(c) {
    const s = String(c || '').replace(/\D/g, '');
    return s.length === 11 ? `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}` : (c || '');
}

function fmtMoney(n) {
    return Number(n || 0).toLocaleString('es-AR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

// Cotizacion suele venir con mas decimales que un monto (ej. 1234.567890).
// La mostramos con 4 decimales para no perder precision pero sin saturar.
function fmtCotizacion(n) {
    return Number(n || 0).toLocaleString('es-AR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
    });
}

// Simbolo del PDF segun la moneda AFIP. Para PES usamos "$" (peso argentino),
// para DOL usamos "USD" (estandar internacional, claro para el receptor).
const CURRENCY_SYMBOLS = {
    PES: '$',
    DOL: 'USD',
};
function currencySymbol(monId) {
    return CURRENCY_SYMBOLS[monId] || (monId || '$');
}

function padNum(n, len) {
    return String(n || '').padStart(len, '0');
}

function fmtDate(d) {
    if (!d || d === '-') return '-';
    if (d instanceof Date) {
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${dd}/${mm}/${d.getFullYear()}`;
    }
    const s = String(d).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10).split('-').reverse().join('/');
    if (/^\d{8}$/.test(s)) return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
    return s;
}

function normalizeAlicuota(raw) {
    const v = String(raw ?? '').replace(/[^0-9.,]/g, '').replace(',', '.').trim();
    if (!v) return null;
    if (ALICUOTAS_IVA.includes(v)) return v;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const match = ALICUOTAS_IVA.find(a => Math.abs(Number(a) - n) < 0.001);
    return match || null;
}

/**
 * Calcula el desglose de IVA por alícuota a partir de las líneas del draft.
 * Si el draft trae todas las líneas con la misma alícuota (caso actual),
 * el resultado va a tener un único bucket cargado; el resto queda en 0.
 */
function calcularDesgloseIva(draft) {
    const buckets = Object.fromEntries(ALICUOTAS_IVA.map(a => [a, 0]));
    let netoGravado = 0;

    const lineas = draft.lineas || [];
    const fallbackAlicuota = normalizeAlicuota(draft.alicuota_iva_pct) || '21';

    for (const l of lineas) {
        const qty = Number(l.quantity || l.cantidad || 0);
        const price = Number(l.unit_price || l.precio_unitario || 0);
        const subtotal = qty * price;
        const ali = normalizeAlicuota(l.alicuota_iva) || fallbackAlicuota;
        const rate = Number(ali) / 100;
        netoGravado += subtotal;
        buckets[ali] += subtotal * rate;
    }

    return {
        netoGravado: Number(netoGravado.toFixed(2)),
        ivaPorAlicuota: Object.fromEntries(
            ALICUOTAS_IVA.map(a => [a, Number(buckets[a].toFixed(2))]),
        ),
    };
}

// ─── Helpers de marca/branding ──────────────────────────────────────────
// Facturación electrónica con CAE: la factura digital es el "original" único
// válido ante AFIP, por lo que no hace falta generar DUPLICADO ni TRIPLICADO.
// Si en el futuro hace falta volver a las 3 copias tradicionales, agregar
// 'DUPLICADO' y 'TRIPLICADO' a este array y el resto del código se adapta solo.
const INVOICE_COPIES = ['ORIGINAL'];

// ─── Etiquetas del PDF por idioma (Fase 2 i18n) ─────────────────────────────
// SOLO se traducen las ETIQUETAS de campos. Las leyendas/textos OBLIGATORIOS de
// AFIP quedan SIEMPRE en español (ARCA, "AGENCIA DE RECAUDACIÓN...", "Comprobante
// Autorizado", "Esta Agencia no se responsabiliza...", RG 5614 "Régimen de
// Transparencia Fiscal", RG 5616 leyenda de cotización, "ORIGINAL", "COD.", CAE,
// CUIT). Los importes y fechas mantienen formato argentino (es-AR) por ser un
// comprobante fiscal argentino. Default 'es' → comportamiento de SIEMPRE.
const PDF_LABELS = {
    es: {
        titleFactura: 'FACTURA', titleNC: 'NOTA DE CRÉDITO', titleND: 'NOTA DE DÉBITO',
        razonSocial: 'Razón Social: ', domicilio: 'Domicilio: ', condIva: 'Cond. IVA: ',
        tel: 'Tel: ', puntoVenta: 'Punto de Venta: ', compNro: 'Comp. Nro: ',
        fechaEmision: 'Fecha de Emisión: ', ingresosBrutos: 'Ingresos Brutos: ',
        fechaInicio: 'Fecha de Inicio de Actividades: ',
        periodoDesde: 'Período Facturado Desde: ', hasta: 'Hasta: ',
        vtoPago: 'Fecha de Vto. para el pago: ',
        apellidoNombre: 'Apellido y Nombre / Razón Social: ', consumidorFinal: 'Consumidor Final',
        condFrenteIva: 'Condición frente al IVA: ', domicilioComercial: 'Domicilio Comercial: ',
        condVenta: 'Condición de venta: ', contado: 'Contado',
        compAsociado: 'Comprobante Asociado: ', facturaWord: 'Factura', fecha: 'Fecha: ',
        thCodigo: 'Código', thProdServ: 'Producto / Servicio', thCantidad: 'Cantidad',
        thUMedida: 'U. Medida', thPrecioUnit: 'Precio Unit.', thBonif: '% Bonif',
        thSubtotal: 'Subtotal', thAlicIva: 'Alícuota IVA', thSubtotalIva: 'Subtotal c/IVA',
        thImpBonif: 'Imp. Bonif.', unidades: 'unidades', observaciones: 'Observaciones:',
        importeNeto: 'Importe Neto Gravado: ', iva: 'IVA', otrosTributos: 'Importe Otros Tributos: ',
        importeTotal: 'Importe Total: ', subtotalTot: 'Subtotal: ', ivaContenido: 'IVA Contenido: ',
        caeVto: 'Fecha de Vto. de CAE: ', pag: 'Pág. ', pendiente: 'PENDIENTE',
    },
    en: {
        titleFactura: 'INVOICE', titleNC: 'CREDIT NOTE', titleND: 'DEBIT NOTE',
        razonSocial: 'Legal Name: ', domicilio: 'Address: ', condIva: 'VAT Condition: ',
        tel: 'Phone: ', puntoVenta: 'Sales Point: ', compNro: 'Voucher No.: ',
        fechaEmision: 'Issue Date: ', ingresosBrutos: 'Gross Income Tax: ',
        fechaInicio: 'Start of Activities Date: ',
        periodoDesde: 'Billing Period From: ', hasta: 'To: ',
        vtoPago: 'Payment Due Date: ',
        apellidoNombre: 'Name / Legal Name: ', consumidorFinal: 'Final Consumer',
        condFrenteIva: 'VAT Condition: ', domicilioComercial: 'Business Address: ',
        condVenta: 'Sale Condition: ', contado: 'Cash',
        compAsociado: 'Associated Voucher: ', facturaWord: 'Invoice', fecha: 'Date: ',
        thCodigo: 'Code', thProdServ: 'Product / Service', thCantidad: 'Quantity',
        thUMedida: 'Unit', thPrecioUnit: 'Unit Price', thBonif: '% Disc.',
        thSubtotal: 'Subtotal', thAlicIva: 'VAT Rate', thSubtotalIva: 'Subtotal w/VAT',
        thImpBonif: 'Disc. Amt.', unidades: 'units', observaciones: 'Remarks:',
        importeNeto: 'Net Taxable Amount: ', iva: 'VAT', otrosTributos: 'Other Taxes: ',
        importeTotal: 'Total Amount: ', subtotalTot: 'Subtotal: ', ivaContenido: 'VAT Included: ',
        caeVto: 'CAE Due Date: ', pag: 'Page ', pendiente: 'PENDING',
    },
};
function pdfLabelsFor(language) {
    return language === 'en' ? PDF_LABELS.en : PDF_LABELS.es;
}

// Normaliza una URL para mostrar: saca "https://" (no aporta info visual).
// NO hace pre-truncate — drawKV se encarga del auto-shrink y truncate final,
// aprovechando todo el ancho disponible de la columna.
function truncateWeb(url) {
    if (!url) return '';
    return String(url).replace(/^https?:\/\//, '');
}

// Dibuja "Label: Value" en UNA sola línea en Y fija, con auto-shrink del
// fontSize si el texto no entra. Escalona fontSize de `fontSize` → `minFont`
// (0.5pt por iteración) y sólo si todavía no entra al mínimo, trunca con "…".
// Crítico para que las filas del emisor se alineen con el comprobante
// (no wrapear nunca a 2 líneas) conservando el dato completo cuando se pueda.
function drawKV(doc, x, y, width, label, value, fontSize = 8, minFont = 6.5) {
    let v = String(value ?? '-');
    let f = fontSize;

    doc.font('Helvetica-Bold').fontSize(f);
    let labelW = doc.widthOfString(label);
    doc.font('Helvetica').fontSize(f);
    let vw = doc.widthOfString(v);

    while (labelW + vw + 2 > width && f > minFont) {
        f = Math.max(minFont, f - 0.5);
        doc.font('Helvetica-Bold').fontSize(f);
        labelW = doc.widthOfString(label);
        doc.font('Helvetica').fontSize(f);
        vw = doc.widthOfString(v);
    }

    if (labelW + vw + 2 > width) {
        while (v.length > 3 && doc.widthOfString(v + '…') > width - labelW - 2) {
            v = v.slice(0, -1);
        }
        v = v + '…';
    }

    doc.fontSize(f);
    doc.font('Helvetica-Bold').text(label, x, y, { lineBreak: false });
    doc.font('Helvetica').text(v, x + labelW, y, { lineBreak: false });
}

// Intenta convertir el logo de la empresa (base64 + mime desde DB) a un
// Buffer utilizable por pdfkit. SVG y formatos no soportados → null.
function decodeCompanyLogo(company) {
    if (!company?.logo_base64) return null;
    const mime = String(company.logo_mime_type || '').toLowerCase();
    // pdfkit soporta PNG y JPG nativos. SVG/WebP no.
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/jpg') return null;
    try {
        return Buffer.from(company.logo_base64, 'base64');
    } catch {
        return null;
    }
}

// Dibuja un logo centrado dentro de una caja (w × h). Si falla silently
// retorna false para que el caller pueda renderear el emisor sin logo.
function drawLogo(doc, x, y, w, h, logoBuffer) {
    if (!logoBuffer) return false;
    try {
        doc.image(logoBuffer, x, y, { fit: [w, h], align: 'center', valign: 'center' });
        return true;
    } catch (err) {
        console.warn('[pdf] No se pudo insertar logo de empresa:', err.message);
        return false;
    }
}

// `isExportacion` (Factura E) cambia DOS cosas del payload, ambas por spec de AFIP
// (RG 4892 — el QR aplica también a exportación, no está exceptuada):
//   - el fallback de tipoCmp pasa a 19 (una Factura E con fallback 11 publicaría
//     un QR de Factura C: comprobante inexistente para AFIP);
//   - se OMITEN tipoDocRec/nroDocRec. En la spec son "de corresponder" (opcionales)
//     y el receptor del exterior no tiene documento argentino que informar. Mandar
//     99/0 sería declarar "doc tipo Otro, número 0", que es un dato inventado.
// En A/B/C nada de esto se activa y el orden de las claves queda intacto (el spread
// se evalúa en el lugar donde estaban), así que el JSON → base64 → QR es idéntico.
async function fetchQrImage({ company, draft, afipResult, isExportacion = false }) {
    const tStart = Date.now();
    try {
        // PASO 3 USD — moneda y cotizacion del draft (defaults preservan
        // comportamiento PES historico cuando el caller no las pasa).
        const qrMoneda     = draft.moneda     || 'PES';
        const qrCotizacion = Number(draft.cotizacion) || 1;
        const qrData = {
            ver: 1,
            fecha: draft.fecha_emision || new Date().toISOString().slice(0, 10),
            cuit: Number(String(company.cuit).replace(/\D/g, '')),
            ptoVta: Number(draft.punto_venta),
            tipoCmp: afipResult?.cbte_tipo_afip
                ?? TIPO_CBTE_NUM[afipResult?.tipo_comprobante]
                ?? (isExportacion ? TIPO_CBTE_NUM.E : 11),
            nroCmp: Number(afipResult?.numero_comprobante || 0),
            importe: Number(draft.importe_total || 0),
            moneda: qrMoneda,
            ctz: qrCotizacion,
            // En exportación el receptor NO tiene documento argentino, así que la
            // primera lectura fue omitir estos campos (la spec del QR los marca
            // "DE CORRESPONDER"). ESTABA MAL: se decodificó el QR de 2 Facturas E
            // REALES emitidas por AFIP y las dos mandan `tipoDocRec: 80` (=CUIT)
            // con el **CUIT País** como `nroDocRec`:
            //     00004-00000045 (EEUU)         → 80 / 55000002126
            //     00004-00000037 (Puerto Rico)  → 80 / 51600002213
            // Sin esto, la constatación de AFIP no puede matchear al receptor y
            // rechaza el comprobante aunque el CAE sea válido.
            // Si no hay CUIT País (zonas francas: se emite con Id_impositivo), no
            // hay documento que informar → se omiten, que es el caso real de
            // "DE CORRESPONDER".
            ...(isExportacion
                ? (draft.receptor_cuit_pais
                    ? { tipoDocRec: 80, nroDocRec: Number(draft.receptor_cuit_pais) }
                    : {})
                : {
                    tipoDocRec: Number(draft.docTipo ?? 99),
                    nroDocRec: Number(draft.docNro ?? 0),
                }),
            // 'E' = CAE (vs 'A' = CAEA). NO es la letra del comprobante — que en la
            // Factura E también sea "E" es pura coincidencia.
            tipoCodAut: 'E',
            codAut: Number(afipResult?.cae || 0),
        };
        const base64Payload = Buffer.from(JSON.stringify(qrData)).toString('base64');
        const arcaUrl = `https://www.afip.gob.ar/fe/qr/?p=${base64Payload}`;

        // Generamos el QR LOCALMENTE (librería qrcode, 100% in-process).
        // Antes llamábamos a api.qrserver.com (externo gratuito, latencia
        // variable 200ms-30s, potencial SPOF). Ahora es ~10-30ms siempre.
        //   width: 600 → PNG nítido al escalar en el PDF
        //   margin: 4  → quiet zone obligatoria para lectura a distancia
        //   errorCorrectionLevel: 'M' → 15% (default L es muy frágil a 7%)
        const buf = await QRCode.toBuffer(arcaUrl, {
            type: 'png',
            width: 600,
            margin: 4,
            errorCorrectionLevel: 'M',
        });
        console.log(`[timing] pdf_qr_fetch: ${Date.now() - tStart}ms status=ok (local)`);
        return buf;
    } catch (err) {
        console.warn(`[pdf] QR falló tras ${Date.now() - tStart}ms: ${err.message}`);
    }
    return null;
}

// `demoLeyendas` (opcional, SOLO preview): { headerLegend?: string, bodyLegends?: string[] }.
// En produccion viene undefined → el PDF es byte-identico. Lo usa scripts/demo-leyendas-pdf.js
// para previsualizar dónde irían las leyendas propuestas (RG 1575 / RG 5003) sin implementarlas.
async function generateFacturaPdfBuffer({ company, draft, afipResult, language, demoLeyendas /*, itemId */ }) {
    const L = pdfLabelsFor(language); // etiquetas del PDF por idioma (default 'es')
    const tQrStart = Date.now();
    const qrImageBuffer = await fetchQrImage({ company, draft, afipResult });
    const tLogoStart = Date.now();
    const logoBuffer = decodeCompanyLogo(company);
    const tRenderStart = Date.now();
    console.log(`[timing] pdf_logo_decode: ${tRenderStart - tLogoStart}ms qr_total=${tLogoStart - tQrStart}ms`);

    // Sub-timers del render: puntos clave para detectar qué sección tarda.
    const marks = [];
    const mark = (label) => marks.push({ label, t: Date.now() });
    mark('start');

    return new Promise((resolve, reject) => {
        try {
            const M = 18; // margen reducido (antes 28pt) — recuadro más ancho
            const doc = new PDFDocument({ size: 'A4', margin: M });
            mark('doc_init');
            const buffers = [];
            doc.on('data', (chunk) => buffers.push(chunk));
            doc.on('end', () => {
                const buf = Buffer.concat(buffers);
                mark('stream_end');
                // Calcular deltas relativos al inicio y al anterior
                const baseT = marks[0].t;
                const deltas = marks.map((m, i) => {
                    const dPrev = i > 0 ? m.t - marks[i-1].t : 0;
                    const dTotal = m.t - baseT;
                    return `${m.label}:+${dPrev}ms(${dTotal}ms)`;
                }).join(' | ');
                console.log(`[timing] pdf_render_breakdown: ${deltas}`);
                console.log(`[timing] pdf_render: ${Date.now() - tRenderStart}ms bytes=${buf.length}`);
                resolve(buf);
            });
            doc.on('error', reject);

            const W = 595.28 - M * 2;
            const colLeft = M;
            const colRight = M + W;

            const tipoLetra = draft.tipo_comprobante || 'C';
            // Tipo numérico AFIP del comprobante: 1/6/11 para facturas, 3/8/13
            // para Notas de Crédito. afipResult.cbte_tipo_afip es la fuente
            // autoritativa; el fallback por letra cubre PDFs regenerados desde
            // un afip_result_json viejo (anterior a ese campo).
            const cbteTipoNum = afipResult?.cbte_tipo_afip
                ?? TIPO_CBTE_NUM[afipResult?.tipo_comprobante]
                ?? TIPO_CBTE_NUM[tipoLetra]
                ?? 11;
            const isNotaCredito = [3, 8, 13].includes(Number(cbteTipoNum));
            const isNotaDebito  = [2, 7, 12].includes(Number(cbteTipoNum));
            const tipoCod = String(cbteTipoNum).padStart(2, '0');
            const isFacturaA = tipoLetra === 'A';
            // PASO 3 USD — moneda + simbolo a usar en este PDF. Defaults a PES
            // si el draft no la trae (clientes legacy o tests).
            const moneda      = draft.moneda || 'PES';
            const cotizacion  = Number(draft.cotizacion) || 1;
            const monSym      = currencySymbol(moneda);
            const isMonExt    = moneda !== 'PES';
            const isFacturaB = tipoLetra === 'B';

            // Leyenda RG 1575 en Factura A (modalidad declarada en Datos Fiscales).
            // Solo aplica a la letra A. `demoLeyendas` (preview) tiene prioridad para
            // el script de muestra; en producción sale de company.factura_a_leyenda.
            const FACTURA_A_LEGENDS = {
                cbu_informada:   'PAGO EN C.B.U. INFORMADA',
                sujeta_retencion: 'OPERACIÓN SUJETA A RETENCIÓN',
            };
            const facturaAModalidad = isFacturaA ? (company?.factura_a_leyenda || null) : null;
            const headerLegendText = demoLeyendas?.headerLegend
                || FACTURA_A_LEGENDS[facturaAModalidad]
                || null;
            // Leyendas de cuerpo. RG 5003: una Factura A a un Monotributista lleva 2
            // leyendas obligatorias. Es automático — la letra A implica emisor RI, y
            // receptorCondicion viene del padrón de AFIP. Son textos legales → van en
            // español siempre (no se traducen). demoLeyendas tiene prioridad (preview).
            const MONOTRIBUTO_LEGENDS = [
                'Receptor del comprobante - Responsable Monotributo',
                'El crédito fiscal discriminado en el presente comprobante, sólo podrá ser computado a efectos del Régimen de Sostenimiento e Inclusión Fiscal para Pequeños Contribuyentes de la Ley N° 27.618.',
            ];
            const esFacturaAMonotributo = isFacturaA
                && draft.receptorCondicion === config.IVA_CONDITION.MONOTRIBUTO;
            const bodyLegendsToDraw = demoLeyendas?.bodyLegends
                || (esFacturaAMonotributo ? MONOTRIBUTO_LEGENDS : null);

            const pv = padNum(draft.punto_venta, 5);
            const nroComp = padNum(afipResult?.numero_comprobante, 8);
            const fechaEmision = fmtDate(draft.fecha_emision) || new Date().toLocaleDateString('es-AR');
            const caeVto = fmtDate(afipResult?.cae_vencimiento);
            const startDate = fmtDate(company.start_date);

            // Loop por las 3 copias tradicionales: ORIGINAL / DUPLICADO / TRIPLICADO.
            // Cada copia es una página idéntica salvo por el tag superior y la
            // numeración del footer. Aplica igual para A, B y C.
            mark('prep_done');
            const totalPages = INVOICE_COPIES.length;
            for (let copyIdx = 0; copyIdx < totalPages; copyIdx++) {
                if (copyIdx > 0) doc.addPage();
                const copyTag = INVOICE_COPIES[copyIdx];
                const pageNum = copyIdx + 1;

            // Borde exterior. La altura final del bloque depende del pie de totales:
            // - A: desglose de IVA por alícuota
            // - B: agrega leyenda Régimen de Transparencia Fiscal + IVA Contenido (RG 5614/2024)
            // - C: solo subtotal y total
            // En moneda extranjera (RG 5616/2024) sumamos:
            //   +14pt header "Moneda: USD - Dólar Estadounidense"
            //   +24pt leyenda de conversión a pesos al pie del bloque
            const totalesExtraMonExt = isMonExt ? 40 : 0;
            const totalesH = (isFacturaA ? 142 : (isFacturaB ? 90 : 50)) + totalesExtraMonExt;
            const boxTop = M;
            const boxH = 720; // header creció de 110 a 145pt — compensamos con 20pt extra
            doc.rect(colLeft, boxTop, W, boxH).stroke('#000');

            // ── Copy tag (ORIGINAL / DUPLICADO / TRIPLICADO) ─────
            let y = boxTop;
            doc.rect(colLeft, y, W, 16).stroke('#000');
            doc.fontSize(8).font('Helvetica-Bold')
               .text(copyTag.split('').join(' '), colLeft, y + 4, { width: W, align: 'center', characterSpacing: 3 });
            y += 16;

            // ── HEADER V2 ─────────────────────────────────────────
            // Layout:
            //   ┌──────────────────────────────────────────────────┐
            //   │ [LOGO]  NOMBRE     [A]        FACTURA              │  ← Banner (60pt)
            //   ├──────────────────────────────────────────────────┤
            //   │ Razón Social: ...             Punto de Venta: ...  │
            //   │ Domicilio: ...                Fecha de Emisión: .. │
            //   │ Cond. IVA: ...                CUIT: ...            │  ← Data rows
            //   │ Tel: ...                      Ingresos Brutos: ... │    (emisor y
            //   │ Email: ...                    Fecha Inicio: ...    │     comprobante
            //   │ Web: ...                                           │     full-width
            //   └──────────────────────────────────────────────────┘     en su columna)
            const headerH = 145;
            const BANNER_H = 60; // banner con logo/nombre/letraA/FACTURA
            doc.rect(colLeft, y, W, headerH).stroke('#000');

            // Columnas: emisor y comprobante del mismo ancho geométrico
            const centerW = W * 0.08;
            const leftW = (W - centerW) / 2;
            const centerX = colLeft + leftW;
            const pad = 8;
            const contentX = colLeft + pad;
            const contentW = leftW - pad * 2;

            // ── BANNER SUPERIOR ───────────────────────────────────
            const bannerCenterY = y + BANNER_H / 2;

            // Logo (izquierda, centrado vertical en banner)
            const LOGO_SIZE = 50;
            const hasLogo = Boolean(logoBuffer);
            let nameX = contentX;
            let nameMaxW = contentW;
            if (hasLogo) {
                drawLogo(doc, contentX, y + (BANNER_H - LOGO_SIZE) / 2, LOGO_SIZE, LOGO_SIZE, logoBuffer);
                nameX = contentX + LOGO_SIZE + 10;
                nameMaxW = contentW - LOGO_SIZE - 10;
            }

            // Nombre comercial (trade_name) arriba del banner — cae a business_name
            // si la empresa todavía no migró al campo de "Nombre de fantasía".
            // El nombre de fantasía se respeta TAL CUAL lo cargó el usuario
            // (ej: "eGrowers" queda "eGrowers", no se uppercase-a). El fallback
            // a business_name (que viene de AFIP en MAYUSCULAS) se pasa por
            // toTitleCase para que se vea consistente con el resto del PDF.
            const displayName = company.trade_name
                ? company.trade_name
                : invoiceRules.toTitleCase(company.business_name || '');
            const nameFontSize = 14;
            doc.fontSize(nameFontSize).font('Helvetica-Bold')
               .text(displayName,
                     nameX, bannerCenterY - nameFontSize / 2,
                     { width: nameMaxW, align: hasLogo ? 'left' : 'center', lineBreak: false });

            // Letra A/B/C (pegada al borde superior del header, como AFIP clásico).
            // Si hay leyenda RG 1575, el recuadro se agranda hacia abajo y la
            // leyenda va ADENTRO (bajo "COD."), compartiendo el borde — como AFIP.
            const BOX_SIZE = 42;
            const hasHeaderLegend = Boolean(headerLegendText);
            const boxW = hasHeaderLegend ? 64 : BOX_SIZE;
            let legInnerH = 0;
            if (hasHeaderLegend) {
                doc.font('Helvetica-Bold').fontSize(5);
                legInnerH = doc.heightOfString(headerLegendText, { width: boxW - 4, align: 'center' }) + 6;
            }
            const boxTotalH = BOX_SIZE + legInnerH;
            const boxX = (centerX + centerW / 2) - boxW / 2;
            const boxY = y;
            doc.rect(boxX, boxY, boxW, boxTotalH).stroke('#000');
            doc.fontSize(26).font('Helvetica-Bold')
               .text(tipoLetra, boxX, boxY + 6, { width: boxW, align: 'center' });
            doc.fontSize(6).font('Helvetica-Bold')
               .text(`COD. ${tipoCod}`, boxX, boxY + 34, { width: boxW, align: 'center' });
            if (hasHeaderLegend) {
                doc.moveTo(boxX, boxY + BOX_SIZE).lineTo(boxX + boxW, boxY + BOX_SIZE).stroke('#000');
                doc.fillColor('#000').font('Helvetica-Bold').fontSize(5)
                   .text(headerLegendText, boxX + 2, boxY + BOX_SIZE + 3,
                         { width: boxW - 4, align: 'center' });
            }

            // FACTURA (centrado horizontalmente en su columna, vertical con nombre/logo)
            const rx = centerX + centerW;
            const rightColW = colRight - rx - 8;
            const facturaFontSize = 16;
            const tituloComprobante = isNotaCredito ? L.titleNC
                : isNotaDebito ? L.titleND
                : L.titleFactura;
            doc.fontSize(facturaFontSize).font('Helvetica-Bold')
               .text(tituloComprobante, rx, bannerCenterY - facturaFontSize / 2,
                     { width: rightColW, align: 'center', lineBreak: false });

            // Línea vertical desde bottom del recuadro (con leyenda incluida) al bottom del header
            doc.moveTo(centerX + centerW / 2, boxY + boxTotalH)
               .lineTo(centerX + centerW / 2, y + headerH).stroke('#000');

            // ── SECCIÓN DE DATOS (debajo del banner) ──────────────
            // Emisor (izquierda, full-width en su columna) y comprobante (derecha,
            // también full-width) arrancan en la misma Y → grilla vertical perfecta.
            //   Razón Social    ↔  Punto de Venta
            //   Domicilio       ↔  Fecha de Emisión
            //   Cond. IVA       ↔  CUIT
            //   Tel (opcional)  ↔  Ingresos Brutos
            //   Email (opcional)↔  Fecha de Inicio
            //   Web (opcional)  ↔  (sin par)
            const dataStartY = y + BANNER_H + 12;
            const STEP = 12;

            // Emisor — todos los campos en Title Case (con IVA preservado en
            // mayusculas y abreviaturas con punto/slash respetadas).
            let dy = dataStartY;
            drawKV(doc, contentX, dy, contentW,
                L.razonSocial, invoiceRules.toTitleCase(company.business_name || ''));
            dy += STEP;
            drawKV(doc, contentX, dy, contentW,
                L.domicilio, invoiceRules.toTitleCase(company.address || '-'));
            dy += STEP;
            drawKV(doc, contentX, dy, contentW,
                L.condIva, invoiceRules.toTitleCase(invoiceRules.condicionLabel(draft.emisorCondicion || '', language)));
            if (company.phone) {
                dy += STEP;
                drawKV(doc, contentX, dy, contentW, L.tel, company.phone);
            }
            if (company.email) {
                dy += STEP;
                drawKV(doc, contentX, dy, contentW, 'Email: ', company.email);
            }
            if (company.website) {
                dy += STEP;
                drawKV(doc, contentX, dy, contentW, 'Web: ', truncateWeb(company.website));
            }

            // Comprobante (arranca en la misma Y que Razón Social → grilla)
            const compX = centerX + centerW + 8;
            const compW = colRight - compX - 8;
            let cry = dataStartY;
            drawKV(doc, compX, cry, compW, L.puntoVenta, `${pv}   ${L.compNro}${nroComp}`);
            cry += STEP;
            drawKV(doc, compX, cry, compW, L.fechaEmision, fechaEmision);
            cry += STEP;
            drawKV(doc, compX, cry, compW, 'CUIT: ', fmtCuit(company.cuit));
            cry += STEP;
            drawKV(doc, compX, cry, compW, L.ingresosBrutos, fmtCuit(company.cuit));
            cry += STEP;
            drawKV(doc, compX, cry, compW, L.fechaInicio, startDate);

            y += headerH;
            mark(`header_done_c${copyIdx}`);

            // ── PERÍODO (solo servicios o productos+servicios) ────
            // Layout: izquierda | centro geométrico | derecha alineado
            //   Período Facturado Desde: ...   Hasta: ...   Fecha de Vto. para el pago: ...
            if (draft.concepto_afip === 2 || draft.concepto_afip === 3) {
                const periodoH = 18;
                doc.rect(colLeft, y, W, periodoH).stroke('#000');
                const periodoY = y + 5;
                doc.fontSize(7.5);

                // Izquierda: Período Facturado Desde
                doc.font('Helvetica-Bold').text(L.periodoDesde, colLeft + 8, periodoY, { continued: true, lineBreak: false });
                doc.font('Helvetica').text(fmtDate(draft.fecha_servicio_desde) || fechaEmision, { lineBreak: false });

                // Centro: Hasta (geométricamente centrado en W/2)
                const hastaLabel = L.hasta;
                const hastaValue = fmtDate(draft.fecha_servicio_hasta) || fechaEmision;
                doc.font('Helvetica-Bold');
                const hastaLabelW = doc.widthOfString(hastaLabel);
                doc.font('Helvetica');
                const hastaValueW = doc.widthOfString(hastaValue);
                const hastaX = colLeft + (W - hastaLabelW - hastaValueW) / 2;
                doc.font('Helvetica-Bold').text(hastaLabel, hastaX, periodoY, { lineBreak: false });
                doc.font('Helvetica').text(hastaValue, hastaX + hastaLabelW, periodoY, { lineBreak: false });

                // Derecha: Fecha de Vto. para el pago (alineado a la derecha)
                const vtoLabel = L.vtoPago;
                const vtoValue = fmtDate(draft.fecha_vto_pago) || fechaEmision;
                doc.font('Helvetica-Bold');
                const vtoLabelW = doc.widthOfString(vtoLabel);
                doc.font('Helvetica');
                const vtoValueW = doc.widthOfString(vtoValue);
                const vtoX = colRight - 8 - vtoLabelW - vtoValueW;
                doc.font('Helvetica-Bold').text(vtoLabel, vtoX, periodoY, { lineBreak: false });
                doc.font('Helvetica').text(vtoValue, vtoX + vtoLabelW, periodoY, { lineBreak: false });

                y += periodoH;
            }

            // ── RECEPTOR (2 columnas) ────────────────────────────
            const receptorH = 44;
            doc.rect(colLeft, y, W, receptorH).stroke('#000');
            const halfW = W / 2;
            let cy = y + 5;
            doc.fontSize(7.5);
            doc.font('Helvetica-Bold').text('CUIT: ', colLeft + 8, cy, { continued: true });
            doc.font('Helvetica').text(fmtCuit(draft.receptor_cuit_o_dni) || '-');
            doc.font('Helvetica-Bold').text(L.apellidoNombre, colLeft + halfW + 8, cy, { continued: true });
            const recNombreRaw = (draft.receptor_nombre || '').trim();
            const esConsumidorFinalGenerico = !recNombreRaw || recNombreRaw.toLowerCase() === 'consumidor final';
            doc.font('Helvetica').text(
                esConsumidorFinalGenerico ? L.consumidorFinal : invoiceRules.toTitleCase(recNombreRaw));
            cy += 12;
            doc.font('Helvetica-Bold').text(L.condFrenteIva, colLeft + 8, cy, { continued: true });
            doc.font('Helvetica').text(invoiceRules.toTitleCase(invoiceRules.condicionLabel(draft.receptorCondicion || '', language)));
            doc.font('Helvetica-Bold').text(L.domicilioComercial, colLeft + halfW + 8, cy, { continued: true });
            doc.font('Helvetica').text(invoiceRules.toTitleCase(draft.receptor_domicilio || '-'));
            cy += 12;
            doc.font('Helvetica-Bold').text(L.condVenta, colLeft + 8, cy, { continued: true });
            doc.font('Helvetica').text(invoiceRules.toTitleCase(draft.condicion_venta || L.contado));
            y += receptorH;
            mark(`receptor_done_c${copyIdx}`);

            // ── COMPROBANTE ASOCIADO (solo Notas de Crédito) ─────
            // AFIP exige que la NC indique el comprobante que rectifica.
            // Para facturas draft.comprobante_asociado no existe → no se dibuja
            // y el layout queda idéntico al histórico.
            if (draft.comprobante_asociado) {
                const ca = draft.comprobante_asociado;
                const caH = 18;
                doc.rect(colLeft, y, W, caH).stroke('#000');
                const caPv  = padNum(ca.punto_venta, 5);
                const caNro = padNum(ca.numero, 8);
                let caTxt = `${L.facturaWord} ${ca.letra || ''} ${caPv}-${caNro}`.replace(/\s+/g, ' ').trim();
                if (ca.fecha) caTxt += `    ${L.fecha}${fmtDate(ca.fecha)}`;
                if (ca.cae)   caTxt += `    CAE: ${ca.cae}`;
                doc.fontSize(7.5).font('Helvetica-Bold')
                   .text(L.compAsociado, colLeft + 8, y + 5, { continued: true, lineBreak: false });
                doc.font('Helvetica').text(caTxt, { lineBreak: false });
                y += caH;
            }

            // ── TABLA DE ITEMS ───────────────────────────────────
            // Factura A: agrega Alícuota IVA + Subtotal c/IVA (RG 1415 Ap. A.IV.a).
            // B/C: layout original sin discriminación.
            // Cuando isMonExt: AFIP exige indicar la moneda en los headers de las
            // columnas que llevan importes (Precio Unit., Subtotal, etc.).
            const monSuffix = isMonExt ? ` (${monSym})` : '';
            const cols = isFacturaA ? [
                { label: L.thCodigo,                        w: W * 0.06, align: 'center' },
                { label: L.thProdServ,                      w: W * 0.26, align: 'left'   },
                { label: L.thCantidad,                      w: W * 0.07, align: 'right'  },
                { label: L.thUMedida,                       w: W * 0.08, align: 'center' },
                { label: `${L.thPrecioUnit}${monSuffix}`,   w: W * 0.11, align: 'right'  },
                { label: L.thBonif,                         w: W * 0.07, align: 'right'  },
                { label: `${L.thSubtotal}${monSuffix}`,     w: W * 0.11, align: 'right'  },
                { label: L.thAlicIva,                       w: W * 0.10, align: 'center' },
                { label: `${L.thSubtotalIva}${monSuffix}`,  w: W * 0.14, align: 'right'  },
            ] : [
                { label: L.thCodigo,                        w: W * 0.08, align: 'center' },
                { label: L.thProdServ,                      w: W * 0.30, align: 'left'   },
                { label: L.thCantidad,                      w: W * 0.08, align: 'right'  },
                { label: L.thUMedida,                       w: W * 0.10, align: 'center' },
                { label: `${L.thPrecioUnit}${monSuffix}`,   w: W * 0.13, align: 'right'  },
                { label: L.thBonif,                         w: W * 0.08, align: 'right'  },
                { label: `${L.thImpBonif}${monSuffix}`,     w: W * 0.10, align: 'right'  },
                { label: `${L.thSubtotal}${monSuffix}`,     w: W * 0.13, align: 'right'  },
            ];
            // En moneda extranjera el header crece a 2 lineas: "Subtotal" + "(USD)".
            const rowH = isMonExt ? 22 : 16;

            // Header de la tabla
            doc.rect(colLeft, y, W, rowH).fill('#f1f1f1').stroke('#000');
            let cx = colLeft;
            doc.fillColor('#000');
            for (const col of cols) {
                doc.rect(cx, y, col.w, rowH).stroke('#000');
                doc.fontSize(7).font('Helvetica-Bold')
                   .text(col.label, cx + 2, y + 4, { width: col.w - 4, align: 'center' });
                cx += col.w;
            }
            y += rowH;

            const lineas = draft.lineas || [];
            const fallbackAlicuota = normalizeAlicuota(draft.alicuota_iva_pct) || '21';
            mark(`table_header_done_c${copyIdx}`);

            // Indice de la columna "Producto / Servicio" — es la que tiene
            // textos largos (descripcion del producto) y fuerza a que la fila
            // crezca en altura cuando el texto necesita >1 linea.
            const conceptColIdx = cols.findIndex(c => /Producto.*Servicio|Product.*Service/i.test(c.label));

            for (const line of lineas) {
                const qty = Number(line.quantity || line.cantidad || 0);
                const price = Number(line.unit_price || line.precio_unitario || 0);
                const subtotal = qty * price;
                const ali = normalizeAlicuota(line.alicuota_iva) || fallbackAlicuota;
                const aliRate = Number(ali) / 100;
                const priceConIva    = price * (1 + aliRate);
                const subtotalConIva = subtotal * (1 + aliRate);

                cx = colLeft;
                let vals;
                if (isFacturaA) {
                    // A: discrimina IVA — precio neto + col de alícuota + col subtotal c/IVA
                    vals = [
                        '',
                        line.concept || line.descripcion || '',
                        String(qty),
                        (line.unidad_medida || L.unidades).toLowerCase(),
                        fmtMoney(price),
                        '0,00',
                        fmtMoney(subtotal),
                        `${ali}%`,
                        fmtMoney(subtotalConIva),
                    ];
                } else if (isFacturaB) {
                    // B: IVA incluido en el precio (el consumidor paga lo que ve).
                    // El desglose va al pie como "IVA Contenido" (RG 5614/2024).
                    vals = [
                        '',
                        line.concept || line.descripcion || '',
                        String(qty),
                        (line.unidad_medida || L.unidades).toLowerCase(),
                        fmtMoney(priceConIva),
                        '0,00',
                        '0,00',
                        fmtMoney(subtotalConIva),
                    ];
                } else {
                    // C: emisor Monotributo/Exento, no factura IVA — precio neto sin más.
                    vals = [
                        '',
                        line.concept || line.descripcion || '',
                        String(qty),
                        (line.unidad_medida || L.unidades).toLowerCase(),
                        fmtMoney(price),
                        '0,00',
                        '0,00',
                        fmtMoney(subtotal),
                    ];
                }

                // Altura dinamica por fila: si el texto del concepto wrap-ea
                // a varias lineas, la fila crece para que el borde envuelva
                // todo. Sin esto, el texto se sale del rect.
                let rowHActual = rowH;
                if (conceptColIdx >= 0) {
                    const conceptText = vals[conceptColIdx] || '';
                    const conceptW = cols[conceptColIdx].w - 6;
                    doc.fontSize(7).font('Helvetica');
                    const measuredH = doc.heightOfString(conceptText, { width: conceptW });
                    // padding: 4px arriba + 4px abajo. Damos algo de margen.
                    rowHActual = Math.max(rowH, Math.ceil(measuredH) + 8);
                }

                for (let i = 0; i < cols.length; i++) {
                    doc.rect(cx, y, cols[i].w, rowHActual).stroke('#000');
                    doc.fontSize(7).font('Helvetica')
                       .text(vals[i], cx + 3, y + 4, { width: cols[i].w - 6, align: cols[i].align });
                    cx += cols[i].w;
                }
                y += rowHActual;
            }

            mark(`table_rows_done_c${copyIdx}`);

            // ── OBSERVACIONES (opcional, max 255 chars) ─────────────────────
            // Bloque de texto libre. Solo se renderiza si hay contenido. Se
            // ubica al PIE del espacio vacio entre la tabla de items y el
            // bloque de totales — pegado al borde superior de los totales
            // para que el espacio en blanco quede arriba (no abajo).
            const observacionesText = (draft.observaciones || '').trim();
            const totalsY = boxTop + boxH - totalesH;
            let obsHeight = 0;
            const obsW = W - 16;
            const obsLabelW = observacionesText
                ? doc.font('Helvetica-Bold').fontSize(8).widthOfString(L.observaciones + ' ')
                : 0;
            if (observacionesText) {
                const textH = doc.heightOfString(observacionesText, { width: obsW - obsLabelW });
                obsHeight = Math.max(textH, 11) + 10;
            }
            // Y donde arranca el bloque de observaciones (queda apoyado contra
            // el inicio del bloque de totales). Si no hay obs, obsStartY === totalsY.
            const obsStartY = totalsY - obsHeight;

            // Lineas verticales desde la tabla hasta donde arranca observaciones
            // (o totales si no hay obs).
            if (y < obsStartY) {
                doc.moveTo(colLeft, y).lineTo(colLeft, obsStartY).stroke('#000');
                doc.moveTo(colRight, y).lineTo(colRight, obsStartY).stroke('#000');
                y = obsStartY;
            }
            // Renderizar el bloque de observaciones (si hay)
            if (observacionesText) {
                const obsX = colLeft + 8;
                doc.fontSize(8);
                doc.fillColor('#000').font('Helvetica-Bold').text(L.observaciones, obsX, y + 4);
                doc.font('Helvetica').text(observacionesText, obsX + obsLabelW, y + 4, {
                    width: obsW - obsLabelW,
                    align: 'left',
                });
                y = totalsY;
            }

            // Espacio vacío restante hasta totales (caso sin observaciones —
            // las lineas ya se dibujaron arriba)
            if (y < totalsY) {
                doc.moveTo(colLeft, y).lineTo(colLeft, totalsY).stroke('#000');
                doc.moveTo(colRight, y).lineTo(colRight, totalsY).stroke('#000');
                y = totalsY;
            }

            // DEMO/preview (ej. RG 5003 factura a monotributista): leyendas de cuerpo
            // en la banda libre justo arriba del bloque de totales. Solo si
            // demoLeyendas.bodyLegends tiene contenido; en producción no dibuja nada.
            if (bodyLegendsToDraw?.length) {
                doc.font('Helvetica-BoldOblique').fontSize(7);
                const heights = bodyLegendsToDraw.map(
                    (t) => Math.max(11, doc.heightOfString(t, { width: W - 20 }) + 4));
                const blockH = heights.reduce((a, b) => a + b, 0) + 4;
                let dly = totalsY - blockH;
                doc.moveTo(colLeft, dly - 3).lineTo(colRight, dly - 3).stroke('#000');
                doc.fillColor('#000');
                bodyLegendsToDraw.forEach((txt, i) => {
                    doc.font('Helvetica-BoldOblique').fontSize(7)
                       .text(txt, colLeft + 8, dly + 1, { width: W - 20 });
                    dly += heights[i];
                });
            }

            // ── TOTALES ──────────────────────────────────────────
            doc.rect(colLeft, y, W, totalesH).stroke('#000');
            const labelW = 200;
            const valueW = 110;
            const totLabelX = colRight - labelW - valueW - 12;
            const totValueX = colRight - valueW - 8;
            let ty = y + 8;
            doc.fontSize(8);

            // Header "Moneda: USD - Dólar Estadounidense" (oficial AFIP, RG 5616/2024).
            // Va arriba a la derecha del bloque de totales, subrayado.
            if (isMonExt) {
                const MONEDA_LABEL = {
                    DOL: 'USD - Dólar Estadounidense',
                };
                const monLabel = MONEDA_LABEL[moneda] || moneda;
                doc.font('Helvetica-Bold').fontSize(8)
                   .text(`Moneda: ${monLabel}`, colLeft + 8, ty, {
                       width: W - 16,
                       align: 'right',
                       underline: true,
                   });
                ty += 14;
            }

            if (isFacturaA) {
                // Desglose obligatorio (RG 1415 Anexo II Ap. A.IV.a)
                const { netoGravado, ivaPorAlicuota } = calcularDesgloseIva(draft);
                const totalIva = Object.values(ivaPorAlicuota).reduce((s, v) => s + v, 0);
                const importeTotalCalculado = Number((netoGravado + totalIva).toFixed(2));

                const drawRow = (label, value, bold = false) => {
                    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
                       .text(label, totLabelX, ty, { width: labelW, align: 'right' });
                    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
                       .text(value, totValueX, ty, { width: valueW, align: 'right' });
                    ty += 11;
                };

                drawRow(`${L.importeNeto}${monSym}`, fmtMoney(netoGravado), true);
                drawRow(`${L.iva} 27%: ${monSym}`,   fmtMoney(ivaPorAlicuota['27']));
                drawRow(`${L.iva} 21%: ${monSym}`,   fmtMoney(ivaPorAlicuota['21']));
                drawRow(`${L.iva} 10.5%: ${monSym}`, fmtMoney(ivaPorAlicuota['10.5']));
                drawRow(`${L.iva} 5%: ${monSym}`,    fmtMoney(ivaPorAlicuota['5']));
                drawRow(`${L.iva} 2.5%: ${monSym}`,  fmtMoney(ivaPorAlicuota['2.5']));
                drawRow(`${L.iva} 0%: ${monSym}`,    fmtMoney(ivaPorAlicuota['0']));
                drawRow(`${L.otrosTributos}${monSym}`, '0,00');
                drawRow(`${L.importeTotal}${monSym}`,
                    fmtMoney(draft.importe_total ?? importeTotalCalculado), true);
            } else {
                doc.font('Helvetica-Bold').text(`${L.subtotalTot}${monSym}`, totLabelX, ty, { width: labelW, align: 'right' });
                doc.font('Helvetica-Bold').text(fmtMoney(draft.importe_total), totValueX, ty, { width: valueW, align: 'right' });
                ty += 14;
                doc.font('Helvetica-Bold').text(`${L.otrosTributos}${monSym}`, totLabelX, ty, { width: labelW, align: 'right' });
                doc.font('Helvetica-Bold').text('0,00', totValueX, ty, { width: valueW, align: 'right' });
                ty += 14;
                doc.font('Helvetica-Bold').text(`${L.importeTotal}${monSym}`, totLabelX, ty, { width: labelW, align: 'right' });
                doc.font('Helvetica-Bold').text(fmtMoney(draft.importe_total), totValueX, ty, { width: valueW, align: 'right' });
                // Si es Factura C en moneda extranjera, avanzamos el cursor para
                // que el divisor de la leyenda monExt no caiga sobre el texto
                // de "Importe Total". Para A los drawRow ya avanzan ty; para B
                // el cierre del bloque isFacturaB tambien avanza.
                if (!isFacturaB && isMonExt) {
                    ty += 14;
                }

                // Régimen de Transparencia Fiscal al Consumidor — RG 5614/2024 (Ley 27.743).
                // Obligatorio en Factura B desde 01/04/2025: leyenda + IVA contenido en el precio.
                if (isFacturaB) {
                    ty += 16;
                    doc.moveTo(colLeft, ty - 4).lineTo(colRight, ty - 4).stroke('#000');
                    doc.fontSize(8).font('Helvetica-BoldOblique')
                       .text('Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)',
                             colLeft + 8, ty, { width: W - 16 });
                    ty += 12;
                    const ivaContenido = Number(draft.importe_iva || 0);
                    doc.font('Helvetica-Bold').text(`${L.ivaContenido}${monSym}`, totLabelX, ty, { width: labelW, align: 'right' });
                    doc.font('Helvetica-Bold').text(fmtMoney(ivaContenido), totValueX, ty, { width: valueW, align: 'right' });
                    ty += 14;  // avanzar bajo IVA Contenido para que la leyenda monExt no se solape
                }
            }

            // ── LEYENDA DE CONVERSION A PESOS (oficial AFIP, RG 5616/2024) ─
            // Cuando es moneda extranjera, AFIP exige la formula textual:
            //   "El total de este comprobante expresado en moneda de curso
            //    legal - Pesos Argentinos - considerándose un tipo de cambio
            //    consignado de X.XXXXXX asciende a: $ Y,YY"
            // Va dentro del rectangulo de totales, al pie, abarcando el ancho
            // completo del bloque.
            if (isMonExt) {
                ty += 8;
                doc.moveTo(colLeft, ty - 2).lineTo(colRight, ty - 2).stroke('#000');
                ty += 2;
                const totalEnPesos = Number(draft.importe_total || 0) * cotizacion;
                const cotizStr     = Number(cotizacion).toFixed(6);
                const montoEnPesos = `$ ${fmtMoney(totalEnPesos)}`;
                // Layout en 2 columnas: leyenda a la izquierda (wrap natural)
                // + monto en pesos a la derecha alineado al fondo de la ultima
                // linea, replicando el oficial AFIP.
                const leyenda =
                    `El total de este comprobante expresado en moneda de curso legal ` +
                    `- Pesos Argentinos - considerándose un tipo de cambio consignado ` +
                    `de ${cotizStr} asciende a:`;
                const montoW   = 90;
                const leyendaW = W - 16 - montoW - 8;
                doc.fontSize(7).font('Helvetica')
                   .text(leyenda, colLeft + 8, ty, {
                       width: leyendaW,
                       align: 'left',
                   });
                // Alineamos el monto al bottom de la leyenda calculando su altura.
                const leyendaH = doc.heightOfString(leyenda, { width: leyendaW });
                doc.fontSize(8).font('Helvetica-Bold')
                   .text(montoEnPesos, colRight - montoW - 8, ty + leyendaH - 10, {
                       width: montoW,
                       align: 'right',
                   });
            }

            y = boxTop + boxH;
            mark(`totals_done_c${copyIdx}`);

            // ── FOOTER (fuera del borde) ─────────────────────────
            y += 8;
            const footerY = y;

            // QR a 75pt (~26 mm). AFIP recomienda ≥ 50 mm, pero el footer no
            // tiene espacio vertical para más sin tocar el layout principal.
            const QR_SIZE = 75;
            if (qrImageBuffer) {
                try {
                    doc.image(qrImageBuffer, colLeft, footerY, { width: QR_SIZE, height: QR_SIZE });
                } catch (imgErr) {
                    console.warn('[pdf] No se pudo insertar QR en PDF:', imgErr.message);
                }
            }

            const arcaX = colLeft + (qrImageBuffer ? QR_SIZE + 10 : 0);
            doc.fontSize(16).font('Helvetica-Bold').text('ARCA', arcaX, footerY);
            doc.fontSize(5).font('Helvetica-Bold')
               .text('AGENCIA DE RECAUDACIÓN Y CONTROL ADUANERO', arcaX, footerY + 18);
            doc.fontSize(9).font('Helvetica-BoldOblique')
               .text('Comprobante Autorizado', arcaX, footerY + 28);
            doc.fontSize(5.5).font('Helvetica')
               .text('Esta Agencia no se responsabiliza por los datos ingresados en el detalle de la operación',
                      arcaX, footerY + 40);

            doc.fontSize(8).font('Helvetica-Bold')
               .text(`CAE N°: ${afipResult?.cae || L.pendiente}`, colRight - 180, footerY + 18, { width: 180, align: 'right' });
            doc.fontSize(8).font('Helvetica')
               .text(`${L.caeVto}${caeVto}`, colRight - 180, footerY + 30, { width: 180, align: 'right' });

            doc.fontSize(8).font('Helvetica')
               .text(`${L.pag}${pageNum}/${totalPages}`, colLeft + W / 2 - 20, footerY + 24);

            mark(`footer_done_c${copyIdx}`);
            } // end for copyIdx (loop por ORIGINAL / DUPLICADO / TRIPLICADO)

            mark('before_doc_end');
            doc.end();
            mark('after_doc_end');
        } catch (err) {
            reject(err);
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════
// FACTURA E — Comprobante de exportación (CbteTipo 19, WSFEX)
// ════════════════════════════════════════════════════════════════════════════
//
// Función SEPARADA de generateFacturaPdfBuffer a propósito. La exportación no
// comparte casi nada con A/B/C: no hay neto ni alícuotas ni subtotales (la
// operación es exenta), el receptor no tiene CUIT ni condición frente al IVA
// argentinos, y aparecen bloques que en mercado interno no existen (CUIT País,
// Divisa/Destino, Forma de Pago/Incoterms). Meter todo eso como ramas dentro de
// la función de A/B/C la convertiría en un campo minado para los clientes que
// hoy facturan en producción. Con dos funciones, el PDF de A/B/C queda
// byte-idéntico por construcción, no por cuidado.
//
// El layout está copiado de dos Facturas E REALES emitidas por "Comprobantes en
// línea" de AFIP con el mismo CUIT (una en pesos, otra en USD con tipo de
// cambio). Lo que no se pudo verificar contra esas dos está marcado con OJO.

// El comprobante de exportación NO agrupa miles: AFIP imprime "150000,00", no
// "150.000,00" (verificado en los dos comprobantes reales, tanto en el precio
// unitario como en el total). Tiene sentido para un papel que lee un extranjero:
// el punto de miles del formato argentino es justo el separador DECIMAL en la
// mayoría de los países destino, y "6.900,00" se puede leer como 6,9. Por eso la
// Factura E tiene sus propios formatters en vez de reusar fmtMoney (que sí agrupa,
// y que NO se toca para no alterar el PDF de A/B/C).
function fmtExpoMoney(n) {
    return Number(n || 0).toLocaleString('es-AR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: false,
    });
}

// Cantidad y precio unitario van con 6 decimales ("1,000000" / "6000,000000").
function fmtExpoCantidad(n) {
    return Number(n || 0).toLocaleString('es-AR', {
        minimumFractionDigits: 6,
        maximumFractionDigits: 6,
        useGrouping: false,
    });
}

// Font size más grande (arrancando en `max`) con el que `text` entra en `width`.
// Los encabezados de la grilla de exportación llevan la moneda pegada
// ("Total por ítem (USD)") y en una columna angosta no entran a 7pt: sin esto el
// header wrapea a 2 líneas y se derrama sobre el primer renglón. AFIP resuelve lo
// mismo achicando ese rótulo en su propio comprobante.
function fitFontSize(doc, text, width, max = 7, min = 4.5) {
    let f = max;
    doc.font('Helvetica-Bold');
    while (f > min && doc.fontSize(f).widthOfString(text) > width) f -= 0.25;
    return f;
}

// ─── Etiquetas del PDF de exportación por idioma ────────────────────────────
// Mismo criterio que PDF_LABELS (ver :120): se traducen SOLO los rótulos de
// campo. Los textos de AFIP van SIEMPRE en español y por eso no están acá sino
// hardcodeados abajo: "FACTURA DE EXPORTACIÓN", "IVA EXENTO OPERACIÓN DE
// EXPORTACIÓN", "ORIGINAL", "COD.", "Comprobante Autorizado", "CAE", "Esta
// Agencia no se responsabiliza…".
//
// Dos rótulos NO se traducen a propósito:
//   - "CUIT País": CUIT es un identificador argentino y la fila que lo describe
//     es de una tabla de AFIP. Es el mismo criterio que en A/B/C, donde 'CUIT: '
//     está hardcodeado fuera de PDF_LABELS.
//   - "Incoterms": es la misma palabra en los tres idiomas (es un término de la
//     Cámara de Comercio Internacional, no se traduce en ningún idioma).
const PDF_LABELS_E = {
    es: {
        razonSocial: 'Razón Social: ', domicilioComercial: 'Domicilio Comercial: ',
        condFrenteIva: 'Condición frente al IVA: ',
        comprNro: 'Compr. Nro: ', fechaEmision: 'Fecha de Emisión: ',
        ingresosBrutos: 'Ingresos Brutos: ',
        fechaInicio: 'Fecha de Inicio de Actividades: ',
        senores: 'Señor(es): ', domicilio: 'Domicilio: ',
        idImpositivo: 'ID Impositivo: ',
        divisa: 'Divisa: ', destinoCbte: 'Destino del Comprobante: ',
        formaPago: 'Forma de Pago: ', fechaPago: 'Fecha de Pago: ',
        thItem: 'Ítem', thDescripcion: 'Descripción', thCantidad: 'Cantidad',
        thPrecioUnit: 'Precio Unit.', thTotalItem: 'Total por ítem',
        uMedida: 'U. Medida:', observaciones: 'Observaciones:',
        tipoCambio: 'Tipo de Cambio: ', importeTotal: 'Importe Total: ',
        caeVto: 'Fecha de Vto. de CAE: ', pendiente: 'PENDIENTE',
    },
    en: {
        razonSocial: 'Legal Name: ', domicilioComercial: 'Business Address: ',
        condFrenteIva: 'VAT Condition: ',
        comprNro: 'Voucher No.: ', fechaEmision: 'Issue Date: ',
        ingresosBrutos: 'Gross Income Tax: ',
        fechaInicio: 'Start of Activities Date: ',
        senores: 'Client: ', domicilio: 'Address: ',
        idImpositivo: 'Tax ID: ',
        divisa: 'Currency: ', destinoCbte: 'Voucher Destination: ',
        formaPago: 'Payment Method: ', fechaPago: 'Payment Date: ',
        thItem: 'Item', thDescripcion: 'Description', thCantidad: 'Quantity',
        thPrecioUnit: 'Unit Price', thTotalItem: 'Item Total',
        uMedida: 'Unit:', observaciones: 'Remarks:',
        tipoCambio: 'Exchange Rate: ', importeTotal: 'Total Amount: ',
        caeVto: 'CAE Due Date: ', pendiente: 'PENDING',
    },
};

/**
 * Elige el idioma de los RÓTULOS del PDF de exportación.
 *
 * OJO — hay DOS idiomas en juego y son cosas distintas:
 *   • `language`          → idioma de la APP (config del board). Lo lee el USUARIO
 *                           de monday: mensajes, status, comentarios.
 *   • `draft.idioma_cbte` → campo AFIP Idioma_cbte (1=ES / 2=EN / 3=PT). Es el
 *                           idioma en el que el usuario DECLARÓ ANTE AFIP que
 *                           emite este comprobante. Lo lee el CLIENTE DEL EXTERIOR.
 *
 * Manda `idioma_cbte`. El PDF de exportación no es una pantalla de la app: es el
 * papel que viaja al importador. Que el emisor tenga su board en español no dice
 * nada sobre qué idioma entiende su cliente de Texas — `idioma_cbte` sí, y encima
 * ya está declarado ante AFIP, así que emitir el PDF en otro idioma que el
 * declarado sería incoherente con el propio comprobante.
 *
 * `language` queda SOLO como fallback para drafts que no traigan el campo (PDFs
 * regenerados de una fila vieja).
 *
 * PT (3) no tiene tabla de rótulos → cae a español, que es el idioma nativo del
 * comprobante fiscal argentino y el más cercano al portugués. Forzar inglés sería
 * meter un tercer idioma que nadie pidió.
 */
function resolveExportLang(idiomaCbte, language) {
    const i = Number(idiomaCbte);
    if (i === 2) return 'en';
    if (i === 1 || i === 3) return 'es';
    return language === 'en' ? 'en' : 'es';
}

async function generateFacturaEPdfBuffer({ company, draft, afipResult, language }) {
    // `langCbte` manda en TODO el PDF: rótulos y también los pocos VALORES que la
    // app traduce (la condición frente al IVA del emisor sale de condicionLabel).
    // Si se usara `language` para el valor saldría el rótulo en inglés y el valor
    // en español dentro de la misma línea.
    const langCbte = resolveExportLang(draft.idioma_cbte, language);
    const L = PDF_LABELS_E[langCbte];
    const qrImageBuffer = await fetchQrImage({ company, draft, afipResult, isExportacion: true });
    const logoBuffer = decodeCompanyLogo(company);
    const tRenderStart = Date.now();

    return new Promise((resolve, reject) => {
        try {
            const M = 18;
            const doc = new PDFDocument({ size: 'A4', margin: M });
            const buffers = [];
            doc.on('data', (chunk) => buffers.push(chunk));
            doc.on('end', () => {
                const buf = Buffer.concat(buffers);
                console.log(`[timing] pdf_render_fe: ${Date.now() - tRenderStart}ms bytes=${buf.length}`);
                resolve(buf);
            });
            doc.on('error', reject);

            const W = 595.28 - M * 2;
            const colLeft = M;
            const colRight = M + W;

            // Tipo AFIP: la fuente autoritativa es afipResult (lo que AFIP confirmó).
            // El resto de la cadena cubre PDFs regenerados desde un draft viejo.
            const cbteTipoNum = afipResult?.cbte_tipo_afip
                ?? draft.cbte_tipo_afip
                ?? TIPO_CBTE_NUM.E;
            const tipoCod = String(cbteTipoNum).padStart(2, '0');

            // Divisa: AFIP la imprime como "<símbolo> - <descripción>"
            // ("$ - Pesos Argentinos" / "USD - Dólar Estadounidense"). La
            // descripción sale de la tabla de monedas de WSFEX → es un dato de
            // AFIP, viene en español y NO se traduce.
            const moneda      = draft.moneda || 'PES';
            const monSym      = currencySymbol(moneda);
            const isMonExt    = moneda !== 'PES';
            const cotizacion  = Number(draft.cotizacion) || 1;
            const divisaTxt   = `${monSym} - ${draft.moneda_descripcion || moneda}`;

            const pv           = padNum(draft.punto_venta, 5);
            const nroComp      = padNum(afipResult?.numero_comprobante, 8);
            const fechaEmision = fmtDate(draft.fecha_emision);
            const caeVto       = fmtDate(afipResult?.cae_vencimiento);
            const startDate    = fmtDate(company.start_date);

            // ── ORIGINAL ─────────────────────────────────────────
            // Sin el letter-spacing que usa el PDF de A/B/C: el comprobante de
            // exportación de AFIP lo imprime derecho.
            let y = M;
            doc.rect(colLeft, y, W, 16).stroke('#000');
            doc.fontSize(8).font('Helvetica-Bold')
               .text('ORIGINAL', colLeft, y + 4, { width: W, align: 'center' });
            y += 16;

            // ── HEADER ───────────────────────────────────────────
            // Misma geometría que A/B/C (mismo producto, mismo marco de página):
            // emisor a la izquierda, recuadro de letra al medio, comprobante a la
            // derecha, y el divisor vertical justo en W/2.
            const headerH = 134;
            const BANNER_H = 56;
            const hy = y;
            doc.rect(colLeft, hy, W, headerH).stroke('#000');

            const centerW  = W * 0.08;
            const leftW    = (W - centerW) / 2;
            const centerX  = colLeft + leftW;
            const pad      = 8;
            const contentX = colLeft + pad;
            const contentW = leftW - pad * 2;
            const bannerCenterY = hy + BANNER_H / 2;

            // Logo + nombre de fantasía (igual que A/B/C — AFIP no tiene logo,
            // pero nuestros comprobantes sí y no hay razón para que la Factura E
            // sea el único sin la marca del emisor).
            const LOGO_SIZE = 50;
            const hasLogo = Boolean(logoBuffer);
            let nameX = contentX;
            let nameMaxW = contentW;
            if (hasLogo) {
                drawLogo(doc, contentX, hy + (BANNER_H - LOGO_SIZE) / 2, LOGO_SIZE, LOGO_SIZE, logoBuffer);
                nameX = contentX + LOGO_SIZE + 10;
                nameMaxW = contentW - LOGO_SIZE - 10;
            }
            const displayName = company.trade_name
                ? company.trade_name
                : invoiceRules.toTitleCase(company.business_name || '');
            doc.fontSize(14).font('Helvetica-Bold')
               .text(displayName, nameX, bannerCenterY - 7,
                     { width: nameMaxW, align: hasLogo ? 'left' : 'center', lineBreak: false });

            // Recuadro "E" + "COD. 19"
            const BOX_SIZE = 42;
            const boxX = (centerX + centerW / 2) - BOX_SIZE / 2;
            doc.rect(boxX, hy, BOX_SIZE, BOX_SIZE).stroke('#000');
            doc.fontSize(26).font('Helvetica-Bold')
               .text('E', boxX, hy + 6, { width: BOX_SIZE, align: 'center' });
            doc.fontSize(6).font('Helvetica-Bold')
               .text(`COD. ${tipoCod}`, boxX, hy + 34, { width: BOX_SIZE, align: 'center' });

            // "FACTURA DE EXPORTACIÓN" — leyenda de AFIP, NO se traduce ni se
            // abrevia a "Factura E": así la titula el comprobante oficial.
            const rx = centerX + centerW;
            const rightColW = colRight - rx - 8;
            doc.fontSize(16).font('Helvetica-Bold')
               .text('FACTURA DE EXPORTACIÓN', rx, bannerCenterY - 8,
                     { width: rightColW, align: 'center', lineBreak: false });

            doc.moveTo(centerX + centerW / 2, hy + BOX_SIZE)
               .lineTo(centerX + centerW / 2, hy + headerH).stroke('#000');

            // Emisor. Los offsets son fijos (no encadenados) para que el bloque no
            // se corra cuando el domicilio ocupa 1 línea en vez de 2.
            drawKV(doc, contentX, hy + 74, contentW,
                L.razonSocial, invoiceRules.toTitleCase(company.business_name || ''));
            // El domicilio del emisor puede necesitar 2 líneas. `ellipsis` corta si
            // no entra: preferimos truncar antes que pisar la fila de abajo.
            doc.fontSize(8).font('Helvetica-Bold');
            const domComLabelW = doc.widthOfString(L.domicilioComercial);
            doc.text(L.domicilioComercial, contentX, hy + 94, { lineBreak: false });
            doc.font('Helvetica').text(
                invoiceRules.toTitleCase(company.address || '-'),
                contentX + domComLabelW, hy + 94,
                { width: contentW - domComLabelW, height: 20, ellipsis: true });
            drawKV(doc, contentX, hy + 122, contentW, L.condFrenteIva,
                invoiceRules.toTitleCase(invoiceRules.condicionLabel(draft.emisorCondicion || '', langCbte)));

            // Comprobante. AFIP no separa "Punto de Venta" del número en la Factura E:
            // imprime un solo "Compr. Nro: 00004-00000045".
            const compX = centerX + centerW + 8;
            const compW = colRight - compX - 8;
            drawKV(doc, compX, hy + 53, compW, L.comprNro, `${pv}-${nroComp}`);
            drawKV(doc, compX, hy + 66, compW, L.fechaEmision, fechaEmision);
            drawKV(doc, compX, hy + 85, compW, 'CUIT: ', String(company.cuit || '').replace(/\D/g, ''));
            drawKV(doc, compX, hy + 98, compW, L.ingresosBrutos, fmtCuit(company.cuit));
            drawKV(doc, compX, hy + 111, compW, L.fechaInicio, startDate);
            // Va donde en A/B/C irían neto/IVA. Leyenda de AFIP → siempre español.
            doc.fontSize(8).font('Helvetica-Bold')
               .text('IVA EXENTO OPERACIÓN DE EXPORTACIÓN', compX, hy + 124,
                     { width: compW, lineBreak: false });
            y += headerH;

            // ── RECEPTOR ─────────────────────────────────────────
            // Sin CUIT ni condición frente al IVA: el receptor es del exterior. En
            // su lugar van CUIT País (la fila de AFIP que identifica país + tipo de
            // entidad) e ID Impositivo (el tax ID que le dio SU país).
            const receptorH = 52;
            doc.rect(colLeft, y, W, receptorH).stroke('#000');
            doc.fontSize(7.5);
            // Nombre y domicilio del receptor se respetan TAL CUAL los cargó el
            // usuario: acá no hay padrón de AFIP que devuelva todo en mayúsculas
            // (el criterio de A/B/C), y toTitleCase rompería razones sociales del
            // exterior ("M&P ... LLC." → "M&p ... Llc.") y códigos postales
            // ("WY 82801" → "Wy 82801"). Mismo criterio que el nombre de fantasía.
            doc.font('Helvetica-Bold').text(L.senores, colLeft + 8, y + 6, { lineBreak: false });
            doc.font('Helvetica').text(
                draft.receptor_nombre || '-',
                colLeft + W * 0.145, y + 6,
                { width: W * 0.29, height: 10, ellipsis: true });
            doc.font('Helvetica-Bold').text(L.domicilio, colLeft + W * 0.445, y + 6, { lineBreak: false });
            // Domicilio del exterior: suele necesitar 2 líneas (así sale en el
            // comprobante real de referencia).
            doc.font('Helvetica').text(
                draft.receptor_domicilio || '-',
                colLeft + W * 0.525, y + 6,
                { width: W * 0.475 - 8, height: 20, ellipsis: true });

            // "55000002126 (ESTADOS UNIDOS - Persona Jurídica)". La glosa entre
            // paréntesis es EXACTAMENTE la descripción de la fila DST_CUIT de AFIP:
            // fexResolveCuitPais() matchea justamente por `"<país> - <tipo entidad>"`,
            // así que rearmarla con esas dos partes da el mismo string que imprime
            // "Comprobantes en línea". Sin CUIT país (zonas francas) no hay fila que
            // glosar → el rótulo va vacío y el receptor queda identificado por su
            // ID Impositivo, que en ese caso AFIP exige (validación 1580).
            const glosaCuitPais = [draft.pais_destino_descripcion, draft.receptor_tipo_entidad]
                .filter(Boolean).join(' - ');
            const cuitPaisTxt = draft.receptor_cuit_pais
                ? `${draft.receptor_cuit_pais}${glosaCuitPais ? ` (${glosaCuitPais})` : ''}`
                : '';
            // OJO: los anchos se miden ANTES de dibujar. Medir con
            // `doc.font('Helvetica-Bold').widthOfString(...)` dentro de los
            // argumentos de un `.text()` deja la fuente en negrita antes de que ese
            // text() corra, y sale el valor en bold junto con el rótulo.
            const cuitPaisLabelW = doc.font('Helvetica-Bold').widthOfString('CUIT País: ');
            const idImpLabelW    = doc.font('Helvetica-Bold').widthOfString(L.idImpositivo);
            doc.font('Helvetica-Bold').text('CUIT País: ', colLeft + 8, y + 27, { lineBreak: false });
            doc.font('Helvetica').text(cuitPaisTxt, colLeft + 8 + cuitPaisLabelW, y + 27,
                { width: W - 16 - cuitPaisLabelW, height: 10, ellipsis: true });
            doc.font('Helvetica-Bold').text(L.idImpositivo, colLeft + 8, y + 39, { lineBreak: false });
            doc.font('Helvetica').text(draft.receptor_id_impositivo || '',
                colLeft + 8 + idImpLabelW, y + 39,
                { width: W - 16 - idImpLabelW, height: 10, ellipsis: true });
            y += receptorH;

            // ── DIVISA / DESTINO ─────────────────────────────────
            const divisaH = 46;
            doc.rect(colLeft, y, W, divisaH).stroke('#000');
            doc.fontSize(7.5);
            const divisaLabelW  = doc.font('Helvetica-Bold').widthOfString(L.divisa);
            const destinoLabelW = doc.font('Helvetica-Bold').widthOfString(L.destinoCbte);
            doc.font('Helvetica-Bold').text(L.divisa, colLeft + 8, y + 6, { lineBreak: false });
            doc.font('Helvetica').text(divisaTxt, colLeft + 8 + divisaLabelW, y + 6, { lineBreak: false });
            doc.font('Helvetica-Bold').text(L.destinoCbte, colLeft + 8, y + 18, { lineBreak: false });
            doc.font('Helvetica').text(draft.pais_destino_descripcion || '',
                colLeft + 8 + destinoLabelW, y + 18, { lineBreak: false });
            y += divisaH;

            // Corte visual: en el comprobante oficial el bloque de la operación
            // arranca separado del encabezado, sin bordes que los unan.
            y += 14;

            // ── FORMA DE PAGO / FECHA DE PAGO / INCOTERMS ────────
            const pagoH = 18;
            doc.rect(colLeft, y, W, pagoH).stroke('#000');
            doc.fontSize(7.5);
            doc.font('Helvetica-Bold').text(L.formaPago, colLeft + 8, y + 5, { lineBreak: false });
            doc.font('Helvetica').text(draft.forma_pago || '', colLeft + W * 0.20, y + 5,
                { width: W * 0.25, height: 10, ellipsis: true });
            // La X de Incoterms se calcula a partir de dónde TERMINA la fecha de pago
            // en vez de fijarse en una fracción del ancho: los rótulos cambian de
            // largo entre español e inglés y con una X fija se pisan.
            const fpX      = colLeft + W * 0.46;
            const fpValue  = fmtDate(draft.fecha_pago);
            const fpLabelW = doc.font('Helvetica-Bold').widthOfString(L.fechaPago);
            const fpValW   = doc.font('Helvetica').widthOfString(fpValue);
            doc.font('Helvetica-Bold').text(L.fechaPago, fpX, y + 5, { lineBreak: false });
            doc.font('Helvetica').text(fpValue, fpX + fpLabelW, y + 5, { lineBreak: false });
            // Incoterms: el rótulo va SIEMPRE aunque no haya valor — así sale en los
            // dos comprobantes reales (ambos de servicios). Los Incoterms describen
            // reparto de flete/seguro/riesgo de MERCADERÍA: en una exportación de
            // servicios no aplican, y hoy la app sólo emite servicios (Tipo_expo=2).
            doc.font('Helvetica-Bold').text('Incoterms: ', fpX + fpLabelW + fpValW + 16, y + 5,
                { lineBreak: false });
            y += pagoH;

            // ── TABLA DE ÍTEMS ───────────────────────────────────
            // Sin columna de IVA ni de bonificación: la operación es exenta y el
            // mapeo de exportación no tiene columna de bonificación.
            // La moneda va en el encabezado de las columnas con importes.
            const monSuffix = ` (${monSym})`;
            const cols = [
                { label: L.thItem,                        w: W * 0.06, align: 'center' },
                { label: L.thDescripcion,                 w: W * 0.53, align: 'left'   },
                { label: L.thCantidad,                    w: W * 0.15, align: 'right'  },
                { label: `${L.thPrecioUnit}${monSuffix}`, w: W * 0.14, align: 'right'  },
                { label: `${L.thTotalItem}${monSuffix}`,  w: W * 0.12, align: 'right'  },
            ];
            const headRowH = 16;
            doc.rect(colLeft, y, W, headRowH).fill('#f1f1f1').stroke('#000');
            let cx = colLeft;
            doc.fillColor('#000');
            for (const col of cols) {
                doc.rect(cx, y, col.w, headRowH).stroke('#000');
                // Cada rótulo se achica lo necesario para entrar en UNA línea: si
                // wrapea, se derrama sobre el primer renglón de ítems.
                const f = fitFontSize(doc, col.label, col.w - 4);
                doc.fontSize(f).font('Helvetica-Bold')
                   .text(col.label, cx + 2, y + (headRowH - f) / 2 - 0.5,
                         { width: col.w - 4, align: 'center', lineBreak: false });
                cx += col.w;
            }
            y += headRowH;

            const lineas = draft.lineas || [];
            const CANT_COL_X = colLeft + cols[0].w + cols[1].w;
            lineas.forEach((line, idx) => {
                const qty   = Number(line.quantity || 0);
                const price = Number(line.unit_price || 0);
                // El total por ítem lo calcula buildExportLinesFromSubitems y es EL
                // que se envió a AFIP: se usa ese, no se recalcula, para que el PDF
                // no pueda diferir del comprobante autorizado por un redondeo.
                const totalItem = line.total_item != null ? Number(line.total_item) : qty * price;
                const vals = [
                    padNum(idx + 1, 4),
                    line.concept || '',
                    fmtExpoCantidad(qty),
                    fmtExpoCantidad(price),
                    fmtExpoMoney(totalItem),
                ];

                // Alto dinámico: si la descripción wrapea, la fila crece.
                doc.fontSize(7).font('Helvetica');
                const descH = doc.heightOfString(vals[1], { width: cols[1].w - 6 });
                const rowH = Math.max(14, Math.ceil(descH) + 6);

                // Sin grilla en las filas: el comprobante oficial sólo tiene bordes
                // en el encabezado gris; los renglones van sueltos.
                cx = colLeft;
                for (let i = 0; i < cols.length; i++) {
                    doc.fontSize(7).font(i === 0 ? 'Helvetica-Bold' : 'Helvetica')
                       .text(vals[i], cx + 3, y + 3, { width: cols[i].w - 6, align: cols[i].align });
                    cx += cols[i].w;
                }
                y += rowH;

                // "U. Medida:" debajo del renglón, bajo la columna Cantidad. En los
                // dos comprobantes reales el rótulo aparece SIN valor — los dos son
                // de servicios, donde no hay unidad de medida que informar. Si el
                // board mapeó la columna, imprimimos el valor: el rótulo pelado no
                // le dice nada a nadie. Sin mapeo, el resultado es idéntico al oficial.
                const umed = (line.unidad_medida || '').trim();
                doc.fontSize(7);
                const umedLabelW = doc.font('Helvetica-Bold').widthOfString(L.uMedida);
                const umedValW   = umed ? doc.font('Helvetica').widthOfString(` ${umed}`) : 0;
                // Rótulo + valor centrados COMO PAR en la columna Cantidad. No se usa
                // `continued` con align:'center': pdfkit centra sólo el primer tramo y
                // pega el segundo corrido, y sale "U. Medida:Horas" descolocado.
                const umedX = CANT_COL_X + (cols[2].w - umedLabelW - umedValW) / 2;
                doc.font('Helvetica-Bold').text(L.uMedida, umedX, y, { lineBreak: false });
                if (umed) doc.font('Helvetica').text(` ${umed}`, umedX + umedLabelW, y, { lineBreak: false });
                y += 12;
            });

            // ── OBSERVACIONES (opcional) ─────────────────────────
            // Mismo criterio que A/B/C: apoyadas contra el bloque de totales, con el
            // blanco arriba. El pie del cuerpo se fija a la misma altura que en
            // A/B/C para que el footer (QR + CAE) quede en el mismo lugar en todos
            // los comprobantes que emite la app.
            const CONTENT_BOTTOM = M + 720;
            const totalesH = 46;
            const totalsY  = CONTENT_BOTTOM - totalesH;
            const obsText  = (draft.observaciones || '').trim();
            if (obsText) {
                doc.fontSize(8).font('Helvetica-Bold');
                const obsLabelW = doc.widthOfString(`${L.observaciones} `);
                const obsW = W - 16 - obsLabelW;
                doc.font('Helvetica');
                const obsH = Math.max(doc.heightOfString(obsText, { width: obsW }), 11);
                const obsY = totalsY - obsH - 6;
                doc.fillColor('#000').font('Helvetica-Bold')
                   .text(L.observaciones, colLeft + 8, obsY, { lineBreak: false });
                doc.font('Helvetica').text(obsText, colLeft + 8 + obsLabelW, obsY, { width: obsW });
            }

            // ── TOTALES ──────────────────────────────────────────
            // CERO IVA: ni neto, ni alícuotas, ni subtotales, ni "Otros Tributos".
            // La exportación es exenta — el único importe del pie es el total.
            doc.rect(colLeft, totalsY, W, totalesH).stroke('#000');
            let ty = totalsY + 8;

            // "Tipo de Cambio: 950.000000" — SOLO en moneda extranjera. En pesos el
            // comprobante real no lo imprime (la cotización es 1 y no aporta nada).
            // Con punto decimal y 6 dígitos: así lo imprime AFIP.
            // El `width` es obligatorio: pdfkit calcula el subrayado a partir del
            // ancho de la línea y con lineBreak:false le queda NaN.
            if (isMonExt) {
                const tcTxt = `${L.tipoCambio}${Number(cotizacion).toFixed(6)}`;
                doc.fontSize(8).font('Helvetica-Bold')
                   .text(tcTxt, colLeft + 8, ty,
                         { width: doc.widthOfString(tcTxt) + 1, underline: true });
            }
            doc.fontSize(8).font('Helvetica-Bold')
               .text(`${L.divisa}${divisaTxt}`, colLeft + 8, ty,
                     { width: W - 16, align: 'right', underline: true });
            ty += 18;

            // "Importe Total: USD    6000,00" — rótulo, símbolo chico y monto,
            // los tres pegados al margen derecho.
            const impValW = 90;
            const impValX = colRight - 8 - impValW;
            const impSymW = 24;
            const impSymX = impValX - impSymW - 2;
            const impLabW = 140;
            doc.fontSize(9.5).font('Helvetica-Bold')
               .text(L.importeTotal, impSymX - impLabW - 2, ty + 1, { width: impLabW, align: 'right' });
            doc.fontSize(7).font('Helvetica')
               .text(monSym, impSymX, ty + 3, { width: impSymW, align: 'right' });
            doc.fontSize(11).font('Helvetica-Bold')
               .text(fmtExpoMoney(draft.importe_total), impValX, ty, { width: impValW, align: 'right' });

            // ── FOOTER (fuera del recuadro) ──────────────────────
            const footerY = CONTENT_BOTTOM + 8;
            const QR_SIZE = 75;
            if (qrImageBuffer) {
                try {
                    doc.image(qrImageBuffer, colLeft, footerY, { width: QR_SIZE, height: QR_SIZE });
                } catch (imgErr) {
                    console.warn('[pdf-fe] No se pudo insertar QR en PDF:', imgErr.message);
                }
            }
            const arcaX = colLeft + (qrImageBuffer ? QR_SIZE + 10 : 0);
            doc.fillColor('#000');
            doc.fontSize(16).font('Helvetica-Bold').text('ARCA', arcaX, footerY);
            doc.fontSize(5).font('Helvetica-Bold')
               .text('AGENCIA DE RECAUDACIÓN Y CONTROL ADUANERO', arcaX, footerY + 18);
            doc.fontSize(9).font('Helvetica-BoldOblique')
               .text('Comprobante Autorizado', arcaX, footerY + 28);
            // OJO: el comprobante de exportación dice "por la veracidad de los datos",
            // mientras que el de A/B/C que emite la app dice "por los datos". Acá se
            // copia el texto tal cual sale de "Comprobantes en línea" para la E.
            doc.fontSize(5.5).font('Helvetica')
               .text('Esta Agencia no se responsabiliza por la veracidad de los datos ingresados en el detalle de la operación',
                     arcaX, footerY + 40);

            doc.fontSize(8).font('Helvetica-Bold')
               .text(`CAE N°: ${afipResult?.cae || L.pendiente}`, colRight - 180, footerY + 18,
                     { width: 180, align: 'right' });
            doc.fontSize(8).font('Helvetica')
               .text(`${L.caeVto}${caeVto}`, colRight - 180, footerY + 30, { width: 180, align: 'right' });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = {
    generateFacturaPdfBuffer,
    generateFacturaEPdfBuffer,
    calcularDesgloseIva,
    normalizeAlicuota,
};
