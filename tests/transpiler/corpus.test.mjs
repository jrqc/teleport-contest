// Transpiler differential tests (tool 4.5): every tests/c-diff/corpus/*.c program
// must print the same bytes and exit with the same status as native clang.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare } from './corpus-harness.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../c-diff/corpus');
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.c')).sort()) {
    test(`corpus ${f}`, { timeout: 120000 }, async () => {
        const r = await compare(path.join(DIR, f));
        assert.deepEqual(r.errors, []);
        assert.equal(r.js.out, r.native.out);
        assert.equal(r.js.status & 255, r.native.status & 255);
    });
}
