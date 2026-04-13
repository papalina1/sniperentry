/**
 * DiscoveryManager — multi-source token discovery orchestrator.
 *
 * Runs BirdeyeDiscoveryProvider, DexScreenerDiscoveryProvider, and
 * JupiterDiscoveryProvider in parallel on every cycle. Results are merged
 * by mint address, enriched with Jupiter trust signals, then stored via
 * birdeyeService's candidate store.
 *
 * For tokens not sourced from Birdeye (i.e., only from DexScreener/Jupiter),
 * a Birdeye token_overview call is attempted (up to MAX_OVERVIEWS_PER_CYCLE)
 * to enrich market data. If that fails or CU is exceeded, the candidate is
 * built from raw provider data only.
 *
 * Exports:
 *   startDiscovery()            — start the recurring discovery loop
 *   stopDiscovery()             — stop it
 *   getDiscoverySystemStatus()  — DiscoverySystemStatus (multi-source view)
 *   getDiscoveryStatus()        — backwards-compat (NORMAL / RATE_LIMITED / CU_EXCEEDED)
 */

import { logger } from '../../logger';
import { config } from '../../config';
import { BirdeyeDiscoveryProvider, isCuExceeded, isRateLimitedBirdeye } from './providers/birdeyeProvider';
import { DexScreenerDiscoveryProvider } from './providers/dexScreenerProvider';
import { JupiterDiscoveryProvider, isJupiterVerified } from './providers/jupiterProvider';
import { RawDiscoveryToken, DiscoverySystemStatus } from './providers/types';
import {
  fetchTokenOverview,
  addOrUpdateCandidate,
  isPermanentlyRejected,
  setLastDiscoveryStats,
  DiscoveryStats,
} from './birdeyeService';

// ─── Providers ────────────────────────────────────────────────────────────────

const birdeyeProvider    = new BirdeyeDiscoveryProvider();
const dexscreenerProvider = new DexScreenerDiscoveryProvider();
const jupiterProvider    = new JupiterDiscoveryProvider();

// ─── Per-cycle cap ────────────────────────────────────────────────────────────

/** Maximum token_overview calls per cycle when enriching non-Birdeye tokens. */
const MAX_OVERVIEWS_PER_CYCLE = 3;

// ─── Discovery loop ───────────────────────────────────────────────────────────

let discoveryTimer: NodeJS.Timeout | null = null;

export async function startDiscovery(): Promise<void> {
  logger.info('Discovery', 'Starting multi-source discovery loop (birdeye + dexscreener + jupiter)');
  await runDiscoveryCycle();
  discoveryTimer = setInterval(runDiscoveryCycle, config.DISCOVERY_INTERVAL_MS);
}

export function stopDiscovery(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
    logger.info('Discovery', 'Discovery loop stopped');
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function getDiscoverySystemStatus(): DiscoverySystemStatus {
  const birdeyeDown = isCuExceeded() || isRateLimitedBirdeye();
  // DexScreener and Jupiter always run — system is at worst PARTIAL, not fully failed
  return birdeyeDown ? 'DISCOVERY_PARTIAL' : 'DISCOVERY_OK';
}

/** Backwards-compat type used by SystemState. */
export type DiscoveryStatus = 'NORMAL' | 'DISCOVERY_RATE_LIMITED' | 'DISCOVERY_CU_EXCEEDED';

export function getDiscoveryStatus(): DiscoveryStatus {
  if (isCuExceeded())         return 'DISCOVERY_CU_EXCEEDED';
  if (isRateLimitedBirdeye()) return 'DISCOVERY_RATE_LIMITED';
  return 'NORMAL';
}

// ─── Cycle ────────────────────────────────────────────────────────────────────

async function runDiscoveryCycle(): Promise<void> {
  try {
    // ── Run all three providers in parallel ───────────────────────────────────
    const [birdeyeSettled, dexSettled, jupSettled] = await Promise.allSettled([
      birdeyeProvider.fetch(),
      dexscreenerProvider.fetch(),
      jupiterProvider.fetch(),
    ]);

    const birdeyeTokens  = birdeyeSettled.status  === 'fulfilled' ? birdeyeSettled.value.tokens  : [];
    const dexTokens      = dexSettled.status       === 'fulfilled' ? dexSettled.value.tokens      : [];
    const jupTokens      = jupSettled.status        === 'fulfilled' ? jupSettled.value.tokens       : [];

    const birdeyeOk = birdeyeSettled.status === 'fulfilled' && birdeyeSettled.value.healthy;
    const dexOk     = dexSettled.status     === 'fulfilled' && dexSettled.value.healthy;
    const jupOk     = jupSettled.status     === 'fulfilled' && jupSettled.value.healthy;

    if (birdeyeSettled.status === 'rejected') logger.warn('Discovery', `Birdeye provider threw: ${birdeyeSettled.reason}`);
    if (dexSettled.status     === 'rejected') logger.warn('Discovery', `DexScreener provider threw: ${dexSettled.reason}`);
    if (jupSettled.status     === 'rejected') logger.warn('Discovery', `Jupiter provider threw: ${jupSettled.reason}`);

    logger.debug(
      'Discovery',
      `Sources: birdeye=${birdeyeTokens.length}(${birdeyeOk ? 'ok' : 'down'}) ` +
      `dex=${dexTokens.length}(${dexOk ? 'ok' : 'down'}) ` +
      `jup=${jupTokens.length}(${jupOk ? 'ok' : 'down'})`
    );

    // ── Merge by mint — combine sources, keep best available fields ───────────
    const merged = new Map<string, RawDiscoveryToken>();

    for (const token of [...birdeyeTokens, ...dexTokens, ...jupTokens]) {
      if (!token.mint || token.mint.length < 32 || token.mint === config.SOL_MINT) continue;
      if (isPermanentlyRejected(token.mint)) continue;

      const ex = merged.get(token.mint);
      if (!ex) {
        merged.set(token.mint, { ...token });
      } else {
        merged.set(token.mint, {
          ...ex,
          // Prefer non-undefined fields from new source
          priceUsd:         token.priceUsd         ?? ex.priceUsd,
          liquidityUsd:     token.liquidityUsd      ?? ex.liquidityUsd,
          volume24hUsd:     token.volume24hUsd      ?? ex.volume24hUsd,
          volume1hUsd:      token.volume1hUsd       ?? ex.volume1hUsd,
          priceChange5mPct: token.priceChange5mPct  ?? ex.priceChange5mPct,
          priceChange1hPct: token.priceChange1hPct  ?? ex.priceChange1hPct,
          listingTimeSec:   token.listingTimeSec    ?? ex.listingTimeSec,
          pairCreatedAtMs:  token.pairCreatedAtMs   ?? ex.pairCreatedAtMs,
          lastTradeTimeSec: token.lastTradeTimeSec  ?? ex.lastTradeTimeSec,
          sources:          [...new Set([...ex.sources, ...token.sources])],
          confidence:
            token.confidence === 'high' || ex.confidence === 'high' ? 'high' :
            token.confidence === 'medium' || ex.confidence === 'medium' ? 'medium' :
            'low',
          jupiterVerified: ex.jupiterVerified || token.jupiterVerified,
        });
      }
    }

    // ── Enrich with Jupiter strict-list trust signal ───────────────────────────
    for (const [mint, token] of merged) {
      if (!token.jupiterVerified && isJupiterVerified(mint)) {
        merged.set(mint, { ...token, jupiterVerified: true });
      }
    }

    if (merged.size === 0) {
      logger.debug('Discovery', 'No tokens to process this cycle');
      return;
    }

    // ── Sort: birdeye-sourced first (richest data), then by liquidity ─────────
    const sorted = [...merged.values()].sort((a, b) => {
      const aBird = a.sources.includes('birdeye') ? 1 : 0;
      const bBird = b.sources.includes('birdeye') ? 1 : 0;
      if (bBird !== aBird) return bBird - aBird;
      return (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0);
    });

    // ── Overview enrichment for non-Birdeye tokens ────────────────────────────
    const cycleStats: DiscoveryStats = {
      cycleAt: Date.now(),
      totalFetched: sorted.length,
      overviewAttempted: 0,
      overviewSucceeded: 0,
      overviewFailed: 0,
      rateLimitedCount: 0,
      removedByDiscoveryAge: 0,
      remainingAfterDiscovery: 0,
      verifiedAgeCount: 0,
      estimatedAgeCount: 0,
      unknownAgeCount: 0,
    };

    let overviewsUsed = 0;
    let rateLimitedThisCycle = false;

    for (const raw of sorted) {
      const fromBirdeye = raw.sources.includes('birdeye');
      const canFetchOverview =
        !fromBirdeye &&
        !rateLimitedThisCycle &&
        overviewsUsed < MAX_OVERVIEWS_PER_CYCLE &&
        !isCuExceeded() &&
        !isRateLimitedBirdeye();

      let ov = null;

      if (canFetchOverview) {
        await sleep(1500);
        cycleStats.overviewAttempted++;
        overviewsUsed++;

        const result = await fetchTokenOverview(raw.mint);
        if (result === 'rate_limited') {
          cycleStats.rateLimitedCount++;
          rateLimitedThisCycle = true;
          logger.warn('Discovery', `Rate-limited on overview for ${raw.mint.slice(0, 8)}… — stopping enrichment for this cycle`);
        } else if (result) {
          ov = result;
          cycleStats.overviewSucceeded++;
        } else {
          cycleStats.overviewFailed++;
        }
      }

      // Store candidate (age-cap filtering happens inside addOrUpdateCandidate)
      const stored = addOrUpdateCandidate(raw, ov);
      if (!stored) continue;

      if (stored.status === 'discovery_age_filtered') {
        cycleStats.removedByDiscoveryAge++;
      } else {
        cycleStats.remainingAfterDiscovery++;
        if      (stored.ageState === 'verified')  cycleStats.verifiedAgeCount++;
        else if (stored.ageState === 'estimated') cycleStats.estimatedAgeCount++;
        else                                       cycleStats.unknownAgeCount++;
      }
    }

    setLastDiscoveryStats(cycleStats);

    const highQualityCount = sorted.filter(t => (t.liquidityUsd ?? 0) >= 10_000).length;

    logger.info(
      'Discovery',
      `Cycle: ${sorted.length} merged (be=${birdeyeTokens.length} dex=${dexTokens.length} jup=${jupTokens.length}) | ` +
      `overviews ${cycleStats.overviewSucceeded}/${cycleStats.overviewAttempted} | ` +
      `age: ${cycleStats.verifiedAgeCount}v ${cycleStats.estimatedAgeCount}e ${cycleStats.unknownAgeCount}u | ` +
      `${cycleStats.remainingAfterDiscovery} active, ${cycleStats.removedByDiscoveryAge} age-capped`
    );
    logger.info('Discovery', `High-quality candidates this cycle: ${highQualityCount}`);

    if (
      cycleStats.totalFetched > 0 &&
      cycleStats.removedByDiscoveryAge / cycleStats.totalFetched > 0.8
    ) {
      logger.warn(
        'Discovery',
        `>80% of candidates removed by discovery age cap — ` +
        `MAX_DISCOVERY_AGE_MINUTES=${config.MAX_DISCOVERY_AGE_MINUTES} may be too strict`
      );
    }

  } catch (err: unknown) {
    logger.error('Discovery', 'Discovery cycle failed', { err: String(err) });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
