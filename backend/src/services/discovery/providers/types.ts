/**
 * Shared types for the multi-source discovery system.
 *
 * Every discovery provider maps its API response into RawDiscoveryToken before
 * returning. The DiscoveryManager then merges, deduplicates, and scores them.
 */

export type ProviderName = 'birdeye' | 'dexscreener' | 'jupiter';

/**
 * Normalised token data returned by any provider.
 * All fields except mint/symbol/name/sources/confidence are optional because
 * not every provider returns every field.
 */
export interface RawDiscoveryToken {
  mint: string;
  symbol: string;
  name: string;
  decimals?: number;

  // Market data
  pairAddress?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  volume1hUsd?: number;
  priceChange5mPct?: number;
  priceChange1hPct?: number;
  priceChange24hPct?: number;

  // Age signals — prefer listingTimeSec (explicit creation time)
  pairCreatedAtMs?: number;    // DexScreener pairCreatedAt (already in ms)
  listingTimeSec?: number;     // Explicit creation timestamp (unix seconds)
  lastTradeTimeSec?: number;   // Proxy for age estimation (unix seconds)

  // Provenance
  sources: ProviderName[];
  confidence: 'high' | 'medium' | 'low';
  jupiterVerified?: boolean;
}

export interface ProviderFetchResult {
  tokens: RawDiscoveryToken[];
  /** True when the provider responded successfully (even if 0 tokens). */
  healthy: boolean;
  /** True when the provider is temporarily throttled / quota-limited. */
  degraded?: boolean;
  error?: string;
}

export interface IDiscoveryProvider {
  readonly name: ProviderName;
  fetch(): Promise<ProviderFetchResult>;
}

export type DiscoverySystemStatus =
  | 'DISCOVERY_OK'               // all primary sources healthy
  | 'DISCOVERY_PARTIAL'          // at least one primary source healthy
  | 'DISCOVERY_DEGRADED'         // primary sources down; only trust-signal source up
  | 'DISCOVERY_ALL_SOURCES_FAILED';
