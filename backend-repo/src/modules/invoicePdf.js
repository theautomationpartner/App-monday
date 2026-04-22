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

    return new Promise((resolve, reject) => {
        try {
            const M = 28;
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

            const pv = padNum(draft.punto_venta, 5);
            const nroComp = padNum(afipResult?.numero_comprobante, 8);
            const fechaEmision = fmtDate(draft.fecha_emision) || new Date().toLocaleDateString('es-AR');
            const caeVto = fmtDate(afipResult?.cae_vencimiento);
            const startDate = fmtDate(company.start_date);

            // Borde exterior. La altura final del bloque depende del pie de
            // totales: Factura A necesita más alto para el desglose de IVA.
            const totalesH = isFacturaA ? 142 : 50;
            const boxTop = M;
            const boxH = 700;
            doc.rect(colLeft, boxTop, W, boxH).stroke('#000');

            // ── ORIGINAL tag ─────────────────────────────────────
            let y = boxTop;
            doc.rect(colLeft, y, W, 16).stroke('#000');
            doc.fontSize(8).font('Helvetica-Bold')
               .text('O R I G I N A L', colLeft, y + 4, { width: W, align: 'center', characterSpacing: 3 });
            y += 16;

            // ── HEADER ROW ───────────────────────────────────────
            const headerH = 110;
            doc.rect(colLeft, y, W, headerH).stroke('#000');

            const leftW = W * 0.46;
            const centerW = W * 0.08;

            // Emisor (izquierda)
            let ey = y + 12;
            doc.fontSize(12).font('Helvetica-Bold')
               .text((company.business_name || '').toUpperCase(), colLeft + 8, ey, { width: leftW - 16, align: 'center' });
            ey += 22;
            doc.fontSize(8).font('Helvetica');
            doc.font('Helvetica-Bold').text('Razón Social: ', colLeft + 8, ey, { continued: true });
            doc.font('Helvetica').text((company.business_name || '').toUpperCase());
            ey += 12;
            doc.font('Helvetica-Bold').text('Domicilio Comercial: ', colLeft + 8, ey, { continued: true });
            doc.font('Helvetica').text((company.address || '-').toUpperCase());
            ey += 12;
            doc.font('Helvetica-Bold').text('Condición frente al IVA: ', colLeft + 8, ey, { continued: true });
            doc.font('Helvetica').text(invoiceRules.condicionLabel(draft.emisorCondicion || ''));

            // Centro — caja con letra de comprobante (A=01, B=06, C=11)
            const centerX = colLeft + leftW;
            const boxSize = 42;
            const boxX = centerX + (centerW - boxSize) / 2;
            doc.rect(boxX, y, boxSize, boxSize).stroke('#000');
            doc.fontSize(26).font('Helvetica-Bold')
               .text(tipoLetra, boxX, y + 6, { width: boxSize, align: 'center' });
            doc.fontSize(6).font('Helvetica-Bold')
               .text(`COD. ${tipoCod}`, boxX, y + 34, { width: boxSize, align: 'center' });
            doc.moveTo(centerX + centerW / 2, y + boxSize).lineTo(centerX + centerW / 2, y + headerH).stroke('#000');

            // Comprobante (derecha)
            const rx = centerX + centerW + 8;
            let ry = y + 12;
            doc.fontSize(16).font('Helvetica-Bold').text('FACTURA', rx, ry);
            ry += 22;
            doc.fontSize(8).font('Helvetica-Bold')
               .text(`Punto de Venta: ${pv}    Comp. Nro: ${nroComp}`, rx, ry);
            ry += 12;
            doc.font('Helvetica-Bold').text('Fecha de Emisión: ', rx, ry, { continued: true });
            doc.font('Helvetica').text(fechaEmision);
            ry += 12;
            doc.font('Helvetica-Bold').text('CUIT: ', rx, ry, { continued: true });
            doc.font('Helvetica').text(fmtCuit(company.cuit));
            ry += 12;
            doc.font('Helvetica-Bold').text('Ingresos Brutos: ', rx, ry, { continued: true });
            doc.font('Helvetica').text(fmtCuit(company.cuit));
            ry += 12;
            doc.font('Helvetica-Bold').text('Fecha de Inicio de Actividades: ', rx, ry, { continued: true });
            doc.font('Helvetica').text(startDate);

            y += headerH;

            // ── PERÍODO (solo servicios o productos+servicios) ────
            if (draft.concepto_afip === 2 || draft.concepto_afip === 3) {
                const periodoH = 18;
                doc.rect(colLeft, y, W, periodoH).stroke('#000');
                doc.fontSize(7.5);
                const periodoY = y + 5;
                const thirdW = W / 3;
                doc.font('Helvetica-Bold').text('Período Facturado Desde: ', colLeft + 8, periodoY, { continued: true });
                doc.font('Helvetica').text(fmtDate(draft.fecha_servicio_desde) || fechaEmision);
                doc.font('Helvetica-Bold').text('Hasta: ', colLeft + thirdW + 8, periodoY, { continued: true });
                doc.font('Helvetica').text(fmtDate(draft.fecha_servicio_hasta) || fechaEmision);
                doc.font('Helvetica-Bold').text('Fecha de Vto. para el pago: ', colLeft + thirdW * 2 + 8, periodoY, { continued: true });
                doc.font('Helvetica').text(fmtDate(draft.fecha_vto_pago) || fechaEmision);
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
                const subtotalConIva = subtotal * (1 + Number(ali) / 100);

                cx = colLeft;
                const vals = isFacturaA ? [
                    '',
                    line.concept || line.descripcion || '',
                    String(qty),
                    (line.unidad_medida || 'unidades').toLowerCase(),
                    fmtMoney(price),
                    '0,00',
                    fmtMoney(subtotal),
                    `${ali}%`,
                    fmtMoney(subtotalConIva),
                ] : [
                    '',
                    line.concept || line.descripcion || '',
                    String(qty),
                    (line.unidad_medida || 'unidades').toLowerCase(),
                    fmtMoney(price),
                    '0,00',
                    '0,00',
                    fmtMoney(subtotal),
                ];
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
               .text('Pág. 1/1', colLeft + W / 2 - 20, footerY + 24);

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
