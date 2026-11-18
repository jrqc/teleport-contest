# Results log

Date, change, score delta, root cause found. Scores from `node tools/score.mjs`
(frozen/score.sh, 44 public sessions).

| Date | Change | Passed | Screens | RNG | Root cause / note |
|---|---|---|---|---|---|
| 2026-11-18 | First full run of the transpiled build (commit e5acdec): Lua heap world + bridge, save serializers, contiguous multidimensional arrays, localtime(&t) | 17/44 | 3170/11405 | 183867/792838 | Before: every session stopped at lua_newstate (~200 RNG calls). Remaining failures are mostly one trap: record pointer arithmetic on a lone record (22 sessions, e.g. engrave.c make_engr_at) |
