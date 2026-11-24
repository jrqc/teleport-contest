// Whether two builds of js/nh differ only in whitespace (readability step c: line breaks).
// Usage: node tools/analysis/wsdiff.mjs <dirA> <dirB>   (exit 1 if any file differs otherwise)
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const [A, B] = process.argv.slice(2);
const norm = (t) => t.replace(/\s+/g, ' ').replaceAll('( ', '(').replaceAll(' )', ')');
let bad = 0, added = 0;
for (const f of readdirSync(B).filter((x) => x.endsWith('.js')).sort()) {
    const a = readFileSync(path.join(A, f), 'utf8'), b = readFileSync(path.join(B, f), 'utf8');
    added += a.split('\n').length - b.split('\n').length;
    if (norm(a) !== norm(b)) { bad++; console.log(`differs beyond whitespace: ${f}`); }
}
console.log(`${bad} files differ beyond whitespace; ${added} lines added`);
process.exit(bad ? 1 : 0);
