// consts.test.mjs: every named constant of js/nh equals clang's value (readability plan P2c).
//
// For each generated header module (js/nh/<header>.h.js) every export is checked: a
// namespace object member NS.SHORT is the C constant NS_SHORT, any other export has its C
// name. The C side is compiled by clang itself, with the recorder's flags, in the context
// of a TU that names constants of that header (transpiler/out/const-tus.json, written by
// transpiler/emit/run.mjs): the TU's source is included and followed by
//     long long nh_cv[] = { (long long)(PM_ANGEL), ... };
// compiled with -S -emit-llvm, and the folded values are read back from the IR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jsName } from '../../transpiler/emit/names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NH = path.join(ROOT, 'js/nh');

test('every named constant in js/nh equals clang\'s value', async () => {
    const tusFile = path.join(ROOT, 'transpiler/out/const-tus.json');
    assert.ok(existsSync(tusFile), 'transpiler/out/const-tus.json is missing: run node transpiler/emit/run.mjs');
    const tus = JSON.parse(readFileSync(tusFile, 'utf8'));
    const db = JSON.parse(readFileSync(path.join(ROOT, 'transpiler/out/compile_commands.json'), 'utf8'));
    // the TUs to try: those recorded first, then every object-world NetHack TU
    const tuList = [...new Set([...Object.values(tus), ...db.filter((x) => x.group === 'nethack').map((x) => path.relative(ROOT, path.resolve(ROOT, x.file)))])].sort();
    const homeTU = new Map(Object.entries(tus).filter(([f]) => f.endsWith('.h')).map(([f, t]) => [path.basename(f), t]));
    // the constants of every header module: { c: C name, js, v }
    const all = [];
    for (const f of readdirSync(NH).filter((x) => x.endsWith('.h.js')).sort()) {
        const m = await import(pathToFileURL(path.join(NH, f)).href);
        const first = homeTU.get(f.replace(/\.js$/, '')) || tuList[0];
        for (const [k, v] of Object.entries(m)) {
            if (v !== null && typeof v === 'object') for (const [s2, x] of Object.entries(v)) all.push({ c: `${k}_${s2}`, js: `${f}: ${k}.${s2}`, v: x, tu: first });
            else all.push({ c: /_$/.test(k) && jsName(k.slice(0, -1)) === k ? k.slice(0, -1) : k, js: `${f}: ${k}`, v, tu: first });
        }
    }
    const total = all.length;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'nhconsts-'));
    const bad = [];
    let checked = 0;
    // clang in a TU: Map(index -> value) for the names it knows; undeclared names are returned
    const evalIn = (tu, list) => {
        const e = db.find((x) => path.relative(ROOT, path.resolve(ROOT, x.file)) === tu);
        assert.ok(e, `${tu}: not in compile_commands.json`);
        const src = path.join(tmp, path.basename(tu));
        writeFileSync(src, `#include "${path.resolve(ROOT, e.file)}"\nlong long nh_cv[] = {\n${list.map((x) => `    (long long)(${x.c}),`).join('\n')}\n};\n`);
        const args = e.arguments.slice(1).filter((a) => a !== '-c' && a !== '-g' && !a.endsWith(path.basename(e.file)));
        const r = spawnSync(e.arguments[0], [...args, '-w', '-ferror-limit=0', '-S', '-emit-llvm', '-o', '-', src], { cwd: path.resolve(ROOT, e.directory), maxBuffer: 1 << 28 });
        if (r.status !== 0) {
            const und = new Set([...String(r.stderr).matchAll(/use of undeclared identifier '(\w+)'/g)].map((x) => x[1]));
            assert.ok(und.size, `${tu}: clang failed:\n${String(r.stderr).slice(0, 2000)}`);
            return { missing: list.filter((x) => und.has(x.c)), rest: list.filter((x) => !und.has(x.c)) };
        }
        const m = String(r.stdout).match(/@nh_cv = (?:dso_local )?global \[(\d+) x i64\] (zeroinitializer|\[([^\]]*)\])/);
        assert.ok(m, `${tu}: nh_cv not found in the IR`);
        const vals = m[2] === 'zeroinitializer' ? list.map(() => 0n) : m[3].split(',').map((t) => BigInt(t.trim().replace(/^i64 /, '')));
        assert.equal(vals.length, list.length);
        list.forEach((x, i) => {
            if (BigInt.asIntN(64, BigInt(x.v)) !== vals[i]) bad.push(`${x.js} = ${x.v}, clang ${x.c} = ${vals[i]}`);
            checked++;
        });
        return { missing: [], rest: [] };
    };
    try {
        let todo = all;
        for (let round = 0; todo.length && round <= tuList.length; round++) {
            const byTU = new Map();
            for (const x of todo) { if (!byTU.has(x.tu)) byTU.set(x.tu, []); byTU.get(x.tu).push(x); }
            const next = [];
            for (const [tu, list] of [...byTU].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
                let r = evalIn(tu, list);
                if (r.rest.length) { const r2 = evalIn(tu, r.rest); assert.equal(r2.rest.length + r2.missing.length, 0, `${tu}: names still failing`); }
                // an undeclared name is tried in the next TU of the list
                for (const x of r.missing) { x.tried = (x.tried || 0) + 1; x.tu = tuList[(tuList.indexOf(x.tu) + 1) % tuList.length]; if (x.tried <= tuList.length) next.push(x); else bad.push(`${x.js}: no TU declares ${x.c}`); }
            }
            todo = next;
        }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    assert.deepEqual(bad, [], `${bad.length} of ${total} constants differ from clang`);
    assert.equal(checked, total);
    console.log(`# ${total} constants in ${readdirSync(NH).filter((x) => x.endsWith('.h.js')).length} header modules equal clang's values`);
});
