// js/nhmain.js: glue between the contest API and the transpiled NetHack
// (transpiler-design.md 8.3). Hand-written; replaces the template's jsmain.js
// once the generated build runs end to end (decision D5).
//
// One segment = one run of the recorder's process: reset all module state,
// install the recorder's environment, run main("nethack", "-u", name), and
// collect what the recorder collected:
//   - screens and cursors from the in-band OSC 7777 markers the patched tty
//     port writes to stdout at every input boundary (NOMUX_MARKERS=1), encoded
//     exactly as tools/recorder-env/record-session.mjs encodes them;
//   - RNG calls from the NETHACK_RNGLOG file the patched rnd.c writes
//     (parseRngLines), without the "@ caller" tag; the full lines are kept as
//     a debug log for triage.
// The segment ends when the program waits for a key and none is left, or exits.
import * as $c from './crt/index.js';
import { game as gstate } from './gstate.js';
import { $initAll } from './nh/index.js';
import { main } from './nh/unixmain.js';
import { files as dataFiles, dirs as dataDirs } from './data/index.js';

// The recorder environment (docs/recording-environment.md, record-session.mjs recordSegment)
export const HOME = '/Users/davidbau/git/mazesofmenace/teleport/maud/test/comparison/c-harness/results';
export const HACKDIR = '/Users/davidbau/git/mazesofmenace/teleport/nethack-c/recorder/install/games/lib/nethackdir';
const RNGLOG = '/dev/nethack-rnglog';

function parseNethackrcName(rc) {
    if (!rc) return null;
    for (const rawLine of rc.split('\n')) {
        const line = rawLine.trim();
        const upper = line.toUpperCase();
        if (!(upper.startsWith('OPTIONS=') || upper.startsWith('OPTIONS ='))) continue;
        for (const opt of line.slice(line.indexOf('=') + 1).split(',')) {
            const t = opt.trim();
            if (t.toLowerCase().startsWith('name:')) return t.slice('name:'.length).trim();
        }
    }
    return null;
}

// ---------- screen encoding: record-session.mjs encodeScreenAnsiRle(payloadToLines(p)) ----------
function compressAnsiLine(line) {
    let out = '', i = 0;
    while (i < line.length) {
        if (line[i] === ' ') {
            const start = i;
            while (i < line.length && line[i] === ' ') i++;
            const run = i - start;
            out += run >= 5 ? `\x1b[${run}C` : ' '.repeat(run);
        } else out += line[i++];
    }
    return out;
}
function encodeScreen(payload) {
    const lines = payload.split('\n');
    while (lines.length < 24) lines.push('');
    const compressed = lines.slice(0, 24).map((l) => compressAnsiLine(l.replace(/ +$/u, '')));
    while (compressed.length && compressed[compressed.length - 1] === '') compressed.pop();
    return compressed.join('\n');
}

/** Incremental parser for ESC ] 7777 ; KIND=k;SEQ=n;ANIM=a;CX=x;CY=y;LEN=L BEL <L bytes>. */
class MarkerParser {
    constructor(onMarker) { this.buf = new Uint8Array(0); this.onMarker = onMarker; this.dec = new TextDecoder('utf-8'); }
    push(bytes) {
        const b = new Uint8Array(this.buf.length + bytes.length);
        b.set(this.buf); b.set(bytes, this.buf.length);
        this.buf = b;
        for (;;) {
            const start = this.find();
            if (start < 0) { this.buf = this.buf.subarray(Math.max(0, this.buf.length - 7)); return; }
            const bel = this.buf.indexOf(7, start);
            if (bel < 0) { this.buf = this.buf.subarray(start); return; }
            const header = String.fromCharCode(...this.buf.subarray(start + 7, bel));
            const m = {};
            for (const kv of header.split(';')) { const [k, v] = kv.split('='); m[k] = v; }
            const len = Number(m.LEN);
            if (this.buf.length < bel + 1 + len) { this.buf = this.buf.subarray(start); return; }
            const payload = this.dec.decode(this.buf.subarray(bel + 1, bel + 1 + len));
            this.buf = this.buf.subarray(bel + 1 + len);
            this.onMarker({ kind: m.KIND, seq: Number(m.SEQ), cx: Number(m.CX), cy: Number(m.CY), payload });
        }
    }
    find() {
        const b = this.buf;
        for (let i = 0; i + 6 < b.length; i++) {
            if (b[i] === 0x1b && b[i + 1] === 0x5d && b[i + 2] === 0x37 && b[i + 3] === 0x37 && b[i + 4] === 0x37 && b[i + 5] === 0x37 && b[i + 6] === 0x3b) return i;
        }
        return -1;
    }
}

class SegmentGame {
    constructor() { this.screens = []; this.cursors = []; this.anim = []; this.rng = []; this.rngDebug = []; this.error = null; this.exitStatus = null; }
    getScreens() { return this.screens; }
    getCursors() { return this.cursors; }
    getRngLog() { return this.rng; }
    getRngDebugLog() { return this.rngDebug; }
    getAnimationFramesByStep() { return this.anim; }
    async animationFrame() { /* frames come from the C markers */ }
}

export async function runSegment(input, _prevGame = null) {
    const g = new SegmentGame();
    const moves = (input.moves ?? '').replace(/\r/g, '\n');   // tmux's ICRNL, as record-session.mjs does
    const expected = moves.length + 1;
    let pendingAnim = [];
    const parser = new MarkerParser((m) => {
        if (m.kind === 'anim') { pendingAnim.push({ screen: encodeScreen(m.payload), cursor: [m.cx, m.cy, 1] }); return; }
        if (m.kind !== 'input' || g.screens.length >= expected) return;
        g.screens.push(encodeScreen(m.payload));
        g.cursors.push([m.cx, m.cy, 1]);
        g.anim.push(pendingAnim);
        pendingAnim = [];
    });
    let rngText = '';
    const rngSink = (bytes) => {
        rngText += String.fromCharCode(...bytes);
        let nl;
        while ((nl = rngText.indexOf('\n')) >= 0) {
            const line = rngText.slice(0, nl).trimEnd();
            rngText = rngText.slice(nl + 1);
            if (!line || '<>^'.includes(line[0])) continue;
            const sp = line.indexOf(' ');
            if (sp < 0) continue;
            const rest = line.slice(sp + 1).replace(' = ', '=');
            g.rngDebug.push(rest);
            const at = rest.indexOf(' @ ');
            g.rng.push(at >= 0 ? rest.slice(0, at) : rest);
        }
    };

    // ---- a fresh process ----
    gstate.mockStorage = input.storage || null;
    $c.resetStdio();
    $c.resetFs();
    $c.mountData(HACKDIR, dataFiles);
    for (const d of dataDirs) $c.mountData(`${HACKDIR}/${d}`, []);
    $c.mountData(HOME, []);
    $c.mountDevice(RNGLOG, rngSink);
    $c.putFile(`${HOME}/.nethackrc`, input.nethackrc || '');
    let starved;
    const starvedP = new Promise((res) => { starved = res; });
    $c.resetProcess({
        env: {
            HOME, TERM: 'xterm-256color', TZ: 'America/New_York', USER: 'davidbau', LOGNAME: 'davidbau',
            NETHACKDIR: HACKDIR, HACKDIR, NETHACK_NO_DELAY: '1',
            NETHACK_SEED: String(input.seed ?? 0), NETHACK_FIXED_DATETIME: input.datetime || '20000110090000',
            NETHACK_RNGLOG: RNGLOG, NOMUX_MARKERS: '1', NETHACK_RAW_KEYS: '1',
        },
        keys: moves, cwd: HOME, onStarve: () => starved(),
    });
    $c.setSink($c.stdout, (b) => parser.push(b));
    $c.setSink($c.stderr, null);
    $initAll();

    const name = parseNethackrcName(input.nethackrc) ?? '';
    const args = [`${HACKDIR}/nethack`, '-u', name];
    const argv = new $c.Ptr([...args.map((s) => $c.lit(s)), null], 0);
    const run = main(args.length, argv).then(
        (status) => { g.exitStatus = status; },
        (e) => { if (e instanceof $c.ProcessExit) g.exitStatus = e.status; else g.error = e; });
    await Promise.race([run, starvedP]);
    if (rngText) rngSink(Uint8Array.of(10));
    if (g.error && !globalThis.__nhQuiet) console.error('[nhmain] ' + (g.error.stack || g.error));
    return g;
}
