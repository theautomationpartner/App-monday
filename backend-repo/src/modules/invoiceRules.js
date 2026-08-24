/**
 * invoiceRules.js — Reglas fiscales para determinar el tipo de factura correcto.
 *
 * Tabla de referencia (Argentina - AFIP):
 * ┌────────────────────┬──────────────────────┬──────┬────────────────────┐
 * │ EMISOR             │ RECEPTOR             │ TIPO │ IVA                │
 * ├────────────────────┼──────────────────────┼──────┼────────────────────┤
 * │ RI                 │ RI                   │ A    │ DISCRIMINA IVA     │
 * │ RI                 │ MONOTRIBUTO          │ A    │ DISCRIMINA IVA     │
 * │ RI                 │ EXENTO               │ B    │ NO DISCRIMINA IVA  │
 * │ RI                 │ CF / DESCONOCIDO     │ B    │ NO DISCRIMINA IVA  │
 * │ MONOTRIBUTO        │ CUALQUIERA           │ C    │ NO LLEVA IVA       │
 * │ EXENTO             │ CUALQUIERA           │ C    │ NO LLEVA IVA       │
 * └────────────────────┴──────────────────────┴──────┴────────────────────┘
 *
 * Nota: RI → Exento se factura como B porque el receptor Exento típico no
 *       está adherido al régimen de Factura A (RG 3749/2015). AFIP rechaza
 *       (cbteType=1, CondicionIVAReceptorId=4) con error 10243.
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
        if (receptorCondicion === RI || receptorCondicion === MONOTRIBUTO) {
            return {
                tipo:          'A',
                discriminaIva: true,
                descripcion:   `RI → ${receptorCondicion} → Factura A (discrimina IVA)`,
            };
        }
        // EXENTO, CF, No Alcanzado, Desconocido → B
        // Exento no va por A salvo que esté adherido al régimen RG 3749/2015,
        // y AFIP rechaza el combo (A, CondIvaReceptor=4) con error 10243.
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
 * Etiquetas oficiales AFIP/ARCA — Tabla de Tipos de Responsables
 * (TABLA-TIPO-RESPONSABLES-V.0-06022025.xls). Aplican igual al emisor
 * y al receptor del comprobante. Mostradas en mayúsculas por preferencia
 * del emisor.
 */
function condicionLabel(condicion, language = 'es') {
    const labels = language === 'en' ? {
        [RI]:           'VAT REGISTERED',
        [MONOTRIBUTO]:  'MONOTRIBUTO TAXPAYER',
        [EXENTO]:       'VAT EXEMPT',
        [CF]:           'FINAL CONSUMER',
        [NO_ALCANZADO]: 'NOT SUBJECT TO VAT',
        [UNKNOWN]:      'UNCATEGORIZED SUBJECT',
    } : {
        [RI]:           'IVA RESPONSABLE INSCRIPTO',
        [MONOTRIBUTO]:  'RESPONSABLE MONOTRIBUTO',
        [EXENTO]:       'IVA SUJETO EXENTO',
        [CF]:           'CONSUMIDOR FINAL',
        [NO_ALCANZADO]: 'IVA NO ALCANZADO',
        [UNKNOWN]:      'SUJETO NO CATEGORIZADO',
    };
    return labels[condicion] || String(condicion || '').toUpperCase();
}

/**
 * Convierte un string a "Title Case" (cada palabra con primera letra mayuscula
 * y el resto en minuscula), con reglas especiales para datos fiscales:
 *
 *   - La palabra "IVA" se preserva siempre en mayusculas.
 *   - Palabras con punto o slash (abreviaturas como S.A., S.R.L., S/N) se
 *     mantienen en mayusculas (no se rompe la abreviatura).
 *   - Numeros y simbolos se preservan tal cual.
 *
 * Ejemplos:
 *   "SOFIA ALEWARTS"            -> "Sofia Alewarts"
 *   "POLIFRONI PUERTAS SRL"     -> "Polifroni Puertas Srl"
 *   "IVA RESPONSABLE INSCRIPTO" -> "IVA Responsable Inscripto"
 *   "AV. 9 DE JULIO 1234"       -> "Av. 9 De Julio 1234"
 *   "CARRIEGO 388 PISO:6"       -> "Carriego 388 Piso:6"
 *   "JUAN DE LA TORRE S.R.L."   -> "Juan De La Torre S.R.L."
 */
function toTitleCase(str) {
    if (!str) return str;
    // Splitemos por separadores manteniendo los separadores en el array
    // (espacios, coma, punto y coma, dos puntos), asi al join() conservamos
    // el formato original.
    return String(str).split(/(\s+|,|;|:)/).map(token => {
        if (!token) return token;
        // Separadores: dejar como vienen
        if (/^[\s,;:]+$/.test(token)) return token;
        const upper = token.toUpperCase();
        // Preservar IVA / VAT siempre en mayusculas (siglas fiscales)
        if (upper === 'IVA' || upper === 'VAT') return upper;
        // Siglas multi-punto (S.A., S.R.L., U.S.A., M.G.M.): mantener mayusculas
        // Heuristica: 2 o mas puntos en el token = sigla compuesta. Un solo
        // punto al final (Av., Sr., Cra.) NO entra aca, va por title case.
        const dotCount = (token.match(/\./g) || []).length;
        if (dotCount >= 2) return upper;
        // Title case estandar: primera mayuscula, resto minusculas
        return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    }).join('');
}

/**
 * Normaliza un string de moneda al codigo AFIP correspondiente.
 *
 * Tolerante a:
 *   - Mayusculas/minusculas (toLowerCase)
 *   - Tildes (NFD + strip diacriticos)
 *   - Espacios al inicio/final (trim)
 *   - Singular/plural ("peso"/"pesos", "dolar"/"dolares")
 *   - Codigos AFIP directos ("PES", "DOL", "USD")
 *
 * Retorna:
 *   'PES'  → para pesos argentinos (cualquier variante)
 *   'DOL'  → para dolares americanos (cualquier variante, incluye "USD")
 *   null   → valor no reconocido (vacio o no es ni pesos ni dolares)
 *
 * Ejemplos:
 *   parseMoneda('Pesos')       → 'PES'
 *   parseMoneda('PESOS')       → 'PES'
 *   parseMoneda('peso')        → 'PES'
 *   parseMoneda('PES')         → 'PES'
 *   parseMoneda('Dolares')     → 'DOL'
 *   parseMoneda('DÓLARES')     → 'DOL'
 *   parseMoneda('dolar')       → 'DOL'
 *   parseMoneda('USD')         → 'DOL'
 *   parseMoneda('DOL')         → 'DOL'
 *   parseMoneda('')            → null
 *   parseMoneda('euros')       → null  (no soportado por ahora)
 *   parseMoneda(null)          → null
 */
function parseMoneda(raw) {
    if (raw === null || raw === undefined) return null;
    const normalized = String(raw)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')  // sacar tildes y diacriticos
        .replace(/\s+/g, ' ')              // colapsar espacios
        .trim();
    if (!normalized) return null;

    // Pesos: aceptamos "pes", "peso", "pesos" + codigos AFIP
    if (/^pes(o)?(s)?$/.test(normalized) || normalized === 'ars') {
        return 'PES';
    }
    // Dolares: aceptamos "dol", "dolar", "dolares", "dollar(s)" (EN) + "usd" + codigos AFIP
    if (/^dol(a)?(r)?(es)?$/.test(normalized) || /^dollar(s)?$/.test(normalized) || normalized === 'usd') {
        return 'DOL';
    }
    return null; // no reconocido
}


// Lleva un importe de una nota (NC/ND) a la moneda de la factura que ajusta, para
// poder sumarlas entre si en el control de saldo.
//
// AFIP permite emitir la nota en PESOS aunque la factura sea en otra moneda (es
// como se documenta una diferencia de tipo de cambio). Cuando eso pasa, sumar
// importes crudos da cualquier cosa: hay que convertir.
//
// ⚠️ La nota en PES se convierte con la cotizacion de la FACTURA, no con la de la
// nota. Una nota en pesos tiene cotizacion 1 (pesos a pesos), asi que dividir por
// ella no convierte nada — es el bug que hacia leer ARS 8.976 como USD 8.976. La
// factura se valuo a SU cotizacion, y ese es el tipo de cambio contra el que hay
// que medir cuanto de ella se esta acreditando. Usar la de la factura ademas hace
// que el saldo sea estable: no se mueve con el dolar de hoy.
function convertirAMonedaFactura({ importe, monedaNota, ctzNota, monedaFactura, ctzFactura }) {
    const mF = String(monedaFactura || 'PES').toUpperCase();
    const m  = String(monedaNota || '').toUpperCase();
    const cF = Number(ctzFactura) || 1;
    const n  = Number(importe) || 0;
    // Notas viejas (anteriores a que se guardara la moneda en el draft) vienen sin
    // monedaNota. En esa epoca la nota SIEMPRE heredaba la de la factura, asi que
    // "sin moneda" significa "la misma que la factura": se deja el importe como esta.
    if (!m) return n;
    if (m === mF) return n;
    // Nota en pesos sobre factura en moneda extranjera.
    if (m === 'PES' && mF !== 'PES') return n / (cF || 1);
    // Nota en moneda extranjera sobre factura en pesos: aca si manda la de la nota.
    if (mF === 'PES' && m !== 'PES') return n * (Number(ctzNota) || 1);
    return n;
}
module.exports = {
    determineInvoiceType,
    validateInvoiceType,
    resolveInvoiceType,
    getCbteType,
    getIvaRate,
    condicionLabel,
    toTitleCase,
    parseMoneda,
    convertirAMonedaFactura,
};
