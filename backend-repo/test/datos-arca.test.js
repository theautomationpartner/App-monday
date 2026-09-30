/**
 * Receta "Completar datos de ARCA": lo que no necesita red.
 *
 *     node backend-repo/test/datos-arca.test.js
 *
 * El usuario escribe un CUIT o DNI en una columna y la app le completa la razón
 * social y la condición IVA. Lo que se prueba acá es lo que puede salir mal SIN
 * ARCA ni monday: qué documento se entendió, qué valor va a cada columna y qué
 * mensaje lee el usuario cuando algo no se pudo completar.
 */
const assert = require('assert');
const { leerColumnaId, leerDocumento, valoresParaColumnas, casoDeError, mensaje } = require('../src/modules/datosArca');

let fallas = 0;
const caso = (nombre, fn) => {
    try { fn(); console.log(`  ok  ${nombre}`); }
    catch (e) { fallas++; console.log(`  MAL ${nombre}\n      ${e.message}`); }
};

console.log('\nDocumento escrito en la columna');
caso('CUIT con guiones se consulta limpio', () => assert.deepStrictEqual(leerDocumento('30-63766275-5'), { doc: '30637662755' }));
caso('DNI de 8 dígitos con puntos', () => assert.deepStrictEqual(leerDocumento('32.744.634'), { doc: '32744634' }));
caso('DNI de 7 dígitos', () => assert.deepStrictEqual(leerDocumento('5123456'), { doc: '5123456' }));
caso('columna vacía no hace nada', () => assert.deepStrictEqual(leerDocumento('   '), { vacio: true }));
caso('null no rompe', () => assert.deepStrictEqual(leerDocumento(null), { vacio: true }));
caso('10 dígitos es error de forma', () => assert.strictEqual(leerDocumento('2024104470').error, 'forma'));
caso('CUIT con dígito verificador mal NO se consulta', () => assert.strictEqual(leerDocumento('20215005962').error, 'digito'));
caso('un CUIT bueno nunca se rechaza por dígito', () => assert.ok(leerDocumento('20327446348').doc));

console.log('\nColumnas de la receta');
caso('string', () => assert.strictEqual(leerColumnaId('text_mm12'), 'text_mm12'));
caso('objeto { columnId }', () => assert.strictEqual(leerColumnaId({ columnId: 'status' }), 'status'));
caso('objeto { id }', () => assert.strictEqual(leerColumnaId({ id: 'color_x' }), 'color_x'));
caso('vacío', () => assert.strictEqual(leerColumnaId(undefined), ''));

console.log('\nQué se escribe');
const cols = { razonSocial: 'text_rs', condicionIva: 'status_iva' };
caso('empresa inscripta: razón social y condición', () => {
    const v = valoresParaColumnas({ info: { nombre: 'AGROLUCIA S.A.', condicion: 'RESPONSABLE_INSCRIPTO' }, columnas: cols });
    assert.deepStrictEqual(v.map((x) => x.valor), ['Agrolucia S.A.', 'IVA Responsable Inscripto']);
});
caso('monotributista', () => {
    const v = valoresParaColumnas({ info: { nombre: 'PEREZ JUAN', condicion: 'MONOTRIBUTO' }, columnas: cols });
    assert.strictEqual(v[1].valor, 'Responsable Monotributo');
});
caso('tablero en inglés escribe la condición en inglés', () => {
    const v = valoresParaColumnas({ info: { nombre: 'X', condicion: 'CONSUMIDOR_FINAL' }, columnas: cols, language: 'en' });
    assert.strictEqual(v[1].valor, 'Final Consumer');
});
caso('DNI sin CUIT: NO pisa la razón social, sí pone Consumidor Final', () => {
    const v = valoresParaColumnas({ info: { nombre: null, condicion: 'CONSUMIDOR_FINAL' }, columnas: cols });
    assert.deepStrictEqual(v.map((x) => x.campo), ['condicionIva']);
});
caso('"SIN NOMBRE" del padrón no se escribe', () => {
    const v = valoresParaColumnas({ info: { nombre: 'SIN NOMBRE', condicion: 'EXENTO' }, columnas: cols });
    assert.deepStrictEqual(v.map((x) => x.campo), ['condicionIva']);
});
caso('domicilio, localidad y provincia van cada uno a su columna', () => {
    const v = valoresParaColumnas({
        info: { nombre: 'X SA', condicion: 'EXENTO', domicilioPartes: { direccion: 'BELGRANO 560', localidad: 'RIO COLORADO', provincia: 'RIO NEGRO' } },
        columnas: { ...cols, domicilio: 'c_dom', localidad: 'c_loc', provincia: 'c_prov' },
    });
    assert.deepStrictEqual(v.filter((x) => x.campo !== 'razonSocial' && x.campo !== 'condicionIva'),
        [{ campo: 'domicilio', columnId: 'c_dom', valor: 'Belgrano 560' },
         { campo: 'localidad', columnId: 'c_loc', valor: 'Rio Colorado' },
         { campo: 'provincia', columnId: 'c_prov', valor: 'Rio Negro' }]);
});
caso('sin domicilio (DNI sin CUIT) no se vacía la columna', () => {
    const v = valoresParaColumnas({ info: { condicion: 'CONSUMIDOR_FINAL', domicilioPartes: {} }, columnas: { ...cols, domicilio: 'c_dom' } });
    assert.ok(!v.some((x) => x.campo === 'domicilio'));
});
caso('si no mapeó columna de domicilio, no se escribe', () => {
    const v = valoresParaColumnas({ info: { nombre: 'X', condicion: 'EXENTO', domicilioPartes: { direccion: 'CALLE 1' } }, columnas: cols });
    assert.ok(!v.some((x) => x.campo === 'domicilio'));
});
caso('solo la columna que eligió', () => {
    const v = valoresParaColumnas({ info: { nombre: 'X SA', condicion: 'EXENTO' }, columnas: { condicionIva: 'c' } });
    assert.deepStrictEqual(v.map((x) => x.campo), ['condicionIva']);
});

console.log('\nErrores del padrón');
caso('inexistente', () => assert.strictEqual(casoDeError({ errorType: 'CUIT_INEXISTENTE' }), 'inexistente'));
caso('inactivo', () => assert.strictEqual(casoDeError({ errorType: 'CUIT_INACTIVO' }), 'inactivo'));
caso('constancia bloqueada', () => assert.strictEqual(casoDeError({ errorType: 'CONSTANCIA_ERROR' }), 'constancia'));
caso('red / WSAA / 5xx se atribuye a ARCA', () => assert.strictEqual(casoDeError(new Error('ECONNRESET')), 'arcaCaido'));

console.log('\nMensajes al usuario');
const CASOS = ['forma', 'digito', 'inexistente', 'inactivo', 'constancia', 'arcaCaido', 'sinColumnas', 'escritura'];
const vars = { crudo: '20215005962', digitos: 10, detalle: 'bloqueada', columnas: 'razón social' };
for (const c of CASOS) {
    caso(`"${c}" existe en los dos idiomas y no son iguales`, () => {
        const es = mensaje(c, 'es', vars), en = mensaje(c, 'en', vars);
        assert.ok(es && en && es !== en);
    });
    caso(`"${c}" no habla de "receta" (palabra de monday, no del usuario)`, () => {
        assert.ok(!/receta|recipe/i.test(mensaje(c, 'es', vars) + mensaje(c, 'en', vars)));
    });
    caso(`"${c}" sin placeholders sin reemplazar`, () => {
        assert.ok(!/undefined|\$\{/.test(mensaje(c, 'es', vars) + mensaje(c, 'en', vars)));
    });
}
caso('culpa a ARCA SOLO cuando ARCA no responde', () => {
    for (const c of CASOS.filter((x) => x !== 'arcaCaido')) assert.ok(!/no está respondiendo/.test(mensaje(c, 'es', vars)), c);
});

if (fallas) { console.log(`\n${fallas} caso(s) mal`); process.exit(1); }
console.log('\nOK — datos de ARCA');
