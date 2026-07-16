/**
 * test-pdf.js — Genera un PDF de prueba con datos mock para inspeccionar el
 * diseño sin emitir una factura real en AFIP.
 *
 * Uso:
 *   node scripts/test-pdf.js [A|B|C|E] [PES|DOL] [cotizacion] [es|en] [idiomaCbte]
 *
 * Ejemplos:
 *   node scripts/test-pdf.js A                  → Factura A en pesos
 *   node scripts/test-pdf.js A DOL 1364         → Factura A en USD, ctz 1364
 *   node scripts/test-pdf.js C DOL 1400         → Factura C en USD, ctz 1400
 *   node scripts/test-pdf.js E                  → Factura E (exportación) en pesos
 *   node scripts/test-pdf.js E DOL 950          → Factura E en USD, ctz 950
 *   node scripts/test-pdf.js E DOL 950 es 2     → Factura E, board en español pero
 *                                                 comprobante declarado en inglés
 *
 * El 5º argumento es el idioma de la APP (el board). El 6º, SOLO para Factura E,
 * es el Idioma_cbte de AFIP (1=ES / 2=EN / 3=PT) — el idioma que el usuario
 * declaró ante AFIP para el comprobante. Son cosas distintas y en el PDF de
 * exportación manda el segundo (ver pdfLabelsForExport en invoicePdf.js): por eso
 * se pueden pasar por separado, para poder probar justamente ese cruce.
 *
 * Sale: backend-repo/test-output/factura-<tipo>-<moneda>-<lang>-test.pdf
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { generateFacturaPdfBuffer, generateFacturaEPdfBuffer } = require('../src/modules/invoicePdf');
const { IVA_CONDITION } = require('../src/config');

const tipoArg = (process.argv[2] || 'A').toUpperCase();
if (!['A', 'B', 'C', 'E'].includes(tipoArg)) {
    console.error(`Tipo de comprobante inválido: ${tipoArg}. Usar A, B, C o E.`);
    process.exit(1);
}

const monedaArg     = (process.argv[3] || 'PES').toUpperCase();
const cotizacionArg = Number(process.argv[4] || 1);
const langArg       = (process.argv[5] || 'es').toLowerCase() === 'en' ? 'en' : 'es';
const idiomaCbteArg = [1, 2, 3].includes(Number(process.argv[6])) ? Number(process.argv[6]) : 1;
if (!['PES', 'DOL'].includes(monedaArg)) {
    console.error(`Moneda inválida: ${monedaArg}. Usar PES o DOL.`);
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

// Observaciones de muestra — 1 caso por tipo, todos < 255 chars.
const observacionesPorTipo = {
    A: 'Pago a 30 días vía transferencia bancaria. CBU: 0123456789012345678901. Sin descuentos por pronto pago. Consultas: contacto@parasuco.com.ar',
    B: 'Comprobante por servicios prestados en abril 2026. Para reclamos o consultas, comunicarse al 011-1234-5678 o por WhatsApp.',
    C: 'Servicios de automatización — Sprint de abril. Incluye 10 horas de soporte post-implementación.',
};

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
    moneda:           monedaArg,
    cotizacion:       monedaArg === 'PES' ? 1 : cotizacionArg,
    observaciones:    observacionesPorTipo[tipoArg],
    lineas,
    ...receptorPorTipo[tipoArg],
};

const afipResult = {
    cae:                '86162417975371',
    cae_vencimiento:    '2026-05-01',
    numero_comprobante: 9,
    tipo_comprobante:   tipoArg,
};

// ── Factura E (exportación) ──────────────────────────────────────────────
// Draft con la misma forma que arma emitFacturaEHandler (verificado contra una
// emisión real). Diferencias de fondo con A/B/C: importe_neto e importe_iva van
// en null (la operación es exenta: no son 0, no existen), el receptor no tiene
// CUIT ni condición frente al IVA argentinos, y las líneas traen total_item ya
// calculado (es el que se le mandó a AFIP).
const draftE = {
    tipo_comprobante: 'E',
    cbte_tipo_afip:   19,
    punto_venta:      7,
    fecha_emision:    new Date().toISOString().slice(0, 10),
    tipo_expo:        2,          // servicios — lo único que emite la app hoy
    idioma_cbte:      idiomaCbteArg,
    emisorCondicion:  IVA_CONDITION.MONOTRIBUTO,
    receptor_nombre:        'M&P Consulting Services LLC.',
    receptor_domicilio:     '30 N. Gould Street, Suite R, Sheridan, WY 82801',
    receptor_cuit_pais:     '55000002126',
    receptor_tipo_entidad:  'Persona Jurídica',
    receptor_id_impositivo: '36-5056685',
    pais_destino_codigo:      '212',
    pais_destino_descripcion: 'ESTADOS UNIDOS',
    forma_pago:  'Transferencia bancaria',
    fecha_pago:  new Date().toISOString().slice(0, 10),
    moneda:      monedaArg,
    moneda_descripcion: monedaArg === 'DOL' ? 'Dólar Estadounidense' : 'Pesos Argentinos',
    cotizacion:  monedaArg === 'PES' ? 1 : cotizacionArg,
    importe_neto: null,
    importe_iva:  null,
    importe_total: 6900,
    observaciones: null,
    lineas: [
        { concept: 'Consulting services in information technology - Product management services',
          quantity: 1, unit_price: 6000, total_item: 6000,
          unidad_medida: '', unidad_medida_afip: 7, bonificacion: 0 },
        { concept: 'Software maintenance retainer', quantity: 3, unit_price: 300, total_item: 900,
          unidad_medida: 'Horas', unidad_medida_afip: 7, bonificacion: 0 },
    ],
    wsfex_id: 1001,
};

const afipResultE = {
    cae:                '74358934743338',
    cae_vencimiento:    '2026-08-15',
    numero_comprobante: 45,
    tipo_comprobante:   'E',
    cbte_tipo_afip:     19,
};

// ── Generar y guardar ────────────────────────────────────────────────────
(async () => {
    try {
        if (tipoArg === 'E') {
            console.log(`Generando PDF de prueba — Factura E / exportación (${monedaArg}${monedaArg === 'DOL' ? `, ctz=${cotizacionArg}` : ''}, board=${langArg}, Idioma_cbte=${idiomaCbteArg})…`);
            const buf = await generateFacturaEPdfBuffer({
                company, draft: draftE, afipResult: afipResultE, language: langArg,
            });
            const outDirE = path.join(__dirname, '..', 'test-output');
            fs.mkdirSync(outDirE, { recursive: true });
            const outFileE = path.join(outDirE, `factura-E-${monedaArg}-${langArg}-idioma${idiomaCbteArg}-test.pdf`);
            fs.writeFileSync(outFileE, buf);
            console.log(`PDF generado: ${outFileE} (${buf.length} bytes)`);
            return;
        }

        console.log(`Generando PDF de prueba — Factura ${tipoArg} (${monedaArg}${monedaArg === 'DOL' ? `, ctz=${cotizacionArg}` : ''})…`);
        const pdfBuffer = await generateFacturaPdfBuffer({ company, draft, afipResult, language: langArg });

        const outDir = path.join(__dirname, '..', 'test-output');
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, `factura-${tipoArg}-${monedaArg}-${langArg}-test.pdf`);
        fs.writeFileSync(outFile, pdfBuffer);

        console.log(`PDF generado: ${outFile} (${pdfBuffer.length} bytes)`);
    } catch (err) {
        console.error('Error generando PDF:', err);
        process.exit(1);
    }
})();
