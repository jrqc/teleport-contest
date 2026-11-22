#!/usr/bin/env node
// tools/churn/bench.mjs: Phase 2 churn benchmark (method/readability-plan.md).
//
// Transpiles the unmodified C and three edited variants, and counts the js/ lines
// each edit changes the way the Phase 2 judge counts them (docs/PHASES.md: git diff
// --numstat, added + deleted, comment-only and whitespace-only changes normalized out).
// The edits reach clang through a VFS overlay (-ivfsoverlay), so the recorder tree is
// never modified:
//   monster  a new monster inserted after the giant ant in monsters.h (renumbers PM_*)
//   field    a new int field in the middle of struct monst (monst.h)
//   yn       a y_n() call (5.0 spelling of yn) at the top of goodpos() (teleport.c), a deep non-async
//            function; the async ripple (lines that differ only by async/await) is
//            reported separately
// The unmodified transpile is also compared byte for byte with js/nh: the
// determinism check (two transpiles, the committed one and this one).
//
// Usage: node tools/churn/bench.mjs [--label NAME] [--jobs 2] [--variants base,monster,field,yn]
// Output: results/churn/<ts>-<label>/summary.json, summary.md, onscary.js
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const label = opt('label', 'run'), jobs = Number(opt('jobs', 2));
const want = opt('variants', 'base,monster,field,yn').split(',');
const REC = path.join(ROOT, 'tools/recorder-env/build/nethack-c/recorder');
const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const OUT = path.join(ROOT, 'results', 'churn', `${ts}-${label}`);
mkdirSync(OUT, { recursive: true });
const TMP = mkdtempSync(path.join(os.tmpdir(), 'nhchurn-'));

// one edit: [file in the recorder tree, text to find (must occur once), replacement]
function edit(file, find, repl) {
    const src = readFileSync(path.join(REC, file), 'latin1');
    if (src.split(find).length !== 2) throw new Error(`${file}: anchor not found exactly once: ${find.slice(0, 60)}`);
    return { file, text: src.replace(find, repl) };
}
const VARIANTS = {
    base: () => [],
    monster: () => [edit('include/monsters.h', '        4, CLR_BROWN, GIANT_ANT),\n',
        '        4, CLR_BROWN, GIANT_ANT),\n'
        + '    MON(NAM("fire termite"), S_ANT,\n'
        + '        LVL(2, 12, 3, 0, 0), (G_GENO | G_SGROUP | 2),\n'
        + '        A(ATTK(AT_BITE, AD_FIRE, 1, 4),\n'
        + '          NO_ATTK, NO_ATTK, NO_ATTK, NO_ATTK, NO_ATTK),\n'
        + '        SIZ(10, 10, MS_SILENT, MZ_TINY), MR_FIRE, MR_FIRE,\n'
        + '        M1_ANIMAL | M1_NOHANDS | M1_OVIPAROUS | M1_CARNIVORE, M2_HOSTILE, 0,\n'
        + '        4, CLR_RED, FIRE_TERMITE),\n')],
    field: () => [edit('include/monst.h', '    unsigned m_id;\n', '    unsigned m_id;\n    int mchurn;           /* churn benchmark: a new field */\n')],
    yn: () => [edit('src/teleport.c', 'goodpos(\n    coordxy x, coordxy y,\n    struct monst *mtmp,\n    mmflags_nht gpflags)\n{\n',
        'goodpos(\n    coordxy x, coordxy y,\n    struct monst *mtmp,\n    mmflags_nht gpflags)\n{\n    if (x == 0 && y == 0)\n        (void) y_n("Churn benchmark?");\n')],
};

function run(cmd, args, env) {
    return new Promise((resolve, reject) => {
        const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        c.stdout.on('data', () => {});
        c.stderr.on('data', (d) => { err += d; });
        c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`))));
    });
}
async function transpile(name) {
    const dir = path.join(TMP, name);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    const edits = VARIANTS[name]();
    const env = {};
    if (edits.length) {
        const roots = edits.map((e) => {
            const f = path.join(dir, 'src', path.basename(e.file));
            writeFileSync(f, e.text, 'latin1');
            return { type: 'file', name: path.join(REC, e.file), 'external-contents': f };
        });
        const yaml = path.join(dir, 'overlay.json');   // YAML is a superset of JSON
        writeFileSync(yaml, JSON.stringify({ version: 0, 'use-external-names': false, roots }));
        env.NH_CLANG_EXTRA_ARGS = JSON.stringify(['-ivfsoverlay', yaml]);
    }
    const t0 = Date.now();
    await run(process.execPath, ['transpiler/emit/run.mjs', '--out', path.join(dir, 'nh')], env);
    process.stderr.write(`${name}: transpiled in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
    return path.join(dir, 'nh');
}

// The judge's normalization: drop comments, then whitespace; blank lines vanish.
function stripComments(s) {
    let o = '', i = 0;
    const n = s.length;
    while (i < n) {
        const c = s[i], d = s[i + 1];
        if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') { const j = s.indexOf('*/', i + 2); const body = s.slice(i, j < 0 ? n : j + 2); o += body.replace(/[^\n]/g, ''); i = j < 0 ? n : j + 2; continue; }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < n && s[j] !== c) { if (s[j] === '\\') j++; j++; }
            o += s.slice(i, j + 1); i = j + 1; continue;
        }
        o += c; i++;
    }
    return o;
}
const normalize = (s, dropAsync) => {
    let t = stripComments(s);
    if (dropAsync) t = t.replace(/\basync (?=function\b|\(|[A-Za-z_$][\w$]* *=>)/g, '').replace(/\bawait /g, '');
    return t.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l !== '').join('\n') + '\n';
};
function numstat(a, b, dropAsync, tag) {
    const na = path.join(TMP, `norm-${tag}-a`), nb = path.join(TMP, `norm-${tag}-b`);
    const files = [...new Set([...readdirSync(a), ...readdirSync(b)])].filter((f) => f.endsWith('.js') && f !== 'isaac64.js').sort();
    for (const [src, dst] of [[a, na], [b, nb]]) {
        rmSync(dst, { recursive: true, force: true });
        mkdirSync(dst, { recursive: true });
        for (const f of files) {
            const p = path.join(src, f);
            writeFileSync(path.join(dst, f), existsSync(p) ? normalize(readFileSync(p, 'latin1'), dropAsync) : '', 'latin1');
        }
    }
    let out = '';
    try { out = execFileSync('git', ['diff', '--no-index', '--numstat', na, nb], { maxBuffer: 1 << 28 }).toString(); }
    catch (e) { out = e.stdout.toString(); }   // exit 1 = differences
    const perFile = out.trim().split('\n').filter(Boolean).map((l) => { const [ad, de, f] = l.split('\t'); return { file: path.basename(f.replace(/^.*=> /, '').replace(/[{}]/g, '')), added: +ad, deleted: +de }; });
    return { lines: perFile.reduce((s, r) => s + r.added + r.deleted, 0), files: perFile.length, perFile: perFile.sort((x, y) => (y.added + y.deleted) - (x.added + x.deleted)) };
}
const asyncNames = (dir) => new Set(readdirSync(dir).filter((f) => f.endsWith('.js')).flatMap((f) => [...readFileSync(path.join(dir, f), 'latin1').matchAll(/async function ([\w$]+)\(/g)].map((m) => `${f}:${m[1]}`)));
function fnText(dir, file, name) {
    const s = readFileSync(path.join(dir, file), 'latin1');
    const i = s.search(new RegExp(`^(export )?(async )?function ${name}\\(`, 'm'));
    if (i < 0) return null;
    const j = s.indexOf('\n}\n', i);
    return s.slice(i, j + 3);
}

// transpile the variants, `jobs` at a time
const outs = {};
const queue = want.slice();
await Promise.all(Array.from({ length: jobs }, async () => { for (let v; (v = queue.shift());) outs[v] = await transpile(v); }));

const summary = { ts, label, commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(), variants: {} };
if (outs.base) {
    // determinism: the fresh transpile against the committed js/nh
    const committed = path.join(ROOT, 'js/nh');
    const differ = readdirSync(outs.base).filter((f) => f.endsWith('.js') && f !== 'isaac64.js')
        .filter((f) => !existsSync(path.join(committed, f)) || !readFileSync(path.join(committed, f)).equals(readFileSync(path.join(outs.base, f))));
    const extra = readdirSync(committed).filter((f) => f.endsWith('.js') && !existsSync(path.join(outs.base, f)));
    summary.determinism = { identical: differ.length === 0 && extra.length === 0, differ, extra };
    const lines = readdirSync(outs.base).filter((f) => f.endsWith('.js') && f !== 'isaac64.js').reduce((s, f) => s + normalize(readFileSync(path.join(outs.base, f), 'latin1')).split('\n').length - 1, 0);
    summary.codeLines = lines;
    const on = fnText(outs.base, 'monmove.js', 'onscary');
    if (on) writeFileSync(path.join(OUT, 'onscary.js'), on);
    for (const v of want.filter((x) => x !== 'base')) {
        const r = numstat(outs.base, outs[v], false, v);
        const row = { lines: r.lines, files: r.files, top: r.perFile.slice(0, 8) };
        if (v === 'yn') {
            const r2 = numstat(outs.base, outs[v], true, `${v}-noasync`);
            const a0 = asyncNames(outs.base), a1 = asyncNames(outs[v]);
            row.withoutAsync = r2.lines;
            row.asyncRipple = r.lines - r2.lines;
            row.newlyAsync = [...a1].filter((x) => !a0.has(x)).length;
        }
        summary.variants[v] = row;
    }
}
writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
const md = [`# Churn benchmark ${ts} ${label} (commit ${summary.commit})`, '',
    `Determinism (fresh transpile vs committed js/nh): ${summary.determinism ? (summary.determinism.identical ? 'byte-identical' : `DIFFERS: ${summary.determinism.differ.concat(summary.determinism.extra).slice(0, 10).join(', ')}`) : 'not run'}`,
    `Generated code: ${summary.codeLines} normalized lines`, '',
    '| Edit | Changed js/ lines | Files | Largest files |', '|---|---|---|---|',
    ...Object.entries(summary.variants).map(([v, r]) => `| ${v}${v === 'yn' ? ` (async ripple ${r.asyncRipple} lines, ${r.newlyAsync} functions became async; ${r.withoutAsync} without it)` : ''} | ${r.lines} | ${r.files} | ${r.top.slice(0, 5).map((t) => `${t.file} ${t.added + t.deleted}`).join(', ')} |`)];
writeFileSync(path.join(OUT, 'summary.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
console.log(`\n${OUT}`);
rmSync(TMP, { recursive: true, force: true });
