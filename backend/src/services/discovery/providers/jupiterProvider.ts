/**
 * JupiterDiscoveryProvider — trust-signal enrichment via Jupiter's strict token list.
 *
 * Role in the discovery pipeline:
 *   - PRIMARY USE: trust / verification signals.
 *     Tokens that appear in Jupiter's strict list are known, tradeable, and
 *     verified by the Jupiter community. Being in the list boosts confidence.
 *   - SECONDARY USE: new-token discovery via Jupiter's "new" endpoint
 *     (https://lite-api.jup.ag/tokens/v1/new). Attempted on every cycle;
 *     gracefully disabled if the endpoint returns 404.
 *
 * The strict-list cache is refreshed at most every STRICT_CACHE_TTL_MS (30 min).
 * Discovery results from this provider are only the "new" endpoint tokens;
 * the strict list itself is exposed via isJupiterVerified() for use by the manager.
 *
 * No API key required.
 */

import axios from 'axios';
import { logger } from '../../../logger';
import { IDiscoveryProvider, ProviderFetchResult, RawDiscoveryToken } from './types';

const STRICT_URL  = 'https://token.jup.ag/strict';
const NEW_URL     = 'https://lite-api.jup.ag/tokens/v1/new';
const STRICT_CACHE_TTL_MS = 30 * 60 * 1_000; // 30 min

interface JupiterToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  tags?: string[];
}

// ─── Strict-list cache (shared with DiscoveryManager via isJupiterVerified) ──

let strictCache = new Map<string, JupiterToken>();
let strictLoadedAt = 0;

/** Whether the Jupiter strict list has been loaded at least once. */
export function isJupiterCacheReady(): boolean {
  return strictCache.size > 0;
}

/** Returns true if the mint is in Jupiter's verified strict list. */
export function isJupiterVerified(mint: string): boolean {
  return strictCache.has(mint);
}

/** Returns token metadata for a verified mint, if available. */
export function getJupiterTokenMeta(mint: string): JupiterToken | undefined {
  return strictCache.get(mint);
}

async function refreshStrictList(): Promise<void> {
  if (Date.now() - strictLoadedAt < STRICT_CACHE_TTL_MS) return;
  try {
    logger.debug('Jupiter', `Refreshing strict token list from ${STRICT_URL}`);
    const resp = await axios.get<JupiterToken[]>(STRICT_URL, { timeout: 20_000 });
    if (!Array.isArray(resp.data)) return;
    strictCache = new Map(resp.data.map(t => [t.address, t]));
    strictLoadedAt = Date.now();
    logger.debug('Jupiter', `Strict list cached — ${strictCache.size} verified tokens`);
  } catch (err: unknown) {
    const msg = (err as { message?: string }).message ?? String(err);
    // DNS errors for token.jup.ag are non-critical — the strict list is a trust
    // signal only. Only the quote endpoint (api.jup.ag) determines Jupiter health.
    const isDns = msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN') || msg.includes('ECONNREFUSED');
    if (isDns) {
      logger.debug('Jupiter', `Strict list unavailable (network): ${msg}`);
    } else {
      logger.warn('Jupiter', `Strict list refresh failed: ${msg}`);
    }
  }
}

// ─── New-token discovery (best-effort) ────────────────────────────────────────

let newEndpointDisabled = false;

async function fetchNewTokens(): Promise<RawDiscoveryToken[]> {
  if (newEndpointDisabled) return [];

  try {
    logger.debug('Jupiter', `GET ${NEW_URL}`);
    const resp = await axios.get<JupiterToken[]>(NEW_URL, { timeout: 10_000 });
    if (!Array.isArray(resp.data)) return [];

    return resp.data
      .filter(t => t.address?.length >= 32)
      .slice(0, 15)
      .map(t => ({
        mint:       t.address,
        symbol:     t.symbol || '?',
        name:       t.name   || '?',
        decimals:   t.decimals,
        sources:    ['jupiter'] as RawDiscoveryToken['sources'],
        confidence: 'medium' as const,
        jupiterVerified: true,
      }));
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 404 || status === 405) {
      newEndpointDisabled = true;
      logger.warn('Jupiter', `${NEW_URL} returned ${status} — disabling new-token discovery from Jupiter (trust signals still active)`);
    } else {
      logger.debug('Jupiter', `New-tokens fetch failed: ${(err as { message?: string }).message ?? String(err)}`);
    }
    return [];
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class JupiterDiscoveryProvider implements IDiscoveryProvider {
  readonly name = 'jupiter' as const;

  async fetch(): Promise<ProviderFetchResult> {
    // Always refresh the strict cache (rate-controlled internally)
    await refreshStrictList();

    // Best-effort: discover new tokens from Jupiter's "new" endpoint
    const newTokens = await fetchNewTokens();

    // Provider is healthy as long as the strict cache has data
    const healthy = isJupiterCacheReady();
    return { tokens: newTokens, healthy };
  }
}
