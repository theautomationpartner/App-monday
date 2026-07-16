/**
 * check-i18n.js — Verifica que los diccionarios ES y EN estén simétricos.
 *
 * Uso:  node scripts/check-i18n.js   (o `npm run check:i18n`)
 *
 * Por qué existe: monday no aprueba la app si algo no está en los dos idiomas, y
 * una clave que falta en EN no rompe nada visible (t() cae al español), así que
 * se escapa fácil en el code review. Este chequeo la caza antes.
 *
 * Sale con código 1 si hay claves asimétricas o duplicadas.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'src', 'i18n.jsx');
const src = fs.readFileSync(FILE, 'utf8');

const esStart = src.indexOf('\n  es: {');
const enStart = src.indexOf('\n  en: {');
if (esStart < 0 || enStart < 0) {
    console.error('❌ No se encontraron los bloques `es: {` / `en: {` en i18n.jsx');
    process.exit(2);
}
const enEnd = src.indexOf('\n};', enStart);

const keysOf = (block) => [...block.matchAll(/^\s{4}"([^"]+)":/gm)].map((m) => m[1]);

const esKeys = keysOf(src.slice(esStart, enStart));
const enKeys = keysOf(src.slice(enStart, enEnd > 0 ? enEnd : undefined));
const esSet = new Set(esKeys);
const enSet = new Set(enKeys);

const faltanEn = esKeys.filter((k) => !enSet.has(k));
const faltanEs = enKeys.filter((k) => !esSet.has(k));
const dupEs = [...new Set(esKeys.filter((k, i) => esKeys.indexOf(k) !== i))];
const dupEn = [...new Set(enKeys.filter((k, i) => enKeys.indexOf(k) !== i))];

console.log(`claves ES: ${esSet.size}   claves EN: ${enSet.size}`);

let ok = true;
if (faltanEn.length) { ok = false; console.log(`\n❌ Faltan en INGLÉS (${faltanEn.length}):`); faltanEn.forEach((k) => console.log('   ' + k)); }
if (faltanEs.length) { ok = false; console.log(`\n❌ Faltan en ESPAÑOL (${faltanEs.length}):`); faltanEs.forEach((k) => console.log('   ' + k)); }
if (dupEs.length)    { ok = false; console.log(`\n❌ Duplicadas en ES: ${dupEs.join(', ')}`); }
if (dupEn.length)    { ok = false; console.log(`\n❌ Duplicadas en EN: ${dupEn.join(', ')}`); }

if (ok) {
    console.log('\n✅ Diccionarios simétricos.');
    process.exit(0);
}
process.exit(1);
