/**
 * ScoringService — 0–100 composite score for a token candidate.
 *
 * Scoring model:
 *
 *   Positive factors (85 pts possible)
 *     liquidity quality     0–20
 *     momentum quality      0–20
 *     buy pressure quality  0–20
 *     timing / age quality  0–15
 *     quote / execution     0–10
 *
 *   Penalties (-35 pts possible)
 *     volatility penalty    0 to -5
 *     late-entry penalty    0 to -5
 *     slippage penalty      0 to -10
 *     suspicious penalty    0 to -10
 *     concentration penalty 0 to -5
 *
 * Final score is clamped to [0, 100].
 * Caller passes an optional priceImpactPct from Jupiter; without it the
 * quote/execution factor uses a neutral value.
 */

import { config } from '../../config';
import { TokenCandidate, ScoreBreakdown, ScoreResult } from '../../types';

interface ScoringInput {
  candidate: TokenCandidate;
  priceImpactPct?: number;  // from Jupiter quote; undefined = not yet quoted
}

export function scoreCandidate({ candidate: c, priceImpactPct }: ScoringInput): ScoreResult {
  // ── Positive factors ──────────────────────────────────────────────────────

  const liquidityScore    = scoreLiquidity(c.liquidityUsd);
  const momentumScore     = scoreMomentum(c.priceChange5m, c.priceChange30m, c.priceChange1h);
  const buyPressureScore  = scoreBuyPressure(c.buyCount30m, c.sellCount30m, c.buySellRatio);
  const timingScore       = scoreTiming(c.pairAgeMinutes);
  const quoteScore        = scoreQuoteExecution(priceImpactPct);

  // ── Penalties ─────────────────────────────────────────────────────────────

  const volatilityPenalty     = penaltyVolatility(c.priceChange5m);
  const lateEntryPenalty      = penaltyLateEntry(c.pairAgeMinutes);
  const slippagePenalty       = penaltySlippage(priceImpactPct);
  const suspiciousPenalty     = penaltySuspicious(c);
  const concentrationPenalty  = penaltyConcentration(c);

  // ── Totals ────────────────────────────────────────────────────────────────

  const rawTotal =
    liquidityScore + momentumScore + buyPressureScore + timingScore + quoteScore +
    volatilityPenalty + lateEntryPenalty + slippagePenalty +
    suspiciousPenalty + concentrationPenalty;

  const total = Math.max(0, Math.min(100, Math.round(rawTotal)));

  const breakdown: ScoreBreakdown = {
    liquidityScore,
    momentumScore,
    buyPressureScore,
    timingScore,
    quoteScore,
    volatilityPenalty,
    lateEntryPenalty,
    slippagePenalty,
    suspiciousPenalty,
    concentrationPenalty,
  };

  const grade: ScoreResult['grade'] =
    total >= config.MIN_SCORE ? 'pass' : total >= config.MIN_SCORE - 10 ? 'warn' : 'reject';

  const summary = buildSummary(total, grade, breakdown, c);

  return { total, grade, summary, breakdown };
}

// ─── Factor scorers ───────────────────────────────────────────────────────────

function scoreLiquidity(liq: number): number {
  // Perfect band is $60 k – $150 k. Either end of the range loses points.
  if (liq <= 0) return 0;
  if (liq < 30_000)   return 4;
  if (liq < 50_000)   return 10;
  if (liq < 60_000)   return 14;
  if (liq <= 150_000) return 20;  // sweet spot
  if (liq <= 200_000) return 16;
  return 12; // $200 k – $250 k: extended
}

function scoreMomentum(change5m: number, change30m: number, change1h: number): number {
  // We want controlled, sustained upward momentum — not a spike or a flat line.
  let score = 0;

  // 5 m trend — mild positive is ideal
  if (change5m > 0 && change5m <= 30)  score += 8;
  else if (change5m > 30 && change5m <= 60) score += 5;
  else if (change5m > 60)              score += 2;
  else if (change5m > -5)              score += 4; // flat, neutral
  else                                 score += 0; // negative

  // 30 m trend — should confirm 5 m direction
  if (change30m > 10 && change30m <= 80) score += 7;
  else if (change30m > 0)               score += 4;
  else                                  score += 0;

  // 1 h trend — sustained move scores well
  if (change1h > 20 && change1h <= 120) score += 5;
  else if (change1h > 0)               score += 3;
  else                                 score += 0;

  return Math.min(20, score);
}

function scoreBuyPressure(buys: number, sells: number, ratio: number): number {
  let score = 0;

  // Raw buy count
  if (buys >= 100) score += 8;
  else if (buys >= 60) score += 6;
  else if (buys >= 40) score += 4;
  else                 score += 2;

  // Buy/sell ratio
  if (ratio >= 4)   score += 8;
  else if (ratio >= 3) score += 6;
  else if (ratio >= 2) score += 4;
  else              score += 2;

  // Absolute sell count — many sells alongside buys means liquidity + participation
  if (sells > 10) score += 4;

  return Math.min(20, score);
}

function scoreTiming(ageMinutes: number): number {
  // Ideal window: 5–15 min. Score degrades gradually up to 180 min max.
  if (ageMinutes < 2)    return 0;
  if (ageMinutes < 5)    return 6;
  if (ageMinutes <= 15)  return 15; // best window
  if (ageMinutes <= 30)  return 12;
  if (ageMinutes <= 60)  return 8;
  if (ageMinutes <= 120) return 4;
  if (ageMinutes <= 180) return 2;
  return 0;
}

function scoreQuoteExecution(priceImpactPct?: number): number {
  if (priceImpactPct === undefined) return 5; // neutral — not yet quoted
  if (priceImpactPct < 1)   return 10;
  if (priceImpactPct < 3)   return 8;
  if (priceImpactPct < 6)   return 5;
  if (priceImpactPct < 10)  return 2;
  return 0; // high impact
}

// ─── Penalty scorers ──────────────────────────────────────────────────────────

function penaltyVolatility(change5m: number): number {
  const abs = Math.abs(change5m);
  if (abs > 100) return -5;
  if (abs > 70)  return -3;
  if (abs > 40)  return -1;
  return 0;
}

function penaltyLateEntry(ageMinutes: number): number {
  if (ageMinutes > 120) return -5;
  if (ageMinutes > 60)  return -3;
  if (ageMinutes > 30)  return -1;
  return 0;
}

function penaltySlippage(priceImpactPct?: number): number {
  if (priceImpactPct === undefined) return 0;
  if (priceImpactPct >= 10) return -10;
  if (priceImpactPct >= 7)  return -7;
  if (priceImpactPct >= 4)  return -4;
  if (priceImpactPct >= 2)  return -2;
  return 0;
}

function penaltySuspicious(c: TokenCandidate): number {
  let penalty = 0;

  // Sell pressure spike
  if (c.sellCount30m > c.buyCount30m * 1.5) penalty -= 5;

  // Extreme vertical move with limited volume
  if (Math.abs(c.priceChange5m) > 80 && c.volume30m < config.MIN_RECENT_VOLUME_USD * 1.2) {
    penalty -= 5;
  }

  // Accumulated red flags from the filter stage
  penalty -= Math.min(10, c.redFlags.length * 2);

  return Math.max(-10, penalty);
}

function penaltyConcentration(c: TokenCandidate): number {
  // Proxy: if volume-to-liquidity ratio is very high it suggests concentrated activity
  const ratio = c.liquidityUsd > 0 ? c.volume30m / c.liquidityUsd : 0;
  if (ratio > 5) return -5;
  if (ratio > 3) return -3;
  return 0;
}

// ─── Human-readable summary ───────────────────────────────────────────────────

function buildSummary(
  total: number,
  grade: ScoreResult['grade'],
  bd: ScoreBreakdown,
  c: TokenCandidate
): string {
  const parts: string[] = [`Score ${total}/100 — ${grade.toUpperCase()}.`];

  if (bd.liquidityScore >= 18) parts.push('Liquidity excellent.');
  else if (bd.liquidityScore <= 8) parts.push('Liquidity weak.');

  if (bd.momentumScore >= 15) parts.push('Momentum strong.');
  else if (bd.momentumScore <= 5) parts.push('Momentum weak or absent.');

  if (bd.buyPressureScore >= 15) parts.push('Buy pressure solid.');
  else if (bd.buyPressureScore <= 6) parts.push('Buy pressure insufficient.');

  if (bd.timingScore >= 13) parts.push('Entry timing in ideal window.');
  else if (bd.timingScore <= 5) parts.push('Entry timing poor (too early or late).');

  const penalties = [
    bd.volatilityPenalty,
    bd.lateEntryPenalty,
    bd.slippagePenalty,
    bd.suspiciousPenalty,
    bd.concentrationPenalty,
  ].reduce((a, b) => a + b, 0);

  if (penalties < -10) parts.push(`Heavy penalties applied (${penalties} pts).`);

  if (c.redFlags.length > 0) {
    parts.push(`Red flags: ${c.redFlags.join(', ')}.`);
  }

  return parts.join(' ');
}
