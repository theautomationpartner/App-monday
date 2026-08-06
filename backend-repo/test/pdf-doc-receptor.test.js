/**
 * ¿El comprobante llama bien al documento del receptor?
 *
 *     node backend-repo/test/pdf-doc-receptor.test.js
 *
 * El encabezado del PDF decía siempre "CUIT". En producción hay 41 comprobantes
 * emitidos a un DNI, y en 17 de ellos quedó impreso "CUIT: 12345678" arriba de
 * un número que no es un CUIT — en un papel fiscal que el cliente le manda a su
 * comprador.
 *
 * AFIP identifica al receptor con un tipo de documento (80 CUIT, 86 CUIL,
 * 96 DNI) y el título tiene que seguir ese tipo, no suponer.
 *
 * Lo que más importa acá es el default: ante la duda tiene que decir "CUIT",
 * que es el caso de lejos más común y lo que se imprimió siempre. Cambiar el
 * título de un comprobante que hoy sale bien sería peor que el bug.
 */
const { etiquetaDocReceptor } = require('../src/modules/invoicePdf');

const casos = [
    // El tipo que manda AFIP gana siempre
    [{ docTipo: 96, receptor_cuit_o_dni: '1' },           'DNI: ',  'el caso real: AFIP registró DNI 1'],
    [{ docTipo: 96, receptor_cuit_o_dni: '20308008' },    'DNI: ',  'DNI de 8'],
    [{ docTipo: 80, receptor_cuit_o_dni: '30637662755' }, 'CUIT: ', 'CUIT'],
    [{ docTipo: 86, receptor_cuit_o_dni: '20308008453' }, 'CUIL: ', 'CUIL'],
    [{ docTipo: 99, receptor_cuit_o_dni: null },          'CUIT: ', 'consumidor final sin identificar'],

    // Sin tipo, se deduce por el largo
    [{ receptor_cuit_o_dni: '12345678' },                 'DNI: ',  'sin tipo, 8 dígitos'],
    [{ receptor_cuit_o_dni: '1234567' },                  'DNI: ',  'sin tipo, 7 dígitos'],
    [{ receptor_cuit_o_dni: '30637662755' },              'CUIT: ', 'sin tipo, 11 dígitos'],
    [{ receptor_cuit_o_dni: '30-63766275-5' },            'CUIT: ', 'sin tipo, con guiones'],

    // El default: ante la duda, lo de siempre
    [{},                                                   'CUIT: ', 'draft vacío'],
    [{ receptor_cuit_o_dni: null },                        'CUIT: ', 'sin documento'],
    [{ receptor_cuit_o_dni: '' },                          'CUIT: ', 'documento vacío'],
    [null,                                                 'CUIT: ', 'sin draft'],
    [{ docTipo: 96, receptor_cuit_o_dni: '30637662755' },  'DNI: ',  'AFIP dice DNI aunque parezca CUIT: gana AFIP'],
];

let fallos = 0;
console.log(`\n${casos.length} receptores\n` + '─'.repeat(70));

for (const [draft, esperado, porque] of casos) {
    const dio = etiquetaDocReceptor(draft);
    const ok = dio === esperado;
    if (!ok) fallos++;
    console.log(`${ok ? '  ok  ' : ' FALLA'} │ ${esperado.trim().padEnd(6)} │ ${porque}`);
    if (!ok) console.log(`       │        │   → imprimió "${dio.trim()}"`);
}

// Lo que no puede pasar nunca: que un CUIT de 11 dígitos, sin que AFIP diga
// otra cosa, deje de titularse CUIT. Eso cambiaría comprobantes que hoy salen bien.
const rompeLoQueAndaba = [
    { docTipo: 80, receptor_cuit_o_dni: '20327446348' },
    { receptor_cuit_o_dni: '20327446348' },
    { docTipo: 99, receptor_cuit_o_dni: null },
].filter(d => etiquetaDocReceptor(d) !== 'CUIT: ');
if (rompeLoQueAndaba.length) {
    fallos++;
    console.log(`\nFALLA: cambiaría el título de comprobantes que hoy salen bien: ${JSON.stringify(rompeLoQueAndaba)}`);
}

console.log('─'.repeat(70));
if (fallos > 0) { console.log(`\nFALLA: ${fallos} caso(s).`); process.exit(1); }
console.log('\nOK — el título sigue al tipo de documento, y ante la duda dice CUIT.');
