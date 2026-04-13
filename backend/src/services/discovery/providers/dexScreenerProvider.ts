/**
 * DexScreenerDiscoveryProvider
 *
 * Discovers new Solana tokens via two public DexScreener endpoints:
 *
 *   1. GET /token-profiles/latest/v1
 *      Returns recently created/updated token profiles. We filter for chainId=solana.
 *
 *   2. GET /latest/dex/tokens/{address1,address2,...}
 *      Returns pair data (price, volume, liquidity, pairCreatedAt) for up to 30 addresses.
 *      We pick the best Solana pair per mint (highest liquidity).
 *
 * Rate limiting:
 *   DexScreener does not publish hard rate limits for their public API.
 *   We self-throttle to at most one full fetch cycle per MIN_INTERVAL_MS (30 s).
 *
 * No API key required.
 */

import axios from 'axios';
import { logger } from '../../../logger';
import { config } from '../../../config';
import { IDiscoveryProvider, ProviderFetchResult, RawDiscoveryToken } from './types';

const BASE = 'https://api.dexscreener.com';
const PROFILES_PATH  = '/token-profiles/latest/v1';
const TOKENS_PATH    = (addrs: string) => `/latest/dex/tokens/${addrs}`;
const VOLUME_PAIRS_PATH = '/latest/dex/pairs?chain=solana&sort=volume24h';

/** Minimum USD liquidity a pair must have before it enters scoring. */
const MIN_LIQUIDITY_USD = 10_000;

const client = axios.create({ baseURL: BASE, timeout: 10_000, headers: { Accept: 'application/json' } });

/** Minimum ms between full fetch cycles to respect DexScreener's free tier. */
const MIN_INTERVAL_MS = 30_000;
let lastFetchAt = 0;

// ─── DexScreener response shapes ─────────────────────────────────────────────

interface DexProfile {
  chainId: string;
  tokenAddress: string;
}

interface DexPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h24?: number };
  txns?: { m5?: { buys: number; sells: number }; h1?: { buys: number; sells: number } };
  pairCreatedAt?: number; // milliseconds (DexScreener)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class DexScreenerDiscoveryProvider implements IDiscoveryProvider {
  readonly name = 'dexscreener' as const;

  async fetch(): Promise<ProviderFetchResult> {
    const now = Date.now();
    if (now - lastFetchAt < MIN_INTERVAL_MS) {
      const secs = Math.ceil((MIN_INTERVAL_MS - (now - lastFetchAt)) / 1_000);
      logger.debug('DexScreener', `Self-throttled — next cycle in ${secs}s`);
      // Healthy but throttled: not an error, just return empty for this cycle
      return { tokens: [], healthy: true };
    }
    lastFetchAt = now;

    try {
      // ── Step 1a: latest token profiles ───────────────────────────────────
      logger.debug('DexScreener', `GET ${BASE}${PROFILES_PATH}`);
      const profileResp = await client.get<DexProfile[]>(PROFILES_PATH);
      const profiles: DexProfile[] = Array.isArray(profileResp.data) ? profileResp.data : [];

      const profileMints = [
        ...new Set(
          profiles
            .filter(p => p.chainId === 'solana' && p.tokenAddress?.length >= 32)
            .map(p => p.tokenAddress)
            .filter(a => a !== config.SOL_MINT)
        ),
      ].slice(0, 15); // conservative batch to stay under API limits

      // ── Step 1b: top-volume pairs feed (runs in parallel with profile lookup) ─
      logger.debug('DexScreener', `GET ${BASE}${VOLUME_PAIRS_PATH}`);
      const [volumePairsSettled] = await Promise.allSettled([
        client.get<{ pairs: DexPair[] }>(VOLUME_PAIRS_PATH),
      ]);
      const volumePairs: DexPair[] =
        volumePairsSettled.status === 'fulfilled' &&
        Array.isArray(volumePairsSettled.value.data?.pairs)
          ? volumePairsSettled.value.data.pairs
          : [];

      if (volumePairsSettled.status === 'rejected') {
        logger.warn('DexScreener', `Volume pairs fetch failed: ${(volumePairsSettled.reason as { message?: string }).message ?? String(volumePairsSettled.reason)}`);
      }

      // ── Step 2: pair data for profile mints ──────────────────────────────
      let profilePairs: DexPair[] = [];
      if (profileMints.length > 0) {
        await sleep(400);
        const path = TOKENS_PATH(profileMints.join(','));
        logger.debug('DexScreener', `GET ${BASE}${path.slice(0, 80)}… (${profileMints.length} mints)`);
        const pairsResp = await client.get<{ pairs: DexPair[] }>(path);
        profilePairs = Array.isArray(pairsResp.data?.pairs) ? pairsResp.data.pairs : [];
      }

      // ── Step 3: merge all pairs, best per mint (highest liquidity, Solana) ─
      const allPairs = [...profilePairs, ...volumePairs];
      const bestPair = new Map<string, DexPair>();
      for (const pair of allPairs) {
        if (pair.chainId !== 'solana') continue;
        const mint = pair.baseToken?.address;
        if (!mint || mint.length < 32 || mint === config.SOL_MINT) continue;
        const existing = bestPair.get(mint);
        if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
          bestPair.set(mint, pair);
        }
      }

      // ── Step 4: pre-scoring liquidity gate ($10 K minimum) ───────────────
      let belowLiquidityCount = 0;
      const tokens: RawDiscoveryToken[] = [];
      for (const [mint, pair] of bestPair) {
        const liq = pair.liquidity?.usd ?? 0;
        if (liq < MIN_LIQUIDITY_USD) {
          belowLiquidityCount++;
          continue; // drop before scoring
        }
        const token: RawDiscoveryToken = {
          mint,
          symbol:           pair.baseToken.symbol || '?',
          name:             pair.baseToken.name   || '?',
          pairAddress:      pair.pairAddress,
          priceUsd:         pair.priceUsd ? parseFloat(pair.priceUsd) : undefined,
          liquidityUsd:     liq,
          volume24hUsd:     pair.volume?.h24,
          volume1hUsd:      pair.volume?.h1,
          priceChange5mPct: pair.priceChange?.m5,
          priceChange1hPct: pair.priceChange?.h1,
          // pairCreatedAt from DexScreener is already in milliseconds
          pairCreatedAtMs:  pair.pairCreatedAt,
          sources:          ['dexscreener'],
          confidence:       liq >= 50_000 ? 'high' : liq >= 10_000 ? 'medium' : 'low',
        };
        tokens.push(token);
      }

      logger.debug(
        'DexScreener',
        `${profiles.length} profiles (${profileMints.length} mints) + ${volumePairs.length} volume pairs → ` +
        `${allPairs.length} total pairs → ${bestPair.size} unique mints → ` +
        `${belowLiquidityCount} below $${MIN_LIQUIDITY_USD.toLocaleString()} liq → ${tokens.length} tokens`
      );
      return { tokens, healthy: true };

    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } }).response?.status;
      const msg    = (err as { message?: string }).message ?? String(err);
      logger.warn('DexScreener', `Fetch failed — HTTP ${status ?? 'network'}: ${msg}`);
      return { tokens: [], healthy: false, error: msg };
    }
  }
}
