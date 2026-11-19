// tools/fuzz/gen.mjs: random recipes (postmortem T3 option fuzzing + T2 random play).
// A recipe is a v5 session without steps: segments[] of {seed, datetime, nethackrc,
// moves}. tools/fuzz/run.mjs records it with the reference recorder and scores
// the port on the recording.
//
// Kinds (each aims at a postmortem area; any kind may hit any other):
//   opts   random nethackrc (T3, F7, F2): booleans, compound options, MENUCOLOR,
//          MSGTYPE, AUTOPICKUP_EXCEPTION, BIND, SYMBOLS, symsets, number_pad
//   play   weighted command grammar with prompt answers (T2), meta keys (F4)
//   deep   wizard mode: level teleports (^V) deep into the Dungeons, Gehennom and
//          the branches, maps (^F), wishes, walking (F14)
//   bones  segment 1 dies on a level (wizard mode, "Save bones?" y); segment 2,
//          a new game, goes to that level and loads them ("Get bones?" y) (F3)
//   saves  play, save (S y), restore in the next segment, play on, save again (F13)
//   long   one long normal game, 2000-4000 keys, descending often (F15, T6)
//   special wizard mode: ^V ? (the special-level menu) and a random entry: Sokoban,
//          Minetown, Oracle, quest, big room, ...; play, save there, restore, play,
//          save again (F13 on special levels, T6)
//   meta   altmeta on: every meta command as ESC + key and as an 8-bit byte, with its
//          prompts answered, ESC before digits, counts and directions, BIND=M-x,
//          number_pad variants (F4)
//   longopts one long game (1500-3000 keys) under random options (T3 + T6)
// Everything is a function of the case seed: gen(kind, seed) is deterministic.

export function rng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
    const r = {
        int: (n) => next() % n,
        pick: (a) => a[next() % a.length],
        chance: (p) => next() / 0x100000000 < p,
        // weighted: [[w, value], ...]
        wpick: (ws) => { let t = 0; for (const [w] of ws) t += w; let x = next() % t; for (const [w, v] of ws) { if (x < w) return v; x -= w; } return ws[0][1]; },
    };
    return r;
}

// role, race, gender, alignment combinations NetHack allows (role.c roles[] / races[])
const ROLES = {
    Archeologist: { races: ['human', 'dwarf', 'gnome'], aligns: ['lawful', 'neutral'] },
    Barbarian: { races: ['human', 'orc'], aligns: ['neutral', 'chaotic'] },
    Caveman: { races: ['human', 'dwarf', 'gnome'], aligns: ['lawful', 'neutral'] },
    Healer: { races: ['human', 'gnome'], aligns: ['neutral'] },
    Knight: { races: ['human'], aligns: ['lawful'] },
    Monk: { races: ['human'], aligns: ['lawful', 'neutral', 'chaotic'] },
    Priest: { races: ['human', 'elf'], aligns: ['lawful', 'neutral', 'chaotic'] },
    Rogue: { races: ['human', 'orc'], aligns: ['chaotic'] },
    Ranger: { races: ['human', 'elf', 'gnome', 'orc'], aligns: ['neutral', 'chaotic'] },
    Samurai: { races: ['human'], aligns: ['lawful'] },
    Tourist: { races: ['human'], aligns: ['neutral'] },
    Valkyrie: { races: ['human', 'dwarf'], aligns: ['lawful', 'neutral'], genders: ['female'] },
    Wizard: { races: ['human', 'elf', 'gnome', 'orc'], aligns: ['neutral', 'chaotic'] },
};
const RACE_ALIGN = { human: null, dwarf: ['lawful'], gnome: ['neutral'], elf: ['chaotic'], orc: ['chaotic'] };
const NAMES = ['Ada', 'Bram', 'Cora', 'Dov', 'Esme', 'Finn', 'Gale', 'Hugo', 'Ines', 'Jory', 'Kit', 'Lev', 'Mira', 'Nils', 'Oona', 'Pim', 'Quin', 'Rhea', 'Sol', 'Tam'];

function character(r) {
    for (;;) {
        const role = r.pick(Object.keys(ROLES)), R = ROLES[role];
        const race = r.pick(R.races);
        const aligns = R.aligns.filter((a) => !RACE_ALIGN[race] || RACE_ALIGN[race].includes(a));
        if (!aligns.length) continue;
        const gender = R.genders ? r.pick(R.genders) : r.pick(['male', 'female']);
        return { name: r.pick(NAMES), role, race, gender, align: r.pick(aligns) };
    }
}
function datetime(r) {
    const y = 2000 + r.int(27), mo = 1 + r.int(12), d = 1 + r.int(28), h = r.int(24), mi = r.int(60);
    const p = (n) => String(n).padStart(2, '0');
    return `${y}${p(mo)}${p(d)}${p(h)}${p(mi)}00`;
}

// ---------- options (T3) ----------
const BOOLEANS = ['autodig', 'autoopen', 'autopickup', 'autoquiver', 'bones', 'checkpoint', 'cmdassist', 'color',
    'confirm', 'dark_room', 'fixinv', 'help', 'hilite_pet', 'hilite_pile', 'implicit_uncursed', 'legacy', 'lit_corridor',
    'lootabc', 'mail', 'mention_walls', 'menucolors', 'null', 'pickup_thrown', 'pushweapon', 'rest_on_space', 'safe_pet',
    'showexp', 'showrace', 'silent', 'sortpack', 'sparkle', 'standout', 'time', 'tombstone', 'travel', 'verbose',
    'tutorial', 'autodescribe', 'mention_decor', 'showscore', 'splash_screen', 'quick_farsight', 'nudist', 'blind'];
const COMPOUND = [
    () => 'pickup_types:' + ['$', '$?!/="+', '$?!', 'all', '()[%'][0],
    (r) => 'pickup_types:' + r.pick(['$', '$?!/="+', '$?!', '`', '()[%']),
    (r) => 'menustyle:' + r.pick(['traditional', 'combination', 'full', 'partial']),
    (r) => 'runmode:' + r.pick(['teleport', 'run', 'walk', 'crawl']),
    (r) => 'disclose:' + r.pick(['yi ya yv yg yc yo', '-i -a -v -g -c -o', 'ni na nv ng nc no', '+i +a']),
    (r) => 'fruit:' + r.pick(['mango', 'kumquat', 'slime mold', 'durian']),
    (r) => 'number_pad:' + r.pick(['0', '1', '2', '3', '4', '-1']),
    (r) => 'msg_window:' + r.pick(['s', 'c', 'f', 'r']),
    (r) => 'msghistory:' + r.pick(['5', '20', '60']),
    (r) => 'symset:' + r.pick(['DECgraphics', 'IBMgraphics', 'plain', 'curses', 'Enhanced1', 'DECgraphics']),
    (r) => 'roguesymset:' + r.pick(['RogueEpyx', 'RogueIBM', 'RogueWindows']),
    (r) => 'sortloot:' + r.pick(['full', 'loot', 'none']),
    (r) => 'pile_limit:' + r.pick(['0', '1', '5']),
    (r) => 'paranoid_confirmation:' + r.pick(['quit', 'pray', 'attack', 'wand-break', 'Remove', 'quit die attack pray']),
    (r) => 'whatis_coord:' + r.pick(['none', 'compass', 'map', 'screen']),
    (r) => 'boulder:' + r.pick(['0', '`', '8']),
    (r) => 'statushilites:' + r.pick(['0', '2', '10']),
    (r) => 'hilite_status:' + r.pick(['hitpoints/<50%/red', 'gold/always/yellow', 'hunger/always/inverse', 'experience-level/changed/green/bold', 'hitpoints/up/green&bold']),
    (r) => 'packorder:' + r.pick(['")[%?+!=/(*`0_', '$?!/="+%)[(']),
    (r) => 'scores:' + r.pick(['3 top/2 around', 'own', '10 top']),
    (r) => 'altmeta',
    (r) => '!altmeta',
    (r) => 'menu_headings:' + r.pick(['bold', 'inverse', 'underline']),
    (r) => 'petattr:' + r.pick(['bold', 'inverse', 'underline']),
    (r) => 'mouse_support:0',
    (r) => 'suppress_alert:3.4.3',
    (r) => 'dogname:' + r.pick(['Rex', 'Fido']),
    (r) => 'catname:' + r.pick(['Tom', 'Felix']),
    (r) => 'horsename:Silver',
    (r) => 'pettype:' + r.pick(['cat', 'dog', 'horse', 'none']),
    (r) => 'versinfo:' + r.pick(['1', '2', '4']),
    (r) => r.pick(['unknownopt', 'menustyle:bogus', 'number_pad:9']),   // error paths
];
const LINES = [
    (r) => `MENUCOLOR=${r.pick(['"blessed"=green', '" cursed"=red', '"uncursed"=white&bold', '"(being worn)"=cyan', '"^[a-z] - .*wand"=magenta', '"loadstone|luckstone"=yellow&inverse', '"[0-9]+ gold"=yellow', '"(weapon|wielded)( in hand)?"=brown', '"bad[pattern"=red'])}`,
    (r) => `MSGTYPE=${r.pick(['hide', 'norep', 'show', 'stop'])} ${r.pick(['"You see here .*"', '"You hear .*"', '"The .* misses"', '"You displace .*"', '"(unclosed"'])}`,
    (r) => `AUTOPICKUP_EXCEPTION=${r.pick(['"<*gold*"', '">*corpse"', '"<.*wand.*"', '">*boulder"', '"<[a-z]+ ring"'])}`,
    (r) => `BIND=${r.pick(['v:inventory', '^X:attributes', 'M-p:pray', 'Q:quit', 'x:search', '\\:discoveries'])}`,
    (r) => `SYMBOLS=${r.pick(['S_pool:~', 'S_fountain:{', 'S_boulder:0', 'S_vwall:|,S_hwall:-', 'S_room:.'])}`,
];
function nethackrc(r, ch, extra = []) {
    const lines = [`OPTIONS=name:${ch.name},role:${ch.role},race:${ch.race},gender:${ch.gender},align:${ch.align}`];
    lines.push(...extra);
    return lines.join('\n') + '\n';
}
function randomOptions(r) {
    const out = [];
    const n = 2 + r.int(10);
    const bools = [];
    for (let i = 0; i < n; i++) bools.push((r.chance(0.5) ? '!' : '') + r.pick(BOOLEANS));
    out.push('OPTIONS=' + bools.join(','));
    const m = 1 + r.int(6);
    for (let i = 0; i < m; i++) out.push('OPTIONS=' + r.pick(COMPOUND)(r));
    const k = r.int(5);
    for (let i = 0; i < k; i++) out.push(r.pick(LINES)(r));
    if (r.chance(0.8)) out.push('OPTIONS=!tutorial');
    return out;
}

// ---------- key grammar (T2) ----------
const DIRS = 'hjklyubn', RUN = 'HJKLYUBN';
const letter = (r) => r.pick('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$-*?'.split(''));
const answer = (r) => r.wpick([[6, ' '], [3, '\x1b'], [3, '\r'], [3, 'y'], [2, 'n'], [3, letter(r)], [1, 'q']]);
function command(r, o) {
    const dir = () => r.pick([...DIRS, '<', '>', '.']);
    return r.wpick([
        [30, () => r.pick(DIRS)],
        [6, () => r.pick(RUN)],
        [3, () => 'G' + r.pick(DIRS)],
        [3, () => String(2 + r.int(20)) + r.pick(['s', ...DIRS])],
        [6, () => 's'],
        [3, () => ','],
        [2, () => ':'],
        [3, () => 'i' + answer(r)],
        [2, () => 'd' + letter(r)],
        [2, () => 'e' + letter(r) + answer(r)],
        [2, () => 'q' + letter(r) + answer(r)],
        [2, () => 'r' + letter(r) + answer(r)],
        [2, () => 'z' + letter(r) + dir()],
        [2, () => 't' + letter(r) + dir()],
        [2, () => 'f' + dir()],
        [2, () => 'a' + letter(r) + answer(r)],
        [2, () => 'W' + letter(r)],
        [1, () => 'T' + letter(r)],
        [1, () => 'P' + letter(r)],
        [1, () => 'R' + letter(r)],
        [2, () => 'w' + letter(r)],
        [2, () => 'o' + dir()],
        [1, () => 'c' + dir()],
        [2, () => '\x04' + dir()],
        [3, () => '>'],
        [1, () => '<'],
        [1, () => '_' + r.pick(['<', '>', '_', '.']) + r.pick(['.', ',', ';', ':'])],
        [1, () => '#pray\r' + 'y' + '   '],
        [1, () => '#' + r.pick(['chat', 'force', 'loot', 'sit', 'terrain', 'overview', 'conduct', 'enhance', 'offer', 'dip', 'ride', 'turn', 'jump', 'monster', 'wipe', 'untrap']) + '\r' + answer(r)],
        [1, () => '\x18' + '  '],
        [1, () => '\x10'],
        [1, () => '?' + r.pick(['a', 'b', 'c', 'i']) + '\x1b\x1b'],
        [1, () => 'E' + r.pick(['-', letter(r)]) + r.pick(['Elbereth', 'x']) + '\r'],
        [1, () => '^' + dir()],
        [1, () => 'x'],
        [1, () => 'X'],
        [1, () => 'A' + answer(r)],
        [1, () => '@'],
        [1, () => '\\' + answer(r)],
        [1, () => 'O' + '\x1b'],
        [o.meta, () => r.pick(['\xe1', '\xe3', '\xe4', '\xe5', '\xe6', '\xe9', '\xea', '\xec', '\xed', '\xef', '\xf0', '\xf2', '\xf3', '\xf4', '\xf5', '\xf7', '\xff', '\x80', '\xa0', '\xc1'])],
        [o.meta, () => '\x1b' + r.pick('acdefijlmoprstuvw?'.split(''))],
        [4, () => answer(r)],
    ])();
}
function play(r, n, o = { meta: 2 }) {
    let s = '';
    while (s.length < n) s += command(r, o);
    return s;
}
const intro = '   ';   // the legacy/intro --More-- screens (dismissed with spaces)

// ---------- kinds ----------
export const KINDS = ['opts', 'play', 'deep', 'bones', 'saves', 'long', 'special', 'meta', 'longopts'];

// meta commands (cmd.c: M('x') bindings and extended commands with meta shortcuts), with
// what usually follows them
const META = [
    ['a', (r) => letter(r) + r.pick(['b', 'c', '\x1b'])], ['c', (r) => r.pick([...DIRS, '.'])], ['d', (r) => letter(r) + 'n' + answer(r)],
    ['e', () => '\x1b'], ['f', () => 'n'], ['i', (r) => letter(r)], ['j', (r) => '\x1b'], ['l', (r) => answer(r)],
    ['m', (r) => answer(r)], ['n', (r) => r.pick(['m', 'i', 'o', 'f', 'd', '\x1b']) + '\x1b'], ['o', (r) => answer(r)],
    ['p', () => 'n'], ['q', () => 'n'], ['r', (r) => letter(r)], ['s', () => ''], ['t', () => ''], ['u', (r) => r.pick([...DIRS, '.'])],
    ['v', () => ''], ['w', () => ''], ['?', () => '\x1b'], ['C', () => ' \x1b'], ['O', () => ' \x1b'], ['T', (r) => letter(r)],
    ['R', () => ''], ['A', () => '\x1b'], ['X', () => ''], ['2', () => ''], ['N', () => '\x1b'],
];
function metaCommand(r) {
    const [k, then] = r.pick(META);
    const how = r.int(3);
    const key = how === 0 ? '\x1b' + k : how === 1 ? String.fromCharCode(k.charCodeAt(0) | 0x80) : '\x1b' + k.toUpperCase();
    return key + then(r) + r.pick(['', ' ', '\x1b']);
}

export function gen(kind, seed) {
    const r = rng(seed * 2654435761 + KINDS.indexOf(kind));
    const ch = character(r);
    const seg = (moves, extra, s = seed, dt = datetime(r)) => ({ seed: s, datetime: dt, nethackrc: nethackrc(r, ch, extra), moves });
    const base = ['OPTIONS=suppress_alert:3.4.3'];
    let segments;
    switch (kind) {
    case 'opts':
        segments = [seg(intro + play(r, 60 + r.int(200)), [...base, ...randomOptions(r)])];
        break;
    case 'play':
        segments = [seg(intro + play(r, 200 + r.int(600), { meta: 4 }), [...base, 'OPTIONS=!tutorial', ...(r.chance(0.5) ? ['OPTIONS=altmeta'] : []), ...(r.chance(0.3) ? ['OPTIONS=number_pad:' + r.pick(['1', '2'])] : [])])];
        break;
    case 'deep': {
        let m = intro;
        const hops = 2 + r.int(5);
        for (let i = 0; i < hops; i++) {
            // ^V: "To what level do you want to teleport?" (wizard mode)
            const lvl = r.wpick([[3, 2 + r.int(25)], [3, 26 + r.int(25)], [1, -(1 + r.int(4))]]);
            m += '\x1b\x1b\x16' + String(lvl) + '\r' + '    ';   // ESC: a pending --More-- (moon, Friday 13th) would swallow ^V
            if (r.chance(0.5)) m += '\x06' + '  ';   // ^F map level
            if (r.chance(0.3)) m += '\x17' + r.pick(['blessed +3 speed boots', 'wand of digging', 'ring of levitation', 'potion of see invisible', 'magic marker']) + '\r ';
            m += play(r, 20 + r.int(80), { meta: 1 });
            if (r.chance(0.4)) m += '>' + '  ';
        }
        segments = [seg(m, [...base, 'OPTIONS=playmode:debug,!tutorial,!autopickup'])];
        break;
    }
    case 'bones': {
        // segment 1: a Valkyrie (fixed starting inventory a-d, so a wished-for item is e)
        // goes to the level, wishes for a wand of death and zaps herself; wizard mode asks
        // "Die?" (y) and "Save bones?" (y); then the end-of-game prompts.
        const lvl = 2 + r.int(10);
        const val = { name: r.pick(NAMES), role: 'Valkyrie', race: r.pick(['human', 'dwarf']), gender: 'female', align: 'lawful' };
        const opts = [...base, 'OPTIONS=playmode:debug,!tutorial,!autopickup,!legacy', 'OPTIONS=disclose:-i -a -v -g -c -o'];
        const m1 = '\x1b\x1b\x16' + lvl + '\r    ' + play(r, 20 + r.int(60), { meta: 0 }) + '\x1b\x1b'
            + '\x17wand of death\r ' + 'ze.' + '  ' + 'y' + 'y' + '            ';   // --More-- x2, Die? y, Save bones? y
        // segment 2, same level: "Get bones?" (y). The bones only load if that level can
        // hold bones in segment 2's dungeon too (no_bones_level: not a special or branch
        // level), and the dungeon layout follows the seed: so usually the same seed and
        // character (same layout), sometimes another (a no-bones path)
        const same = r.chance(0.7);
        const ch2 = same ? val : character(r);
        const m2 = '\x1b\x1b\x16' + lvl + '\r' + 'y' + '    ' + play(r, 40 + r.int(160), { meta: 1 });
        segments = [
            { seed, datetime: datetime(r), nethackrc: nethackrc(r, val, opts), moves: m1 },
            { seed: same ? seed : seed + 1, datetime: datetime(r), nethackrc: nethackrc(r, ch2, opts), moves: m2 },
        ];
        break;
    }
    case 'saves': {
        const opts = [...base, 'OPTIONS=!tutorial', ...(r.chance(0.3) ? ['OPTIONS=playmode:debug'] : [])];
        const n = 2 + r.int(3);
        segments = [];
        for (let i = 0; i < n; i++) {
            let m = (i === 0 ? intro : '  ') + play(r, 80 + r.int(300), { meta: 1 });
            if (i < n - 1) m += '\x1b\x1b\x1bSy';
            segments.push(seg(m, opts, i === 0 ? seed : 99999));
        }
        break;
    }
    case 'meta': {
        let m = intro;
        const n = 300 + r.int(500);
        while (m.length < n) {
            m += r.wpick([
                [6, () => metaCommand(r)],
                [1, () => '\x1b' + String(1 + r.int(9)) + r.pick([...DIRS, 's'])],   // ESC then a count
                [1, () => '\x1b' + r.pick(DIRS)],                                    // ESC then a direction (meta-h ...)
                [1, () => '\x1b\x1b' + r.pick(DIRS)],
                [1, () => 'n' + String(2 + r.int(9)) + r.pick(DIRS)],                 // number_pad count prefix
                [5, () => command(r, { meta: 3 })],
            ])();
        }
        const opts = [...base, 'OPTIONS=!tutorial', 'OPTIONS=altmeta'];
        if (r.chance(0.4)) opts.push('OPTIONS=number_pad:' + r.pick(['0', '1', '2', '3', '4', '-1']));
        if (r.chance(0.4)) opts.push('BIND=' + r.pick(['M-p:pray', 'M-x:search', 'M-z:inventory', 'M-v:version', '\\:discoveries']));
        if (r.chance(0.2)) opts.push('OPTIONS=playmode:debug');
        segments = [seg(m, opts)];
        break;
    }
    case 'longopts': {
        let m = intro;
        const n = 1500 + r.int(1500);
        while (m.length < n) m += r.chance(0.04) ? '>' + '  ' : command(r, { meta: 2 });
        segments = [seg(m, [...base, ...randomOptions(r)])];
        break;
    }
    case 'long': {
        let m = intro;
        while (m.length < 2000 + r.int(2000)) m += r.chance(0.04) ? '>' + '  ' : command(r, { meta: 1 });
        segments = [seg(m, [...base, 'OPTIONS=!tutorial', ...(r.chance(0.5) ? ['OPTIONS=!autopickup'] : [])])];
        break;
    }
    case 'special': {
        const opts = [...base, 'OPTIONS=playmode:debug,!tutorial,!autopickup'];
        // ^V takes a level number, a special level's name (dat/dungeon.lua), or "?" for a
        // menu of them (picked by letter)
        const LEVELS = ['oracle', 'bigrm', 'rogue', 'medusa', 'castle', 'valley', 'juiblex', 'baalz', 'asmodeus', 'orcus',
            'wizard1', 'fakewiz1', 'minetn', 'minend', 'soko1', 'soko2', 'soko3', 'soko4', 'x-strt', 'x-loca', 'x-goal', 'knox', 'tower1'];
        const go = () => '\x1b\x1b\x16' + (r.chance(0.75) ? r.pick(LEVELS) + '\r' : '?\r' + r.pick('abcdefghijklmnopqrstuvwxyz'.split(''))) + '    ';
        const n = 2 + r.int(3);
        segments = [];
        for (let i = 0; i < n; i++) {
            let m = (i === 0 ? intro + go() : '  ') + play(r, 40 + r.int(160), { meta: 1 });
            if (i > 0 && r.chance(0.4)) m += go() + play(r, 20 + r.int(80), { meta: 1 });
            if (i < n - 1) m += '\x1b\x1b\x1bSy';
            segments.push(seg(m, opts, i === 0 ? seed : 99999));
        }
        break;
    }
    default: throw new Error(`unknown kind ${kind}`);
    }
    return { version: 5, source: `tools/fuzz/gen.mjs ${kind} ${seed}`, segments };
}
