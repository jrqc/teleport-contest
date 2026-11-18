// Heap-world Lua differential test (tool 4.5): tests/c-diff/lua/driver.c with
// the recorder's Lua sources, native clang vs transpiled (lua-harness.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT } from '../../transpiler/frontend/ast.mjs';
import { build, runNative, runJs } from './lua-harness.mjs';

test('Lua 5.4.8 in the heap world matches native', { timeout: 300000 }, async () => {
    const b = await build(path.join(ROOT, 'transpiler/build/luatest'), { tag: 'test' });
    assert.deepEqual(b.errors, []);
    const n = runNative(b.exe), j = await runJs(b.out);
    assert.equal(j.out, n.out);
});
