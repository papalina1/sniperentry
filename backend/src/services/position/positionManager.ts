/**
 * PositionManager — tracks every open position and decides when to exit.
 *
 * Runs on its own setInterval (POSITION_MONITOR_INTERVAL_MS).
 * For each open position it:
 *   1. Refreshes market data from Birdeye.
 *   2. Evaluates all exit conditions (priority order below).
 *   3. If sell is triggered, calls JupiterService and closes the DB record.
 *
 * Exit priority (checked in order):
 *   1. Emergency stop (global flag)
 *   2. 1.4x take-profit (40% — primary goal)
 *   3. Stop-loss (-30% default)
 *   4. Max hold time (20 min default)
 *   5. Liquidity collapse (30% drop from entry)
 *   6. Sell-pressure spike
 *   7. Exit-quote degradation
 */

import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../logger';
import { broadcastType } from '../../api/wsServer';
import { tradeDb, updateDailyPerformance } from '../../db';
import { refreshCandidate } from '../discovery/birdeyeService';
import { sendTelegram } from '../notification/telegramService';
import {
  getSellQuote,
  executeSell,
} from '../execution/jupiterService';
import {
  ActivePosition,
  PositionDecision,
  TokenCandidate,
} from '../../types';

// ─── State ────────────────────────────────────────────────────────────────────

const openPositions = new Map<string, ActivePosition>(); // mint → position
let monitorTimer: NodeJS.Timeout | null = null;
let emergencyStopTriggered = false;

// Callback invoked after every fully-closed trade.
// Registered by sniperBot to implement STOP_AFTER_ONE_COMPLETED_TRADE.
let onTradeCompletedCallback: ((mint: string, symbol: string) => void) | null = null;

export function setOnTradeCompletedCallback(
  fn: (mint: string, symbol: string) => void
): void {
  onTradeCompletedCallback = fn;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function openPosition(pos: ActivePosition): void {
  openPositions.set(pos.mint, pos);
  logger.info('Positions', `Position opened: ${pos.symbol} @ $${pos.entryPrice.toFixed(8)}`, {
    mint: pos.mint, mode: pos.mode, size: pos.buySizeSol,
  });
  broadcastType('positions_update', serializePositions());
}

export function getOpenPositions(): ActivePosition[] {
  return Array.from(openPositions.values());
}

export function getOpenPositionMints(): Set<string> {
  return new Set(openPositions.keys());
}

export function isEmergencyStop(): boolean {
  return emergencyStopTriggered;
}

export function triggerEmergencyStop(): void {
  emergencyStopTriggered = true;
  logger.warn('Positions', '🚨 EMERGENCY STOP activated — closing all positions');
}

export function clearEmergencyStop(): void {
  emergencyStopTriggered = false;
  logger.info('Positions', 'Emergency stop cleared — bot resumed');
}

// ─── Monitor loop ─────────────────────────────────────────────────────────────

export function startPositionMonitor(): void {
  logger.info('Positions', 'Position monitor started');
  monitorTimer = setInterval(runMonitorCycle, config.POSITION_MONITOR_INTERVAL_MS);
}

export function stopPositionMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

// ─── DexScreener price fallback ───────────────────────────────────────────────

interface DexScreenerPair {
  chainId: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
}

async function fetchDexScreenerPrice(
  mint: string
): Promise<{ priceUsd: number; liquidityUsd: number } | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
    const resp = await axios.get<{ pairs: DexScreenerPair[] }>(url, {
      timeout: 8_000,
      headers: { Accept: 'application/json' },
    });

    const pairs = Array.isArray(resp.data?.pairs) ? resp.data.pairs : [];

    // Pick Solana pair with highest liquidity
    let best: DexScreenerPair | null = null;
    for (const pair of pairs) {
      if (pair.chainId !== 'solana') continue;
      if (!best || (pair.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) {
        best = pair;
      }
    }

    if (!best?.priceUsd) return null;

    return {
      priceUsd:    parseFloat(best.priceUsd),
      liquidityUsd: best.liquidity?.usd ?? 0,
    };
  } catch (err: unknown) {
    logger.debug('Positions', `DexScreener price fetch failed for ${mint.slice(0, 8)}: ${String(err)}`);
    return null;
  }
}

async function runMonitorCycle(): Promise<void> {
  if (openPositions.size === 0) return;

  const positions = Array.from(openPositions.values());

  for (const pos of positions) {
    if (pos.beingClosed) continue; // already being processed

    try {
      await evaluatePosition(pos);
    } catch (err: unknown) {
      logger.error('Positions', `Error evaluating ${pos.symbol}`, { err: String(err) });
    }
  }

  broadcastType('positions_update', serializePositions());
}

async function evaluatePosition(pos: ActivePosition): Promise<void> {
  // ── Step 1: refresh market data ──────────────────────────────────────────
  // Try Birdeye first; fall back to DexScreener if it returns null (e.g. 400).
  const candidate = await refreshCandidate(pos.mint);
  let priceSource: string;

  if (candidate && candidate.price > 0) {
    priceSource = 'birdeye';
    pos.currentPrice = candidate.price;
    pos.currentLiquidityUsd = candidate.liquidityUsd;
    pos.lastChecked = Date.now();
    openPositions.set(pos.mint, pos);
  } else {
    // Birdeye unavailable — fall back to DexScreener
    const dex = await fetchDexScreenerPrice(pos.mint);
    if (dex) {
      priceSource = 'dexscreener';
      pos.currentPrice = dex.priceUsd;
      pos.currentLiquidityUsd = dex.liquidityUsd;
      pos.lastChecked = Date.now();
      openPositions.set(pos.mint, pos);
    } else {
      priceSource = 'stale';
    }
  }

  const currentPrice = pos.currentPrice ?? pos.entryPrice;
  const currentLiq = pos.currentLiquidityUsd ?? pos.entryLiquidityUsd;

  // ── Step 2: compute multiplier and PnL ───────────────────────────────────
  const multiplier = pos.entryPrice > 0 ? currentPrice / pos.entryPrice : 1;
  const unrealizedPct = (multiplier - 1) * 100;

  logger.debug(
    'Positions',
    `${pos.symbol}: ${multiplier.toFixed(3)}x | ${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(1)}% [src=${priceSource}]`,
    { current: currentPrice, entry: pos.entryPrice }
  );

  // ── Step 2b: profit protection — adjust stop loss dynamically ────────────
  if (config.PROFIT_PROTECTION_ENABLED && !pos.beingClosed) {
    applyProfitProtection(pos, unrealizedPct);
  }

  // ── Step 2c: optional partial sell at PARTIAL_SELL_TRIGGER_PCT ────────────
  if (
    config.PARTIAL_SELL_ENABLED &&
    !pos.partialSellExecuted &&
    !pos.beingClosed &&
    unrealizedPct >= config.PARTIAL_SELL_TRIGGER_PCT
  ) {
    await executePartialSell(pos);
  }

  // ── Step 3: evaluate exit conditions ─────────────────────────────────────
  const decision = makeDecision(pos, multiplier, currentPrice, currentLiq, candidate);

  if (decision.action === 'sell') {
    await closePosition(pos, decision.reason!, decision.urgency === 'urgent');
  }
}

function makeDecision(
  pos: ActivePosition,
  multiplier: number,
  currentPrice: number,
  currentLiq: number,
  candidate: TokenCandidate | null
): PositionDecision {
  const now = Date.now();

  // Priority 1: Emergency stop
  if (emergencyStopTriggered) {
    return { action: 'sell', reason: 'Emergency stop activated', urgency: 'urgent' };
  }

  // Priority 2: 1.4x take-profit — 40% gain (primary target)
  if (multiplier >= config.TARGET_MULTIPLIER) {
    return { action: 'sell', reason: `Target reached: ${multiplier.toFixed(3)}x`, urgency: 'normal' };
  }

  // Priority 2b: Pre-target buffer zone — evaluate exit aggressively
  if (multiplier >= config.SELL_TRIGGER_BUFFER_HIGH) {
    // In the high buffer zone, we are very close to target; attempt sell now
    // to avoid missing the window due to execution delay
    return {
      action: 'sell',
      reason: `Buffer zone HIGH (${multiplier.toFixed(3)}x ≥ ${config.SELL_TRIGGER_BUFFER_HIGH}x) — executing before target slips`,
      urgency: 'urgent',
    };
  }

  // Priority 3: Stop-loss
  if (currentPrice <= pos.stopLossPrice) {
    return {
      action: 'sell',
      reason: `Stop-loss: price $${currentPrice.toFixed(8)} ≤ stop $${pos.stopLossPrice.toFixed(8)} (${((multiplier-1)*100).toFixed(1)}%)`,
      urgency: 'urgent',
    };
  }

  // Priority 4: Max hold time
  if (now >= pos.maxExitTime) {
    return {
      action: 'sell',
      reason: `Max hold time exceeded: ${((now - pos.entryTime) / 60_000).toFixed(1)} min`,
      urgency: 'normal',
    };
  }

  // Priority 5: Liquidity collapse
  if (
    pos.entryLiquidityUsd > 0 &&
    currentLiq < pos.entryLiquidityUsd * (1 - config.LIQUIDITY_DROP_EXIT_PCT / 100)
  ) {
    return {
      action: 'sell',
      reason: `Liquidity collapsed: $${currentLiq.toFixed(0)} vs entry $${pos.entryLiquidityUsd.toFixed(0)} (>${config.LIQUIDITY_DROP_EXIT_PCT}% drop)`,
      urgency: 'urgent',
    };
  }

  // Priority 6: Sell-pressure spike (if Birdeye data available)
  if (candidate && candidate.sellCount30m > candidate.buyCount30m * 3 && candidate.sellCount30m > 50) {
    return {
      action: 'sell',
      reason: `Sell-pressure spike: sells=${candidate.sellCount30m}, buys=${candidate.buyCount30m}`,
      urgency: 'urgent',
    };
  }

  // Priority 7: Momentum collapse — token already fell significantly below
  // entry and is not recovering; this is different from stop-loss (which is
  // price-based); here we check if the short-term momentum is very negative.
  if (candidate && candidate.priceChange5m < -30 && multiplier < 0.85) {
    return {
      action: 'sell',
      reason: `Momentum collapse: 5 m change ${candidate.priceChange5m.toFixed(1)}% at ${multiplier.toFixed(3)}x`,
      urgency: 'normal',
    };
  }

  return { action: 'hold', urgency: 'normal' };
}

// ─── Profit protection ────────────────────────────────────────────────────────

/**
 * Dynamically raises the stop-loss price as the position moves into profit.
 *
 * Phase 1 — Break-even (BREAK_EVEN_TRIGGER_PCT, default +15%):
 *   Stop is moved up to the entry price so the trade can no longer result in a loss.
 *
 * Phase 2 — Profit lock (PROFIT_LOCK_TRIGGER_PCT, default +25%):
 *   Stop is raised to entry × (1 + PROFIT_LOCK_FLOOR_PCT / 100), locking in at
 *   least PROFIT_LOCK_FLOOR_PCT% (default +10%) of gain.
 *
 * Both phases are one-way (stop only moves up, never down) and idempotent.
 */
function applyProfitProtection(pos: ActivePosition, unrealizedPct: number): void {
  // Phase 1: break-even
  if (
    unrealizedPct >= config.BREAK_EVEN_TRIGGER_PCT &&
    !pos.breakEvenActivated &&
    pos.stopLossPrice < pos.entryPrice
  ) {
    pos.stopLossPrice     = pos.entryPrice;
    pos.breakEvenActivated = true;
    openPositions.set(pos.mint, pos);
    logger.info(
      'Positions',
      `[PROFIT PROTECT] ${pos.symbol}: break-even activated — ` +
      `stop → entry $${pos.entryPrice.toFixed(8)} at +${unrealizedPct.toFixed(1)}%`
    );
    broadcastType('positions_update', serializePositions());
  }

  // Phase 2: lock minimum profit
  if (
    unrealizedPct >= config.PROFIT_LOCK_TRIGGER_PCT &&
    !pos.profitLockActivated
  ) {
    const lockPrice = pos.entryPrice * (1 + config.PROFIT_LOCK_FLOOR_PCT / 100);
    if (pos.stopLossPrice < lockPrice) {
      pos.stopLossPrice    = lockPrice;
      pos.profitLockActivated = true;
      openPositions.set(pos.mint, pos);
      logger.info(
        'Positions',
        `[PROFIT PROTECT] ${pos.symbol}: profit lock activated — ` +
        `stop → +${config.PROFIT_LOCK_FLOOR_PCT}% @ $${lockPrice.toFixed(8)} at +${unrealizedPct.toFixed(1)}%`
      );
      broadcastType('positions_update', serializePositions());
    }
  }
}

/**
 * Sells 50% of the remaining position at PARTIAL_SELL_TRIGGER_PCT gain (default +20%).
 * Only executes once per position (guarded by pos.partialSellExecuted).
 *
 * Enabled only when config.PARTIAL_SELL_ENABLED = true.
 */
async function executePartialSell(pos: ActivePosition): Promise<void> {
  const halfTokenAmount = pos.tokenAmount / 2;
  const halfTokenUnits  = BigInt(Math.round(halfTokenAmount * 10 ** pos.decimals));

  const unrealizedPct = pos.currentPrice && pos.entryPrice > 0
    ? ((pos.currentPrice / pos.entryPrice) - 1) * 100
    : 0;

  logger.info(
    'Positions',
    `[PARTIAL SELL] ${pos.symbol}: selling 50% at +${unrealizedPct.toFixed(1)}% ` +
    `(${halfTokenAmount.toFixed(4)} tokens)`
  );

  const quote = await getSellQuote(pos.mint, halfTokenUnits);
  if (!quote) {
    logger.warn('Positions', `[PARTIAL SELL] ${pos.symbol}: no quote available — skipping this cycle`);
    return;
  }

  const sellResult = await executeSell(quote, pos.mode === 'paper');
  if (!sellResult.success) {
    logger.warn('Positions', `[PARTIAL SELL] ${pos.symbol}: sell failed — ${sellResult.error}`);
    return;
  }

  const solReceived = sellResult.solReceived ?? 0;

  // Store original buy size before reducing the position (needed for final PnL)
  if (pos.originalBuySizeSol === undefined) {
    pos.originalBuySizeSol = pos.buySizeSol;
  }
  pos.partialSolReceived  = (pos.partialSolReceived ?? 0) + solReceived;
  pos.partialSellExecuted = true;
  pos.tokenAmount         = halfTokenAmount; // remaining tokens for the final close

  openPositions.set(pos.mint, pos);

  logger.info(
    'Positions',
    `[PARTIAL SELL] ${pos.symbol}: sold 50% — received ${solReceived.toFixed(6)} SOL ` +
    `(total partial: ${pos.partialSolReceived.toFixed(6)} SOL)`,
    { signature: sellResult.signature }
  );
  broadcastType('positions_update', serializePositions());
}

// ─── Position closing ─────────────────────────────────────────────────────────

async function closePosition(pos: ActivePosition, reason: string, urgent: boolean): Promise<void> {
  // Duplicate-close guard
  if (pos.beingClosed) return;
  pos.beingClosed = true;
  openPositions.set(pos.mint, pos);

  logger.info('Positions', `Closing ${pos.symbol}: ${reason}`, { urgent });

  try {
    // Build sell quote
    const tokenUnits = BigInt(Math.round(pos.tokenAmount * 10 ** pos.decimals));
    const quote = await getSellQuote(pos.mint, tokenUnits);

    if (!quote && !urgent) {
      // Non-urgent: retry next cycle
      logger.warn('Positions', `Could not get sell quote for ${pos.symbol}, retrying next cycle`);
      pos.beingClosed = false;
      openPositions.set(pos.mint, pos);
      return;
    }

    if (!quote && urgent) {
      logger.error('Positions', `URGENT: no sell quote for ${pos.symbol} — cannot execute sell`);
      // Keep beingClosed=true so we don't keep retrying on every cycle
      // but let the emergency loop handle it later
      return;
    }

    const mode = pos.mode;
    const sellResult = await executeSell(quote!, mode === 'paper');

    if (!sellResult.success) {
      logger.error('Positions', `Sell failed for ${pos.symbol}: ${sellResult.error}`);
      pos.beingClosed = false; // allow retry
      openPositions.set(pos.mint, pos);
      return;
    }

    // ── Finalize position ─────────────────────────────────────────────────
    const exitPrice = pos.currentPrice ?? pos.entryPrice;
    const exitTime = Date.now();
    const closeSolReceived = sellResult.solReceived ?? pos.buySizeSol;

    // Include any SOL already received from a partial sell
    const totalSolReceived   = closeSolReceived + (pos.partialSolReceived ?? 0);
    const originalBuySizeSol = pos.originalBuySizeSol ?? pos.buySizeSol;
    const pnlSol = totalSolReceived - originalBuySizeSol;
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const isWin = pnlSol >= 0;

    tradeDb.close(pos.id, {
      exitTime,
      exitPrice,
      sellSignature: sellResult.signature,
      exitReason: reason,
      pnlSol,
      pnlPct,
      exitQuote: quote ? JSON.stringify(quote) : undefined,
    });

    updateDailyPerformance(pnlSol, isWin);

    logger.info('Positions', `✅ Position closed: ${pos.symbol}`, {
      reason,
      pnlSol: pnlSol.toFixed(6),
      pnlPct: pnlPct.toFixed(1) + '%',
      mode,
    });

    openPositions.delete(pos.mint);

    broadcastType('trade_closed', {
      mint: pos.mint,
      symbol: pos.symbol,
      exitReason: reason,
      pnlSol,
      pnlPct,
    });
    broadcastType('positions_update', serializePositions());

    // ── Telegram: position closed ─────────────────────────────────────────
    const holdMin = Math.round((exitTime - pos.entryTime) / 60_000);
    const modeLabel = mode === 'live' ? '🔴 LIVE' : '📄 PAPER';
    const pnlSign = pnlSol >= 0 ? '+' : '';
    const resultIcon = isWin ? '✅' : '❌';
    sendTelegram(
      `${resultIcon} <b>POSITION CLOSED</b> — ${modeLabel}\n\n` +
      `<b>${pos.symbol}</b>\n` +
      `Address: <code>${pos.mint}</code>\n` +
      `PnL:    <code>${pnlSign}${pnlSol.toFixed(4)} SOL (${pnlSign}${pnlPct.toFixed(1)}%)</code>\n` +
      `Reason: <code>${reason}</code>\n` +
      `Entry:  <code>$${pos.entryPrice.toFixed(8)}</code>\n` +
      `Exit:   <code>$${exitPrice.toFixed(8)}</code>\n` +
      `Hold:   <code>${holdMin}m</code>`
    ).catch(() => {});

    // Notify bot that a trade has fully completed (used for STOP_AFTER_ONE_COMPLETED_TRADE)
    if (onTradeCompletedCallback) {
      onTradeCompletedCallback(pos.mint, pos.symbol);
    }
  } catch (err: unknown) {
    logger.error('Positions', `closePosition threw for ${pos.symbol}`, { err: String(err) });
    pos.beingClosed = false;
    openPositions.set(pos.mint, pos);
  }
}

// ─── Serialisation for WS / API ──────────────────────────────────────────────

export function serializePositions(): unknown[] {
  return Array.from(openPositions.values()).map((p) => {
    const currentPrice = p.currentPrice ?? p.entryPrice;
    const multiplier = p.entryPrice > 0 ? currentPrice / p.entryPrice : 1;
    return {
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      mode: p.mode,
      entryTime: p.entryTime,
      entryPrice: p.entryPrice,
      currentPrice,
      targetPrice: p.targetPrice,
      stopLossPrice: p.stopLossPrice,
      tokenAmount: p.tokenAmount,
      buySizeSol: p.buySizeSol,
      multiplier,
      unrealizedPnlPct: (multiplier - 1) * 100,
      timeInTradeSec: Math.floor((Date.now() - p.entryTime) / 1000),
      maxExitTime: p.maxExitTime,
      entryLiquidityUsd: p.entryLiquidityUsd,
      currentLiquidityUsd: p.currentLiquidityUsd,
      // Profit protection state
      breakEvenActivated:  p.breakEvenActivated  ?? false,
      profitLockActivated: p.profitLockActivated ?? false,
      partialSellExecuted: p.partialSellExecuted ?? false,
      partialSolReceived:  p.partialSolReceived  ?? 0,
    };
  });
}
