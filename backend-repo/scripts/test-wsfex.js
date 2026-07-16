/**
 * test-wsfex.js — Prueba el módulo afipWsfex contra AFIP, sin tocar monday ni la DB.
 *
 * Uso:
 *   node scripts/test-wsfex.js                 # homologación (default, seguro)
 *   AFIP_ENV=production node scripts/test-wsfex.js
 *
 * Qué hace:
 *   1. FEXDummy — no requiere auth. Verifica conectividad, el sobre SOAP y el
 *      parseo. Esto anda SIEMPRE, aunque no haya certificado.
 *   2. Si hay PADRON_CRT/PADRON_KEY en el .env, intenta autenticar contra el
 *      servicio 'wsfex' y bajar las tablas de parámetros.
 *
 * ⚠️ NO emite ningún comprobante. Es solo lectura.
 *
 * Si el paso 2 falla con "no autorizado", es lo ESPERADO hasta que el trámite en
 * AFIP esté hecho: el certificado tiene que estar delegado al servicio 'wsfex'
 * (Administrador de Relaciones), además del punto de venta de exportación.
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const config = require('../src/config');
const wsfex = require('../src/modules/afipWsfex');
const { getToken } = require('../src/modules/afipAuth');

function normalizePem(raw, type) {
    if (!raw) return null;
    const clean = raw
        .replace(/-----BEGIN [^-]+-----/g, '')
        .replace(/-----END [^-]+-----/g, '')
        .replace(/[\r\n\s]/g, '');
    const lines = clean.match(/.{1,64}/g) || [];
    return `-----BEGIN ${type}-----\n${lines.join('\n')}\n-----END ${type}-----`;
}

function head(t) { console.log(`\n${'─'.repeat(66)}\n${t}\n${'─'.repeat(66)}`); }

(async () => {
    console.log(`AFIP_ENV : ${config.afipEnv.toUpperCase()}`);
    console.log(`endpoint : ${config.endpoints.wsfex}`);

    // ── 1. FEXDummy — sin auth ───────────────────────────────────────────────
    head('1. FEXDummy (conectividad, sin certificado)');
    try {
        const d = await wsfex.fexDummy();
        console.log(`   AppServer  : ${d.appServer}`);
        console.log(`   DbServer   : ${d.dbServer}`);
        console.log(`   AuthServer : ${d.authServer}`);
        const ok = [d.appServer, d.dbServer, d.authServer].every((v) => String(v).toUpperCase() === 'OK');
        console.log(ok ? '   ✅ WSFEX operativo' : '   ⚠️  algún componente de AFIP no responde OK');
    } catch (err) {
        console.error(`   ❌ ${err.message}`);
        process.exit(1);
    }

    // ── 2. Auth + tablas de parámetros ───────────────────────────────────────
    head('2. Autenticación contra el servicio wsfex');

    const crt = config.padronCrt;
    const key = config.padronKey;
    if (!crt || !key) {
        console.log('   ⏭️  Sin PADRON_CRT/PADRON_KEY en el .env — se saltea.');
        console.log('   (El paso 1 ya probó que el módulo habla bien con AFIP.)');
        return;
    }

    const cuit = config.padronCuit;
    console.log(`   CUIT: ${cuit} (cert del padrón)`);

    let auth;
    try {
        const t = await getToken({
            certPem: normalizePem(crt, 'CERTIFICATE'),
            keyPem:  normalizePem(key, 'PRIVATE KEY'),
            cuit,
            service: wsfex.WSFEX_SERVICE,
        });
        auth = { token: t.token, sign: t.sign, cuit };
        console.log('   ✅ Token wsfex obtenido');
    } catch (err) {
        console.log(`   ❌ ${err.message}`);
        console.log('\n   👉 Si dice "no autorizado" / "sin permisos", es lo ESPERADO:');
        console.log('      falta delegar el certificado al servicio "wsfex" en AFIP');
        console.log('      (Administrador de Relaciones de Clave Fiscal). Es el trámite');
        console.log('      previo, no un bug del código.');
        return;
    }

    const tablas = [
        ['Países destino',     () => wsfex.fexGetPaises(auth)],
        ['CUIT por país',      () => wsfex.fexGetCuitPaises(auth)],
        ['Monedas',            () => wsfex.fexGetMonedas(auth)],
        ['Idiomas',            () => wsfex.fexGetIdiomas(auth)],
        ['Unidades de medida', () => wsfex.fexGetUnidadesMedida(auth)],
        ['Tipos de expo',      () => wsfex.fexGetTiposExpo(auth)],
        ['Puntos de venta',    () => wsfex.fexGetPtosVenta(auth)],
    ];

    head('3. Tablas de parámetros');
    for (const [nombre, fn] of tablas) {
        try {
            const rows = await fn();
            console.log(`   ✅ ${nombre.padEnd(20)} ${String(rows.length).padStart(4)} filas   ej: ${JSON.stringify(rows[0] || null)}`);
        } catch (err) {
            console.log(`   ❌ ${nombre.padEnd(20)} ${err.message}`);
        }
    }

    // ── 4. Resolución país → CUIT país ───────────────────────────────────────
    head('4. Resolución automática país → CUIT país');
    try {
        const paises = await wsfex.fexGetPaises(auth);
        const muestra = paises.filter((p) => /brasil|estados unidos|espa|uruguay|chile/i.test(p.descripcion)).slice(0, 5);
        for (const p of (muestra.length ? muestra : paises.slice(0, 5))) {
            const cuitPais = await wsfex.fexResolveCuitPais(p.codigo, auth);
            const estado = cuitPais ? `→ ${cuitPais}` : '→ (sin CUIT país — habría que exigir Id_impositivo)';
            console.log(`   ${String(p.codigo).padStart(3)} ${p.descripcion.padEnd(28)} ${estado}`);
        }
    } catch (err) {
        console.log(`   ❌ ${err.message}`);
    }

    // ── 5. Último comprobante / último Id ────────────────────────────────────
    head('5. Estado de la serie (solo lectura)');
    try {
        const lastId = await wsfex.fexGetLastId(auth);
        console.log(`   Último Id de requerimiento: ${lastId}`);
    } catch (err) {
        console.log(`   Id: ${err.message}`);
    }
    try {
        const pvs = await wsfex.fexGetPtosVenta(auth);
        if (!pvs.length) {
            console.log('   ⚠️  Sin puntos de venta de exportación habilitados.');
            console.log('      Hay que darlo de alta en AFIP como "Comprobantes de Exportación - Web Services".');
        }
        for (const pv of pvs.slice(0, 3)) {
            const last = await wsfex.fexGetLastCmp({ ...auth, ptoVenta: pv.nro, cbteTipo: config.CBTE_TYPE_EXPO.FACTURA });
            console.log(`   PV ${String(pv.nro).padStart(5)} — última Factura E: N° ${last.cbteNro} (${last.cbteFecha || 's/f'})`);
        }
    } catch (err) {
        console.log(`   PV: ${err.message}`);
    }

    console.log('\n✅ Fin. No se emitió ningún comprobante.\n');
})();
