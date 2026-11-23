// Compare js/ at HEAD and in the working tree after the judge-style normalization (comments, whitespace). Run from the repo root: node tools/analysis/codeonly.mjs [SHOW=<file>]
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
function strip(s) {
    let o = '', i = 0; const n = s.length;
    while (i < n) {
        const c = s[i], d = s[i + 1];
        if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') { const j = s.indexOf('*/', i + 2); o += s.slice(i, j < 0 ? n : j + 2).replace(/[^\n]/g, ''); i = j < 0 ? n : j + 2; continue; }
        if (c === '"' || c === "'" || c === '`') { let j = i + 1; while (j < n && s[j] !== c) { if (s[j] === '\\') j++; j++; } o += s.slice(i, j + 1); i = j + 1; continue; }
        o += c; i++;
    }
    return o;
}
const norm = (s) => strip(s).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l).join('\n');
const files = execSync("git diff --name-only HEAD -- js", { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.js'));
let same = 0; const diff = [];
for (const f of files) {
    const a = execSync(`git show HEAD:${f}`, { encoding: 'latin1', maxBuffer: 1 << 28 });
    const b = existsSync(f) ? readFileSync(f, 'latin1') : '';
    if (norm(a) === norm(b)) same++; else diff.push(f);
}
console.log(`${files.length} changed js files; ${same} identical after normalization; differ: ${diff.join(' ') || 'none'}`);
if (process.env.SHOW) { const f = process.env.SHOW; const A = norm(execSync(`git show HEAD:${f}`, { encoding: 'latin1', maxBuffer: 1 << 28 })).split('\n'), B = norm(readFileSync(f, 'latin1')).split('\n'); for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) { console.log('HEAD:', A.slice(i - 1, i + 2)); console.log('NOW :', B.slice(i - 1, i + 2)); break; } }
