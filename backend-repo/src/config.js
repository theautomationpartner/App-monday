/**
 * config.js — Configuración centralizada del sistema de facturación.
 *
 * Todas las variables sensibles se leen desde process.env.
 * Agregar en el Developer Center (Secrets / Environment Variables):
 *
 *   AFIP_ENV=homologation|production
 *   ENCRYPTION_KEY=...            ← SECRET — cifra private keys de tenants en DB
 *   MONDAY_CLIENT_SECRET=...      ← SECRET — valida tokens de Monday
 *   PADRON_CUIT=...               ← ENV VAR — CUIT de Martín (para WSAA del padrón)
 *   PADRON_CRT=...                ← ENV VAR — contenido del .crt de Martín
 *   PADRON_KEY=...                ← SECRET — contenido del .key de Martín
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
        wsfex:  'https://servicios1.afip.gov.ar/wsfexv1/service.asmx',
        padron: 'https://aws.arca.gob.ar/sr-padron/webservices/personaServiceA5',
    },
    homologation: {
        wsaa:   'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
        wsfe:   'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
        wsfex:  'https://wswhomo.afip.gov.ar/wsfexv1/service.asmx',
        padron: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5',
    },
};

module.exports = {
    /** 'production' | 'homologation' */
    get afipEnv()      { return getEnv(); },
    get endpoints()    { return AFIP_ENDPOINTS[getEnv()]; },

    /** CUIT habilitado para consultar el padrón (certificado de Martín) */
    get padronCuit()   { return process.env.PADRON_CUIT || '20327446348'; },

    /** Contenido PEM del .crt de Martín (env var) */
    get padronCrt()    { return process.env.PADRON_CRT || null; },

    /** Contenido PEM del .key de Martín (secret) */
    get padronKey()    { return process.env.PADRON_KEY || null; },

    /** Clave de cifrado para private keys en la DB */
    get encryptionKey() { return process.env.ENCRYPTION_KEY || ''; },

    /** Tipos de comprobante AFIP */
    CBTE_TYPE: {
        A: 1,
        B: 6,
        C: 11,
    },

    /**
     * Comprobantes de EXPORTACIÓN (WSFEXv1, no WSFEv1 — otro web service).
     * Fuente: manual oficial AFIP "WSFEX - Factura de Exportación v2.1.0",
     * validación 1530. La letra siempre es E; lo que cambia es la clase.
     */
    CBTE_TYPE_EXPO: {
        FACTURA: 19,
        ND:      20,   // Nota de Débito por operaciones con el Exterior
        NC:      21,   // Nota de Crédito por operaciones con el Exterior
    },

    /** Tipo de exportación (campo Tipo_expo, validación 1540) */
    TIPO_EXPO: {
        BIENES:    1,
        SERVICIOS: 2,
        OTROS:     4,
    },

    /** Idioma del comprobante de exportación (campo Idioma_cbte, validación 1630) */
    IDIOMA_CBTE: {
        ES: 1,
        EN: 2,
        PT: 3,
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
