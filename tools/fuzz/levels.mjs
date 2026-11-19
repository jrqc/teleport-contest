#!/usr/bin/env node
// tools/fuzz/levels.mjs: the levels a recorded session visits, as the port sees them
// (the recordings only show "Dlvl:N"; special levels need the game state). Replays each
// segment through js/nhprocess.js bootProcess with one shared storage, and at every key
// read samples u.uz: the dungeon's name, the level number, and the special level's
// prototype (dungeon.c Is_special), e.g. "The Dungeons of Doom:5 oracle".
// Prints a JSON array of the distinct labels in the order first visited.
// Usage: node tools/fuzz/levels.mjs rec.session.json
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const J = (p) => import(path.join(ROOT, 'js', p));
const { bootProcess } = await J('nhprocess.js');
const { u, svd, svs } = await J('nh/decl.js');
const { Is_special } = await J('nh/dungeon.js');
const { normalizeSession } = await import(path.join(ROOT, 'frozen/session_loader.mjs'));

const cstr = (a) => { let s = ''; for (const b of a) { if (!b) break; s += String.fromCharCode(b & 0xff); } return s; };
export async function levels(file) {
    const s = normalizeSession(JSON.parse(readFileSync(file, 'utf8')));
    const store = new Map();
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null, clear: () => store.clear() };
    const seen = [];
    for (const seg of s.segments) {
        let starved;
        const st = new Promise((res) => { starved = res; });
        const p = bootProcess({
            seed: seg.seed, datetime: seg.datetime, nethackrc: seg.nethackrc, storage,
            keys: (seg.moves ?? '').replace(/\r/g, '\n'), onStarve: () => starved(),
            onMarker: (m) => {
                // skip key reads before the dungeon exists or while a restore has u.uz but not yet the special-level chain
                if (m.kind !== 'input' || u.uz.dlevel <= 0 || !svs.sp_levchn) return;
                const d = svd.dungeons[u.uz.dnum], sp = Is_special(u.uz);
                const label = `${cstr(d.dname)}:${u.uz.dlevel}${sp ? ' ' + cstr(sp.proto) : ''}`;
                if (!seen.includes(label)) seen.push(label);
            },
        });
        await Promise.race([p.done, st]);
    }
    return seen;
}
if (import.meta.url === `file://${process.argv[1]}`) { globalThis.__nhQuiet = true; console.log(JSON.stringify(await levels(process.argv[2]))); }
