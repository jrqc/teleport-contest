// Differential test: js/crt/time.js against Darwin localtime/mktime, TZ=America/New_York
// (tests/c-diff/time/time-ref.c).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localtime, mktime, Tm, time, REAL_NOW } from '../../js/crt/time.js';
import { cstrToJs, Ptr } from '../../js/crt/mem.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fields = (t) => [t.tm_sec, t.tm_min, t.tm_hour, t.tm_mday, t.tm_mon, t.tm_year, t.tm_wday, t.tm_yday,
    t.tm_isdst, t.tm_gmtoff, t.tm_zone ? cstrToJs(t.tm_zone) : '(null)'].join(' ');

test('localtime and mktime match Darwin in America/New_York, 1955-2100', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'time-'));
    const exe = path.join(dir, 'time-ref');
    execFileSync('clang', ['-arch', 'arm64', '-O0', '-o', exe, path.join(HERE, '../c-diff/time/time-ref.c')]);
    const lines = execFileSync(exe, { env: { ...process.env, TZ: 'America/New_York' }, maxBuffer: 1 << 28 })
        .toString().trim().split('\n');
    const fails = [];
    let nL = 0, nM = 0;
    for (const l of lines) {
        if (l.startsWith('L ')) {
            const [, t, ...want] = l.split(' ');
            const got = fields(localtime(new Ptr([Number(t)], 0)));   // localtime(&t)
            if (got !== want.join(' ')) fails.push(`${l}\n   JS ${got}`);
            nL++;
        } else {
            const [inp, out] = l.slice(2).split(' -> ');
            const [sec, min, hour, mday, mon, year, isdst] = inp.split(' ').map(Number);
            const tm = Object.assign(new Tm(), { tm_sec: sec, tm_min: min, tm_hour: hour, tm_mday: mday, tm_mon: mon, tm_year: year, tm_isdst: isdst });
            const t = mktime(tm);
            const got = `${t} ${fields(tm)}`;
            if (got !== out) fails.push(`${l}\n   JS ${got}`);
            nM++;
        }
    }
    assert.ok(nL > 20000 && nM > 20000, `${nL} localtime, ${nM} mktime cases`);
    assert.deepEqual(fails.slice(0, 10), [], `${fails.length} of ${lines.length} differ`);
});

test('time() is the recorder pinned now and stores through tloc', () => {
    let stored;
    assert.equal(time(null), REAL_NOW);
    assert.equal(time({ set: (i, v) => { assert.equal(i, 0); stored = v; } }), REAL_NOW);
    assert.equal(stored, 1777723200);
});

test('the tm_isdst quirk: a pinned winter noon read as daylight time is 11:00 EST', () => {
    const tm = Object.assign(new Tm(), { tm_year: 100, tm_mon: 0, tm_mday: 10, tm_hour: 12, tm_isdst: 1 });
    mktime(tm);
    assert.equal(tm.tm_hour, 11);
    assert.equal(tm.tm_isdst, 0);
});
