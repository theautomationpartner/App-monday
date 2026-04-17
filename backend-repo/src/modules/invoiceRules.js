/**
 * invoiceRules.js — Reglas fiscales para determinar el tipo de factura correcto.
 *
 * Tabla de referencia (Argentina - AFIP):
 * ┌────────────────────┬──────────────────────┬──────┬────────────────────┐
 * │ EMISOR             │ RECEPTOR             │ TIPO │ IVA                │
 * ├────────────────────┼──────────────────────┼──────┼────────────────────┤
 * │ RI                 │ RI                   │ A    │ DISCRIMINA IVA     │
 * │ RI                 │ EXENTO               │ A    │ DISCRIMINA IVA     │
 * │ RI                 │ MONOTRIBUTO          │ B    │ NO DISCRIMINA IVA  │
 * │ RI                 │ CF / DESCONOCIDO     │ B    │ NO DISCRIMINA IVA  │
 * │ MONOTRIBUTO        │ CUALQUIERA           │ C    │ NO LLEVA IVA       │
 * │ EXENTO             │ CUALQUIERA           │ C    │ NO LLEVA IVA       │
 * └────────────────────┴──────────────────────┴──────┴────────────────────┘
 *
 * Nota: RI → Exento → Factura A (receptor tiene CUIT activo y está inscripto).
 *       Algunas contabilidades usan Factura B para RI → Exento.
 *       Acá usamos A (más común), pero está documentado para ajustar.
 */

'use strict';

const { IVA_CONDITION } = require('../config');

const { RI, MONOTRIBUTO, EXENTO, CF, NO_ALCANZADO, UNKNOWN } = IVA_CONDITION;

/**
 * Determina el tipo de factura correcto según las condiciones fiscales.
 *
 * @param {string} emisorCondicion   - Condición del emisor (de config.IVA_CONDITION)
 * @param {string} receptorCondicion - Condición del receptor (de config.IVA_CONDITION)
 *
 * @returns {{
 *   tipo: 'A'|'B'|'C',
 *   discriminaIva: boolean,
 *   descripcion: string
 * }}
 */
function determineInvoiceType(emisorCondicion, receptorCondicion) {
    // Monotributista o Exento → siempre C, sin importar el receptor
    if (emisorCondicion === MONOTRIBUTO || emisorCondicion === EXENTO || emisorCondicion === NO_ALCANZADO) {
        return {
            tipo:         'C',
            discriminaIva: false,
            descripcion:  `Emisor ${emisorCondicion} → Factura C (no lleva IVA)`,
        };
    }

    // RI → tipo depende del receptor
    if (emisorCondicion === RI) {
        if (receptorCondicion === RI || receptorCondicion === EXENTO) {
            return {
                tipo:          'A',
                discriminaIva: true,
                descripcion:   `RI → ${receptorCondicion} → Factura A (discrimina IVA)`,
            };
        }
        // CF, Monotributo, Desconocido → B
        return {
            tipo:          'B',
            discriminaIva: false,
            descripcion:   `RI → ${receptorCondicion} → Factura B (no discrimina IVA)`,
        };
    }

    // Caso inesperado: defaultear a C (el más seguro)
    return {
        tipo:          'C',
        discriminaIva: false,
        descripcion:   `Condición emisor desconocida (${emisorCondicion}) → Factura C por defecto`,
    };
}

/**
 * Valida que el tipo de factura solicitado sea fiscalmente correcto.
 * Si no lo es, lanza un error descriptivo.
 *
 * @param {string} requestedType      - Tipo solicitado: 'A', 'B' o 'C'
 * @param {string} emisorCondicion
 * @param {string} receptorCondicion
 * @param {string} emisorNombre
 * @param {string} receptorNombre
 *
 * @throws {Error} si el tipo solicitado no corresponde fiscalmente
 */
function validateInvoiceType(requestedType, emisorCondicion, receptorCondicion, emisorNombre, receptorNombre) {
    const { tipo: correctType, descripcion } = determineInvoiceType(emisorCondicion, receptorCondicion);

    if (requestedType !== correctType) {
        throw new Error(
            `Tipo de factura incorrecto: solicitaste ${requestedType} pero corresponde ${correctType}. ` +
            `Emisor: ${emisorNombre || emisorCondicion} (${emisorCondicion}), ` +
            `Receptor: ${receptorNombre || receptorCondicion} (${receptorCondicion}). ` +
            `Regla: ${descripcion}`
        );
    }
}

/**
 * Determina y valida en un solo paso.
 * Si requestedType es null/undefined, simplemente determina y devuelve el correcto.
 *
 * @returns {{
 *   tipo: 'A'|'B'|'C',
 *   discriminaIva: boolean,
 *   descripcion: string,
 *   emisorCondicion: string,
 *   receptorCondicion: string
 * }}
 */
function resolveInvoiceType({ requestedType, emisorCondicion, receptorCondicion, emisorNombre, receptorNombre }) {
    const result = determineInvoiceType(emisorCondicion, receptorCondicion);

    if (requestedType && requestedType !== result.tipo) {
        validateInvoiceType(requestedType, emisorCondicion, receptorCondicion, emisorNombre, receptorNombre);
    }

    return {
        ...result,
        emisorCondicion,
        receptorCondicion,
    };
}

/**
 * Retorna el código numérico AFIP para el tipo de comprobante.
 * A=1, B=6, C=11
 */
function getCbteType(tipo) {
    const map = { A: 1, B: 6, C: 11 };
    const code = map[tipo?.toUpperCase()];
    if (!code) throw new Error(`Tipo de comprobante inválido: ${tipo}`);
    return code;
}

/**
 * Retorna la alícuota de IVA según el tipo.
 * A/B → 21% (discriminado o incluido), C → 0%
 */
function getIvaRate(tipo) {
    return tipo === 'C' ? 0 : 0.21;
}

/**
 * Texto legible de la condición IVA para mostrar en el PDF
 */
function condicionLabel(condicion) {
    const labels = {
        [RI]:           'Responsable Inscripto',
        [MONOTRIBUTO]:  'Monotributista',
        [EXENTO]:       'Exento',
        [CF]:           'Consumidor Final',
        [NO_ALCANZADO]: 'No Alcanzado',
        [UNKNOWN]:      'No Categorizado',
    };
    return labels[condicion] || condicion;
}

module.exports = {
    determineInvoiceType,
    validateInvoiceType,
    resolveInvoiceType,
    getCbteType,
    getIvaRate,
    condicionLabel,
};
