# Results log

Date, change, score delta, root cause found. Scores from `node tools/score.mjs`
(frozen/score.sh, 44 public sessions).

| Date | Change | Passed | Screens | RNG | Root cause / note |
|---|---|---|---|---|---|
| 2026-11-18 | First full run of the transpiled build (commit e5acdec): Lua heap world + bridge, save serializers, contiguous multidimensional arrays, localtime(&t) | 17/44 | 3170/11405 | 183867/792838 | Before: every session stopped at lua_newstate (~200 RNG calls). Remaining failures are mostly one trap: record pointer arithmetic on a lone record (22 sessions, e.g. engrave.c make_engr_at) |
| 2026-11-18 | struct engr trailing area (annotation types[].tail, D4) implemented: `(char *)(ep + 1)` -> `$c.recTail(ep)`, `static $tail`; asRec keeps alloc's 8-byte slack | 30/44 | 8220/11405 | 685962/792838 | The tail annotation existed but the emitter never used it: `(char *)(ep+1)` became record arithmetic and trapped in make_engr_at (22 sessions). 0 regressions vs the 17-pass baseline (the 0-score run in between was this change half done) |
| 2026-11-18 | Empty record/logfile/xlogfile at session start (recorder clearStaleState + ensureScorefiles); tools/screendiff.mjs (4.3) | 31/44 | 8222/11405 | 685962/792838 | End-of-game "Cannot open file logfile": the recorder creates empty score files before the first segment |
| 2026-11-18 | Union cells (design 3.4.2, D1) implemented: the 4 unions the punning check flags (any, vptrs, vlaunchinfo, customization_content) keep C bytes (js/crt/ucell.js); ptrToInt canonical for equal pointers | 38/44 | 8789/11405 | 685962/792838 | The emitter ignored the union-pun verdicts. glyphs.c:508 writes content.urep.glyphidx and reads content.ccolor.glyphidx: every symset color customization got glyph 0, so Sokoban walls (DECgraphics /blue) were gray. 0 regressions |
