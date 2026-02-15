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

export const MIN_LIQUIDITY = 1000;         // $1K — more markets in pool (paper trading)
export const MIN_VOLUME = 500;             // $500 — relaxed for paper trading
export const WEATHER_MIN_LIQUIDITY = 500;  // weather with >12h horizon
export const WEATHER_MIN_VOLUME = 500;
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
