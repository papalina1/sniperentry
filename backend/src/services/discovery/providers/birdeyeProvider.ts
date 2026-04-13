/**
 * BirdeyeDiscoveryProvider
 *
 * Extracts Birdeye list-fetching from birdeyeService.ts so it can participate
 * in the multi-source DiscoveryManager as a first-class provider.
 *
 * Fetch strategy (tried in order, first success wins):
 *   1. /defi/v3/token/new-listing  (paid / Starter+ plans)
 *   2. /defi/tokenlist             (free tier, sorted by volume change)
 *   3. /defi/token_trending        (free tier, always available)
 *
 * CU-limit detection:
 *   A 400 response with body { message: "Compute units usage limit exceeded" }
 *   triggers a configurable long backoff (CU_LIMIT_BACKOFF_MS).
 *   While in backoff, the provider immediately returns healthy=false/degraded=true
 *   without touching any Birdeye endpoint.
 */

import axios, { AxiosInstance } from 'axios';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { IDiscoveryProvider, ProviderFetchResult, RawDiscoveryToken } from './types';

// ─── Module-level backoff state ───────────────────────────────────────────────

let rateLimitBackoffUntil = 0;
let cuLimitBackoffUntil   = 0;

let v3Consecutive404s        = 0;
const V3_404_THRESHOLD       = 3;
let v3PermanentlyUnavailable = false;

// ─── Exported helpers consumed by DiscoveryManager ───────────────────────────

export function isCuExceeded(): boolean {
  return Date.now() < cuLimitBackoffUntil;
}

export function isRateLimitedBirdeye(): boolean {
  return Date.now() < rateLimitBackoffUntil;
}

// ─── Axios client ─────────────────────────────────────────────────────────────

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

// ─── Error helpers ────────────────────────────────────────────────────────────

function isRateLimited(err: unknown): boolean {
  return (err as { response?: { status?: number } }).response?.status === 429;
}

function isCuLimitError(err: unknown): boolean {
  const axiosErr = err as { response?: { status?: number; data?: { message?: string } } };
  if (axiosErr.response?.status !== 400) return false;
  const msg = axiosErr.response?.data?.message ?? '';
  return typeof msg === 'string' && msg.includes('Compute units usage limit exceeded');
}

function applyRateLimitBackoff(seconds = 90): void {
  rateLimitBackoffUntil = Date.now() + seconds * 1_000;
  logger.warn('Birdeye', `Rate-limited — backing off ${seconds}s`);
}

function applyCuLimitBackoff(): void {
  cuLimitBackoffUntil = Date.now() + config.CU_LIMIT_BACKOFF_MS;
  const minutes = Math.round(config.CU_LIMIT_BACKOFF_MS / 60_000);
  logger.warn(
    'Birdeye',
    `Birdeye CU limit exceeded — discovery paused for ${minutes} min ` +
    `(resumes ~${new Date(cuLimitBackoffUntil).toLocaleTimeString()})`
  );
}

function log400Body(err: unknown, endpoint: string): void {
  const axiosErr = err as { response?: { status?: number; data?: unknown } };
  if (axiosErr.response?.status === 400) {
    logger.warn('Birdeye', `${endpoint} returned 400 — body: ${JSON.stringify(axiosErr.response.data).slice(0, 300)}`);
  }
}

function describeError(err: unknown): string {
  const axiosErr = err as { response?: { status?: number }; message?: string };
  const status = axiosErr.response?.status;
  return status ? `HTTP ${status} — ${axiosErr.message ?? String(err)}` : String(err);
}

// ─── Normalisation ────────────────────────────────────────────────────────────

function normalizeToRaw(raw: Record<string, unknown>): RawDiscoveryToken {
  const listingTimeSec: number | undefined =
    typeof raw['listing_time']  === 'number' ? raw['listing_time']  as number :
    typeof raw['listingTime']   === 'number' ? raw['listingTime']   as number :
    typeof raw['created_at']    === 'number' ? raw['created_at']    as number :
    typeof raw['pairCreatedAt'] === 'number' ? raw['pairCreatedAt'] as number :
    typeof raw['createdAt']     === 'number' ? raw['createdAt']     as number :
    undefined;

  const lastTradeTimeSec: number | undefined =
    typeof raw['lastTradeUnixTime'] === 'number' ? raw['lastTradeUnixTime'] as number : undefined;

  const liquidityUsd = typeof raw['liquidity'] === 'number' ? raw['liquidity'] as number : undefined;
  const priceUsd     = typeof raw['price']     === 'number' ? raw['price']     as number : undefined;
  const volume24hUsd =
    typeof raw['v24hUSD']   === 'number' ? raw['v24hUSD']   as number :
    typeof raw['volume24h'] === 'number' ? raw['volume24h'] as number : undefined;

  const hasVerified  = listingTimeSec  !== undefined;
  const hasEstimated = lastTradeTimeSec !== undefined;
  const confidence: RawDiscoveryToken['confidence'] =
    hasVerified ? 'high' : hasEstimated ? 'medium' : 'low';

  return {
    mint:          String(raw['address'] ?? raw['mint'] ?? ''),
    symbol:        String(raw['symbol']  ?? ''),
    name:          String(raw['name']    ?? ''),
    decimals:      typeof raw['decimals'] === 'number' ? raw['decimals'] as number : undefined,
    priceUsd,
    liquidityUsd,
    volume24hUsd,
    listingTimeSec,
    lastTradeTimeSec,
    sources:       ['birdeye'],
    confidence,
  };
}

// ─── Individual endpoint fetchers ─────────────────────────────────────────────

async function tryFetchV3NewListing(): Promise<RawDiscoveryToken[]> {
  const endpoint = '/defi/v3/token/new-listing';
  logger.debug('Birdeye', `GET ${config.BIRDEYE_API_BASE}${endpoint}?limit=10`);
  try {
    const resp = await client.get(endpoint, { params: { limit: 10 } });
    v3Consecutive404s = 0;
    const items: unknown[] =
      resp.data?.data?.items ?? resp.data?.data ?? resp.data?.items ?? [];
    if (!Array.isArray(items)) return [];
    return (items as Record<string, unknown>[])
      .map(normalizeToRaw)
      .filter(t => t.mint.length >= 32);
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 429) { applyRateLimitBackoff(90); return []; }
    if (config.DISCOVERY_PAUSE_ON_CU_LIMIT && isCuLimitError(err)) { applyCuLimitBackoff(); return []; }
    if (status === 404 || status === 403) {
      v3Consecutive404s++;
      if (v3Consecutive404s >= V3_404_THRESHOLD && !v3PermanentlyUnavailable) {
        v3PermanentlyUnavailable = true;
        logger.warn('Birdeye', `${endpoint} returned ${status} ×${v3Consecutive404s} — disabling for this session (paid endpoint)`);
      } else {
        logger.debug('Birdeye', `${endpoint} returned ${status} — falling back`);
      }
    } else {
      logger.debug('Birdeye', `${endpoint} failed — ${describeError(err)}`);
    }
    return [];
  }
}

async function tryFetchTokenList(): Promise<RawDiscoveryToken[]> {
  const endpoint = '/defi/tokenlist';
  const params = { sort_by: 'v24hChangePercent', sort_type: 'desc', offset: 0, limit: 20 };
  logger.debug('Birdeye', `GET ${config.BIRDEYE_API_BASE}${endpoint}?sort_by=${params.sort_by}&limit=${params.limit}`);
  try {
    const resp = await client.get(endpoint, { params });
    const tokens: unknown[] =
      resp.data?.data?.tokens ?? resp.data?.tokens ?? resp.data?.data ?? [];
    if (!Array.isArray(tokens) || tokens.length === 0) return [];
    return (tokens as Record<string, unknown>[])
      .map(normalizeToRaw)
      .filter(t => t.mint.length >= 32 && t.mint !== config.SOL_MINT)
      .slice(0, 10);
  } catch (err: unknown) {
    if (isRateLimited(err)) { applyRateLimitBackoff(90); return []; }
    if (config.DISCOVERY_PAUSE_ON_CU_LIMIT && isCuLimitError(err)) { applyCuLimitBackoff(); return []; }
    log400Body(err, endpoint);
    logger.warn('Birdeye', `${endpoint} failed — ${describeError(err)}`);
    return [];
  }
}

async function tryFetchTrending(): Promise<RawDiscoveryToken[]> {
  const endpoint = '/defi/token_trending';
  logger.debug('Birdeye', `GET ${config.BIRDEYE_API_BASE}${endpoint}?limit=10`);
  try {
    const resp = await client.get(endpoint, { params: { limit: 10 } });
    const tokens: unknown[] =
      resp.data?.data?.tokens ?? resp.data?.data?.items ?? resp.data?.items ?? resp.data?.tokens ?? [];
    if (!Array.isArray(tokens)) return [];
    return (tokens as Record<string, unknown>[])
      .map(normalizeToRaw)
      .filter(t => t.mint.length >= 32 && t.mint !== config.SOL_MINT)
      .slice(0, 10);
  } catch (err: unknown) {
    if (isRateLimited(err)) { applyRateLimitBackoff(90); return []; }
    if (config.DISCOVERY_PAUSE_ON_CU_LIMIT && isCuLimitError(err)) { applyCuLimitBackoff(); return []; }
    log400Body(err, endpoint);
    logger.warn('Birdeye', `${endpoint} failed — ${describeError(err)}`);
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Provider class ───────────────────────────────────────────────────────────

export class BirdeyeDiscoveryProvider implements IDiscoveryProvider {
  readonly name = 'birdeye' as const;

  async fetch(): Promise<ProviderFetchResult> {
    const now = Date.now();

    if (now < cuLimitBackoffUntil) {
      const remaining = Math.ceil((cuLimitBackoffUntil - now) / 60_000);
      logger.debug('Birdeye', `CU backoff active — ${remaining} min remaining`);
      return { tokens: [], healthy: false, degraded: true, error: 'CU limit backoff' };
    }

    if (now < rateLimitBackoffUntil) {
      const remaining = Math.ceil((rateLimitBackoffUntil - now) / 1_000);
      logger.debug('Birdeye', `Rate-limit backoff active — ${remaining}s remaining`);
      return { tokens: [], healthy: false, degraded: true, error: 'Rate-limit backoff' };
    }

    // Strategy 1: v3 paid endpoint
    if (!v3PermanentlyUnavailable) {
      const tokens = await tryFetchV3NewListing();
      if (isCuExceeded() || isRateLimitedBirdeye()) {
        return { tokens: [], healthy: false, degraded: true, error: 'Quota hit during v3 fetch' };
      }
      if (tokens.length > 0) {
        logger.debug('Birdeye', `v3/new-listing → ${tokens.length} tokens`);
        return { tokens, healthy: true };
      }
    }

    await sleep(500);

    // Strategy 2: tokenlist
    const listTokens = await tryFetchTokenList();
    if (isCuExceeded() || isRateLimitedBirdeye()) {
      return { tokens: [], healthy: false, degraded: true, error: 'Quota hit during tokenlist fetch' };
    }
    if (listTokens.length > 0) {
      logger.debug('Birdeye', `tokenlist → ${listTokens.length} tokens`);
      return { tokens: listTokens, healthy: true };
    }

    await sleep(500);

    // Strategy 3: trending
    const trendingTokens = await tryFetchTrending();
    if (isCuExceeded() || isRateLimitedBirdeye()) {
      return { tokens: [], healthy: false, degraded: true, error: 'Quota hit during trending fetch' };
    }

    if (trendingTokens.length > 0) {
      logger.debug('Birdeye', `trending → ${trendingTokens.length} tokens`);
      return { tokens: trendingTokens, healthy: true };
    }

    return { tokens: [], healthy: false, error: 'All Birdeye endpoints returned empty' };
  }
}
