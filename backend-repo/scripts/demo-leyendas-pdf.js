/**
 * demo-leyendas-pdf.js — Genera PDFs de MUESTRA para visualizar dónde irían las
 * leyendas propuestas (RG 5003 monotributista, RG 1575 CBU informada / sujeta a
 * retención) sobre el layout REAL de la factura, sin implementarlas todavía.
 *
 * Usa el parámetro `demoLeyendas` de generateFacturaPdfBuffer (default-off, no
 * afecta producción). Las leyendas propuestas salen con un resaltado suave para
 * distinguirlas de las que ya son parte del comprobante.
 *
 * Uso:  node scripts/demo-leyendas-pdf.js
 * Sale: backend-repo/test-output/demo-leyenda-*.pdf
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { generateFacturaPdfBuffer } = require('../src/modules/invoicePdf');
const { IVA_CONDITION } = require('../src/config');

const company = {
    business_name:         'PARASUCO NICO',
    cuit:                  '20278273122',
    address:               'AV. CORRIENTES 1234 - CABA',
    start_date:            '2019-11-23',
    default_point_of_sale: 6,
};

const lineas = [
    { concept: 'Servicio de consultoría técnica', quantity: 1, unit_price: 150000, alicuota_iva: '21', unidad_medida: 'unidades' },
    { concept: 'Soporte mensual',                  quantity: 2, unit_price: 50000,  alicuota_iva: '21', unidad_medida: 'unidades' },
];
const importeNeto  = lineas.reduce((s, l) => s + l.quantity * l.unit_price, 0);
const importeIva   = Number((importeNeto * 0.21).toFixed(2));
const importeTotal = Number((importeNeto + importeIva).toFixed(2));

// Base de una Factura A (los escenarios cambian solo el receptor y las leyendas).
function baseDraft(extra) {
    return {
        tipo_comprobante: 'A',
        cuit_emisor:      company.cuit,
        punto_venta:      company.default_point_of_sale,
        fecha_emision:    new Date().toISOString().slice(0, 10),
        concepto_afip:    1,
        discriminaIva:    true,
        condicion_venta:  'Contado',
        alicuota_iva_pct: '21',
        alicuota_iva_id:  5,
        importe_neto:     Number(importeNeto.toFixed(2)),
        importe_iva:      importeIva,
        importe_total:    importeTotal,
        moneda:           'PES',
        cotizacion:       1,
        observaciones:    '',   // vacío para que la banda de leyendas quede limpia
        lineas,
        ...extra,
    };
}

const afipResult = {
    cae:                '86162417975371',
    cae_vencimiento:    '2026-05-01',
    numero_comprobante: 9,
    tipo_comprobante:   'A',
};

// ── Los 3 escenarios ──────────────────────────────────────────────────────
const escenarios = [
    {
        file: 'demo-leyenda-monotributista',
        titulo: 'Factura A a un Monotributista (RG 5003/21)',
        draft: baseDraft({
            receptor_cuit_o_dni: '20274567893',
            receptor_nombre:     'JUAN PEREZ',
            receptor_domicilio:  'BELGRANO 555, CABA',
            receptorCondicion:   IVA_CONDITION.MONOTRIBUTO,
            emisorCondicion:     IVA_CONDITION.RI,
            docTipo:             80,
            docNro:              20274567893,
        }),
        demoLeyendas: {
            bodyLegends: [
                'Receptor del comprobante - Responsable Monotributo',
                'El crédito fiscal discriminado en el presente comprobante, sólo podrá ser computado a efectos del Régimen de Sostenimiento e Inclusión Fiscal para Pequeños Contribuyentes de la Ley N° 27.618.',
            ],
        },
    },
    {
        file: 'demo-leyenda-cbu-informada',
        titulo: 'Factura A con leyenda "PAGO EN C.B.U. INFORMADA" (RG 1575)',
        draft: baseDraft({
            receptor_cuit_o_dni: '30711514445',
            receptor_nombre:     'ESTANCIA EL PEGUAL SA',
            receptor_domicilio:  'CALLE 32 1328, BALCARCE, BUENOS AIRES',
            receptorCondicion:   IVA_CONDITION.RI,
            emisorCondicion:     IVA_CONDITION.RI,
            docTipo:             80,
            docNro:              30711514445,
        }),
        demoLeyendas: { headerLegend: 'PAGO EN C.B.U. INFORMADA' },
    },
    {
        file: 'demo-leyenda-sujeta-retencion',
        titulo: 'Factura A con leyenda "OPERACIÓN SUJETA A RETENCIÓN" (RG 1575, ex Factura M)',
        draft: baseDraft({
            receptor_cuit_o_dni: '30711514445',
            receptor_nombre:     'ESTANCIA EL PEGUAL SA',
            receptor_domicilio:  'CALLE 32 1328, BALCARCE, BUENOS AIRES',
            receptorCondicion:   IVA_CONDITION.RI,
            emisorCondicion:     IVA_CONDITION.RI,
            docTipo:             80,
            docNro:              30711514445,
        }),
        demoLeyendas: { headerLegend: 'OPERACIÓN SUJETA A RETENCIÓN' },
    },
];

(async () => {
    const outDir = path.join(__dirname, '..', 'test-output');
    fs.mkdirSync(outDir, { recursive: true });
    for (const e of escenarios) {
        const buf = await generateFacturaPdfBuffer({
            company,
            draft: e.draft,
            afipResult,
            language: 'es',
            demoLeyendas: e.demoLeyendas,
        });
        const outFile = path.join(outDir, `${e.file}.pdf`);
        fs.writeFileSync(outFile, buf);
        console.log(`✓ ${e.titulo}\n  → ${outFile} (${buf.length} bytes)\n`);
    }
    console.log('Listo. Abrí los PDFs en backend-repo/test-output/ para revisar las leyendas resaltadas.');
})().catch((err) => {
    console.error('Error generando PDFs demo:', err);
    process.exit(1);
});
