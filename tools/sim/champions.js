// Champion ladder — every era's frozen king measured against the SAME fixed
// opponent (baseline-v0) on the SAME three fresh 160-match blocks.
//
// Why this exists: every other chips number on this panel is scored against
// the ERA ENEMY, which gets stronger each era, so it resets toward 0 by
// construction and can never show cumulative progress. v0 never changes, so
// this is the only axis on which "are we actually getting better" is a
// meaningful question.
//
// Regenerate (nothing else running):
//   for v in 1 2 3 4; do for b in 20000000 21000000 22000000; do
//     node tools/sim/headtohead.mjs tools/sim/baseline-v$v.json 160 $b \
//       tools/sim/baseline-v0.json | grep chips/match; done; done
//
// CAVEAT on era 1: the seat-luck bench bias was only fixed at the era-2 start,
// so era-1's contemporaneous numbers were inflated. The v1 row here is a
// bias-free RE-measurement, so it is comparable with the rest.
window.CHAMPIONS = {
  generated: "2026-08-29",
  enemy: "baseline-v0",
  matchesPerBlock: 160,
  blocks: [20000000, 21000000, 22000000],
  rows: [
    { name: "baseline-v1", era: 1, chips: [27.8, 72.0, 23.9], mean: 41.2 },
    { name: "baseline-v2", era: 2, chips: [62.0, 80.9, 43.0], mean: 62.0 },
    { name: "baseline-v3", era: 3, chips: [27.7, 65.9, 52.8], mean: 48.8 },
    { name: "baseline-v4", era: 4, chips: [61.5, 69.3, 62.9], mean: 64.6 },
  ],
};
