// Record layouts from transpiler/ir/ctypes.mjs vs native clang (arm64, recorder flags).
// For every complete record defined in a NetHack header: sizeof, alignof, the
// offset of each named field, and for bit-fields the bytes an all-ones store sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAst, ROOT } from '../../transpiler/frontend/ast.mjs';
import { Scope } from '../../transpiler/ir/ctypes.mjs';
import { tuScope } from '../../transpiler/ir/scope.mjs';

const SRC = path.join(ROOT, 'tools/recorder-env/build/nethack-c/recorder/src');
const HEADERS = ['hack.h', 'sp_lev.h', 'dlb.h', 'wintty.h', 'tcap.h', 'nhlua.h', 'func_tab.h', 'botl.h', 'selvar.h'];

test('record layouts match native arm64 clang for all NetHack header records', { timeout: 600000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'layout-'));
    const probe = path.join(dir, 'probe.c');
    const incl = HEADERS.map((h) => `#include "${h}"`).join('\n');
    writeFileSync(probe, `${incl}\n#include <stdio.h>\n#include <stddef.h>\n#include <string.h>\nint main(void){return 0;}\n`);
    const flags = ['-arch', 'arm64', '-g', `-I${path.join(SRC, '../include')}`, '-DNOTPARMDECL', '-DNO_TIMED_DELAY', '-w'];
    const { root } = await loadAst({ directory: path.relative(ROOT, dir) === '' ? '.' : dir, file: probe, arguments: ['clang', ...flags, '-c', probe] });
    const scope = tuScope(root, dir);
    // records from NetHack headers, named, at file scope
    const recs = [...scope.records.values()].filter((r) => !r.key.startsWith('@') && scope.recordPos.get(r.key)?.startsWith('tools/'));
    assert.ok(recs.length > 150, `${recs.length} records`);
    const lines = [];
    const expect = [];
    for (const r of recs) {
        const T = `${r.union ? 'union' : 'struct'} ${r.key}`;
        const L = scope.recordLayout(r.key);
        lines.push(`printf("R ${r.key} %zu %zu\\n", sizeof(${T}), _Alignof(${T}));`);
        expect.push(`R ${r.key} ${L.size} ${L.align}`);
        for (const f of L.fields) {
            if (!f.name) continue;
            if (f.bits === null) {
                lines.push(`printf("F ${r.key}.${f.name} %zu\\n", offsetof(${T}, ${f.name}));`);
                expect.push(`F ${r.key}.${f.name} ${f.offset}`);
            } else {
                lines.push(`{ ${T} x; unsigned char *b = (unsigned char *) &x; int i; memset(&x, 0, sizeof x); x.${f.name} = -1;`
                    + ` printf("B ${r.key}.${f.name}"); for (i = 0; i < (int) sizeof x; i++) if (b[i]) printf(" %d:%02x", i, b[i]); printf("\\n"); }`);
                const bytes = new Map();
                for (let k = 0; k < f.bits; k++) {
                    const bitpos = f.offset * 8 + f.bitOffset + k;
                    const byte = bitpos >> 3;
                    bytes.set(byte, (bytes.get(byte) || 0) | (1 << (bitpos & 7)));
                }
                expect.push(`B ${r.key}.${f.name}` + [...bytes].sort((a, b) => a[0] - b[0]).map(([i, v]) => ` ${i}:${v.toString(16).padStart(2, '0')}`).join(''));
            }
        }
    }
    writeFileSync(probe, `${incl}\n#include <stdio.h>\n#include <stddef.h>\n#include <string.h>\nint main(void){\n${lines.join('\n')}\nreturn 0;}\n`);
    const exe = path.join(dir, 'probe');
    execFileSync('clang', [...flags, '-o', exe, probe], { cwd: SRC });
    const got = execFileSync(exe).toString().trim().split('\n');
    const diffs = [];
    for (let i = 0; i < expect.length; i++) if (got[i] !== expect[i]) diffs.push(`C "${got[i]}" vs JS "${expect[i]}"`);
    assert.equal(got.length, expect.length);
    const n = (c) => expect.filter((e) => e[0] === c).length;
    console.log(`layout: ${n("R")} records, ${n("F")} fields, ${n("B")} bit-fields compared`);
    assert.ok(n("B") > 100, "bit-fields covered");
    assert.deepEqual(diffs.slice(0, 20), [], `${diffs.length} of ${expect.length} layout facts differ`);
});
