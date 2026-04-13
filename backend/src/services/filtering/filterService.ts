/**
 * FilterService -- hard rules that reject tokens instantly.
 *
 * Every check is independent. The first failure short-circuits and returns a
 * clear reason string. This service is a pure function: no side effects, no I/O.
 *
 * All thresholds are sourced from config so they can be changed via .env or
 * the runtime settings API.
 *
 * Age handling:
 *   verified  — normal filters apply
 *   estimated — normal filters apply; a red flag is added
 *   unknown   — if ALLOW_UNKNOWN_AGE_ENTRY=true, stricter filters apply
 *               (MIN_LIQUIDITY_USD_UNKNOWN_AGE, MIN_RECENT_VOLUME_USD_UNKNOWN_AGE,
 *                MIN_BUY_SELL_RATIO_UNKNOWN_AGE); otherwise rejected
 *
 * Rejection log format:
 *   Rejected: <field> <value> <op> <threshold> = <result>
 * e.g.:
 *   Rejected: liquidity $544,705 > max $750,000 = false
 *   Rejected: volume $1,818 < min $5,000 = true
 */

import { config } from '../../config';
import { TokenCandidate, FilterResult, FilterRejectionCategory } from '../../types';

export function applyHardFilters(c: TokenCandidate): FilterResult {
  const redFlags: string[] = [];
  const age = c.pairAgeMinutes;

  // ── Age verification gate ──────────────────────────────────────────────────
  //
  // Three possible age states:
  //   verified  → full trust, normal filters
  //   estimated → near-trust, normal filters with a red flag
  //   unknown   → no trust; apply stricter thresholds or reject outright
  //
  let unknownAgeMode = false; // true → use stricter unknown-age thresholds

  if (c.ageState !== 'verified') {
    if (config.REQUIRE_VERIFIED_AGE_FOR_ENTRY) {
      // Hard gate: only verified timestamps allowed
      return fail(
        `Rejected: age is ${c.ageState} (src=${c.ageSource}) — verified timestamp required (REQUIRE_VERIFIED_AGE_FOR_ENTRY=true)`,
        redFlags,
        'age_unverified'
      );
    }

    if (c.ageState === 'unknown') {
      if (!config.ALLOW_UNKNOWN_AGE_ENTRY) {
        return fail(
          `Rejected: age is unknown (src=${c.ageSource}) — ALLOW_UNKNOWN_AGE_ENTRY=false`,
          redFlags,
          'age_unverified'
        );
      }
      // Unknown-age allowed — activate stricter filter set
      unknownAgeMode = true;
      redFlags.push(`Age unknown (src=${c.ageSource}) — stricter safety filters applied`);
    } else {
      // estimated — allow with a low-confidence red flag
      redFlags.push(`Age ${c.ageState} (src=${c.ageSource}) — entry timing unconfirmed`);
    }
  }

  // ── 0. Anti-dead filter ────────────────────────────────────────────────────
  // Tokens with zero liquidity or zero volume across all windows are ghost
  // tokens with no active market — reject immediately before wasting further checks.
  if (c.liquidityUsd === 0) {
    return fail('Rejected: liquidity is zero — no tradeable market', redFlags, 'liquidity_low');
  }
  if (c.volume30m === 0 && c.volume1h === 0 && c.volume24h === 0) {
    return fail('Rejected: all volume is zero — dead token with no trading activity', redFlags, 'volume');
  }

  // ── STRICT ENTRY GUARDS ────────────────────────────────────────────────────
  // These three gates run immediately after basic validity and BEFORE scoring.
  // Any token that fails here is rejected without further evaluation.
  //
  //   Guard 1 — Liquidity    : >= MIN_LIQUIDITY_USD  (default $20 000)
  //   Guard 2 — Momentum     : 5m change >= MIN_5M_PRICE_CHANGE_PCT  (default +2%)
  //   Guard 3 — Buy pressure : buy/sell ratio >= MIN_BUY_SELL_RATIO  (default 1.0)

  // Guard 1: minimum liquidity
  if (c.liquidityUsd < config.MIN_LIQUIDITY_USD) {
    return fail(
      `Rejected: liquidity $${fmt(c.liquidityUsd)} < strict min $${fmt(config.MIN_LIQUIDITY_USD)}`,
      redFlags,
      'liquidity_low'
    );
  }

  // Guard 2: minimum 5m momentum — token must be moving up
  if (c.priceChange5m < config.MIN_5M_PRICE_CHANGE_PCT) {
    return fail(
      `Rejected: 5m momentum ${c.priceChange5m.toFixed(1)}% < strict min +${config.MIN_5M_PRICE_CHANGE_PCT}%`,
      redFlags,
      'price_change'
    );
  }

  // Guard 3: buy-side pressure
  // A ratio of 0 means no trade data yet — treat as neutral (1.0) so very new
  // DexScreener tokens without a trade history are not incorrectly rejected.
  const entryBuySellRatio = c.buySellRatio === 0 ? 1.0 : c.buySellRatio;
  if (entryBuySellRatio < config.MIN_BUY_SELL_RATIO) {
    return fail(
      `Rejected: buy/sell ratio ${c.buySellRatio.toFixed(2)}x < strict min ${config.MIN_BUY_SELL_RATIO}x`,
      redFlags,
      'buy_sell_ratio'
    );
  }

  // ── 1. Pair age ────────────────────────────────────────────────────────────
  if (age < config.MIN_PAIR_AGE_MINUTES) {
    return fail(
      `Rejected: pair age ${age.toFixed(2)}m < min ${config.MIN_PAIR_AGE_MINUTES}m`,
      redFlags,
      'age'
    );
  }
  if (age > config.MAX_PAIR_AGE_MINUTES) {
    return fail(
      `Rejected: pair age ${age.toFixed(2)}m > max ${config.MAX_PAIR_AGE_MINUTES}m`,
      redFlags,
      'age'
    );
  }

  // ── 2. Liquidity band ──────────────────────────────────────────────────────
  // Unknown-age tokens require higher minimum liquidity.
  const minLiquidity = unknownAgeMode
    ? config.MIN_LIQUIDITY_USD_UNKNOWN_AGE
    : config.MIN_LIQUIDITY_USD;

  if (c.liquidityUsd < minLiquidity) {
    return fail(
      `Rejected: liquidity $${fmt(c.liquidityUsd)} < min $${fmt(minLiquidity)}` +
        (unknownAgeMode ? ' [unknown-age strict]' : ''),
      redFlags,
      'liquidity_low'
    );
  }
  if (c.liquidityUsd > config.MAX_LIQUIDITY_USD) {
    return fail(
      `Rejected: liquidity $${fmt(c.liquidityUsd)} > max $${fmt(config.MAX_LIQUIDITY_USD)}`,
      redFlags,
      'liquidity_high'
    );
  }

  // ── 3. Recent volume ───────────────────────────────────────────────────────
  // Unknown-age tokens require higher minimum volume.
  const minVolume = unknownAgeMode
    ? config.MIN_RECENT_VOLUME_USD_UNKNOWN_AGE
    : config.MIN_RECENT_VOLUME_USD;

  const recentVol = c.volume30m > 0 ? c.volume30m : c.volume1h / 2;
  if (recentVol < minVolume) {
    return fail(
      `Rejected: volume $${fmt(recentVol)} < min $${fmt(minVolume)}` +
        (unknownAgeMode ? ' [unknown-age strict]' : ''),
      redFlags,
      'volume'
    );
  }

  // ── 4. Buy count ───────────────────────────────────────────────────────────
  if (c.buyCount30m < config.MIN_RECENT_BUY_COUNT) {
    return fail(
      `Rejected: buy count ${c.buyCount30m} < min ${config.MIN_RECENT_BUY_COUNT} (30m)`,
      redFlags,
      'buy_count'
    );
  }

  // ── 5. Buy/sell ratio ──────────────────────────────────────────────────────
  // Unknown-age tokens require a stronger buy-side bias.
  // Ratio of 0 means no trade data yet — treat as neutral (1.0) rather than
  // rejecting, so early DexScreener tokens without buy/sell counts can pass.
  const minBuySellRatio = unknownAgeMode
    ? config.MIN_BUY_SELL_RATIO_UNKNOWN_AGE
    : config.MIN_BUY_SELL_RATIO;

  const effectiveRatio = c.buySellRatio === 0 ? 1.0 : c.buySellRatio;

  if (effectiveRatio < minBuySellRatio) {
    return fail(
      `Rejected: buy/sell ratio ${c.buySellRatio.toFixed(2)}x < min ${minBuySellRatio}x` +
        (unknownAgeMode ? ' [unknown-age strict]' : ''),
      redFlags,
      'buy_sell_ratio'
    );
  }

  // ── 6. Short-term price change caps ────────────────────────────────────────
  const absChange5m = Math.abs(c.priceChange5m);
  if (absChange5m > config.MAX_5M_PRICE_CHANGE_PCT) {
    return fail(
      `Rejected: 5m change |${c.priceChange5m.toFixed(1)}%| > cap ${config.MAX_5M_PRICE_CHANGE_PCT}%`,
      redFlags,
      'price_change'
    );
  }
  const absChange15m = Math.abs(c.priceChange15m);
  if (absChange15m > config.MAX_15M_PRICE_CHANGE_PCT) {
    return fail(
      `Rejected: 15m change |${c.priceChange15m.toFixed(1)}%| > cap ${config.MAX_15M_PRICE_CHANGE_PCT}%`,
      redFlags,
      'price_change'
    );
  }

  // ── 6b. Momentum floor ─────────────────────────────────────────────────────
  // Require a minimum positive 5m price move — filters out flat/declining tokens
  // and tokens with no 5m data (priceChange5m defaults to 0 when unavailable).
  if (c.priceChange5m < config.MIN_5M_PRICE_CHANGE_PCT) {
    return fail(
      `Rejected: 5m momentum ${c.priceChange5m.toFixed(1)}% < min +${config.MIN_5M_PRICE_CHANGE_PCT}%`,
      redFlags,
      'price_change'
    );
  }

  // ── 7. Missing or zero price ───────────────────────────────────────────────
  if (!c.price || c.price <= 0) {
    return fail('Rejected: token price is missing or zero -- unreliable market data', redFlags, 'price');
  }

  // ── 8. Red-flag suspicious behaviour checks ────────────────────────────────
  // Collapsing liquidity indicator: extreme sell pressure + low buy count
  if (c.sellCount30m > 0 && c.buyCount30m / c.sellCount30m < 0.5) {
    redFlags.push('Sell-side dominating: buys < 50% of sells');
  }

  // Extremely high price move with weak follow-through volume
  if (absChange5m > 80 && recentVol < config.MIN_RECENT_VOLUME_USD * 1.5) {
    redFlags.push('Sharp spike with insufficient volume follow-through');
  }

  // Negative short-term price direction (already rolling over)
  if (c.priceChange5m < -15) {
    redFlags.push(`Negative 5m momentum: ${c.priceChange5m.toFixed(1)}%`);
  }

  // Liquidity near lower boundary
  if (c.liquidityUsd < minLiquidity * 1.2) {
    redFlags.push('Liquidity near lower boundary -- elevated price-impact risk');
  }

  // Hard-reject on multiple severe flags
  const severeFlags = redFlags.filter((f) =>
    f.includes('Sell-side dominating') || f.includes('Negative 5m')
  );
  if (severeFlags.length >= 2) {
    return fail(`Rejected: multiple red flags -- ${severeFlags.join('; ')}`, redFlags, 'red_flags');
  }

  return {
    pass: true,
    reason: unknownAgeMode
      ? 'All hard filters passed [unknown-age strict mode]'
      : 'All hard filters passed',
    redFlags,
    unknownAgeFiltersApplied: unknownAgeMode,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fail(reason: string, redFlags: string[], rejectedBy: FilterRejectionCategory): FilterResult {
  return { pass: false, reason, redFlags, rejectedBy };
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
