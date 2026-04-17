/**
 * pdfInvoice.js — Generación de PDF de factura electrónica con pdfmake.
 *
 * 100% local, sin servicios externos, sin créditos.
 * Soporta Factura A (discrimina IVA), B y C.
 */

'use strict';

const { condicionLabel } = require('./invoiceRules');

// pdfmake 0.3.x: usamos la API "client-side" (createPdf + getBuffer), que
// tambien funciona en Node. No existe PdfPrinter server-side en esta version.
const pdfMake      = require('pdfmake/build/pdfmake');
const pdfMakeFonts = require('pdfmake/build/vfs_fonts');

// El vfs_fonts exporta las keys directamente (Roboto-*.ttf en base64).
pdfMake.vfs = pdfMakeFonts;
pdfMake.fonts = {
    Roboto: {
        normal:      'Roboto-Regular.ttf',
        bold:        'Roboto-Medium.ttf',
        italics:     'Roboto-Italic.ttf',
        bolditalics: 'Roboto-MediumItalic.ttf',
    },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n) {
    return Number(n || 0).toLocaleString('es-AR', {
        minimumFractionDigits:  2,
        maximumFractionDigits:  2,
    });
}

function fmtCuit(cuit) {
    const c = String(cuit || '').replace(/\D/g, '');
    if (c.length === 11) return `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`;
    return cuit || '';
}

function padLeft(str, len, char = '0') {
    return String(str || '').padStart(len, char);
}

// ─── Definición del documento ─────────────────────────────────────────────────

/**
 * Construye la definición pdfmake para una factura.
 *
 * @param {object} opts
 * @param {'A'|'B'|'C'} opts.tipo
 * @param {object} opts.company     - Empresa emisora (DB row)
 * @param {object} opts.receptor    - { nombre, condicion } del padrón
 * @param {object} opts.draft       - Borrador de la factura
 * @param {object} opts.afipResult  - { cae, cae_vencimiento, numero_comprobante, resultado }
 */
function buildDocDefinition({ tipo, company, receptor, draft, afipResult }) {
    const puntoVenta     = padLeft(draft.punto_venta, 5);
    const nroComprobante = padLeft(afipResult?.numero_comprobante, 8);
    const cae            = afipResult?.cae            || 'PENDIENTE';
    const caeVto         = afipResult?.cae_vencimiento || '-';
    const fecha          = draft.fecha_emision
        ? draft.fecha_emision.slice(0, 10).split('-').reverse().join('/')
        : new Date().toLocaleDateString('es-AR');

    // ── Cabecera: letra tipo factura ──────────────────────────────────────────
    const headerTable = {
        table: {
            widths: ['*', 60, '*'],
            body: [[
                // Columna izquierda: datos del emisor
                {
                    stack: [
                        { text: company.business_name || '', style: 'companyName' },
                        { text: `CUIT: ${fmtCuit(company.cuit)}`, style: 'small' },
                        { text: `Cond. IVA: ${condicionLabel(draft.emisorCondicion || '')}`, style: 'small' },
                        { text: company.address || '', style: 'small' },
                        { text: `Inicio actividades: ${company.start_date || '-'}`, style: 'small' },
                    ],
                    border: [true, true, false, true],
                    margin: [8, 8, 4, 8],
                },
                // Columna central: letra grande
                {
                    stack: [
                        { text: tipo, style: 'tipoLetra', alignment: 'center' },
                        { text: `Cod. ${tipo === 'A' ? '001' : tipo === 'B' ? '006' : '011'}`, style: 'tipoCode', alignment: 'center' },
                    ],
                    border: [true, true, true, true],
                    fillColor: '#FFFFFF',
                    margin: [4, 12, 4, 4],
                },
                // Columna derecha: datos del comprobante
                {
                    stack: [
                        { text: 'FACTURA', style: 'facturaTitle', alignment: 'right' },
                        { text: `N°: ${puntoVenta}-${nroComprobante}`, style: 'comprobanteNum', alignment: 'right' },
                        { text: `Fecha: ${fecha}`, style: 'small', alignment: 'right' },
                        { text: `Punto de Venta: ${puntoVenta}`, style: 'small', alignment: 'right' },
                    ],
                    border: [false, true, true, true],
                    margin: [4, 8, 8, 8],
                },
            ]],
        },
        layout: {
            hLineWidth: () => 1.5,
            vLineWidth: () => 1.5,
            hLineColor: () => '#111111',
            vLineColor: () => '#111111',
        },
        margin: [0, 0, 0, 10],
    };

    // ── Datos del receptor ────────────────────────────────────────────────────
    const receptorTable = {
        table: {
            widths: ['*', '*'],
            body: [
                [
                    { text: 'DATOS DEL RECEPTOR', style: 'sectionHeader', colSpan: 2, border: [true, true, true, false] },
                    {},
                ],
                [
                    {
                        stack: [
                            { text: `Nombre / Razón Social:`, style: 'fieldLabel' },
                            { text: receptor?.nombre || draft.receptor_nombre || '-', style: 'fieldValue' },
                            { text: `Condición IVA:`, style: 'fieldLabel', margin: [0, 4, 0, 0] },
                            { text: condicionLabel(draft.receptorCondicion || ''), style: 'fieldValue' },
                        ],
                        border: [true, false, false, true],
                        margin: [8, 4, 4, 8],
                    },
                    {
                        stack: [
                            { text: `CUIT / DNI:`, style: 'fieldLabel' },
                            { text: fmtCuit(draft.receptor_cuit_o_dni) || '-', style: 'fieldValue' },
                            { text: `Domicilio:`, style: 'fieldLabel', margin: [0, 4, 0, 0] },
                            { text: draft.receptor_domicilio || '-', style: 'fieldValue' },
                        ],
                        border: [false, false, true, true],
                        margin: [4, 4, 8, 8],
                    },
                ],
            ],
        },
        layout: {
            hLineWidth: () => 0.5,
            vLineWidth: () => 0.5,
            hLineColor: () => '#AAAAAA',
            vLineColor: () => '#AAAAAA',
        },
        margin: [0, 0, 0, 10],
    };

    // ── Tabla de líneas ───────────────────────────────────────────────────────
    const lineasHeader = [
        { text: 'Descripción', style: 'tableHeader' },
        { text: 'Cant.', style: 'tableHeader', alignment: 'right' },
        { text: 'Precio Unit.', style: 'tableHeader', alignment: 'right' },
        { text: 'Subtotal', style: 'tableHeader', alignment: 'right' },
    ];

    const lineasRows = (draft.lineas || []).map((l, i) => {
        const qty      = Number(l.quantity   || l.cantidad   || 0);
        const price    = Number(l.unit_price || l.precio_unitario || 0);
        const subtotal = qty * price;
        const fill     = i % 2 === 0 ? '#F9F9F9' : '#FFFFFF';
        return [
            { text: l.concept || l.descripcion || '', fillColor: fill },
            { text: String(qty), alignment: 'right', fillColor: fill },
            { text: `$ ${fmt(price)}`, alignment: 'right', fillColor: fill },
            { text: `$ ${fmt(subtotal)}`, alignment: 'right', fillColor: fill },
        ];
    });

    const lineasTable = {
        table: {
            headerRows: 1,
            widths: ['*', 50, 90, 90],
            body: [lineasHeader, ...lineasRows],
        },
        layout: {
            hLineWidth: (i) => i === 0 || i === 1 ? 1 : 0.3,
            vLineWidth: () => 0,
            hLineColor: (i) => i === 0 || i === 1 ? '#333333' : '#DDDDDD',
            fillColor:  (row) => row === 0 ? '#222222' : null,
        },
        margin: [0, 0, 0, 6],
    };

    // ── Totales ───────────────────────────────────────────────────────────────
    const totalesRows = [];

    if (draft.discriminaIva) {
        totalesRows.push([
            { text: 'Subtotal (neto)', alignment: 'right', style: 'totalLabel' },
            { text: `$ ${fmt(draft.importe_neto)}`, alignment: 'right', style: 'totalValue' },
        ]);
        totalesRows.push([
            { text: 'IVA 21%', alignment: 'right', style: 'totalLabel' },
            { text: `$ ${fmt(draft.importe_iva)}`, alignment: 'right', style: 'totalValue' },
        ]);
    }

    totalesRows.push([
        { text: 'TOTAL', alignment: 'right', style: 'totalFinal', fillColor: '#EEEEEE' },
        { text: `$ ${fmt(draft.importe_total)}`, alignment: 'right', style: 'totalFinalValue', fillColor: '#EEEEEE' },
    ]);

    const totalesTable = {
        table: {
            widths: ['*', 120],
            body: totalesRows,
        },
        layout: {
            hLineWidth: () => 0.5,
            vLineWidth: () => 0,
            hLineColor: () => '#CCCCCC',
        },
        margin: [0, 0, 0, 14],
    };

    // ── CAE ───────────────────────────────────────────────────────────────────
    const caeBox = {
        table: {
            widths: ['*'],
            body: [[{
                stack: [
                    { text: 'COMPROBANTE AUTORIZADO POR AFIP', style: 'caeTitle', alignment: 'center' },
                    { text: `CAE: ${cae}`, style: 'caeNum', alignment: 'center', margin: [0, 4, 0, 2] },
                    { text: `Vencimiento CAE: ${caeVto}`, style: 'caeSub', alignment: 'center' },
                ],
                border: [true, true, true, true],
                margin: [10, 8, 10, 8],
            }]],
        },
        layout: {
            hLineWidth: () => 1.5,
            vLineWidth: () => 1.5,
            hLineColor: () => '#111111',
            vLineColor: () => '#111111',
        },
        margin: [0, 0, 0, 10],
    };

    // ── Footer ────────────────────────────────────────────────────────────────
    const footer = {
        text: `Comprobante emitido electrónicamente • Factura Tipo ${tipo} • Sistema de Facturación Electrónica`,
        style: 'footer',
        alignment: 'center',
        margin: [0, 4, 0, 0],
    };

    // ── Estilos ───────────────────────────────────────────────────────────────
    const styles = {
        companyName:     { fontSize: 13, bold: true, color: '#111111' },
        small:           { fontSize: 8,  color: '#444444', lineHeight: 1.3 },
        tipoLetra:       { fontSize: 48, bold: true, color: '#111111' },
        tipoCode:        { fontSize: 8,  color: '#555555' },
        facturaTitle:    { fontSize: 14, bold: true, color: '#111111' },
        comprobanteNum:  { fontSize: 11, bold: true, color: '#111111' },
        sectionHeader:   { fontSize: 9,  bold: true, color: '#FFFFFF', fillColor: '#444444',
                           margin: [8, 4, 8, 4] },
        fieldLabel:      { fontSize: 8,  color: '#777777' },
        fieldValue:      { fontSize: 9,  bold: false, color: '#111111' },
        tableHeader:     { fontSize: 9,  bold: true, color: '#FFFFFF' },
        totalLabel:      { fontSize: 9,  color: '#444444' },
        totalValue:      { fontSize: 9,  color: '#111111' },
        totalFinal:      { fontSize: 11, bold: true, color: '#111111' },
        totalFinalValue: { fontSize: 11, bold: true, color: '#111111' },
        caeTitle:        { fontSize: 8,  bold: true, color: '#333333' },
        caeNum:          { fontSize: 14, bold: true, color: '#111111', characterSpacing: 1 },
        caeSub:          { fontSize: 8,  color: '#555555' },
        footer:          { fontSize: 7,  color: '#AAAAAA' },
    };

    return {
        pageSize:    'A4',
        pageMargins: [30, 30, 30, 40],
        content:     [headerTable, receptorTable, lineasTable, totalesTable, caeBox, footer],
        styles,
        defaultStyle: { font: 'Roboto', fontSize: 9 },
    };
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Genera el PDF de una factura usando pdfmake.
 * Devuelve un Buffer con el PDF listo para guardar o subir.
 *
 * @param {object} opts
 * @param {'A'|'B'|'C'} opts.tipo
 * @param {object} opts.company
 * @param {object} opts.receptor
 * @param {object} opts.draft
 * @param {object} opts.afipResult
 *
 * @returns {Promise<Buffer>}
 */
function generateInvoicePdf({ tipo, company, receptor, draft, afipResult }) {
    return new Promise((resolve, reject) => {
        try {
            const docDef = buildDocDefinition({ tipo, company, receptor, draft, afipResult });
            const pdfDoc = pdfMake.createPdf(docDef);
            pdfDoc.getBuffer((buffer) => resolve(buffer));
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { generateInvoicePdf };
