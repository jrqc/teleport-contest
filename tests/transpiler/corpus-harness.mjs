// corpus-harness.mjs: transpile a small C program and run it, vs native clang.
// Used by corpus.test.mjs (tool 4.5). Each corpus program prints to stdout;
// main's return value becomes the exit status.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAst, ROOT } from '../../transpiler/frontend/ast.mjs';
import { tuScope } from '../../transpiler/ir/scope.mjs';
import { Program } from '../../transpiler/emit/program.mjs';

const FLAGS = ['-arch', 'arm64', '-O0', '-g', '-w'];

export function native(src, dir) {
    const exe = path.join(dir, path.basename(src, '.c'));
    execFileSync('clang', [...FLAGS, '-o', exe, src]);
    try {
        const out = execFileSync(exe, { maxBuffer: 1 << 28 });
        return { out: out.toString('latin1'), status: 0 };
    } catch (e) {
        return { out: (e.stdout || Buffer.alloc(0)).toString('latin1'), status: e.status };
    }
}

let crtNames = null;
export async function transpile(srcs, dir) {
    if (!crtNames) crtNames = new Set(Object.keys(await import('../../js/crt/index.js')));
    const tus = [];
    for (const src of srcs) {
        const rel = path.relative(ROOT, src);
        const { root } = await loadAst({ directory: path.relative(ROOT, path.dirname(src)) || '.', file: rel, arguments: ['clang', ...FLAGS, '-c', src] });
        tus.push({ root, scope: tuScope(root, path.dirname(src)), file: rel, dir: path.dirname(src) });
    }
    const prog = new Program({ crtNames });
    const { files, errors } = prog.emitAll(tus);
    const out = path.join(dir, 'nh');
    mkdirSync(out, { recursive: true });
    try { symlinkSync(path.join(ROOT, 'js/crt'), path.join(dir, 'crt')); } catch { /* exists */ }
    for (const [f, text] of files) writeFileSync(path.join(out, f), text);
    return { dir: out, errors, modules: tus.map((t) => t.module), files };
}

export async function runJs(outDir, mainModule) {
    const crt = await import('../../js/crt/index.js');
    const chunks = [];
    crt.setSink(crt.stdout, (b) => chunks.push(Buffer.from(Uint8Array.from(b, (x) => x & 0xff))));
    const idx = await import(pathToFileURL(path.join(outDir, 'index.js')).href);   // a fresh dir per run: no cache clash
    idx.$initAll();
    const m = await import(pathToFileURL(path.join(outDir, `${mainModule}.js`)).href);   // the instance index.js initialized
    let status = 0;
    try { status = (await m.main()) | 0; } catch (e) { chunks.push(Buffer.from(`\n[JS exception] ${e.stack}\n`)); status = -999; }
    crt.setSink(crt.stdout, null);
    return { out: Buffer.concat(chunks).toString('latin1'), status };
}

export async function compare(src) {
    const dir = mkdtempSync(path.join(tmpdir(), 'corpus-'));
    const n = native(src, dir);
    const t = await transpile([src], dir);
    const j = await runJs(t.dir, t.modules[0]);
    return { native: n, js: j, errors: t.errors, dir: t.dir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const src = path.resolve(process.argv[2]);
    const r = await compare(src);
    if (r.errors.length) console.log('EMIT ERRORS:\n' + r.errors.join('\n'));
    const same = r.native.out === r.js.out && (r.native.status & 255) === (r.js.status & 255);
    console.log(same ? 'SAME' : 'DIFFERENT', `(native status ${r.native.status}, js ${r.js.status}) out: ${r.dir}`);
    if (!same) {
        const a = r.native.out.split('\n'), b = r.js.out.split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { console.log(`line ${i + 1}:\n  C : ${JSON.stringify(a[i])}\n  JS: ${JSON.stringify(b[i])}`); break; }
        if (r.js.out.includes('[JS exception]')) console.log(r.js.out.slice(r.js.out.indexOf('[JS exception]'), r.js.out.indexOf('[JS exception]') + 1500));
    }
}
