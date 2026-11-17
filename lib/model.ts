// Token Radar's value model: one sealed snapshot in, one ranked pre-token board out.
//
// The model is derived from the snapshot's own figures, never from a list of names:
//
//   1. Comparables. Every protocol that already records a token (mcap_usd present)
//      contributes one observation: its market-cap / TVL ratio. Per category the
//      observations are summarised by their median, which shrugs off the wild
//      outliers a mean would swallow (this snapshot holds ratios from 0.001x to
//      400x inside single categories).
//   2. Shrinkage. A category with few comparables is not trusted at face value:
//      its median is blended toward the global median with weight n / (n + 3),
//      so a category backed by one observation lands near the global figure and
//      one backed by fifteen stands almost on its own. The blended multiple is
//      clamped to [0.03, 2.0] so no category can price a protocol at an absurd
//      fraction or multiple of the capital it actually holds.
//   3. Implied value. For a pre-token protocol:
//        base     = tvl_usd x categoryMultiple(category)
//        momentum = 1 + clamp(change_7d, -30, +50) / 100 x 0.6   (null change: 1)
//        maturity = 0.78 + 0.30 x min(age_days, 1460) / 1460     (unknown age: 365d)
//        implied  = round(base x momentum x maturity), at least $1
//      Momentum rewards a protocol whose TVL is actually growing this week and
//      discounts one that is bleeding, without letting a one-week spike (the
//      snapshot holds a +4,448% print) dominate a ranking. Maturity rewards a
//      long track record of operating with no token on record: a protocol
//      tracked for four years has survived conditions a six-week one has not.
//
// The board is pre-token only. Protocols whose token already trades are the
// comparables that price the board; they are never rows on it. The board ranks
// every watchlist protocol (the floor) plus the strongest pre-token protocols
// below the floor (the early radar), 220 rows in all.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One category's comparable set: how many tokened protocols, and their median mcap/TVL. */
export interface CategoryMultiple {
  category: string;
  comparables: number;
  median_multiple: number;
  multiple: number;
}

/** The fitted multiples: one row per category plus the global fallback. */
export interface MultipleTable {
  global_median: number;
  by_category: Map<string, CategoryMultiple>;
}

/** The model's fixed constants, named so the dashboard can state them verbatim. */
export const MODEL = {
  version: 'radar-multiples-1',
  shrink_prior_weight: 3,
  multiple_floor: 0.03,
  multiple_cap: 2.0,
  growth_floor_pct: -30,
  growth_cap_pct: 50,
  momentum_weight: 0.6,
  maturity_base: 0.78,
  maturity_range: 0.3,
  maturity_days: 1460,
  unknown_age_days: 365,
  early_rows: 180,
} as const;

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  token_status: 'pre-token';
  implied_value_usd: number;
  model: {
    category_multiple: number;
    comparables: number;
    base_value_usd: number;
    momentum_factor: number;
    maturity_factor: number;
  };
  farm_steps: string[];
}

/** Everything the dashboard renders: the board rows plus the fitted model, stated in full. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  constants: typeof MODEL;
  global_median_multiple: number;
  categories: CategoryMultiple[];
  protocol_count: number;
  tokened_count: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  rows: BoardRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const bySlugAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The middle value of a non-empty list, robust to the outliers a mean would chase. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whole days from listed_at to the snapshot's as_of date; null when either date is unusable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token: no market cap, no CoinGecko id, no symbol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Fit the multiples from the snapshot's tokened protocols. Only protocols with a
 * real market cap and real TVL count as comparables; a zero or missing figure
 * would poison the median with a ratio that means nothing.
 */
export function computeCategoryMultiples(protocols: SnapshotProtocol[]): MultipleTable {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    allRatios.push(ratio);
    if (p.category !== null) {
      const list = ratiosByCategory.get(p.category) ?? [];
      list.push(ratio);
      ratiosByCategory.set(p.category, list);
    }
  }
  const globalMedian = allRatios.length > 0 ? median(allRatios) : 0.15;
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, ratios] of ratiosByCategory) {
    const med = median(ratios);
    const n = ratios.length;
    const blended = (n * med + MODEL.shrink_prior_weight * globalMedian) / (n + MODEL.shrink_prior_weight);
    byCategory.set(category, {
      category,
      comparables: n,
      median_multiple: round4(med),
      multiple: round4(Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, blended))),
    });
  }
  return { global_median: round4(globalMedian), by_category: byCategory };
}

/** The multiple one category prices at: its shrunk median, or the clamped global median when it has no comparables. */
export function categoryMultiple(table: MultipleTable, category: string | null): CategoryMultiple {
  if (category !== null) {
    const found = table.by_category.get(category);
    if (found !== undefined) return found;
  }
  return {
    category: category ?? 'Uncategorised',
    comparables: 0,
    median_multiple: table.global_median,
    multiple: round4(Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, table.global_median))),
  };
}

/** The momentum factor from a 7-day TVL change: clamped, then weighted, so one hot week bends the value but never makes it. */
export function momentumFactor(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1;
  const clamped = Math.min(MODEL.growth_cap_pct, Math.max(MODEL.growth_floor_pct, change7d));
  return round4(1 + (clamped / 100) * MODEL.momentum_weight);
}

/** The maturity factor from days tracked with no token on record: a longer clean record earns up to +30%. */
export function maturityFactor(age: number | null): number {
  const days = age ?? MODEL.unknown_age_days;
  const capped = Math.min(Math.max(days, 0), MODEL.maturity_days);
  return round4(MODEL.maturity_base + (capped / MODEL.maturity_days) * MODEL.maturity_range);
}

/** One protocol's implied value and the full breakdown the dashboard shows its math with. */
export function impliedValueFor(
  p: SnapshotProtocol,
  asOf: string,
  table: MultipleTable,
): { implied: number; age: number | null; multiple: CategoryMultiple; base: number; momentum: number; maturity: number } {
  const age = ageDays(asOf, p.listed_at);
  const multiple = categoryMultiple(table, p.category);
  const base = Math.round(p.tvl_usd * multiple.multiple);
  const momentum = momentumFactor(p.change_7d);
  const maturity = maturityFactor(age);
  const implied = Math.max(1, Math.round(base * momentum * maturity));
  return { implied, age, multiple, base, momentum, maturity };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol, not a launch candidate. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a below-floor protocol may join the early radar: pre-token, not an exchange, not a versioned pool. */
export function isEarlyCandidate(p: SnapshotProtocol, floorUsd: number): boolean {
  return recordsNoToken(p) && p.tvl_usd < floorUsd && p.category !== 'CEX' && !VERSIONED_NAME.test(p.name);
}

/** The ranked board: every watchlist protocol plus the strongest early candidates, scored and ranked 1..N. */
export function buildBoard(snapshot: Snapshot, table: MultipleTable): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isEarlyCandidate(p, snapshot.floor_usd))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || bySlugAsc(a.slug, b.slug))
    .slice(0, MODEL.early_rows);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, value: impliedValueFor(p, snapshot.as_of, table) }));
  scored.sort(
    (a, b) =>
      b.value.implied - a.value.implied || b.p.tvl_usd - a.p.tvl_usd || bySlugAsc(a.p.slug, b.p.slug),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.value.age,
    watchlist: watchlist.has(s.p.slug),
    token_status: 'pre-token' as const,
    implied_value_usd: s.value.implied,
    model: {
      category_multiple: s.value.multiple.multiple,
      comparables: s.value.multiple.comparables,
      base_value_usd: s.value.base,
      momentum_factor: s.value.momentum,
      maturity_factor: s.value.maturity,
    },
    farm_steps: farmPlanFor(s.p, s.value.age),
  }));
}

// ---------------------------------------------------------------- farm plans
//
// Every plan is generated from a category playbook with the protocol's own
// record woven in: its name, the chains it actually runs on, a capital range
// scaled to its TVL tier, and a hold window scaled to its track record. Two
// protocols in the same category share a playbook's shape but never its text:
// the amounts, chains and durations differ because their records differ.

interface FarmContext {
  chain: string;
  chainList: string;
  low: number;
  high: number;
  gas: number;
  holdDays: number;
}

/** The working context one protocol's plan is written from: its chains, its capital tier, its hold window. */
function farmContext(p: SnapshotProtocol, age: number | null): FarmContext {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const chainList = p.chains.length > 0 ? p.chains.slice(0, 3).join(', ') : 'its main chain';
  let low = 50;
  let high = 150;
  let gas = 5;
  if (p.tvl_usd >= 1_000_000_000) { low = 500; high = 2500; gas = 15; }
  else if (p.tvl_usd >= 250_000_000) { low = 250; high = 1000; gas = 12; }
  else if (p.tvl_usd >= 100_000_000) { low = 150; high = 600; gas = 10; }
  else if (p.tvl_usd >= 50_000_000) { low = 100; high = 400; gas = 8; }
  else if (p.tvl_usd >= 20_000_000) { low = 75; high = 250; gas = 6; }
  const holdDays = age === null ? 45 : age < 180 ? 60 : age < 540 ? 45 : 30;
  return { chain, chainList, low, high, gas, holdDays };
}

const money = (n: number): string => `$${n.toLocaleString('en-US')}`;

/** The category playbook's two core actions and its points logic, written for this protocol. */
function playbookActions(p: SnapshotProtocol, c: FarmContext): [string, string, string] {
  const n = p.name;
  const cap = `${money(c.low)}-${money(c.high)}`;
  switch (p.category) {
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Collateral Markets':
      return [
        `Deposit ${cap} of USDC into a ${n} curated vault on ${c.chain}; curator vaults on ${c.chainList} are the product, so pick the vault whose underlying markets you can explain.`,
        `Split a second tranche across one more ${n} vault on a different chain it curates (${c.chainList}) so your activity is not a single deposit on a single market.`,
        `${n} curators typically reward vault share held over time, so screenshot your share balance weekly; if a points page exists it will key off shares x days, not deposit count.`,
      ];
    case 'Lending':
    case 'Uncollateralized Lending':
      return [
        `Supply ${cap} of USDC or ETH to ${n} on ${c.chain} as collateral, then borrow 30-40% against it and re-supply the borrow once: one careful loop, never a maxed-out one.`,
        `Repay and re-borrow a small slice on ${n} each week and vote in any rate or market-listing polls; lenders usually weight supplied balance, borrow balance and account age together.`,
        `Points logic for lending markets is balance x time with a borrow multiplier, so the loop above earns more per dollar than a passive supply of the same ${cap}.`,
      ];
    case 'CDP':
    case 'CDP Manager':
    case 'Dual-Token Stablecoin':
    case 'Algo-Stables':
    case 'Stablecoin Wrapper':
      return [
        `Open a collateral position on ${n} (${c.chain}): deposit ${cap} of ETH or a liquid staking token and mint its stablecoin at under 50% of the max loan-to-value.`,
        `Put the minted stablecoin to work in ${n}'s own stability or liquidity pool on ${c.chainList} and keep both legs open; mint-and-hold is the behaviour CDP points systems are built to reward.`,
        `Watch ${n}'s governance forum for a points or season announcement: CDP protocols convert mint volume and position age, so an old, healthy vault beats a fresh large one.`,
      ];
    case 'Dexs':
      return [
        `Provide ${cap} of liquidity to ${n}'s highest-volume pair on ${c.chain} in a tight but sane range, and route your own swaps through ${n} on ${c.chainList} instead of an aggregator.`,
        `Claim and re-compound fees weekly, and make 2-3 organic swaps a week in the ${money(c.low)} range; DEX airdrops have historically weighted LP time and real swap count over raw size.`,
        `${n} has no token on record, so if a points program appears it will likely retro-weight LP days and fee generation: keep the position live rather than farming in bursts.`,
      ];
    case 'Yield':
    case 'Yield Aggregator':
    case 'Farm':
    case 'Leveraged Farming':
    case 'Liquidity Manager':
      return [
        `Deposit ${cap} into ${n}'s flagship vault on ${c.chain} and keep the vault shares in the depositing wallet; moving shares between wallets breaks most points accounting.`,
        `Rotate a minority slice (${money(c.low)}) into a second ${n} strategy on ${c.chainList} every few weeks so your history shows more than one product and more than one market condition.`,
        `Yield protocols without a token usually snapshot vault-share balances at season ends: the metric that matters is share-days, so enter early in a season and avoid round-tripping.`,
      ];
    case 'RWA':
      return [
        `Mint or buy ${cap} of ${n}'s tokenised real-world asset on ${c.chain} after completing its onboarding/KYC step if it asks for one; unfinished KYC is the most common reason RWA farmers get nothing.`,
        `Hold the asset through at least two distribution or reporting cycles on ${n} and interact on a second chain it issues on (${c.chainList}) if your jurisdiction allows it.`,
        `RWA launches tend to reward holders of record at announced snapshot dates, not traders: accumulate a steady position in ${n} rather than flipping in and out around news.`,
      ];
    case 'Basis Trading':
    case 'CeDeFi':
      return [
        `Deposit ${cap} of USDC or ETH into ${n}'s basis vault on ${c.chain}; the vault runs the hedged trade, your job is simply to be an early, sticky depositor.`,
        `Add a smaller second deposit (${money(c.low)}) after 2-3 weeks instead of one lump sum: staggered deposits read as conviction in points systems that average balances.`,
        `${n} monetises funding rates, so its eventual points will most plausibly track average deposited balance: maximise days at full size rather than total transactions.`,
      ];
    case 'Chain':
      return [
        `Bridge ${cap} of ETH or USDC to ${n} using its canonical route and keep a gas balance there; a pre-token chain's scarcest signal is a funded wallet that stays.`,
        `Use 3-4 native apps on ${n} each week (a swap, a lend, an NFT mint in the ${money(c.low)} range in total) so the wallet builds a believable on-chain footprint, not bridge-only traffic.`,
        `Chain airdrops weight bridge value, transaction weeks and dapp diversity together: ${n} activity spread over ${c.holdDays}+ days beats the same volume compressed into one weekend.`,
      ];
    case 'Restaking':
    case 'Liquid Restaking':
    case 'Restaked BTC':
    case 'Liquid Staking':
    case 'Staking Pool':
    case 'Anchor BTC':
    case 'Decentralized BTC':
      return [
        `Stake or restake ${cap} of the chain's staking asset through ${n} on ${c.chain} and keep the receipt token in the staking wallet; unstaking early usually forfeits the season.`,
        `Delegate or allocate to more than one operator/strategy inside ${n} where it offers the choice, and claim rewards on schedule so the wallet shows continuous participation.`,
        `Restaking points compound per asset per day and often stack with the underlying protocol's points: ${n} positions earn most by simply staying staked across the full window.`,
      ];
    case 'Bridge':
    case 'Canonical Bridge':
    case 'Cross Chain Bridge':
      return [
        `Bridge ${cap} of USDC or ETH through ${n} to ${c.chain}, then actually use the funds there for a week before bridging anything back.`,
        `Repeat the route in the opposite direction and on a second corridor ${n} serves (${c.chainList}); bridge points systems score corridors and round trips, not one-way dumps.`,
        `Keep each transfer in the ${money(c.low)}-${money(c.high)} band and spread them over weeks: anti-sybil filters discount clusters of identical same-day transfers.`,
      ];
    case 'Derivatives':
    case 'Options':
    case 'Interest Rate Derivatives':
      return [
        `Deposit ${cap} of USDC margin on ${n} (${c.chain}) and trade small, hedged positions: a delta-neutral pair or a covered structure you can hold for days, not directional punts.`,
        `Trade 2-3 sessions a week with modest size and hold at least one position overnight each week; perps venues score volume, open-interest time and liquidation-free history.`,
        `${n} records no token, so a future points season would most plausibly weight fee-paying volume and OI days: steady ${money(c.low)}-sized flow beats one huge week.`,
      ];
    case 'Prediction Market':
      return [
        `Fund ${cap} on ${n} and take positions in 4-6 liquid markets you have an actual view on, sized ${money(c.low)} or less each, instead of one all-in bet.`,
        `Provide liquidity on one or two markets on ${n} and let positions settle rather than selling early every time; settled history is the cleanest activity signal.`,
        `Prediction platforms reward resolved-market participation and LP provision when they launch tokens: a settled, diversified record on ${n} is the asset you are building.`,
      ];
    case 'Insurance':
      return [
        `Buy ${cap} of cover from ${n} on ${c.chain} against a position you genuinely hold elsewhere; a real policy on a real exposure is the core action.`,
        `If ${n} lets members underwrite, stake ${money(c.low)}-${money(c.high)} into its capital pool for a full cover period and leave rewards unclaimed until the period closes.`,
        `Insurance protocols are thin on users, so even small long-lived policies and underwriting stakes on ${n} put a wallet in a very small eligible set if a token arrives.`,
      ];
    case 'Payments':
    case 'Crypto Card Issuer':
      return [
        `Route ${cap} of real spending or transfers through ${n} over the season instead of one deposit: payment products score transaction count and retained balance together.`,
        `Keep an average balance of about ${money(c.low)} in ${n} and make it your default rail for one recurring payment so activity lands every single week.`,
        `For ${n} the credible airdrop metric is genuine payment volume from retained users, so boring consistency beats a single large pass-through transfer.`,
      ];
    case 'Launchpad':
      return [
        `Register and complete ${n}'s participation/KYC steps early, then take a ${money(c.low)}-${money(c.high)} allocation in one launch rather than spraying tiny tickets everywhere.`,
        `Stake or hold whatever ${n} requires for tier access on ${c.chain} for the full lock window; launchpads reward tier tenure when they tokenise.`,
        `Keep a record of every ${n} launch you joined: if allocations convert to points retroactively, completed settled launches are what will count.`,
      ];
    case 'Privacy':
      return [
        `Deposit ${cap} into ${n}'s shielded pool on ${c.chain} and make a small number of private transfers between your own wallets, leaving funds shielded for weeks, not minutes.`,
        `Use ${n}'s relayer or private-send feature at least twice a month so the wallet shows habitual use of the privacy product itself, not just a deposit.`,
        `Privacy protocols have tiny user counts, so a long-lived shielded balance on ${n} is a strong signal on its own; avoid patterns that link your wallets publicly.`,
      ];
    case 'Indexes':
      return [
        `Mint ${cap} of ${n}'s index token on ${c.chain} and hold it unstaked in the minting wallet for the full window.`,
        `Add ${money(c.low)} to the position monthly and take part in any rebalancing votes ${n} runs; index protocols notice holders who show up for governance.`,
        `An index product's natural token metric is assets held over time: steady accumulation in ${n} matters more than mint-and-redeem churn.`,
      ];
    default:
      return [
        `Deposit ${cap} of USDC into ${n}'s core product on ${c.chain} and keep the position open; concentrated, explainable use of the main product is what pre-token snapshots reward.`,
        `Use a second feature of ${n} on ${c.chainList} in the ${money(c.low)} range (a second market, pool or vault) so your history is broader than a single deposit.`,
        `${n} publishes no points program in the snapshot, so farm the fundamentals: real balance, real duration, and governance or community participation if it opens.`,
      ];
  }
}

/** One protocol's farm plan: seven concrete steps, each carrying its action, its cost and its time. */
export function farmPlanFor(p: SnapshotProtocol, age: number | null): string[] {
  const c = farmContext(p, age);
  const [actionA, actionB, pointsLogic] = playbookActions(p, c);
  const ageNote =
    age === null
      ? `${p.name} has no listing date in the snapshot, so treat it as unproven`
      : age < 365
        ? `${p.name} has been tracked for only ${age} days, so it is early and higher-risk`
        : `${p.name} has a ${age}-day track record with no token on record`;
  return [
    `Set up a dedicated wallet for ${p.name}, fund it with gas on ${c.chain} plus ${money(c.low)}-${money(c.high)} of working capital, and bookmark only the official app link. Cost: about ${money(c.gas)} of gas to get started. Time: 15 minutes, once.`,
    `${actionA} Cost: ${money(c.low)}-${money(c.high)} of capital plus about ${money(c.gas)} of gas. Time: 20 minutes to open, then it sits.`,
    `${actionB} Cost: about ${money(Math.max(3, Math.round(c.gas / 2)))} of gas a week on top of the capital already placed. Time: 10 minutes a week.`,
    `${pointsLogic} Cost: nothing beyond the positions above. Time: 5 minutes to check the official points or rewards page each week.`,
    `Keep the ${p.name} position live for at least ${c.holdDays} days: ${ageNote}, and a position held across several weekly snapshots is worth more than a larger one held for a weekend. Cost: the capital stays locked for the window. Time: ${c.holdDays} days.`,
    `Log every ${p.name} transaction (date, chain, amount, hash) in a simple farm tracker and review it monthly; if the protocol announces a season or snapshot, your log is how you verify eligibility fast. Cost: nothing. Time: 5 minutes a month.`,
    `Exit plan: when ${p.name} announces a token or points conversion, claim only from the link on its official channels, then unwind in tranches over a week to avoid slippage on ${c.chain}. Cost: about ${money(c.gas)} of gas to unwind fully. Time: 30 minutes, when the time comes.`,
  ];
}

/** The dashboard's data: the board plus the fitted multiples, stated so the page can show the model's math. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const table = computeCategoryMultiples(snapshot.protocols);
  const board = buildBoard(snapshot, table);
  const categories = [...table.by_category.values()].sort(
    (a, b) => b.comparables - a.comparables || bySlugAsc(a.category, b.category),
  );
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL.version,
    constants: MODEL,
    global_median_multiple: table.global_median,
    categories,
    protocol_count: snapshot.protocols.length,
    tokened_count: snapshot.protocols.filter((p) => !recordsNoToken(p)).length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    rows: board,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it carries the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((x): x is string => typeof x === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, shared values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const trimmed = s.trim();
      if (trimmed.length < 20 || trimmed.length > 600) return `${r.slug} has a farm step of ${trimmed.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
