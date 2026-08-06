/**
 * ¿El comprobante que AFIP nos devolvió es REALMENTE el de esta emisión?
 *
 * Cuando una emisión queda trabada reservamos un número y después le
 * preguntamos a AFIP "¿existe el número N?". Si existe, la tentación es darlo
 * por nuestro. Pero el número puede habérselo quedado OTRA emisión: nuestro
 * contador se adelanta, AFIP rechaza con [10016], y mientras tanto la factura
 * del ítem de al lado se lleva ese número.
 *
 * Adoptar ahí el CAE ajeno es lo peor que puede pasar: el comprobante queda
 * marcado como emitido con el CAE de la factura de otro, y la factura real de
 * ese ítem nunca se emitió. Pasó dos veces con el mismo cliente — la NC
 * 0007-00000002 y la Factura A 0007-00000177, esta última con el agravante de
 * que el mismatch se detectó, se escribió en el registro, y se adoptó igual.
 *
 * Lo usan los DOS caminos que pueden adoptar un CAE ajeno — la Fase 1 (cuando
 * el usuario reintenta) y el cron de reconciliación (cuando no reintenta) —
 * porque son la misma decisión y no pueden contestar distinto.
 *
 * ── La regla, y por qué es asimétrica ────────────────────────────────────────
 * Devuelve los motivos por los que el comprobante NO es nuestro. Lista vacía
 * significa "no hay evidencia de que sea ajeno", que NO es lo mismo que "es
 * nuestro": cuando un dato falta o vale 0, no se compara y no se bloquea.
 *
 * Es a propósito. Los dos errores posibles no cuestan lo mismo:
 *
 *   adoptar uno ajeno   → el cliente cree que facturó y no facturó, con el CAE
 *                         de otro encima. Lo arregla a mano, con AFIP.
 *   rechazar uno propio → re-emitimos y queda DUPLICADO en AFIP. Eso se arregla
 *                         con una nota de crédito y es peor.
 *
 * Por eso solo se bloquea con evidencia positiva: dos datos que existen y no
 * coinciden. Ante la duda, no bloquea.
 */
'use strict';

function motivosDeComprobanteAjeno({ recovered, expectedTotal, expectedDocNro, expectedCbtesAsoc } = {}) {
    const motivos = [];
    if (!recovered) return motivos;

    const totalNuestro = Number(expectedTotal || 0);
    const totalAfip    = Number(recovered.imp_total || 0);
    if (totalNuestro > 0 && totalAfip > 0 && Math.abs(totalAfip - totalNuestro) > 0.01) {
        motivos.push(`importe: nuestro=${totalNuestro} vs AFIP=${totalAfip}`);
    }

    // Receptor. Dos comprobantes pueden coincidir en importe por casualidad,
    // pero no en importe Y receptor. docNro 0 es consumidor final sin
    // identificar: ahí no hay nada que comparar.
    const docNuestro = Number(expectedDocNro || 0);
    const docAfip    = Number(recovered.doc_nro || 0);
    if (docNuestro > 0 && docAfip > 0 && docNuestro !== docAfip) {
        motivos.push(`receptor: nuestro=${docNuestro} vs AFIP=${docAfip}`);
    }

    // NC/ND: tiene que anular la MISMA factura.
    if (Array.isArray(expectedCbtesAsoc) && expectedCbtesAsoc.length > 0
        && Array.isArray(recovered.cbtes_asoc) && recovered.cbtes_asoc.length > 0) {
        const clave = (t, pv, nro) => `${Number(t)}|${Number(pv)}|${Number(nro)}`;
        const nuestros = expectedCbtesAsoc
            .map(c => clave(c.tipo, c.ptoVta != null ? c.ptoVta : c.pto_vta, c.nro)).sort();
        const deAfip = recovered.cbtes_asoc
            .map(c => clave(c.tipo, c.pto_vta, c.nro)).sort();
        if (nuestros.length !== deAfip.length || nuestros.some((n, i) => n !== deAfip[i])) {
            motivos.push(`factura asociada: nuestra=${nuestros.join(',')} vs AFIP=${deAfip.join(',')}`);
        }
    }

    return motivos;
}

module.exports = { motivosDeComprobanteAjeno };
