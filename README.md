[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/supdinals/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/supdinals/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Radar

A token launch radar for the [token-radar-01](https://make.fun/bounty/token-radar-01) bounty on make.fun.

Token Radar reads the sealed DefiLlama snapshot (758 protocols, as of 2026-11-14) and ranks 220 pre-token protocols by implied value. The value model is derived from the snapshot itself: protocols that already have a token set a per-category market-cap/TVL multiple (median, shrunk toward the global median when a category has few comparables, then clamped). Each pre-token protocol is valued as its TVL times its category multiple, adjusted by a momentum factor from its 7-day TVL change and a maturity factor from how long it has been tracked with no token on record.

The board covers all 40 watchlist protocols (TVL at or above the $50M floor, no token on record) plus the 180 strongest pre-token protocols below the floor. Every row carries a concrete farm plan generated from category playbooks with the protocol's own chains, TVL tier and track record woven in. The static dashboard (board, per-protocol detail view with the full model breakdown, and search/category/chain filters) runs fully offline.

Run it with:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

It writes `board.json`, `data.js`, the copied `dashboard/` and `screenshots/`, and `dossier.json` into the output directory. Node 22+, standard library only.
