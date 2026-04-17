/**
 * pdfco.js — Generación de PDF de factura electrónica via pdf.co.
 *
 * Usa la API HTML→PDF de pdf.co para generar un PDF con diseño real.
 * Fallback: si pdf.co falla, genera un PDF básico con pdfkit.
 *
 * Referencia API: https://developer.pdf.co/api/pdf-from-html/
 */

'use strict';

const PDFDocument = require('pdfkit');
const config = require('../config');
const { condicionLabel } = require('./invoiceRules');

// ─── HTML Template ─────────────────────────────────────────────────────────

/**
 * Genera el HTML para la factura.
 * Soporta tipos A, B y C con el diseño correspondiente.
 */
function buildInvoiceHtml({ tipo, company, receptor, draft, afipResult }) {
    const { discriminaIva } = draft;
    const fecha = draft.fecha_emision || new Date().toLocaleDateString('es-AR');
    const puntoVenta = String(draft.punto_venta || '').padStart(5, '0');
    const nroComprobante = String(afipResult?.numero_comprobante || '0').padStart(8, '0');
    const cae = afipResult?.cae || 'PENDIENTE';
    const caeVto = afipResult?.cae_vencimiento || '';

    // Color de letra según tipo: A=negro borde, B=negro, C=negro
    const tipoColor = tipo === 'A' ? '#000' : tipo === 'B' ? '#000' : '#000';
    const tipoLetter = tipo;

    const lineasHtml = (draft.lineas || []).map((l, i) => {
        const qty   = Number(l.quantity   || 0);
        const price = Number(l.unit_price || 0);
        const subtotal = qty * price;
        return `
        <tr class="${i % 2 === 0 ? 'even' : 'odd'}">
          <td>${escHtml(l.concept || '')}</td>
          <td class="num">${qty}</td>
          <td class="num">${formatMoney(price)}</td>
          <td class="num">${formatMoney(subtotal)}</td>
        </tr>`;
    }).join('');

    const subtotal  = draft.importe_neto || 0;
    const iva21     = draft.importe_iva  || 0;
    const total     = draft.importe_total || 0;

    const ivaRow = discriminaIva
        ? `<tr><td colspan="3" class="right">IVA 21%</td><td class="num total-row">${formatMoney(iva21)}</td></tr>`
        : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #111; padding: 20px; }
  h1 { font-size: 14px; }
  .header { display: flex; justify-content: space-between; border: 2px solid #111; margin-bottom: 8px; }
  .header-left, .header-right { padding: 10px; width: 45%; }
  .header-center { width: 10%; display: flex; align-items: center; justify-content: center;
    border-left: 2px solid #111; border-right: 2px solid #111; }
  .tipo-letra { font-size: 42px; font-weight: bold; color: ${tipoColor}; }
  .tipo-sub { font-size: 9px; text-align: center; }
  .section { border: 1px solid #ccc; padding: 8px; margin-bottom: 6px; }
  .section-title { font-weight: bold; margin-bottom: 4px; border-bottom: 1px solid #ccc; padding-bottom: 2px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .label { color: #555; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  thead th { background: #222; color: #fff; padding: 4px 6px; text-align: left; }
  th.num, td.num { text-align: right; }
  tr.even { background: #f9f9f9; }
  td { padding: 3px 6px; border-bottom: 1px solid #eee; }
  .totales { margin-left: auto; width: 260px; border: 1px solid #ccc; }
  .totales td { padding: 4px 8px; }
  .total-row { font-weight: bold; font-size: 12px; }
  .right { text-align: right; }
  .cae-box { border: 2px solid #111; padding: 8px; margin-top: 8px; text-align: center; }
  .cae-box .cae-num { font-size: 16px; font-weight: bold; letter-spacing: 2px; }
  .footer { font-size: 9px; color: #888; text-align: center; margin-top: 10px; }
</style>
</head>
<body>

<!-- CABECERA -->
<div class="header">
  <div class="header-left">
    <h1>${escHtml(company.business_name || 'EMISOR')}</h1>
    <p><span class="label">Razón Social:</span> ${escHtml(company.business_name || '')}</p>
    <p><span class="label">CUIT:</span> ${formatCuit(company.cuit)}</p>
    <p><span class="label">Condición IVA:</span> ${escHtml(condicionLabel(draft.emisorCondicion || ''))}</p>
    <p><span class="label">Domicilio:</span> ${escHtml(company.address || '')}</p>
  </div>
  <div class="header-center">
    <div>
      <div class="tipo-letra">${tipoLetter}</div>
      <div class="tipo-sub">COD. ${tipo === 'A' ? '001' : tipo === 'B' ? '006' : '011'}</div>
    </div>
  </div>
  <div class="header-right">
    <p><strong>FACTURA</strong></p>
    <p><span class="label">N°:</span> <strong>${puntoVenta}-${nroComprobante}</strong></p>
    <p><span class="label">Fecha:</span> ${escHtml(fecha)}</p>
    <p><span class="label">Punto de Venta:</span> ${puntoVenta}</p>
    <p><span class="label">Inicio actividades:</span> ${escHtml(company.start_date || '')}</p>
  </div>
</div>

<!-- RECEPTOR -->
<div class="section">
  <div class="section-title">Datos del Receptor</div>
  <div class="grid-2">
    <p><span class="label">Nombre / Razón Social:</span> ${escHtml(receptor?.nombre || draft.receptor_nombre || '')}</p>
    <p><span class="label">Condición IVA:</span> ${escHtml(condicionLabel(draft.receptorCondicion || ''))}</p>
    <p><span class="label">CUIT / DNI:</span> ${escHtml(String(draft.receptor_cuit_o_dni || ''))}</p>
    <p><span class="label">Domicilio:</span> ${escHtml(draft.receptor_domicilio || '')}</p>
  </div>
</div>

<!-- LÍNEAS -->
<table>
  <thead>
    <tr>
      <th>Descripción</th>
      <th class="num">Cant.</th>
      <th class="num">Precio Unit.</th>
      <th class="num">Subtotal</th>
    </tr>
  </thead>
  <tbody>${lineasHtml}</tbody>
</table>

<!-- TOTALES -->
<table class="totales">
  <tr>
    <td colspan="3" class="right">Subtotal (neto)</td>
    <td class="num">${formatMoney(subtotal)}</td>
  </tr>
  ${ivaRow}
  <tr style="background:#f0f0f0">
    <td colspan="3" class="right total-row">TOTAL</td>
    <td class="num total-row">$ ${formatMoney(total)}</td>
  </tr>
</table>

<!-- CAE -->
<div class="cae-box">
  <p>CAE: <span class="cae-num">${escHtml(cae)}</span></p>
  <p>Vencimiento CAE: ${escHtml(caeVto)}</p>
</div>

<div class="footer">
  Comprobante emitido electrónicamente por AFIP — Factura Tipo ${tipoLetter}
</div>

</body>
</html>`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatMoney(n) {
    return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCuit(cuit) {
    const c = String(cuit || '').replace(/\D/g, '');
    if (c.length === 11) return `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`;
    return cuit;
}

// ─── pdf.co API ───────────────────────────────────────────────────────────────

/**
 * Genera un PDF via pdf.co a partir del HTML de la factura.
 * Devuelve un Buffer con el PDF.
 *
 * @param {string} html
 * @returns {Promise<Buffer>}
 */
async function htmlToPdfViaPdfCo(html) {
    const apiKey = config.pdfCoApiKey;
    if (!apiKey) throw new Error('Falta PDF_CO_API_KEY en variables de entorno');

    // Paso 1: Solicitar conversión
    const response = await fetch('https://api.pdf.co/v1/pdf/convert/from/html', {
        method: 'POST',
        headers: {
            'x-api-key':    apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            html,
            name:   'factura.pdf',
            async:  false,
            margins: '10mm 10mm 10mm 10mm',
            paperSize: 'A4',
        }),
    });

    const result = await response.json();

    if (result.error || !result.url) {
        throw new Error(`pdf.co error: ${result.message || JSON.stringify(result)}`);
    }

    // Paso 2: Descargar el PDF generado
    const pdfResponse = await fetch(result.url);
    if (!pdfResponse.ok) {
        throw new Error(`No se pudo descargar el PDF de pdf.co: HTTP ${pdfResponse.status}`);
    }

    const arrayBuffer = await pdfResponse.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

// ─── Fallback: pdfkit básico ──────────────────────────────────────────────────

function generateFallbackPdf({ company, draft, afipResult, tipo }) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            doc.fontSize(18).text(`FACTURA TIPO ${tipo}`, { align: 'center' });
            doc.moveDown();
            doc.fontSize(11);
            doc.text(`Emisor: ${company.business_name} — CUIT: ${company.cuit}`);
            doc.text(`Receptor: ${draft.receptor_nombre || ''} — CUIT/DNI: ${draft.receptor_cuit_o_dni || ''}`);
            doc.text(`Fecha: ${draft.fecha_emision || new Date().toLocaleDateString('es-AR')}`);
            doc.text(`N° Comprobante: ${draft.punto_venta}-${afipResult?.numero_comprobante || ''}`);
            doc.moveDown();

            (draft.lineas || []).forEach(l => {
                doc.text(`${l.concept} — Cant: ${l.quantity} × $${l.unit_price} = $${Number(l.quantity) * Number(l.unit_price)}`);
            });

            doc.moveDown();
            doc.text(`Total: $${draft.importe_total || 0}`, { underline: true });
            doc.moveDown();
            if (afipResult?.cae) {
                doc.text(`CAE: ${afipResult.cae}`);
                doc.text(`Vto CAE: ${afipResult.cae_vencimiento || ''}`);
            }

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Genera el PDF de una factura. Intenta pdf.co y hace fallback a pdfkit si falla.
 *
 * @param {object} opts
 * @param {'A'|'B'|'C'} opts.tipo
 * @param {object} opts.company     - Datos de la empresa emisora (DB row)
 * @param {object} opts.receptor    - { nombre, condicion } del receptor (del padrón)
 * @param {object} opts.draft       - Datos del borrador de la factura
 * @param {object} opts.afipResult  - Respuesta de AFIP (cae, numero_comprobante, etc.)
 *
 * @returns {Promise<Buffer>}  Buffer del PDF
 */
async function generateInvoicePdf({ tipo, company, receptor, draft, afipResult }) {
    const html = buildInvoiceHtml({ tipo, company, receptor, draft, afipResult });

    try {
        return await htmlToPdfViaPdfCo(html);
    } catch (pdfCoErr) {
        console.warn('[pdfco] Error con pdf.co, usando pdfkit como fallback:', pdfCoErr.message);
        return generateFallbackPdf({ company, draft, afipResult, tipo });
    }
}

module.exports = { generateInvoicePdf, buildInvoiceHtml };
