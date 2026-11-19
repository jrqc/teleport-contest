#!/usr/bin/env node
// tools/fuzz/inspect.mjs: what recorded sessions reached (checks that recipes do what
// they aim at): per segment, the deepest Dlvl on the status line, and whether the
// screens show bones being saved or loaded, a save, a restore, death, or a config error.
// Usage: node tools/fuzz/inspect.mjs rec.session.json ...
import { readFileSync } from 'node:fs';
import path from 'node:path';
const MARKS = { bonesSave: /Save bones\?/, bonesGet: /Get bones\?/, died: /You die|Die\?|killed by|Do you want your possessions identified/, saved: /Saving\.\.\.|Be seeing you/, restored: /Restoring save file|welcome back/i, cfgError: /error in .*nethackrc|Line \d+:/, gehennom: /Gehennom|Valley of the Dead/, hallu: /You feel/ };
const strip = (s) => s.replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(+n)).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][0-9A-Za-z]|[\x0e\x0f]/g, '');
for (const f of process.argv.slice(2)) {
    const s = JSON.parse(readFileSync(f, 'utf8'));
    const segs = s.segments.map((seg) => {
        let deepest = 0; const seen = new Set();
        for (const st of seg.steps) {
            const t = strip(st.screen || '');
            for (const m of t.matchAll(/Dlvl:(\d+)/g)) deepest = Math.max(deepest, +m[1]);
            for (const [k, re] of Object.entries(MARKS)) if (re.test(t)) seen.add(k);
        }
        return `${seg.steps.length} steps, Dlvl<=${deepest}${seen.size ? ', ' + [...seen].join(' ') : ''}`;
    });
    console.log(`${path.basename(f).replace('.session.json', '').padEnd(12)} ${segs.join(' || ')}`);
}
