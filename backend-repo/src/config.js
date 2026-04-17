/**
 * config.js — Configuración centralizada del sistema de facturación.
 *
 * Todas las variables sensibles se leen desde process.env.
 * Agregar en el Developer Center (Secrets) o en el archivo .env:
 *
 *   AFIP_ENV=homologation|production
 *   ENCRYPTION_KEY=...
 *   MONDAY_CLIENT_SECRET=...
 *   PDF_CO_API_KEY=martinmeliendrez@gmail.com_ZXHPiUXxPU0bsG0MaiU8yAOgSOH88OtIOuMMpxB7d8p3K9cXHRxIq4p7Nz9jLchS
 *   PADRON_CUIT=20327446348       ← CUIT habilitado para consultar el padrón (Martín)
 *   PADRON_COMPANY_ID=...         ← ID en tabla companies de la cuenta de Martín
 */

'use strict';

function getEnv() {
    const env = (process.env.AFIP_ENV || 'homologation').toLowerCase();
    return env === 'production' ? 'production' : 'homologation';
}

const AFIP_ENDPOINTS = {
    production: {
        wsaa:   'https://wsaa.afip.gov.ar/ws/services/LoginCms',
        wsfe:   'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
        padron: 'https://aws.arca.gob.ar/sr-padron/webservices/personaServiceA5',
    },
    homologation: {
        wsaa:   'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
        wsfe:   'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
        padron: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5',
    },
};

module.exports = {
    /** 'production' | 'homologation' */
    get afipEnv()      { return getEnv(); },
    get endpoints()    { return AFIP_ENDPOINTS[getEnv()]; },

    /** CUIT habilitado para consultar el padrón (certificado de Martín) */
    get padronCuit()   { return process.env.PADRON_CUIT || '20327446348'; },

    /** ID de la company de Martín en la tabla companies */
    get padronCompanyId() { return process.env.PADRON_COMPANY_ID || null; },

    /** Clave de cifrado para private keys en la DB */
    get encryptionKey() { return process.env.ENCRYPTION_KEY || ''; },

    /** Tipos de comprobante AFIP */
    CBTE_TYPE: {
        A: 1,
        B: 6,
        C: 11,
    },

    /** Condiciones IVA normalizadas (lo que devuelve el padrón) */
    IVA_CONDITION: {
        RI:           'RESPONSABLE_INSCRIPTO',
        MONOTRIBUTO:  'MONOTRIBUTO',
        EXENTO:       'EXENTO',
        CF:           'CONSUMIDOR_FINAL',
        NO_ALCANZADO: 'NO_ALCANZADO',
        UNKNOWN:      'DESCONOCIDO',
    },
};
