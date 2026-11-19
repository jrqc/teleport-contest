// Our own recorded sessions (CLAUDE.md 4.4): tests/sessions/*.session.json, recorded by
// the reference recorder from the .recipe.json next to each (tools/recorder-env/
// record-session.mjs with RERECORD_CANON_HOME=1). Each must pass completely under the
// frozen runner, as a public session must. Most are regression cases found by
// tools/fuzz/run.mjs, reduced by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'tests/sessions');
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.session.json')).sort()) {
    test(`own session ${f}`, () => {
        const c = spawnSync(process.execPath, [path.join(ROOT, 'frozen/ps_test_runner.mjs'), `--worker-session=${path.join(DIR, f)}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
        const i = c.stdout.lastIndexOf('__RESULT_ONE__');
        assert.ok(i >= 0, `runner: ${c.stderr.slice(-400)}`);
        const m = JSON.parse(c.stdout.slice(i + 14)).metrics;
        assert.equal(`${m.screens.matched}/${m.screens.total} screens, ${m.rngCalls.matched}/${m.rngCalls.total} rng`, `${m.screens.total}/${m.screens.total} screens, ${m.rngCalls.total}/${m.rngCalls.total} rng`);
    });
}
