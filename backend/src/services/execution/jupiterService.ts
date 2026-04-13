/**
 * JupiterService — quote, validate, and execute swaps via Jupiter v6.
 *
 * Buy path  (SOL → token):
 *   getQuote → validateQuote → executeSwap → parseBuyResult
 *
 * Sell path (token → SOL):
 *   getSellQuote → validateSellQuote → executeSwap → parseSellResult
 *
 * Paper mode:
 *   executeSwap is bypassed; amounts are taken from the quote response.
 *
 * Duplicate-protection:
 *   The caller (SniperBot) is responsible for holding locks; JupiterService
 *   is stateless and does not maintain its own dedup set.
 */

import axios, { AxiosInstance } from 'axios';
import {
  Connection,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { config } from '../../config';
import { logger } from '../../logger';
import { getConnection, loadKeypair } from './walletService';
import {
  JupiterQuoteResponse,
  JupiterSwapResponse,
  BuyResult,
  SellResult,
} from '../../types';

// ─── Axios client ─────────────────────────────────────────────────────────────

export let jupiterHealthy = true;

function buildJupiterClient(): AxiosInstance {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.JUPITER_API_KEY) {
    headers['Authorization'] = `Bearer ${config.JUPITER_API_KEY}`;
  }
  return axios.create({
    baseURL: config.JUPITER_QUOTE_API,
    timeout: 15_000,
    headers,
  });
}

const jupiterClient = buildJupiterClient();

// ─── Startup health check ─────────────────────────────────────────────────────

/**
 * Verify the Jupiter quote endpoint is reachable at startup.
 * Makes a minimal SOL→USDC quote request; logs success or failure.
 * Sets jupiterHealthy accordingly.
 */
export async function checkJupiterEndpoint(): Promise<boolean> {
  const endpoint = `${config.JUPITER_QUOTE_API}/quote`;
  try {
    const resp = await jupiterClient.get<unknown>('/quote', {
      params: {
        inputMint: config.SOL_MINT,
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        amount: 1_000_000, // 0.001 SOL in lamports
        slippageBps: 50,
      },
      timeout: 8_000,
    });
    // Any 2xx response means DNS resolved and the endpoint is up
    jupiterHealthy = true;
    logger.info('Jupiter', `✅ Quote endpoint reachable: ${endpoint}`, {
      status: (resp as { status?: number }).status,
    });
    return true;
  } catch (err: unknown) {
    jupiterHealthy = false;
    const msg = String(err);
    const isDns = msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN');
    const isConn = msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET');
    const tag = isDns ? 'DNS resolution failed' : isConn ? 'connection refused / timeout' : 'request failed';
    logger.error('Jupiter', `Jupiter API unreachable: ${endpoint} — ${tag}`, { err: msg });
    return false;
  }
}

// ─── Quote rate limiter ───────────────────────────────────────────────────────
// Max 2 quote requests per second; enforced by a 500 ms minimum gap.

let lastQuoteAt = 0;
const QUOTE_MIN_INTERVAL_MS = 500;

async function waitForQuoteSlot(): Promise<void> {
  const elapsed = Date.now() - lastQuoteAt;
  if (elapsed < QUOTE_MIN_INTERVAL_MS) {
    await sleep(QUOTE_MIN_INTERVAL_MS - elapsed);
  }
  lastQuoteAt = Date.now();
}

// ─── Quote helpers ────────────────────────────────────────────────────────────

/**
 * Request a buy quote: SOL → token.
 *
 * Rate limiting: enforces ≥500 ms between calls (max 2/sec).
 * 429 handling: waits 2 s then retries once; skips token on second failure.
 */
export async function getBuyQuote(
  tokenMint: string,
  solAmount: number
): Promise<JupiterQuoteResponse | null> {
  const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);
  const params = {
    inputMint: config.SOL_MINT,
    outputMint: tokenMint,
    amount: lamports,
    slippageBps: config.SLIPPAGE_BPS,
  };
  const requestUrl = `${config.JUPITER_QUOTE_API}/quote?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${params.slippageBps}`;

  // Enforce rate limit before every quote request
  await waitForQuoteSlot();

  logger.debug('Jupiter', `getBuyQuote — ${requestUrl}`);

  const tryOnce = async (): Promise<JupiterQuoteResponse | null | '429'> => {
    try {
      const resp = await jupiterClient.get<unknown>('/quote', { params });
      const raw = resp.data as Record<string, unknown>;
      const quote: JupiterQuoteResponse | null =
        raw['inputMint']
          ? (raw as unknown as JupiterQuoteResponse)
          : ((raw['data'] as JupiterQuoteResponse | undefined) ?? null);

      if (quote && quote.outAmount) {
        jupiterHealthy = true;
        return quote;
      }

      logger.warn('Jupiter', 'getBuyQuote: no outAmount in response', { raw: JSON.stringify(raw).slice(0, 200) });
      return null;
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 429) return '429';
      jupiterHealthy = false;
      logger.warn('Jupiter', `getBuyQuote failed — ${String(err)}`);
      return null;
    }
  };

  const result = await tryOnce();

  if (result === '429') {
    logger.warn('Jupiter', 'getBuyQuote rate-limited (429) — waiting 2 s then retrying once');
    jupiterHealthy = false;
    await sleep(2000);
    lastQuoteAt = Date.now(); // reset slot after the 2 s wait

    const retry = await tryOnce();
    if (retry === '429' || retry === null) {
      logger.warn('Jupiter', 'getBuyQuote retry after 429 failed — skipping token');
      return null;
    }
    return retry;
  }

  if (result === null) {
    logger.warn('Jupiter', 'getBuyQuote returned no usable quote — skipping token');
  }

  return result;
}

/**
 * Request a sell quote: token → SOL.
 * @param tokenMint    Source token mint
 * @param tokenAmount  Amount in token's smallest unit (already accounting for decimals)
 */
export async function getSellQuote(
  tokenMint: string,
  tokenAmount: bigint
): Promise<JupiterQuoteResponse | null> {
  const params = {
    inputMint: tokenMint,
    outputMint: config.SOL_MINT,
    amount: tokenAmount.toString(),
    slippageBps: config.SLIPPAGE_BPS,
  };

  for (let attempt = 1; attempt <= config.MAX_RETRY_COUNT; attempt++) {
    try {
      const resp = await jupiterClient.get<unknown>('/quote', { params });

      const raw = resp.data as Record<string, unknown>;
      const quote: JupiterQuoteResponse | null =
        raw['inputMint']
          ? (raw as unknown as JupiterQuoteResponse)
          : ((raw['data'] as JupiterQuoteResponse | undefined) ?? null);

      if (quote && quote.outAmount) {
        jupiterHealthy = true;
        return quote;
      }
    } catch (err: unknown) {
      logger.warn('Jupiter', `getSellQuote attempt ${attempt} failed — ${String(err)}`);
      jupiterHealthy = false;
      if (attempt < config.MAX_RETRY_COUNT) {
        await sleep(config.QUOTE_RETRY_DELAY_MS * attempt);
      }
    }
  }
  return null;
}

// ─── Quote validation ─────────────────────────────────────────────────────────

export interface QuoteValidation {
  valid: boolean;
  reason?: string;
  priceImpactPct: number;
  estimatedSlippagePct: number;
}

export function validateBuyQuote(
  quote: JupiterQuoteResponse,
  marketPriceUsd: number,
  tokenDecimals: number
): QuoteValidation {
  const priceImpactPct = parseFloat(quote.priceImpactPct ?? '0');
  const outAmount = BigInt(quote.outAmount);
  const inAmount = BigInt(quote.inAmount);

  // Effective price per token in SOL
  const solPerToken =
    Number(inAmount) / LAMPORTS_PER_SOL / (Number(outAmount) / 10 ** tokenDecimals);

  // Approximate SOL→USD rate is implicit — we only compare relative slippage
  // If marketPriceUsd is provided, we can check quoted effective price
  // against it. Slippage = deviation from theoretical market price.
  let estimatedSlippagePct = priceImpactPct; // proxy when no USD price

  if (marketPriceUsd > 0 && solPerToken > 0) {
    // Convert market price: USD/token → SOL/token using rough SOL price
    // We don't have live SOL/USD here, so we skip this cross-rate check
    // and use priceImpactPct as the authoritative slippage measure.
    estimatedSlippagePct = priceImpactPct;
  }

  if (priceImpactPct > config.MAX_ESTIMATED_SLIPPAGE_PCT) {
    return {
      valid: false,
      reason: `Price impact ${priceImpactPct.toFixed(2)}% exceeds ${config.MAX_ESTIMATED_SLIPPAGE_PCT}% maximum`,
      priceImpactPct,
      estimatedSlippagePct,
    };
  }

  if (!outAmount || outAmount === 0n) {
    return {
      valid: false,
      reason: 'Quote returned zero output amount',
      priceImpactPct,
      estimatedSlippagePct,
    };
  }

  return { valid: true, priceImpactPct, estimatedSlippagePct };
}

// ─── Swap execution ───────────────────────────────────────────────────────────

/**
 * Execute a buy swap (SOL → token).
 * In paper mode: skips transaction, returns simulated result from quote.
 */
export async function executeBuy(
  quote: JupiterQuoteResponse,
  tokenDecimals: number,
  marketPriceUsd: number,
  paperMode: boolean
): Promise<BuyResult> {
  if (paperMode) {
    const tokenAmount = Number(BigInt(quote.outAmount)) / 10 ** tokenDecimals;
    logger.info('Jupiter', `[PAPER] Buy simulated: ${tokenAmount.toFixed(4)} tokens`);
    return {
      success: true,
      signature: `PAPER_${Date.now()}`,
      tokenAmountReceived: tokenAmount,
      effectiveEntryPrice: marketPriceUsd,
      quoteUsed: quote,
    };
  }

  // Live mode
  try {
    const keypair = loadKeypair();
    const connection = getConnection();

    const swapTx = await getSwapTransaction(quote, keypair.publicKey);
    if (!swapTx) return { success: false, error: 'Failed to get swap transaction from Jupiter' };

    const txBytes = Buffer.from(swapTx.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBytes);
    transaction.sign([keypair]);

    const signature = await sendAndConfirmTx(connection, transaction);

    // Query actual token amount received
    const tokenAmount = await getTokenBalance(
      connection,
      quote.outputMint,
      keypair.publicKey,
      tokenDecimals
    );

    const effectivePrice = tokenAmount > 0 ? marketPriceUsd : marketPriceUsd;

    logger.info('Jupiter', `Buy confirmed: ${signature}`, {
      tokenAmount, effectivePrice,
    });

    return {
      success: true,
      signature,
      tokenAmountReceived: tokenAmount > 0
        ? tokenAmount
        : Number(BigInt(quote.outAmount)) / 10 ** tokenDecimals,
      effectiveEntryPrice: effectivePrice,
      quoteUsed: quote,
    };
  } catch (err: unknown) {
    logger.error('Jupiter', 'executeBuy failed', { err: String(err) });
    return { success: false, error: String(err) };
  }
}

/**
 * Execute a sell swap (token → SOL).
 * Returns SOL received.
 */
export async function executeSell(
  quote: JupiterQuoteResponse,
  paperMode: boolean
): Promise<SellResult> {
  if (paperMode) {
    const solReceived = Number(BigInt(quote.outAmount)) / LAMPORTS_PER_SOL;
    logger.info('Jupiter', `[PAPER] Sell simulated: ${solReceived.toFixed(6)} SOL`);
    return { success: true, signature: `PAPER_${Date.now()}`, solReceived, quoteUsed: quote };
  }

  try {
    const keypair = loadKeypair();
    const connection = getConnection();

    const swapTx = await getSwapTransaction(quote, keypair.publicKey);
    if (!swapTx) return { success: false, error: 'Failed to get swap transaction from Jupiter' };

    const txBytes = Buffer.from(swapTx.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBytes);
    transaction.sign([keypair]);

    const signature = await sendAndConfirmTx(connection, transaction);
    const solReceived = Number(BigInt(quote.outAmount)) / LAMPORTS_PER_SOL;

    logger.info('Jupiter', `Sell confirmed: ${signature}`, { solReceived });

    return { success: true, signature, solReceived, quoteUsed: quote };
  } catch (err: unknown) {
    logger.error('Jupiter', 'executeSell failed', { err: String(err) });
    return { success: false, error: String(err) };
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function getSwapTransaction(
  quote: JupiterQuoteResponse,
  userPublicKey: PublicKey
): Promise<JupiterSwapResponse | null> {
  try {
    const resp = await jupiterClient.post<JupiterSwapResponse>('/swap', {
      quoteResponse: quote,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: config.PRIORITY_FEE_LAMPORTS,
    });
    return resp.data;
  } catch (err: unknown) {
    logger.error('Jupiter', 'getSwapTransaction failed', { err: String(err) });
    return null;
  }
}

async function sendAndConfirmTx(
  connection: Connection,
  transaction: VersionedTransaction
): Promise<string> {
  const rawTx = transaction.serialize();

  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  const latestBlock = await connection.getLatestBlockhash('confirmed');
  const result = await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlock.blockhash,
      lastValidBlockHeight: latestBlock.lastValidBlockHeight,
    },
    'confirmed'
  );

  if (result.value.err) {
    throw new Error(`Transaction confirmed with error: ${JSON.stringify(result.value.err)}`);
  }

  return signature;
}

async function getTokenBalance(
  connection: Connection,
  tokenMint: string,
  owner: PublicKey,
  decimals: number
): Promise<number> {
  try {
    const mintPub = new PublicKey(tokenMint);
    const accounts = await connection.getTokenAccountsByOwner(owner, {
      mint: mintPub,
    });

    if (accounts.value.length === 0) return 0;

    const info = await connection.getTokenAccountBalance(
      accounts.value[0].pubkey,
      'confirmed'
    );
    return info.value.uiAmount ?? 0;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
