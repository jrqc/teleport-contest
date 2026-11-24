// Summarize a V8 .cpuprofile (node --cpu-prof): self time per function and per module, all
// samples and only samples under a given function (default moveloop_core, the per-key path
// the playability runner times). Usage: node tools/analysis/cpuprof.mjs <file.cpuprofile> [root] [top]
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [file, rootName = 'moveloop_core', topN = '30'] = process.argv.slice(2);
const prof = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);
const dt = new Map();   // node id -> sampled microseconds
for (let i = 0; i < prof.samples.length; i++) dt.set(prof.samples[i], (dt.get(prof.samples[i]) || 0) + (prof.timeDeltas[i + 1] || prof.timeDeltas[i] || 0));
const under = new Map();   // node id -> is inside rootName
const isUnder = (id) => {
    if (under.has(id)) return under.get(id);
    const n = byId.get(id);
    const r = n.callFrame.functionName === rootName || (parent.has(id) ? isUnder(parent.get(id)) : false);
    under.set(id, r);
    return r;
};
const mod = (cf) => {
    if (!cf.url) return cf.functionName.startsWith('(') ? cf.functionName : '(native)';
    const u = cf.url.replace(/^file:\/\//, '');
    const m = /\/js\/(.*)$/.exec(u);
    return m ? `js/${m[1]}` : path.basename(u);
};
function report(filter, label) {
    const fn = new Map(), md = new Map();
    let total = 0;
    for (const [id, t] of dt) {
        if (!filter(id)) continue;
        const cf = byId.get(id).callFrame;
        const k = `${cf.functionName || '(anonymous)'}  ${mod(cf)}:${cf.lineNumber + 1}`;
        fn.set(k, (fn.get(k) || 0) + t);
        md.set(mod(cf), (md.get(mod(cf)) || 0) + t);
        total += t;
    }
    const pct = (t) => `${((100 * t) / total).toFixed(1).padStart(5)}%`;
    console.log(`\n== ${label}: ${(total / 1000).toFixed(0)} ms sampled ==`);
    console.log('-- self time by module --');
    for (const [k, t] of [...md].sort((a, b) => b[1] - a[1]).slice(0, Number(topN))) console.log(`${pct(t)}  ${(t / 1000).toFixed(0).padStart(6)} ms  ${k}`);
    console.log('-- self time by function --');
    for (const [k, t] of [...fn].sort((a, b) => b[1] - a[1]).slice(0, Number(topN))) console.log(`${pct(t)}  ${(t / 1000).toFixed(0).padStart(6)} ms  ${k}`);
}
report(() => true, 'all samples');
report((id) => isUnder(id), `under ${rootName}()`);
