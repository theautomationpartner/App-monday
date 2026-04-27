/**
 * test-pdf.js — Genera un PDF de prueba con datos mock para inspeccionar el
 * diseño sin emitir una factura real en AFIP.
 *
 * Uso:
 *   node scripts/test-pdf.js [A|B|C]
 *
 * Sale: backend-repo/test-output/factura-<tipo>-test.pdf
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { generateFacturaPdfBuffer } = require('../src/modules/invoicePdf');
const { IVA_CONDITION } = require('../src/config');

const tipoArg = (process.argv[2] || 'A').toUpperCase();
if (!['A', 'B', 'C'].includes(tipoArg)) {
    console.error(`Tipo de comprobante inválido: ${tipoArg}. Usar A, B o C.`);
    process.exit(1);
}

// ── Datos mock ──────────────────────────────────────────────────────────
const company = {
    business_name:        'PARASUCO NICO',
    cuit:                 '20278273122',
    address:              'AV. CORRIENTES 1234 - CABA',
    start_date:           '2019-11-23',
    default_point_of_sale: 6,
};

// Receptor según tipo:
//  - A → Responsable Inscripto (con CUIT)
//  - B → Consumidor Final (sin DNI)
//  - C → Monotributo (con CUIT)
const receptorPorTipo = {
    A: {
        receptor_cuit_o_dni: '30711514445',
        receptor_nombre:     'ESTANCIA EL PEGUAL SA',
        receptor_domicilio:  'CALLE 32 1328, BALCARCE, BUENOS AIRES',
        receptorCondicion:   IVA_CONDITION.RI,
        emisorCondicion:     IVA_CONDITION.RI,
        docTipo:             80,
        docNro:              30711514445,
    },
    B: {
        receptor_cuit_o_dni: '',
        receptor_nombre:     'CONSUMIDOR FINAL',
        receptor_domicilio:  '-',
        receptorCondicion:   IVA_CONDITION.CF,
        emisorCondicion:     IVA_CONDITION.RI,
        docTipo:             99,
        docNro:              0,
    },
    C: {
        receptor_cuit_o_dni: '20274567893',
        receptor_nombre:     'JUAN PEREZ',
        receptor_domicilio:  'BELGRANO 555, CABA',
        receptorCondicion:   IVA_CONDITION.MONOTRIBUTO,
        emisorCondicion:     IVA_CONDITION.MONOTRIBUTO,
        docTipo:             80,
        docNro:              20274567893,
    },
};

const lineas = [
    { concept: 'Servicio de consultoría técnica', quantity: 1, unit_price: 150000, alicuota_iva: '21',   unidad_medida: 'unidades' },
    { concept: 'Soporte mensual',                  quantity: 2, unit_price: 50000,  alicuota_iva: '21',   unidad_medida: 'unidades' },
    { concept: 'Capacitación in-house',            quantity: 1, unit_price: 80000,  alicuota_iva: '21',   unidad_medida: 'unidades' },
];

const importeNeto = lineas.reduce((s, l) => s + l.quantity * l.unit_price, 0);
const ivaRate = tipoArg === 'C' ? 0 : 0.21;
const importeIva = Number((importeNeto * ivaRate).toFixed(2));
const importeTotal = Number((importeNeto + importeIva).toFixed(2));

const draft = {
    tipo_comprobante: tipoArg,
    cuit_emisor:      company.cuit,
    punto_venta:      company.default_point_of_sale,
    fecha_emision:    new Date().toISOString().slice(0, 10),
    concepto_afip:    1, // Productos → no muestra Período Facturado
    discriminaIva:    tipoArg === 'A',
    condicion_venta:  'Contado',
    alicuota_iva_pct: tipoArg === 'C' ? '0' : '21',
    alicuota_iva_id:  tipoArg === 'C' ? 3 : 5,
    importe_neto:     Number(importeNeto.toFixed(2)),
    importe_iva:      importeIva,
    importe_total:    importeTotal,
    lineas,
    ...receptorPorTipo[tipoArg],
};

const afipResult = {
    cae:                '86162417975371',
    cae_vencimiento:    '2026-05-01',
    numero_comprobante: 9,
    tipo_comprobante:   tipoArg,
};

// ── Generar y guardar ────────────────────────────────────────────────────
(async () => {
    try {
        console.log(`Generando PDF de prueba — Factura ${tipoArg}…`);
        const pdfBuffer = await generateFacturaPdfBuffer({ company, draft, afipResult });

        const outDir = path.join(__dirname, '..', 'test-output');
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, `factura-${tipoArg}-test.pdf`);
        fs.writeFileSync(outFile, pdfBuffer);

        console.log(`PDF generado: ${outFile} (${pdfBuffer.length} bytes)`);
    } catch (err) {
        console.error('Error generando PDF:', err);
        process.exit(1);
    }
})();
