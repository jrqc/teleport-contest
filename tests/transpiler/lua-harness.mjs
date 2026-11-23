// lua-harness.mjs: differential test of the heap-world Lua interpreter (tool 4.5).
// tests/c-diff/lua/driver.c + the recorder's 32 Lua TUs, built natively with
// clang (the recorder's flags) and transpiled with every TU in the heap world;
// the outputs must be identical.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAst, ROOT } from '../../transpiler/frontend/ast.mjs';
import { tuScope } from '../../transpiler/ir/scope.mjs';
import { Program } from '../../transpiler/emit/program.mjs';
import { parseJsonc } from '../../transpiler/annotations/jsonc.mjs';

const SRC = path.join(ROOT, 'tests/c-diff/lua');
const ann = parseJsonc(readFileSync(path.join(ROOT, 'transpiler/annotations.jsonc'), 'utf8'));
const luaDefines = ann.groups.lua.defines || [];
const db = JSON.parse(readFileSync(path.join(ROOT, 'transpiler/out/compile_commands.json'), 'utf8')).filter((e) => e.group === 'lua');
const luaDir = path.resolve(ROOT, db[0].directory);
const FLAGS = ['-O2', '-DLUA_COMPAT_5_3', '-DLUA_USE_MACOSX'];

function scriptInc(lua) {
    const chunks = lua.split(/^-- @@chunk$/m);
    return chunks.map((c) => JSON.stringify(c).replace(/\\u0000/g, '\\0') + ',').join('\n') + '\n';
}

export async function build(work, { tag = 'run', script = path.join(SRC, 'script.lua') } = {}) {
    mkdirSync(work, { recursive: true });
    writeFileSync(path.join(work, 'script.inc'), scriptInc(readFileSync(script, 'utf8')));
    writeFileSync(path.join(work, 'driver.c'), readFileSync(path.join(SRC, 'driver.c')));
    // native
    const exe = path.join(work, 'driver');
    execFileSync('clang', ['-arch', 'arm64', ...FLAGS, '-w', `-I${luaDir}`, '-o', exe, path.join(work, 'driver.c'), ...db.map((e) => path.resolve(ROOT, e.file))]);
    // transpiled
    const crtNames = new Set(Object.keys(await import('../../js/crt/index.js')));
    const heapCrtNames = new Set(Object.keys(await import('../../js/crt/heaplibc.js')));
    const prog = new Program({ crtNames, heapCrtNames, isHeapFile: () => true });
    prog.missingFn = new Set();
    const entries = [...db.map((e) => ({ ...e, extraArgs: luaDefines })),
        { directory: path.relative(ROOT, work), file: path.relative(ROOT, path.join(work, 'driver.c')), arguments: ['clang', ...FLAGS, `-I${luaDir}`, '-c', path.join(work, 'driver.c')] }];
    const load = async (e) => { const { root } = await loadAst(e); return { root, scope: tuScope(root, e.directory), file: path.relative(ROOT, path.resolve(ROOT, e.file)), dir: e.directory, entry: e }; };
    for (const e of entries) prog.addFacts(await load(e));
    const out = path.join(work, tag, 'nh');
    rmSync(path.join(work, tag), { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    symlinkSync(path.join(ROOT, 'js/crt'), path.join(work, tag, 'crt'));
    const errors = [];
    const results = [];
    for (const e of entries) { const r = prog.emitTU(await load(e)); results.push(r); errors.push(...r.errors); }
    // readability plan P3: macro sites are resolved once every TU is emitted
    for (const [f, code] of prog.resolveTUs(results)) writeFileSync(path.join(out, f), code);
    for (const [f, text] of prog.finish()) writeFileSync(path.join(out, f), text);
    return { exe, out, errors, missing: [...prog.missingFn] };
}

export function runNative(exe) {
    try { return { out: execFileSync(exe).toString('latin1'), status: 0 }; } catch (e) { return { out: String(e.stdout), status: e.status }; }
}
export async function runJs(out) {
    const crt = await import('../../js/crt/index.js');
    const chunks = [];
    crt.setSink(crt.stdout, (b) => chunks.push(Buffer.from(Uint8Array.from(b, (x) => x & 0xff))));
    const idx = await import(pathToFileURL(path.join(out, 'index.js')).href);
    idx.$initAll();
    const m = await import(pathToFileURL(path.join(out, 'driver.js')).href);
    let status = 0;
    const t0 = Date.now();
    try { status = (await m.main()) | 0; } catch (e) { chunks.push(Buffer.from(`\n[JS exception] ${e.stack}\n`)); status = -999; }
    crt.setSink(crt.stdout, null);
    return { out: Buffer.concat(chunks).toString('latin1'), status, ms: Date.now() - t0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const work = path.join(ROOT, 'transpiler/build/luatest');
    const b = await build(work, process.argv[2] ? { script: path.resolve(process.argv[2]) } : {});
    if (b.errors.length) console.log('EMIT ERRORS:\n' + b.errors.join('\n'));
    const n = runNative(b.exe), j = await runJs(b.out);
    console.log(n.out === j.out ? 'SAME' : 'DIFFERENT', `(js ${j.ms} ms)`);
    if (n.out !== j.out) {
        const a = n.out.split('\n'), c = j.out.split('\n');
        for (let i = 0; i < Math.max(a.length, c.length); i++) if (a[i] !== c[i]) { console.log(`line ${i + 1}:\n  C : ${JSON.stringify(a[i])}\n  JS: ${JSON.stringify(c[i])}`); break; }
        if (j.out.includes('[JS exception]')) console.log(j.out.slice(j.out.indexOf('[JS exception]'), j.out.indexOf('[JS exception]') + 2000));
    }
}
