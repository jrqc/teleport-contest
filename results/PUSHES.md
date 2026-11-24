# Pushes to main

Every push to `origin/main` (UTC, from `git reflog show refs/remotes/origin/main`), with the
step it carries. The judge does not publish the commit it scored: a judge run scored the last
push before its `lastScored` time (CLAUDE.md section 7). If a judge run drops below 100%, the
step to revert is the one pushed last before that run.

| Pushed (UTC) | Head | Step |
|---|---|---|
| 2026-11-19 21:11 | `8a5bfb6` | Docs: METHODS.md, method/ (judged 2026-11-22 18:29: 100/100) |
| 2026-11-22 22:38 | `8a9d975` | CLAUDE.md section 7 row; churn benchmark baseline |
| 2026-11-22 23:24 | `4f4680b` | Readability P1: RNG calls without caller tags |
| 2026-11-23 00:45 | `a66176f` | Readability P2: named constants |
| 2026-11-23 01:39 | `913bf50` | Readability P3: macros as functions |
| 2026-11-23 04:05 | `fb50c24` | Readability P2c-1: tables as literals |
| 2026-11-23 05:32 | `a17eef9` | Readability P2c-2: constant namespaces |
| 2026-11-23 15:54 | `95b3095` | Readability P4: C comments and notices |
| 2026-11-23 16:43 | `7f196ad` | Readability: fortify names |
| 2026-11-23 17:37 | `eec068c` | Readability: JSDoc from C signatures |
| 2026-11-23 18:22 | `e321f99` | Readability: === for pointers to record array elements |
| 2026-11-23 19:17 | `38d287c` | Readability P5: wrapper reduction |
| 2026-11-23 20:03 | `c44d6c4` | Readability: const locals, declared at first assignment |
| 2026-11-23 20:11 | `4273930` | Handoff note (method/HANDOFF.md), tools/analysis scripts |
| 2026-11-24 01:30 | `8ded0ff` | Readability: string literals as tagged templates |
| 2026-11-24 02:29 | `767801b` | Readability (a): === for record-pointer comparisons (one ElemPtr per position); per-move profile |
| 2026-11-24 03:18 | `6fe9c78` | Readability (b): more macro expansions as calls (Role_if, rn1, strcmpi, max, Is_waterlevel...) |
| 2026-11-24 04:02 | `b23c4a7` | Readability (c): the C's line breaks in long statements |
