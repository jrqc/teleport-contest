// T1 (postmortem F1): the recorder's screen capture (patch 006, transpiled into
// js/nh/termcap.js) must hold the most expensive screen the shadow buffer can
// describe. Every cell alternates between "all attributes, bright color, DEC
// graphics" and "plain, other color, ASCII", which forces the most SGR and
// shift sequences per cell. The old 24*256-byte buffer overflowed on such
// screens (upstream 6ee30e6: Gehennom lava/water maps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { nomux_buf, nomux_capture_screen } from '../../js/nh/termcap.js';

test('worst-case capture fits the capture buffer', () => {
    for (let r = 0; r < 24; r++) for (let c = 0; c < 80; c++) {
        const cell = nomux_buf[r][c], odd = (r + c) & 1;
        cell.ch = odd ? 113 /* q */ : 35 /* # */;
        cell.fg = odd ? 9 + (c % 7) : 1 + (c % 6);
        cell.attr = odd ? 0 : 7;
        cell.decgfx = odd ? 0 : 1;
    }
    const p = nomux_capture_screen();
    let n = 0;
    while (p.buf[p.off + n] !== 0) n++;
    assert.ok(n > 24 * 256, `the test screen must exceed the old buffer (got ${n} bytes)`);
    assert.ok(n < p.buf.length, `capture of ${n} bytes in a ${p.buf.length}-byte buffer`);
});
