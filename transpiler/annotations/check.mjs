// check.mjs: annotation checker (tool 4.8, transpiler-design.md 9.3).
//
//   node transpiler/annotations/check.mjs      check transpiler/annotations.jsonc
//
// checkAnnotations(ann, facts) is pure (tests feed it synthetic facts); the CLI
// loads the facts from transpiler/out/. Failures exit 1.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './jsonc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TREE = path.join(ROOT, 'tools/recorder-env/build/nethack-c/recorder');
const TOP_KEYS = ['groups', 'types', 'functions', 'pointers', 'edges'];
const GROUP_REPRS = ['heap', 'extern'];
const TYPE_REPRS = ['object', 'heap', 'union-cell'];
const RAW_EVIDENCE = ['mem-raw', 'cast', 'offsetof'];   // union, save-io: decided by rules (3.4, 3.6)

/** sha256 of a function's source lines, to detect C changes under a hand-written override. */
export function functionHash(lines) {
    return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/**
 * facts: {
 *   functions: {key: {name, file, line, endLine, calls[]}},   // callgraph nodes
 *   records: {key: "file:line"},                                // heap.json recordFiles
 *   evidence: {key: {kind: [...]}},                             // heap.json evidence
 *   unions: {key: {verdict, file}},                             // union-pun.json
 *   macros: Set<name>,
 *   unresolvedIndirect: {desc: count},                          // async.json
 *   icallDescs: Set<desc>,                                      // every indirect call desc
 *   asyncSize, sourceLines(file, line, endLine) -> string[], fileExists(rel) -> bool
 * }
 * Returns { errors[], warnings[], summary }.
 */
export function checkAnnotations(ann, facts) {
    const errors = [], warnings = [];
    const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
    const needWhy = (where, e) => { if (!e || typeof e.why !== 'string' || !e.why.trim()) err(`${where}: missing "why"`); };

    for (const k of Object.keys(ann)) if (!TOP_KEYS.includes(k)) err(`unknown top-level key "${k}"`);
    const groups = ann.groups || {}, types = ann.types || {}, fns = ann.functions || {};
    const ptrs = ann.pointers || {}, cuts = (ann.edges && ann.edges.cut) || [];
    const fnFiles = new Set(Object.values(facts.functions).map((f) => f.file));
    const fnByKey = facts.functions;
    const inGroup = (file, repr) => Object.values(groups).some((g) => g && (!repr || g.repr === repr) && file.startsWith(g.files));

    // groups
    for (const [name, g] of Object.entries(groups)) {
        needWhy(`groups.${name}`, g);
        if (!GROUP_REPRS.includes(g.repr)) err(`groups.${name}: repr "${g.repr}" not one of ${GROUP_REPRS.join(', ')}`);
        if (typeof g.files !== 'string' || ![...fnFiles].some((f) => f.startsWith(g.files))) err(`groups.${name}: stale, no analyzed file matches "${g.files}"`);
        if (g.defines !== undefined && !(Array.isArray(g.defines) && g.defines.every((d) => typeof d === 'string' && /^-D\w+(=.*)?$/.test(d)))) err(`groups.${name}: "defines" must be a list of -DNAME[=value]`);
        if (g.repr === 'extern') {
            if (!g.module || !facts.fileExists(g.module)) err(`groups.${name}: extern module "${g.module}" does not exist`);
            if (!g.adapter) err(`groups.${name}: extern group needs an "adapter"`);
            else if (!facts.fileExists(g.adapter)) warn(`groups.${name}: adapter ${g.adapter} not written yet`);
        }
    }

    // types
    for (const [key, t] of Object.entries(types)) {
        needWhy(`types["${key}"]`, t);
        if (!Object.hasOwn(facts.records, key)) { err(`types["${key}"]: stale, no such record`); continue; }
        if (!TYPE_REPRS.includes(t.repr)) err(`types["${key}"]: repr "${t.repr}" not one of ${TYPE_REPRS.join(', ')}`);
        if (t.tail) {
            for (const m of ['alloc', 'space']) {
                const n = t.tail[m];
                if (!n || !(facts.macros.has(n) || Object.values(fnByKey).some((f) => f.name === n))) err(`types["${key}"].tail.${m}: stale, no macro or function "${n}"`);
            }
        }
        if (key.startsWith('union ') && t.repr === 'object') {
            const u = facts.unions[key];
            if (u && u.verdict !== 'object' && !(t.discriminant && t.approved === true)) {
                err(`types["${key}"]: "object" for a union the punning check does not prove free of punning needs "discriminant" and owner "approved": true`);
            }
        }
    }

    // every record with raw-memory evidence outside heap groups needs a decision
    for (const [key, ev] of Object.entries(facts.evidence)) {
        const file = (facts.records[key] || '').replace(/:\d+$/, '');
        if (inGroup(file, 'heap') || inGroup(file, 'extern')) continue;
        const kinds = RAW_EVIDENCE.filter((k) => ev[k]);
        if (kinds.length && !Object.hasOwn(types, key)) err(`${key} (${facts.records[key]}): raw-memory evidence (${kinds.join(', ')}) without a decision`);
    }

    // functions
    let handLines = 0;
    for (const [key, f] of Object.entries(fns)) {
        needWhy(`functions["${key}"]`, f);
        const node = fnByKey[key];
        if (!node) { err(`functions["${key}"]: stale, no such function`); continue; }
        if (f.handwritten) {
            if (!facts.fileExists(f.handwritten)) err(`functions["${key}"]: ${f.handwritten} does not exist`);
            else handLines += facts.countLines(f.handwritten);
            const h = functionHash(facts.sourceLines(node.file, node.line, node.endLine));
            if (f.csha !== h) err(`functions["${key}"]: C source changed or "csha" missing (current ${h}); review ${f.handwritten}`);
        }
    }

    // indirect calls
    for (const desc of Object.keys(facts.unresolvedIndirect)) if (!Object.hasOwn(ptrs, desc)) err(`indirect call ${desc}: unresolved, needs pointers["${desc}"].targets`);
    for (const [desc, p] of Object.entries(ptrs)) {
        needWhy(`pointers["${desc}"]`, p);
        if (!facts.icallDescs.has(desc)) err(`pointers["${desc}"]: stale, no such indirect call`);
        for (const t of (p && p.targets) || []) if (!fnByKey[t]) err(`pointers["${desc}"]: stale target ${t}`);
    }

    // edge cuts
    for (const c of cuts) {
        needWhy(`edges.cut ${c.from} -> ${c.to}`, c);
        const n = fnByKey[c.from];
        if (!n || !fnByKey[c.to]) err(`edges.cut ${c.from} -> ${c.to}: stale function`);
        else if (!n.calls.includes(c.to)) err(`edges.cut ${c.from} -> ${c.to}: stale, no such call`);
    }

    // summary: effective decisions
    const unionRows = Object.entries(facts.unions).map(([k, u]) => {
        const lua = inGroup(u.file, 'heap');
        const t = types[k];
        return [k, lua ? 'heap (group)' : (t ? `${t.repr} (annotation)` : `${u.verdict} (punning check)`)];
    });
    const recordRows = Object.entries(types).filter(([k]) => !k.startsWith('union ')).map(([k, t]) => [k, t.repr + (t.tail ? ' + tail' : '')]);
    const heapGroupRecords = Object.entries(facts.records).filter(([, f]) => inGroup(f.replace(/:\d+$/, ''), 'heap')).length;
    return { errors, warnings, summary: { unionRows, recordRows, heapGroupRecords, asyncSize: facts.asyncSize, handLines } };
}

export function loadFacts() {
    const out = (p) => JSON.parse(readFileSync(path.join(ROOT, 'transpiler/out', p), 'utf8'));
    const cg = out('inventory/callgraph.json');
    const heap = out('inventory/heap.json');
    const asy = out('inventory/async.json');
    const icallDescs = new Set();
    for (const n of Object.values(cg.nodes)) for (const k of Object.keys(n.icalls)) icallDescs.add(k);
    const srcCache = new Map();
    return {
        functions: cg.nodes,
        records: heap.recordFiles,
        evidence: heap.evidence,
        unions: out('union-pun.json'),
        macros: new Set(out('inventory/macros.json').map((m) => m.name)),
        unresolvedIndirect: asy.unresolvedIndirect,
        icallDescs,
        asyncSize: asy.input.size,
        fileExists: (rel) => existsSync(path.join(ROOT, rel)),
        countLines: (rel) => readFileSync(path.join(ROOT, rel), 'utf8').split('\n').length,
        sourceLines: (file, line, endLine) => {
            if (!srcCache.has(file)) srcCache.set(file, readFileSync(path.join(TREE, file), 'utf8').split('\n'));
            return srcCache.get(file).slice(line - 1, endLine || line);
        },
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const ann = parseJsonc(readFileSync(path.join(ROOT, 'transpiler/annotations.jsonc'), 'utf8'));
    const { errors, warnings, summary } = checkAnnotations(ann, loadFacts());
    console.log('Unions:');
    for (const [k, d] of summary.unionRows) console.log(`  ${k.padEnd(48)} ${d}`);
    console.log('Annotated records:');
    for (const [k, d] of summary.recordRows) console.log(`  ${k.padEnd(48)} ${d}`);
    console.log(`Records in heap groups (Lua): ${summary.heapGroupRecords}`);
    console.log(`Async set: ${summary.asyncSize} functions; hand-written override lines: ${summary.handLines}`);
    for (const w of warnings) console.log(`WARN  ${w}`);
    for (const e of errors) console.log(`ERROR ${e}`);
    console.log(errors.length ? `FAIL: ${errors.length} error(s)` : 'OK');
    process.exit(errors.length ? 1 : 0);
}
