/**
 * invoicePdf.js — Generación del PDF de la factura replicando el diseño oficial de ARCA.
 *
 * Diferencias clave por tipo de comprobante:
 *  - Factura A (RG 1415 Anexo II Ap. A.IV.a): discrimina IVA → suma columnas
 *    "Alícuota IVA" y "Subtotal c/IVA" en la grilla, y desglosa Neto Gravado +
 *    IVA por alícuota (27/21/10.5/5/2.5/0) en el pie.
 *  - Factura B/C: layout sin discriminación (IVA incluido o no aplicable).
 */

'use strict';

const PDFDocument = require('pdfkit');
const invoiceRules = require('./invoiceRules');

// Códigos AFIP de comprobante (siempre 2 dígitos en el cabezal según ARCA).
const TIPO_COD = { A: '01', B: '06', C: '11' };
const TIPO_CBTE_NUM = { A: 1, B: 6, C: 11 };

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
// Las 3 copias tradicionales AFIP: ORIGINAL (cliente), DUPLICADO (emisor),
// TRIPLICADO (transporte/archivo). Se imprimen como 3 páginas idénticas
// del mismo PDF, cambia sólo el tag superior y la numeración del footer.
const INVOICE_COPIES = ['ORIGINAL', 'DUPLICADO', 'TRIPLICADO'];

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

async function fetchQrImage({ company, draft, afipResult }) {
    try {
        const qrData = {
            ver: 1,
            fecha: draft.fecha_emision || new Date().toISOString().slice(0, 10),
            cuit: Number(String(company.cuit).replace(/\D/g, '')),
            ptoVta: Number(draft.punto_venta),
            tipoCmp: TIPO_CBTE_NUM[afipResult?.tipo_comprobante] ?? 11,
            nroCmp: Number(afipResult?.numero_comprobante || 0),
            importe: Number(draft.importe_total || 0),
            moneda: 'PES',
            ctz: 1,
            tipoDocRec: Number(draft.docTipo ?? 99),
            nroDocRec: Number(draft.docNro ?? 0),
            tipoCodAut: 'E',
            codAut: Number(afipResult?.cae || 0),
        };
        const base64Payload = Buffer.from(JSON.stringify(qrData)).toString('base64');
        const arcaUrl = `https://www.afip.gob.ar/fe/qr/?p=${base64Payload}`;
        // size=600 → PNG nítido al escalarlo en el PDF.
        // margin=4 → quiet zone obligatoria para que los lectores detecten los patrones a distancia.
        // ecc=M → 15% de corrección de errores (default L = 7% es muy frágil).
        const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=4&ecc=M&data=${encodeURIComponent(arcaUrl)}`;
        const qrResp = await fetch(qrApiUrl);
        if (qrResp.ok) return Buffer.from(await qrResp.arrayBuffer());
    } catch (err) {
        console.warn('[pdf] No se pudo generar QR:', err.message);
    }
    return null;
}

async function generateFacturaPdfBuffer({ company, draft, afipResult /*, itemId */ }) {
    const qrImageBuffer = await fetchQrImage({ company, draft, afipResult });
    const logoBuffer = decodeCompanyLogo(company);

    return new Promise((resolve, reject) => {
        try {
            const M = 18; // margen reducido (antes 28pt) — recuadro más ancho
            const doc = new PDFDocument({ size: 'A4', margin: M });
            const buffers = [];
            doc.on('data', (chunk) => buffers.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            const W = 595.28 - M * 2;
            const colLeft = M;
            const colRight = M + W;

            const tipoLetra = draft.tipo_comprobante || 'C';
            const tipoCod = TIPO_COD[tipoLetra] || '11';
            const isFacturaA = tipoLetra === 'A';
            const isFacturaB = tipoLetra === 'B';

            const pv = padNum(draft.punto_venta, 5);
            const nroComp = padNum(afipResult?.numero_comprobante, 8);
            const fechaEmision = fmtDate(draft.fecha_emision) || new Date().toLocaleDateString('es-AR');
            const caeVto = fmtDate(afipResult?.cae_vencimiento);
            const startDate = fmtDate(company.start_date);

            // Loop por las 3 copias tradicionales: ORIGINAL / DUPLICADO / TRIPLICADO.
            // Cada copia es una página idéntica salvo por el tag superior y la
            // numeración del footer. Aplica igual para A, B y C.
            const totalPages = INVOICE_COPIES.length;
            for (let copyIdx = 0; copyIdx < totalPages; copyIdx++) {
                if (copyIdx > 0) doc.addPage();
                const copyTag = INVOICE_COPIES[copyIdx];
                const pageNum = copyIdx + 1;

            // Borde exterior. La altura final del bloque depende del pie de totales:
            // - A: desglose de IVA por alícuota
            // - B: agrega leyenda Régimen de Transparencia Fiscal + IVA Contenido (RG 5614/2024)
            // - C: solo subtotal y total
            const totalesH = isFacturaA ? 142 : (isFacturaB ? 90 : 50);
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

            // Nombre del emisor (centrado vertical en banner)
            const nameFontSize = 14;
            doc.fontSize(nameFontSize).font('Helvetica-Bold')
               .text((company.business_name || '').toUpperCase(),
                     nameX, bannerCenterY - nameFontSize / 2,
                     { width: nameMaxW, align: hasLogo ? 'left' : 'center', lineBreak: false });

            // Letra A/B/C (pegada al borde superior del header, como AFIP clásico)
            const BOX_SIZE = 42;
            const boxX = centerX + (centerW - BOX_SIZE) / 2;
            const boxY = y;
            doc.rect(boxX, boxY, BOX_SIZE, BOX_SIZE).stroke('#000');
            doc.fontSize(26).font('Helvetica-Bold')
               .text(tipoLetra, boxX, boxY + 6, { width: BOX_SIZE, align: 'center' });
            doc.fontSize(6).font('Helvetica-Bold')
               .text(`COD. ${tipoCod}`, boxX, boxY + 34, { width: BOX_SIZE, align: 'center' });

            // FACTURA (centrado horizontalmente en su columna, vertical con nombre/logo)
            const rx = centerX + centerW;
            const rightColW = colRight - rx - 8;
            const facturaFontSize = 16;
            doc.fontSize(facturaFontSize).font('Helvetica-Bold')
               .text('FACTURA', rx, bannerCenterY - facturaFontSize / 2,
                     { width: rightColW, align: 'center', lineBreak: false });

            // Línea vertical desde bottom del cuadro de la letra hasta bottom del header
            doc.moveTo(centerX + centerW / 2, boxY + BOX_SIZE)
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

            // Emisor
            let dy = dataStartY;
            drawKV(doc, contentX, dy, contentW,
                'Razón Social: ', (company.business_name || '').toUpperCase());
            dy += STEP;
            drawKV(doc, contentX, dy, contentW,
                'Domicilio: ', (company.address || '-').toUpperCase());
            dy += STEP;
            drawKV(doc, contentX, dy, contentW,
                'Cond. IVA: ', invoiceRules.condicionLabel(draft.emisorCondicion || ''));
            if (company.phone) {
                dy += STEP;
                drawKV(doc, contentX, dy, contentW, 'Tel: ', company.phone);
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
            drawKV(doc, compX, cry, compW, 'Punto de Venta: ', `${pv}   Comp. Nro: ${nroComp}`);
            cry += STEP;
            drawKV(doc, compX, cry, compW, 'Fecha de Emisión: ', fechaEmision);
            cry += STEP;
            drawKV(doc, compX, cry, compW, 'CUIT: ', fmtCuit(company.cuit));
            cry += STEP;
            drawKV(doc, compX, cry, compW, 'Ingresos Brutos: ', fmtCuit(company.cuit));
            cry += STEP;
            drawKV(doc, compX, cry, compW, 'Fecha de Inicio de Actividades: ', startDate);

            y += headerH;

            // ── PERÍODO (solo servicios o productos+servicios) ────
            // Layout: izquierda | centro geométrico | derecha alineado
            //   Período Facturado Desde: ...   Hasta: ...   Fecha de Vto. para el pago: ...
            if (draft.concepto_afip === 2 || draft.concepto_afip === 3) {
                const periodoH = 18;
                doc.rect(colLeft, y, W, periodoH).stroke('#000');
                const periodoY = y + 5;
                doc.fontSize(7.5);

                // Izquierda: Período Facturado Desde
                doc.font('Helvetica-Bold').text('Período Facturado Desde: ', colLeft + 8, periodoY, { continued: true, lineBreak: false });
                doc.font('Helvetica').text(fmtDate(draft.fecha_servicio_desde) || fechaEmision, { lineBreak: false });

                // Centro: Hasta (geométricamente centrado en W/2)
                const hastaLabel = 'Hasta: ';
                const hastaValue = fmtDate(draft.fecha_servicio_hasta) || fechaEmision;
                doc.font('Helvetica-Bold');
                const hastaLabelW = doc.widthOfString(hastaLabel);
                doc.font('Helvetica');
                const hastaValueW = doc.widthOfString(hastaValue);
                const hastaX = colLeft + (W - hastaLabelW - hastaValueW) / 2;
                doc.font('Helvetica-Bold').text(hastaLabel, hastaX, periodoY, { lineBreak: false });
                doc.font('Helvetica').text(hastaValue, hastaX + hastaLabelW, periodoY, { lineBreak: false });

                // Derecha: Fecha de Vto. para el pago (alineado a la derecha)
                const vtoLabel = 'Fecha de Vto. para el pago: ';
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
            doc.font('Helvetica-Bold').text('Apellido y Nombre / Razón Social: ', colLeft + halfW + 8, cy, { continued: true });
            doc.font('Helvetica').text((draft.receptor_nombre || 'CONSUMIDOR FINAL').toUpperCase());
            cy += 12;
            doc.font('Helvetica-Bold').text('Condición frente al IVA: ', colLeft + 8, cy, { continued: true });
            doc.font('Helvetica').text(invoiceRules.condicionLabel(draft.receptorCondicion || ''));
            doc.font('Helvetica-Bold').text('Domicilio Comercial: ', colLeft + halfW + 8, cy, { continued: true });
            doc.font('Helvetica').text((draft.receptor_domicilio || '-').toUpperCase());
            cy += 12;
            doc.font('Helvetica-Bold').text('Condición de venta: ', colLeft + 8, cy, { continued: true });
            doc.font('Helvetica').text((draft.condicion_venta || 'Contado').toUpperCase());
            y += receptorH;

            // ── TABLA DE ITEMS ───────────────────────────────────
            // Factura A: agrega Alícuota IVA + Subtotal c/IVA (RG 1415 Ap. A.IV.a).
            // B/C: layout original sin discriminación.
            const cols = isFacturaA ? [
                { label: 'Código',              w: W * 0.06, align: 'center' },
                { label: 'Producto / Servicio',  w: W * 0.26, align: 'left'   },
                { label: 'Cantidad',             w: W * 0.07, align: 'right'  },
                { label: 'U. Medida',            w: W * 0.08, align: 'center' },
                { label: 'Precio Unit.',         w: W * 0.11, align: 'right'  },
                { label: '% Bonif',              w: W * 0.07, align: 'right'  },
                { label: 'Subtotal',             w: W * 0.11, align: 'right'  },
                { label: 'Alícuota IVA',         w: W * 0.10, align: 'center' },
                { label: 'Subtotal c/IVA',       w: W * 0.14, align: 'right'  },
            ] : [
                { label: 'Código',              w: W * 0.08, align: 'center' },
                { label: 'Producto / Servicio',  w: W * 0.30, align: 'left'   },
                { label: 'Cantidad',             w: W * 0.08, align: 'right'  },
                { label: 'U. Medida',            w: W * 0.10, align: 'center' },
                { label: 'Precio Unit.',         w: W * 0.13, align: 'right'  },
                { label: '% Bonif',              w: W * 0.08, align: 'right'  },
                { label: 'Imp. Bonif.',          w: W * 0.10, align: 'right'  },
                { label: 'Subtotal',             w: W * 0.13, align: 'right'  },
            ];
            const rowH = 16;

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
                        (line.unidad_medida || 'unidades').toLowerCase(),
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
                        (line.unidad_medida || 'unidades').toLowerCase(),
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
                        (line.unidad_medida || 'unidades').toLowerCase(),
                        fmtMoney(price),
                        '0,00',
                        '0,00',
                        fmtMoney(subtotal),
                    ];
                }
                for (let i = 0; i < cols.length; i++) {
                    doc.rect(cx, y, cols[i].w, rowH).stroke('#000');
                    doc.fontSize(7).font('Helvetica')
                       .text(vals[i], cx + 3, y + 4, { width: cols[i].w - 6, align: cols[i].align });
                    cx += cols[i].w;
                }
                y += rowH;
            }

            // Espacio vacío restante hasta totales
            const totalsY = boxTop + boxH - totalesH;
            if (y < totalsY) {
                doc.moveTo(colLeft, y).lineTo(colLeft, totalsY).stroke('#000');
                doc.moveTo(colRight, y).lineTo(colRight, totalsY).stroke('#000');
                y = totalsY;
            }

            // ── TOTALES ──────────────────────────────────────────
            doc.rect(colLeft, y, W, totalesH).stroke('#000');
            const labelW = 200;
            const valueW = 110;
            const totLabelX = colRight - labelW - valueW - 12;
            const totValueX = colRight - valueW - 8;
            let ty = y + 8;
            doc.fontSize(8);

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

                drawRow('Importe Neto Gravado: $', fmtMoney(netoGravado), true);
                drawRow('IVA 27%: $',   fmtMoney(ivaPorAlicuota['27']));
                drawRow('IVA 21%: $',   fmtMoney(ivaPorAlicuota['21']));
                drawRow('IVA 10.5%: $', fmtMoney(ivaPorAlicuota['10.5']));
                drawRow('IVA 5%: $',    fmtMoney(ivaPorAlicuota['5']));
                drawRow('IVA 2.5%: $',  fmtMoney(ivaPorAlicuota['2.5']));
                drawRow('IVA 0%: $',    fmtMoney(ivaPorAlicuota['0']));
                drawRow('Importe Otros Tributos: $', '0,00');
                drawRow('Importe Total: $',
                    fmtMoney(draft.importe_total ?? importeTotalCalculado), true);
            } else {
                doc.font('Helvetica-Bold').text('Subtotal: $', totLabelX, ty, { width: labelW, align: 'right' });
                doc.font('Helvetica-Bold').text(fmtMoney(draft.importe_total), totValueX, ty, { width: valueW, align: 'right' });
                ty += 14;
                doc.font('Helvetica-Bold').text('Importe Otros Tributos: $', totLabelX, ty, { width: labelW, align: 'right' });
                doc.font('Helvetica-Bold').text('0,00', totValueX, ty, { width: valueW, align: 'right' });
                ty += 14;
                doc.font('Helvetica-Bold').text('Importe Total: $', totLabelX, ty, { width: labelW, align: 'right' });
                doc.font('Helvetica-Bold').text(fmtMoney(draft.importe_total), totValueX, ty, { width: valueW, align: 'right' });

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
                    doc.font('Helvetica-Bold').text('IVA Contenido: $', totLabelX, ty, { width: labelW, align: 'right' });
                    doc.font('Helvetica-Bold').text(fmtMoney(ivaContenido), totValueX, ty, { width: valueW, align: 'right' });
                }
            }

            y = boxTop + boxH;

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
               .text(`CAE N°: ${afipResult?.cae || 'PENDIENTE'}`, colRight - 180, footerY + 18, { width: 180, align: 'right' });
            doc.fontSize(8).font('Helvetica')
               .text(`Fecha de Vto. de CAE: ${caeVto}`, colRight - 180, footerY + 30, { width: 180, align: 'right' });

            doc.fontSize(8).font('Helvetica')
               .text(`Pág. ${pageNum}/${totalPages}`, colLeft + W / 2 - 20, footerY + 24);

            } // end for copyIdx (loop por ORIGINAL / DUPLICADO / TRIPLICADO)

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = {
    generateFacturaPdfBuffer,
    calcularDesgloseIva,
    normalizeAlicuota,
};
