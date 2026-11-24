# Per-move profile (2026-11-24)

Owner request (2026-11-24): the judge measured 7.26 ms/move on `e321f99` (5.35 on
`a17eef9`) against the 5 ms limit, while we measure about 2.1 locally. Profile the per-move
path and report what dominates; no optimization without the owner's go-ahead.

## Method

`tools/analysis/playprof.mjs` drives the game exactly as `frozen/playability_runner.mjs`
does (modules loaded once; per session `start()` untimed, then one `moveloop_core()` per
queued key) and runs the V8 sampling profiler (100 us) only around each session's
interactive loop. 44 public sessions, 9,096 keys, build `8ded0ff`. The profiler's own
`Profiler.stop` samples are dropped. Inclusive times count a function once per sampled
stack; async functions resumed after an `await` lose their callers, so inclusive times of
callers above an `await` are lower bounds.

## The judge's figure is mostly the judge's machine

Same runner, this machine, three runs each, back to back:

| Build | Judge ms/move | Local ms/move |
|---|---|---|
| `a17eef9` | 5.35 | 2.078 / 2.089 / 2.082 |
| `e321f99` | 7.26 | 2.042 / 2.049 / 2.037 |
| `8ded0ff` (head) | - | 2.067 / 2.080 / 2.084 |

The builds are within 2% of each other locally; the judge's 5.35 -> 7.26 is not ours. Its
figures for our builds have ranged 4.94-7.26 while local stayed 2.0-2.5 (CLAUDE.md
section 7), and the factor between them 2.4-3.5x.

## Where the per-key time goes

Self time (28.3 s sampled while playing; profiler overhead makes it 3.1 ms/move here):

| Area | Share |
|---|---|
| Game code (`js/nh`, without Lua) | 34.7% |
| C runtime (`js/crt`) | 34.2% |
| Lua interpreter (`js/nh/l*.js`) | 13.8% |
| Glue (`js/*.js`: `nhprocess.js`, `game_display.js`, `allmain.js`) | 9.2% |
| V8 `(program)` and GC | 7.6% |

By path (inclusive):

1. **Screen capture (patch 006 markers), about 15-20%.** At every input boundary
   `tty_nhgetch` (9.0%) runs `nomux_capture_write_input_boundary` (8.7%):
   `nomux_capture_screen` (5.0%) copies the shadow screen into a byte buffer cell by cell
   (the largest caller of `Ptr.set`), and `nomux_emit_marker` (10.4%) writes it with
   `fwrite` to stdout, whose sink feeds `MarkerParser.push` in `js/nhprocess.js` (7.9%) and
   `onMarker` (3.6%). `push` allocates a new array of the whole pending buffer on every
   write it receives, and tty output arrives one byte at a time (`putchar` 4.4%), so it is
   quadratic in the size of a pending marker.
2. **Level files on level change, about 7-10%.** `goto_level` saves the old level
   (`savelevl` 3.2%, `bwrite` 7.0%, `serialize`/`wRec` in `js/crt/serial.js` 5.8% self), as
   the C does (to the VFS).
3. **Lua, about 14% self.** Special levels and themed rooms load their scripts with
   `nhl_loadlua`, which lexes, parses and compiles the source every time (`llex`,
   `lparser`, `lcode`, about 7%), then runs it (`luaV_execute` about 2-3%).
4. **Game logic** proper: `findtravelpath` 2.8%, `vision_recalc` 2.4%, `test_move` 2.2%,
   `dochug` 2.1%, `newsym`/`show_glyph` about 3.7%, `flush_screen` 2.1%.
5. **tty output** (`xputs`/`xputc`/`tputs`/`putchar`): about 4-5%.
6. **Byte accessors**: `Ptr.set`/`Ptr.get` (bounds-checked per byte) 10.8% self, spread over
   the capture (2.6%), `nhl_loadlua` (1.3%), `sprintf` stores (1.1%), `strcpy`/`strncpy`
   (1.3%), `strstri` (0.6%).

## Candidates (not done; each needs the owner's go-ahead)

- `MarkerParser.push`: append into a growing buffer instead of reallocating per write
  (hand-written glue; no effect on the C behavior).
- The capture's cell copy and marker encoding: buffer-level copies instead of per-byte
  `Ptr.set` (runtime) or a transpiler pattern for the loop.
- Lua chunk caching by source text (the C re-parses; caching changes no RNG call or
  output, but it is a deliberate departure from a 1:1 port).
