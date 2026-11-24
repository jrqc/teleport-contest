# Handoff (2026-11-23, 20:10 UTC)

## Current state

- `main` and `origin/main` were both at `4273930` (this note; the last code push is
  `c44d6c4`). No uncommitted work and no WIP branch.
  No background jobs (the fuzz batches, churn benchmarks and score runs are all finished).
- Local checks at `c44d6c4`:
  - 44/44 sessions, screens 11,405/11,405, RNG 792,838/792,838.
  - Transpiler tests 63/63, fuzz-regress 4/4, determinism byte-identical.
  - Sandbox 45/45, playcheck 44/44, tablecheck 547/547.
  - Playability 2.07-2.10 ms/move locally.
  - Churn benchmark (monster/field/y_n edits): 289 / 62 / 79 lines.
- The owner's readability list (2026-11-23) is done except the string-literal step:
  P4 comments, fortify names, JSDoc, pointer comparisons, P5 wrapper reduction, declarations.
  Each step has its own row in `method/readability-plan.md`, `results/LOG.md` and
  `results/fuzz/BATCHES.md` (batches 8-13, all 990/990).

## Pushes and the judge

(Updated at the start of the next session, 2026-11-23.) The judge last scored this fork at
**2026-11-23 18:34 UTC** (leaderboard `lastScored`), on `e321f99` (the last push before
it): 24,531/24,531 points, tied for rank 1 of 6 (transpiled), playability **7.26 ms/move**
(5.35 on `a17eef9`; startup 3,166 ms, was 2,103). CLAUDE.md section 7 has that row.

Confirmed by that run: `95b3095` (P4), `7f196ad` (fortify names), `eec068c` (JSDoc),
`e321f99` (pointer comparisons). Pushed since then, **not yet confirmed by the judge**:

| Pushed (UTC) | Commit | Step |
|---|---|---|
| 19:17 | `38d287c` | P5 wrapper reduction (value ranges) |
| 20:03 | `c44d6c4` | `const` locals, declared at first assignment |
| 20:11 | `4273930` | This note, tools/analysis scripts (no js/ change) |

When the judge scores again, check that the points stay at 24,531, and watch its
playability figure against the 5 ms target. Local
playability has not risen since then (2.0-2.2), but the judge machine is about 3x slower.
Add a CLAUDE.md section 7 row only if the score or the scored commit changed.

## Open decisions (owner)

1. **String literals** (`$c.lit(...)`, 27,446 sites): which option?
   1. `String.prototype` C-pointer shims (get/add/set/buf/off), so a JS string can stand in
      for a read-only `char *` (recommended, if playability holds).
   2. A coercion helper at every `char *` use.
   3. Plain strings only where a literal goes straight to a runtime function (~15%).

   Analysis: `tools/analysis/litflow.mjs` (where the literals flow; writes
   `transpiler/out/litflow.txt`). vpline indexes, compares and reassigns its `line`, so a
   per-function analysis of which literals may stay strings is not feasible.
2. G_ stays flat (decided: no rule change).

## Next steps

1. At session start: fetch `https://mazesofmenace.ai/leaderboard/data.json` (entry
   `name == "jrqc"`) and update CLAUDE.md section 7 if the score or scored commit changed.
2. Wait for the owner's string-literal choice, then implement it with the usual checks
   (44/44, tests, fuzz-regress, a fuzz batch, sandbox, playability, determinism, churn
   benchmark, `onscary()` before/after), separate commits (transpiler / js/nh / results),
   push, and add a `results/PUSHES.md` row.
3. Watch the judge's playability against 5 ms/move.

## Notes for the next session

- `tools/analysis/codeonly.mjs` checks that a js/ change is comments and whitespace only
  (HEAD vs working tree; `SHOW=<file>` prints the first difference).
- Run the churn benchmark (`tools/churn/bench.mjs`) only while `transpiler/` is not being
  edited: it transpiles the working tree several times, and an edit during a run
  contaminated one result today (rerun cleanly before the P5 push).
- `method/issues-for-bau.md` stays uncommitted (it is in `.git/info/exclude`).
