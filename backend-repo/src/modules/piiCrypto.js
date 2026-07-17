/**
 * piiCrypto.js — Cifrado a nivel aplicación de los datos personales del EMISOR.
 *
 * Requisito del review de monday: la PII del emisor (nombre, domicilio, teléfono,
 * email) tiene que estar cifrada en la DB, no solo por el disco cifrado de
 * DigitalOcean.
 *
 * Reusa exactamente el patrón que ya usa el proyecto para la private key del
 * certificado AFIP: CryptoJS.AES.encrypt con passphrase (ENCRYPTION_KEY), que
 * produce el formato OpenSSL "Salted__" → prefijo base64 `U2FsdGVkX1...`. Ese
 * prefijo es también la forma de detectar si un valor ya está cifrado.
 *
 * Solo el emisor (tabla companies). Los datos del receptor no se tocan.
 */

'use strict';

const CryptoJS = require('crypto-js');

// La misma env var que ya usa el cifrado del certificado. Fail-fast al cargar:
// cifrar con key vacía produce ciphertext "cifrado con nada" (CryptoJS no tira
// error con passphrase '') → un cifrado inútil y que además rompe al descifrar en
// un entorno con la key real. Mejor no arrancar.
const KEY = process.env.ENCRYPTION_KEY;
if (!KEY) {
    throw new Error(
        'piiCrypto: falta ENCRYPTION_KEY en el entorno. Es obligatoria para cifrar ' +
        'la PII del emisor (y ya la usa el cifrado del certificado AFIP).'
    );
}

// Firma del formato OpenSSL de CryptoJS: base64 de los 8 bytes "Salted__".
const ENCRYPTED_PREFIX = 'U2FsdGVkX1';

// Campos de PII del emisor en la tabla companies. Los padron_* son el nombre y
// domicilio del emisor según el padrón AFIP — misma categoría de PII.
const PII_COMPANY_FIELDS = [
    'business_name',
    'trade_name',
    'address',
    'phone',
    'email',
    'padron_nombre',
    'padron_domicilio',
];

function looksEncrypted(v) {
    return typeof v === 'string' && v.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Cifra un valor. Idempotente: si ya viene cifrado, o es null/vacío, lo devuelve
 * tal cual (para poder llamarlo sin miedo en un backfill que se re-ejecuta).
 */
function encryptPII(value) {
    if (value === null || value === undefined || value === '') return value;
    if (looksEncrypted(value)) return value;
    return CryptoJS.AES.encrypt(String(value), KEY).toString();
}

/**
 * Descifra un valor. Defensivo a propósito:
 *  - null/vacío → tal cual.
 *  - NO parece cifrado → tal cual. Esto es lo que hace segura la transición: en
 *    la ventana entre el deploy y el fin del backfill, una fila todavía en texto
 *    plano se lee sin romperse.
 *  - Parece cifrado pero el descifrado da vacío → devolver la entrada original.
 *    Cubre el caso (astronómico) de un valor plano que arranque con el prefijo.
 */
function decryptPII(value) {
    if (value === null || value === undefined || value === '') return value;
    if (!looksEncrypted(value)) return value;
    try {
        const plain = CryptoJS.AES.decrypt(value, KEY).toString(CryptoJS.enc.Utf8);
        return plain === '' ? value : plain;
    } catch {
        // Descifrado fallido (dato corrupto / key equivocada): devolver la entrada
        // antes que romper la lectura. Es preferible mostrar el ciphertext a que
        // no se pueda emitir.
        return value;
    }
}

/**
 * Devuelve una COPIA del row con los campos de PII descifrados. Es el helper que
 * se usa en cada punto de lectura de companies. No muta el original.
 */
function decryptCompanyRow(row) {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    for (const f of PII_COMPANY_FIELDS) {
        if (f in out) out[f] = decryptPII(out[f]);
    }
    return out;
}

module.exports = {
    PII_COMPANY_FIELDS,
    looksEncrypted,
    encryptPII,
    decryptPII,
    decryptCompanyRow,
};
