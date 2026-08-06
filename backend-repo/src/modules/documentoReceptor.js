/**
 * Lo que se puede saber del documento del receptor SIN preguntarle a nadie.
 *
 * Las dos funciones de acá son cuentas: no consultan AFIP, no tocan la base, no
 * necesitan una sola librería. Eso no es un detalle de diseño, es el punto:
 *
 *   - `cuitDvValido` existe justamente para cuando AFIP NO responde. Si viviera
 *     dentro del módulo que habla con AFIP, no serviría para lo único que tiene
 *     que servir.
 *   - Y como este archivo no importa nada, los bancos de prueba lo pueden correr
 *     en el CI sin instalar dependencias. Cuando estas funciones vivían en
 *     afipPadron.js e invoicePdf.js, el paso de tests del deploy explotaba con
 *     MODULE_NOT_FOUND: para probar una cuenta de módulo 11 había que cargar el
 *     cliente de AFIP entero.
 *
 * Los módulos grandes las re-exportan, así nadie tiene que cambiar de dónde las
 * importa.
 */
'use strict';

/**
 * ¿El CUIT pasa el dígito verificador de AFIP?
 *
 * Se calcula acá, sin red. Cuando el padrón de AFIP no responde no podemos saber
 * si un CUIT existe, pero SÍ podemos saber si está mal escrito. Sin esto, a un
 * cliente con un CUIT mal tipeado le decimos "AFIP está caído, reintentá" — y
 * reintenta para siempre. Pasó: 9 intentos en dos días, y terminó facturando
 * desde el portal de AFIP.
 *
 * Devuelve `true`, `false`, o **`null` cuando no se puede opinar**:
 *   - no son 11 dígitos (un DNI no tiene dígito verificador)
 *   - resto 1, el caso donde el dígito daría 10: AFIP ahí cambia el prefijo
 *     (20→23) en vez de usar ese dígito, así que la cuenta simple no alcanza
 *     para condenarlo.
 *
 * `null` nunca se usa para rechazar nada. Solo un `false` — que significa "este
 * número no puede ser un CUIT de AFIP" — habilita un mensaje distinto.
 */
function cuitDvValido(cuit) {
    const s = String(cuit || '').replace(/\D/g, '');
    if (s.length !== 11) return null;
    const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    let suma = 0;
    for (let i = 0; i < 10; i++) suma += parseInt(s[i], 10) * mult[i];
    const resto = suma % 11;
    if (resto === 1) return null;
    const dv = resto === 0 ? 0 : 11 - resto;
    return dv === parseInt(s[10], 10);
}

/**
 * Cómo se llama el documento del receptor en el encabezado del comprobante.
 *
 * Decía siempre "CUIT". A 17 comprobantes ya emitidos les quedó impreso
 * "CUIT: 12345678" arriba de un DNI — en un papel fiscal que el cliente le manda
 * a su comprador. AFIP identifica al receptor con un tipo de documento (80 CUIT,
 * 86 CUIL, 96 DNI) y el título tiene que seguirlo.
 *
 * Si el tipo no viene, se deduce por el largo: 7 u 8 dígitos es un DNI, 11 es un
 * CUIT. Ante la duda queda "CUIT", que es el caso de lejos más común y el
 * comportamiento de siempre.
 */
function etiquetaDocReceptor(draft) {
    const tipo = Number(draft?.docTipo);
    if (tipo === 96) return 'DNI: ';
    if (tipo === 86) return 'CUIL: ';
    if (tipo === 80) return 'CUIT: ';
    const digitos = String(draft?.receptor_cuit_o_dni || '').replace(/\D/g, '').length;
    if (digitos === 7 || digitos === 8) return 'DNI: ';
    return 'CUIT: ';
}

module.exports = { cuitDvValido, etiquetaDocReceptor };
