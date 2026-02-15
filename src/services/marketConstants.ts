/**
 * Shared market filtering constants — SINGLE SOURCE OF TRUTH.
 * Used by: smartTrader.ts (buildShortTermPool), polymarket.ts (Bot View),
 *          MarketsPanel.tsx (cluster dedup count).
 *
 * ⚠️  If you add/remove patterns here, BOTH the bot pipeline and the
 *     Bot View UI will pick them up automatically. No sync issues.
 */

// ─── Junk / noise patterns (string includes) ─────────────────

export const JUNK_PATTERNS: string[] = [
  // Social media noise
  "tweet", "tweets", "post on x", "post on twitter", "retweet",
  "truth social post", "truth social",
  "tiktok", "instagram", "youtube video", "viral",
  "# of ", "#1 free app", "app store", "play store",
  // Follower/subscriber counting
  "how many", "number of", "followers", "subscribers",
  "most streamed", "most viewed",
  // Specific personality noise
  "elon musk", "musk post", "musk tweet",
  // Trivial games
  "spelling bee", "wordle", "jeopardy", "wheel of fortune",
  "chatgpt",
  // Prop bets Claude can't verify (no public data source)
  "robot dancer", "robot dance", "have robot",
  "gala", "spring festival",
  "fundraiser",
  // Arbitrary count ranges from specific markets
  "160-179", "180-199", "200-219",
];

// ─── Junk regex patterns (for complex matching) ──────────────

export const JUNK_REGEXES: RegExp[] = [
  /will .{1,40} say .{1,30} during/,            // "will X say Y during Z" speech props
  /\d{2,3}-\d{2,3}\s*(posts?|tweets?|times?)/,  // "160-179 posts" count ranges
];

// ─── Weather detection ───────────────────────────────────────

export const WEATHER_RE = /temperature|°[cf]|weather|rain|snow|hurricane|tornado|wind speed|heat wave|cold|frost|humidity|celsius|fahrenheit|forecast|precipitation|storm|flood|drought|wildfire|nws|noaa/;

// ─── Liquidity / Volume / Price thresholds ───────────────────

// Dynamic liquidity: max(MIN_LIQUIDITY_FLOOR, 50 × typical Kelly bet size), capped at $10K
// This ensures markets have enough depth to absorb our orders without slippage.
// With bankroll $1500 and typical bet $37.50 → min_liq = max(1500, 1875) = $1,875
// Cap at $10K so high bankrolls don't over-filter
export const MIN_LIQUIDITY_FLOOR = 1500;   // Absolute floor — $1,500
export const MIN_LIQUIDITY_CAP = 10_000;   // Absolute cap — never require more than $10K
export const MIN_LIQUIDITY_MULTIPLIER = 50; // min_liq = 50× expected bet size
export const MIN_VOLUME = 300;             // $300 — minimum trading activity
export const WEATHER_MIN_LIQUIDITY = 500;  // weather with >12h horizon
export const WEATHER_MIN_VOLUME = 300;

/** Compute dynamic MIN_LIQUIDITY based on bankroll, capped at $10K */
export function computeMinLiquidity(bankroll: number): number {
  // Typical bet = bankroll × KELLY_FRACTION(0.25) × MAX_BET_FRACTION(0.10) = 2.5% of bankroll
  const typicalBet = bankroll * 0.025;
  const raw = Math.max(MIN_LIQUIDITY_FLOOR, MIN_LIQUIDITY_MULTIPLIER * typicalBet);
  return Math.min(raw, MIN_LIQUIDITY_CAP);
}

/**
 * Estimate bid/ask spread from liquidity (proxy — no real orderbook data).
 * Based on empirical Polymarket observation:
 *   Liq ≥ $50K → ~1%  (tight, market makers active)
 *   $10-50K   → ~2-3% (decent depth)
 *   $2-10K    → ~4-5% (moderate)
 *   $1-2K     → ~6%   (thin)
 *   < $1K     → ~8%+  (very thin, dangerous)
 */
export function estimateSpread(liquidity: number): number {
  if (liquidity >= 50_000) return 0.01;
  if (liquidity >= 10_000) return 0.025;
  if (liquidity >= 2_000)  return 0.045;
  if (liquidity >= 1_000)  return 0.06;
  return 0.08;
}

/** Max acceptable estimated spread — reject markets above this */
export const MAX_SPREAD = 0.08;  // 8%
export const PRICE_FLOOR = 0.05;           // 5¢ — below this, edges are illusory
export const PRICE_CEILING = 0.95;         // 95¢

// ─── Cluster dedup ───────────────────────────────────────────

/**
 * Extract a "cluster key" from a question by removing numbers/thresholds.
 * Markets with the same cluster key are considered variations (e.g.,
 * "Paris temp 13°C", "Paris temp 14°C" → same cluster).
 * Only the highest-volume market per cluster is sent to Claude.
 */
export function computeClusterKey(question: string): string {
  let q = question.toLowerCase().trim();
  // Replace digits (including decimals, negatives, commas) with placeholder
  q = q.replace(/[-+]?\d[\d,]*\.?\d*/g, "#");
  q = q.replace(/\s+/g, " ");
  if (q.length < 15) return "";
  return q;
}

/**
 * Count unique clusters from a list of market questions.
 * Returns the number of markets Claude would actually see after dedup.
 */
export function countUniqueClusters(questions: string[]): number {
  const keys = new Set<string>();
  let uniqueCount = 0;
  for (const q of questions) {
    const key = computeClusterKey(q) || `__unique_${uniqueCount++}`;
    if (!keys.has(key)) {
      keys.add(key);
      uniqueCount = keys.size;
    }
  }
  return keys.size;
}
