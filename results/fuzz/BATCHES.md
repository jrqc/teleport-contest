# Fuzz batches (tools/fuzz/batch.mjs)

Seeds rotate; failing recordings stay in results/fuzz/<run>/fail/.

| Run | Commit | Kinds | Seeds | Cases | Pass | Fail | Not recorded | Failures by first divergence | Levels | Special levels reached |
|---|---|---|---|---|---|---|---|---|---|---|
| 20261119T144321 | 4dedf3c | all | 10000-10109 | 990 | 990 | 0 | 0 | - | 82 | asmodeus, baalz, bigrm, castle, fakewiz1, fakewiz2, juiblex, medusa, oracle, orcus, rogue, sanctum, tut-1, valley, wizard1, wizard2, wizard3 |
| 20261119T151228 | b0a2e28 | all | 10110-10219 | 990 | 990 | 0 | 0 | - | 121 | Arc-goal, Arc-strt, Bar-strt, Hea-goal, Hea-strt, Kni-loca, Mon-loca, Rog-goal, Sam-loca, Sam-strt, Tou-loca, Val-strt, Wiz-loca, air, asmodeus, astral, baalz, bigrm, castle, earth, fakewiz1, fire, juiblex, medusa, minend, minetn, oracle, orcus, rogue, sanctum, soko1, soko2, soko3, soko4, tower1, tower2, tower3, tut-1, valley, water, wizard1, wizard2, wizard3 |
| 20261122T224919 | 8a9d975 + P1 (working tree; P1 committed after the batch) | all | 10220-10329 | 990 | 990 | 0 | 0 | - | 112 | Bar-strt, Cav-goal, Cav-loca, Kni-loca, Kni-strt, Pri-loca, Pri-strt, Ran-loca, Tou-goal, Tou-loca, Val-loca, Wiz-loca, air, asmodeus, astral, baalz, bigrm, castle, earth, fakewiz1, fakewiz2, fire, juiblex, medusa, minend, minetn, oracle, orcus, rogue, sanctum, soko1, soko2, soko3, soko4, tower1, tower2, tower3, tut-1, valley, water, wizard1, wizard2, wizard3 |
