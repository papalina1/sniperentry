/**
 * BirdeyeService — candidate store and Birdeye market-data enrichment.
 *
 * This module owns:
 *   - The in-memory candidate map (single source of truth for all discovered tokens)
 *   - Birdeye token_overview fetching (with caching and rate-limit awareness)
 *   - Candidate construction from Birdeye overview OR raw provider data
 *   - Discovery stats reporting
 *
 * Token list fetching (new-listing / tokenlist / trending) has been moved to
 * providers/birdeyeProvider.ts. The discovery loop is now owned by discoveryManager.ts.
 *
 * Age states:
 *   verified  — explicit listing/creation timestamp from API
 *   estimated — proxy timestamp (lastTradeUnixTime, pairCreatedAtMs) or carried forward
 *   unknown   — no timestamp available; synthetic fallback value used
 *
 * Birdeye API notes:
 *   - Chain specified via `x-chain` header (not a query param)
 *   - Rate limit: ~30-50 req/min on free tier; 429 handled by birdeyeProvider
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../../config';
import { logger } from '../../logger';
import {
  AgeState,
  BirdeyeNewListingItem,
  BirdeyeTokenOverview,
  TokenCandidate,
} from '../../types';
import { RawDiscoveryToken } from './providers/types';

// ─── In-memory state ──────────────────────────────────────────────────────────

const candidateMap       = new Map<string, TokenCandidate>();
const permanentlyRejected = new Set<string>();

export let birdeyeHealthy = true;

// ─── Overview cache ───────────────────────────────────────────────────────────

interface OverviewCacheEntry {
  data: BirdeyeTokenOverview;
  cachedAt: number;
}
const overviewCache = new Map<string, OverviewCacheEntry>();
const OVERVIEW_CACHE_TTL_MS = 30_000; // 30 seconds

// ─── Discovery stats ──────────────────────────────────────────────────────────

export interface DiscoveryStats {
  cycleAt: number;
  totalFetched: number;
  overviewAttempted: number;
  overviewSucceeded: number;
  overviewFailed: number;
  rateLimitedCount: number;
  removedByDiscoveryAge: number;
  remainingAfterDiscovery: number;
  verifiedAgeCount: number;
  estimatedAgeCount: number;
  unknownAgeCount: number;
}

export let lastDiscoveryStats: DiscoveryStats = {
  cycleAt: 0,
  totalFetched: 0,
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

export function setLastDiscoveryStats(stats: DiscoveryStats): void {
  lastDiscoveryStats = stats;
}

// ─── Axios client (overview calls only) ──────────────────────────────────────

function buildClient(): AxiosInstance {
  return axios.create({
    baseURL: config.BIRDEYE_API_BASE,
    timeout: 12_000,
    headers: {
      'x-api-key': config.BIRDEYE_API_KEY,
      'x-chain':   'solana',
      'Accept':    'application/json',
    },
  });
}

const client = buildClient();

// ─── Public candidate-store API ───────────────────────────────────────────────

export function getAllCandidates(): TokenCandidate[] {
  return Array.from(candidateMap.values());
}

export function getCandidate(mint: string): TokenCandidate | undefined {
  return candidateMap.get(mint);
}

export function updateCandidateStatus(
  mint: string,
  status: TokenCandidate['status'],
  extra?: Partial<TokenCandidate>
): void {
  const existing = candidateMap.get(mint);
  if (existing) {
    candidateMap.set(mint, { ...existing, ...extra, status, lastUpdated: Date.now() });
  }
}

export function rejectPermanently(mint: string): void {
  permanentlyRejected.add(mint);
}

export function isPermanentlyRejected(mint: string): boolean {
  return permanentlyRejected.has(mint);
}

// ─── addOrUpdateCandidate ─────────────────────────────────────────────────────

/**
 * Build and store a candidate from a raw provider token + optional Birdeye overview.
 *
 * Called by discoveryManager for every merged token each cycle.
 * Returns the stored candidate, or null if the token was skipped.
 * The returned candidate's status will be 'discovery_age_filtered' when the age cap rejected it.
 */
export function addOrUpdateCandidate(
  raw: RawDiscoveryToken,
  ov: BirdeyeTokenOverview | null
): TokenCandidate | null {
  const mint = raw.mint;
  if (!mint || mint.length < 32 || mint === config.SOL_MINT) return null;
  if (permanentlyRejected.has(mint)) return null;

  const existing = candidateMap.get(mint);

  // Skip frequent re-processing of already-advanced candidates (positions etc.)
  if (
    existing &&
    (existing.status === 'pending_buy' || existing.status === 'bought') &&
    Date.now() - existing.lastUpdated < 45_000
  ) return existing;

  // Build candidate
  let candidate: TokenCandidate | null;

  if (ov) {
    // Rich path: Birdeye overview available
    const item: BirdeyeNewListingItem = {
      address:          mint,
      symbol:           raw.symbol,
      name:             raw.name,
      decimals:         raw.decimals,
      listing_time:     raw.listingTimeSec,
      lastTradeUnixTime: raw.lastTradeTimeSec,
      liquidity:        raw.liquidityUsd,
    };
    candidate = buildCandidate(item, ov);
  } else {
    // Lean path: no overview — build from raw provider data
    candidate = buildCandidateFromRawOnly(raw);
  }

  if (!candidate) return null;

  // ── Discovery age cap ────────────────────────────────────────────────────────
  if (candidate.pairAgeMinutes > config.MAX_DISCOVERY_AGE_MINUTES) {
    candidate.status = 'discovery_age_filtered';
    candidate.rejectionReason =
      `Discovery age cap: ${candidate.pairAgeMinutes.toFixed(1)} min > ` +
      `max ${config.MAX_DISCOVERY_AGE_MINUTES} min [age ${candidate.ageState}]`;
    logger.debug(
      'Discovery',
      `[AGE CAP] ${candidate.symbol}: ${candidate.rejectionReason}`
    );
    // Only store if not already further along the pipeline
    if (!existing || existing.status === 'discovered' || existing.status === 'discovery_age_filtered') {
      candidateMap.set(mint, candidate);
    }
    return candidate; // caller checks status to count age-filtered
  }

  if (!existing) {
    logger.info(
      'Discovery',
      `NEW token: ${candidate.symbol} (${mint.slice(0, 8)}…) [${raw.sources.join('+')}]`,
      {
        liq:      '$' + fmtK(candidate.liquidityUsd),
        age:      candidate.pairAgeMinutes.toFixed(1) + 'm',
        ageState: candidate.ageState,
        ageSource: candidate.ageSource,
      }
    );
  }

  // ── Preserve status for in-pipeline candidates ───────────────────────────────
  if (existing && existing.status !== 'discovered') {
    candidate.status       = existing.status;
    candidate.score        = existing.score;
    candidate.scoreDetails = existing.scoreDetails;
    candidate.discoveredAt = existing.discoveredAt;
    // Don't downgrade a previously verified age
    if (existing.ageState === 'verified' && candidate.ageState !== 'verified') {
      candidate.ageState      = existing.ageState;
      candidate.ageSource     = existing.ageSource + '(preserved)';
      candidate.pairAgeMinutes = existing.pairAgeMinutes +
        (Date.now() - existing.lastUpdated) / 60_000;
    }
  }

  candidateMap.set(mint, candidate);
  return candidate;
}

// ─── Token overview ───────────────────────────────────────────────────────────

/**
 * Fetches /defi/token_overview for a single mint.
 *
 * Returns:
 *   BirdeyeTokenOverview  — successful fetch (possibly from cache)
 *   null                  — fetch failed (non-rate-limit error)
 *   'rate_limited'        — 429 received; caller should stop enrichment
 */
export async function fetchTokenOverview(
  mint: string
): Promise<BirdeyeTokenOverview | null | 'rate_limited'> {
  const cached = overviewCache.get(mint);
  if (cached && Date.now() - cached.cachedAt < OVERVIEW_CACHE_TTL_MS) {
    return cached.data;
  }

  const endpoint = '/defi/token_overview';
  logger.debug('Discovery', `[OVERVIEW] GET ${config.BIRDEYE_API_BASE}${endpoint}?address=${mint.slice(0, 8)}…`);

  try {
    const resp = await client.get(endpoint, { params: { address: mint } });
    const data = resp.data?.data ?? resp.data;
    if (!data || !data.address) return null;

    overviewCache.set(mint, { data: data as BirdeyeTokenOverview, cachedAt: Date.now() });
    birdeyeHealthy = true;
    return data as BirdeyeTokenOverview;
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 429) {
      // Rate-limit state is managed by birdeyeProvider; just signal to caller
      return 'rate_limited';
    }
    logger.debug('Discovery', `[OVERVIEW] Failed for ${mint.slice(0, 8)}`, { err: String(err) });
    return null;
  }
}

/** Called by positionManager to get fresh market data for open positions. */
export async function refreshCandidate(mint: string): Promise<TokenCandidate | null> {
  const overviewResult = await fetchTokenOverview(mint);
  if (!overviewResult || overviewResult === 'rate_limited') return null;

  const existing = candidateMap.get(mint);
  const listing: BirdeyeNewListingItem = {
    address: mint,
    symbol:  existing?.symbol ?? overviewResult.symbol ?? '?',
    name:    existing?.name   ?? overviewResult.name   ?? '?',
    listing_time: existing
      ? Math.floor((Date.now() - existing.pairAgeMinutes * 60_000) / 1000)
      : undefined,
  };

  const candidate = buildCandidate(listing, overviewResult);
  if (!candidate) return null;

  if (existing) {
    candidate.status        = existing.status;
    candidate.score         = existing.score;
    candidate.scoreDetails  = existing.scoreDetails;
    candidate.rejectionReason = existing.rejectionReason;
    candidate.redFlags      = existing.redFlags;
    candidate.passedFilters = existing.passedFilters;
    candidate.discoveredAt  = existing.discoveredAt;
    if (existing.ageState === 'verified' && candidate.ageState !== 'verified') {
      candidate.ageState       = existing.ageState;
      candidate.ageSource      = existing.ageSource + '(preserved-refresh)';
      candidate.pairAgeMinutes = existing.pairAgeMinutes +
        (Date.now() - existing.lastUpdated) / 60_000;
    }
  }

  candidateMap.set(mint, candidate);
  return candidate;
}

// ─── Candidate construction — Birdeye overview path ──────────────────────────

function buildCandidate(
  item: BirdeyeNewListingItem,
  ov: BirdeyeTokenOverview
): TokenCandidate | null {
  const mint = ov.address || item.address;
  if (!mint || mint === config.SOL_MINT) return null;

  const ovRaw = ov as unknown as Record<string, unknown>;

  let ageSource = 'unknown';
  let ageState: AgeState = 'unknown';
  let listingTimeSrc: number | undefined;

  if (item.listing_time !== undefined) {
    listingTimeSrc = item.listing_time;
    ageSource = 'listing_time';
    ageState  = 'verified';
  } else if (item.listingTime !== undefined) {
    listingTimeSrc = item.listingTime;
    ageSource = 'listingTime';
    ageState  = 'verified';
  } else if (typeof ovRaw['firstTradeUnixTime'] === 'number') {
    listingTimeSrc = ovRaw['firstTradeUnixTime'] as number;
    ageSource = 'firstTradeUnixTime';
    ageState  = 'verified';
  } else if (typeof ovRaw['createdAt'] === 'number') {
    listingTimeSrc = ovRaw['createdAt'] as number;
    ageSource = 'createdAt';
    ageState  = 'verified';
  } else if (typeof item.lastTradeUnixTime === 'number') {
    listingTimeSrc = item.lastTradeUnixTime;
    ageSource = 'lastTradeUnixTime';
    ageState  = 'estimated';
  }

  let pairAgeMinutes: number;

  if (listingTimeSrc !== undefined) {
    const listingTimeMs = listingTimeSrc > 1e12 ? listingTimeSrc : listingTimeSrc * 1000;
    const ageMs = Date.now() - listingTimeMs;
    pairAgeMinutes = ageMs / 60_000;
    const tsUnit = listingTimeSrc > 1e12 ? 'ms' : 'sec';
    logger.debug(
      'Discovery',
      `[AGE] ${ov.symbol || item.symbol}: src=${ageSource} state=${ageState} ` +
      `rawTs=${listingTimeSrc}(${tsUnit}) age=${pairAgeMinutes.toFixed(2)}m`
    );
  } else {
    const existing = candidateMap.get(mint);
    if (existing) {
      pairAgeMinutes = existing.pairAgeMinutes + (Date.now() - existing.lastUpdated) / 60_000;
      ageSource = 'carried_forward';
      ageState  = existing.ageState === 'verified' ? 'estimated' : existing.ageState;
    } else {
      pairAgeMinutes = config.MIN_PAIR_AGE_MINUTES + 1;
      ageSource = 'fallback';
      ageState  = 'unknown';
    }
    logger.debug(
      'Discovery',
      `[AGE] ${ov.symbol || item.symbol}: src=${ageSource} state=${ageState} age=${pairAgeMinutes.toFixed(2)}m`
    );
  }

  pairAgeMinutes = Math.max(0, pairAgeMinutes);

  const volume30m = ov.v30mUSD ?? ov.volume30m ?? 0;
  const volume1h  = ov.v1hUSD  ?? ov.volume1h  ?? volume30m * 2;

  const buyCount30m  = ov.buy30m  ?? Math.floor((ov.buy1h  ?? 0) / 2);
  const sellCount30m = ov.sell30m ?? Math.floor((ov.sell1h ?? 0) / 2);
  const buySellRatio = sellCount30m > 0
    ? buyCount30m / sellCount30m
    : (buyCount30m > 0 ? buyCount30m : 0);

  const priceChange5m  = ov.priceChange5mPercent  ?? ov.priceChange30mPercent ?? 0;
  const priceChange15m = ov.priceChange15mPercent ?? ov.priceChange30mPercent ?? 0;
  const priceChange30m = ov.priceChange30mPercent ?? 0;
  const priceChange1h  = ov.priceChange1hPercent  ?? 0;

  const now = Date.now();
  return {
    mint,
    symbol:   ov.symbol || item.symbol || 'UNKNOWN',
    name:     ov.name   || item.name   || 'Unknown Token',
    decimals: ov.decimals ?? item.decimals ?? 6,
    discoveredAt: now,
    lastUpdated:  now,
    status: 'discovered',

    price:        ov.price    ?? 0,
    liquidityUsd: ov.liquidity ?? 0,
    volume24h:    ov.v24hUSD  ?? ov.volume24h ?? 0,
    volume1h,
    volume30m,
    priceChange5m,
    priceChange15m,
    priceChange30m,
    priceChange1h,
    buyCount30m,
    sellCount30m,
    buySellRatio,
    pairAgeMinutes,
    fdv: ov.fdv,
    mc:  ov.mc,

    ageState,
    ageSource,

    passedFilters: false,
    redFlags:      [],
  };
}

// ─── Candidate construction — raw provider path (no Birdeye overview) ─────────

function buildCandidateFromRawOnly(raw: RawDiscoveryToken): TokenCandidate | null {
  const mint = raw.mint;
  if (!mint || mint === config.SOL_MINT) return null;

  let ageSource = 'unknown';
  let ageState: AgeState = 'unknown';
  let pairAgeMinutes: number;

  if (raw.listingTimeSec !== undefined) {
    const ageMs = Date.now() - raw.listingTimeSec * 1000;
    pairAgeMinutes = Math.max(0, ageMs / 60_000);
    ageSource = 'listingTimeSec';
    ageState  = 'verified';
  } else if (raw.pairCreatedAtMs !== undefined) {
    const ageMs = Date.now() - raw.pairCreatedAtMs;
    pairAgeMinutes = Math.max(0, ageMs / 60_000);
    ageSource = 'pairCreatedAtMs';
    ageState  = 'verified';
  } else if (raw.lastTradeTimeSec !== undefined) {
    const ageMs = Date.now() - raw.lastTradeTimeSec * 1000;
    pairAgeMinutes = Math.max(0, ageMs / 60_000);
    ageSource = 'lastTradeTimeSec';
    ageState  = 'estimated';
  } else {
    const existing = candidateMap.get(mint);
    if (existing) {
      pairAgeMinutes = existing.pairAgeMinutes + (Date.now() - existing.lastUpdated) / 60_000;
      ageSource = 'carried_forward';
      ageState  = existing.ageState === 'verified' ? 'estimated' : existing.ageState;
    } else {
      pairAgeMinutes = config.MIN_PAIR_AGE_MINUTES + 1;
      ageSource = 'fallback';
      ageState  = 'unknown';
    }
  }

  logger.debug(
    'Discovery',
    `[AGE-RAW] ${raw.symbol}: src=${ageSource} state=${ageState} age=${pairAgeMinutes.toFixed(2)}m [${raw.sources.join('+')}]`
  );

  const now = Date.now();
  return {
    mint,
    symbol:   raw.symbol  || 'UNKNOWN',
    name:     raw.name    || 'Unknown Token',
    decimals: raw.decimals ?? 6,
    discoveredAt: now,
    lastUpdated:  now,
    status: 'discovered',

    price:        raw.priceUsd     ?? 0,
    liquidityUsd: raw.liquidityUsd ?? 0,
    volume24h:    raw.volume24hUsd ?? 0,
    volume1h:     raw.volume1hUsd  ?? 0,
    volume30m:    0,
    priceChange5m:  raw.priceChange5mPct  ?? 0,
    priceChange15m: 0,
    priceChange30m: 0,
    priceChange1h:  raw.priceChange1hPct  ?? 0,
    buyCount30m:  0,
    sellCount30m: 0,
    buySellRatio: 0,
    pairAgeMinutes,
    fdv: undefined,
    mc:  undefined,

    ageState,
    ageSource,

    passedFilters: false,
    redFlags:      [],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(0);
}
