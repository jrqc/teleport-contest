#!/usr/bin/env node
// tools/playcheck.mjs: interactive play (js/allmain.js NethackGame + moveloop_core) shows the
// recorded screens: after start() and after each moveloop_core() the display grid (chars and
// colors) and cursor must equal the session's next step. First segment of each session.
// Usage: node tools/playcheck.mjs [sessions/...json ...]   (default: all public sessions)
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { NethackGame, moveloop_core } = await import(path.join(ROOT, 'js/allmain.js'));
const { GameDisplay } = await import(path.join(ROOT, 'js/game_display.js'));
const { game } = await import(path.join(ROOT, 'js/gstate.js'));
const { decodeScreen } = await import(path.join(ROOT, 'frozen/screen-decode.mjs'));
const { DEC_TO_UNICODE } = await import(path.join(ROOT, 'js/terminal.js'));
const files = process.argv.slice(2).length ? process.argv.slice(2)
    : readdirSync(path.join(ROOT, 'sessions')).filter((f) => f.endsWith('.session.json')).sort().map((f) => path.join(ROOT, 'sessions', f));
let bad = 0;
for (const f of files) {
    const seg = JSON.parse(readFileSync(f, 'utf8')).segments[0];
    const d = new GameDisplay(null);
    for (const ch of seg.moves) d.pushKey(ch.charCodeAt(0));
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null };
    const g = new NethackGame({ seed: seg.seed, datetime: seg.datetime, nethackrc: seg.nethackrc, storage });
    g._pendingDisplay = d;
    await g.start();
    let firstBad = -1, n = 0;
    for (let i = 0; i < seg.steps.length; i++) {
        if (i > 0) { if (game.program_state.gameover) break; await moveloop_core(); }
        const want = decodeScreen(seg.steps[i].screen);
        let ok = true;
        for (let r = 0; r < 24 && ok; r++) for (let c = 0; c < 80 && ok; c++) {
            const w = want[r][c], h = d.grid[r][c];
            const wch = w.decgfx ? (DEC_TO_UNICODE[w.ch] ?? w.ch) : w.ch;
            if (wch !== h.ch || (w.ch !== ' ' && w.color !== h.color) || w.attr !== h.attr) ok = false;
        }
        const cur = seg.steps[i].cursor;
        if (cur && (cur[0] !== d.cursorCol || cur[1] !== d.cursorRow)) ok = false;
        n++;
        if (!ok && firstBad < 0) firstBad = i;
    }
    if (firstBad >= 0) bad++;
    console.log(`${firstBad < 0 ? 'ok  ' : 'BAD '} ${path.basename(f)}: ${n} steps${firstBad >= 0 ? `, first mismatch at step ${firstBad}` : ''}`);
}
console.log(`${files.length - bad}/${files.length} sessions: interactive screens equal the recording`);
process.exit(bad ? 1 : 0);
