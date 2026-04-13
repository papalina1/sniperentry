/**
 * SniperBot — main orchestration engine.
 *
 * Pipeline (runs every DISCOVERY_INTERVAL_MS):
 *   1. Gate checks (emergency stop, daily loss, running flag, completed-trade gate)
 *   2. Pull discovered candidates from BirdeyeService
 *   3. For each 'discovered' candidate: run hard filters → score
 *   4. For candidates that score ≥ MIN_SCORE: evaluate buy conditions
 *   5. If all buy conditions pass: get Jupiter quote → validate → execute buy
 *   6. Open position in PositionManager
 *
 * The position monitor loop is owned by PositionManager and runs independently.
 *
 * Safety invariants enforced here:
 *   - One position per token (checked via openPositionMints)
 *   - MAX_OPEN_POSITIONS enforcement
 *   - Cooldown between consecutive buys
 *   - Daily loss limit before any buy
 *   - Duplicate-buy protection via pendingBuys Set
 *   - Live mode explicitly required; paper mode is the safe default
 *   - STOP_AFTER_ONE_COMPLETED_TRADE: bot halts cleanly after first closed trade
 *
 * Unknown-age token handling:
 *   When ALLOW_UNKNOWN_AGE_ENTRY=true and a token's ageState is 'unknown', the
 *   bot allows it through the age gate but applies stricter safety filters
 *   (MIN_LIQUIDITY_USD_UNKNOWN_AGE, MIN_RECENT_VOLUME_USD_UNKNOWN_AGE,
 *    MIN_BUY_SELL_RATIO_UNKNOWN_AGE, MAX_ESTIMATED_SLIPPAGE_PCT_UNKNOWN_AGE).
 *   A warning is logged for every such token that reaches the scoring stage.
 */

import { config } from '../config';
import { logger } from '../logger';
import { broadcastType } from '../api/wsServer';
import { sendTelegram } from '../services/notification/telegramService';
import { candidateDb, tradeDb } from '../db';
import {
  getAllCandidates,
  getCandidate,
  updateCandidateStatus,
  rejectPermanently,
  lastDiscoveryStats,
  refreshCandidate,
} from '../services/discovery/birdeyeService';
import { getDiscoveryStatus } from '../services/discovery/discoveryManager';
import { applyHardFilters } from '../services/filtering/filterService';
import { scoreCandidate } from '../services/scoring/scoringService';
import {
  getBuyQuote,
  validateBuyQuote,
  executeBuy,
  jupiterHealthy,
} from '../services/execution/jupiterService';
import {
  openPosition,
  getOpenPositions,
  getOpenPositionMints,
  isEmergencyStop,
  startPositionMonitor,
  stopPositionMonitor,
  serializePositions,
  setOnTradeCompletedCallback,
} from '../services/position/positionManager';
import { SystemState, TokenCandidate, ActivePosition, FilterDiagnostics } from '../types';

// ─── Bot state ────────────────────────────────────────────────────────────────

let running = false;
let pipelineTimer: NodeJS.Timeout | null = null;
let lastBuyTime = 0;
let completedTradeCount = 0;

// Mints that are currently in the middle of a buy attempt — prevents double-buy
const pendingBuys = new Set<string>();

// ─── Evaluation freshness cache ───────────────────────────────────────────────
// Tracks per-token history to skip re-evaluation of unchanged candidates.
//
// Cooldown tiers (checked in priority order):
//   traded   — 2 h  : never re-buy a recently traded token
//   rejected — 25 m : scored but failed threshold
//   filtered — 25 m : failed hard filters
//   default  — 20 m : unchanged candidate without prior outcome

const EVAL_COOLDOWN_MS      = 20 * 60 * 1_000; // 20 min — default (no prior outcome)
const REJECTED_COOLDOWN_MS  = 25 * 60 * 1_000; // 25 min — after filter/score rejection
const TRADED_COOLDOWN_MS    =  2 * 60 * 60 * 1_000; // 2 h — after position closes

type EvalOutcome = 'passed' | 'rejected' | 'filtered' | 'traded' | null;

interface EvalCacheEntry {
  firstSeenAt:     number;
  lastSeenAt:      number;
  lastEvaluatedAt: number;
  timesSeen:       number;
  lastScore:       number;
  // Outcome of the last full evaluation — drives cooldown tier selection
  lastOutcome: EvalOutcome;
}

const evalCache = new Map<string, EvalCacheEntry>();

// ─── Near-miss watchlist ──────────────────────────────────────────────────────
//
// Tokens that score within WATCHLIST_NEAR_MISS_POINTS of MIN_SCORE are placed
// on a 10-minute watchlist. A dedicated timer rechecks them every 60 seconds.
// If momentum, buy-pressure, and score all clear their promotion thresholds
// before the window expires the token is promoted directly to a buy attempt.

const WATCHLIST_DURATION_MS      = 10 * 60 * 1_000; // hold for 10 minutes
const WATCHLIST_RECHECK_INTERVAL =      60 * 1_000; // recheck every 60 s
const WATCHLIST_NEAR_MISS_POINTS = 5;               // within 5 pts of MIN_SCORE
const WATCHLIST_MAX_AGE_MINUTES  = 30;              // only young tokens qualify
const WATCHLIST_MIN_LIQUIDITY    = 20_000;          // minimum $20 000 liquidity
const WATCHLIST_PROMO_MOMENTUM   = 3;               // promote if 5m change >= +3 %
const WATCHLIST_PROMO_BUY_SELL   = 1.1;             // promote if buy/sell ratio >= 1.1

interface WatchlistEntry {
  mint:       string;
  symbol:     string;
  addedAt:    number;
  expiresAt:  number;
  scoreAtAdd: number;
  rechecks:   number;
}

const watchlist    = new Map<string, WatchlistEntry>();
let watchlistTimer: NodeJS.Timeout | null = null;

/** Format a USD liquidity value as a compact string for log messages. */
function fmtWl(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function addToWatchlist(candidate: TokenCandidate, score: number): void {
  if (watchlist.has(candidate.mint)) return; // already watching
  const now = Date.now();
  watchlist.set(candidate.mint, {
    mint:       candidate.mint,
    symbol:     candidate.symbol,
    addedAt:    now,
    expiresAt:  now + WATCHLIST_DURATION_MS,
    scoreAtAdd: score,
    rechecks:   0,
  });
  logger.info(
    'Bot',
    `[WATCHLIST] add ${candidate.symbol} — score ${score}/${config.MIN_SCORE} ` +
    `(gap ${config.MIN_SCORE - score} pts), ` +
    `liq $${fmtWl(candidate.liquidityUsd)}, age ${candidate.pairAgeMinutes.toFixed(1)}m`
  );
}

async function runWatchlistRecheck(): Promise<void> {
  if (!running || watchlist.size === 0) return;
  const now = Date.now();

  for (const [mint, entry] of watchlist) {
    // ── Expiry ────────────────────────────────────────────────────────────
    if (now >= entry.expiresAt) {
      watchlist.delete(mint);
      logger.info(
        'Bot',
        `[WATCHLIST] expired ${entry.symbol} — no improvement in ${WATCHLIST_DURATION_MS / 60_000}m ` +
        `(score was ${entry.scoreAtAdd}/${config.MIN_SCORE})`
      );
      continue;
    }

    // ── Global buy guards (checked before spending a Birdeye call) ────────
    if (isEmergencyStop() || systemState.completedOneTrade) continue;
    if (getOpenPositions().length >= config.MAX_OPEN_POSITIONS) continue;
    if (getOpenPositionMints().has(mint) || pendingBuys.has(mint)) continue;

    // ── Refresh market data ───────────────────────────────────────────────
    entry.rechecks++;
    const minutesLeft = Math.ceil((entry.expiresAt - now) / 60_000);
    const fresh = await refreshCandidate(mint);

    if (!fresh) {
      logger.info(
        'Bot',
        `[WATCHLIST] recheck ${entry.symbol} (#${entry.rechecks}) — no fresh data, ${minutesLeft}m left`
      );
      continue;
    }

    // ── Evaluate promotion criteria ───────────────────────────────────────
    const effectiveBuySell = fresh.buySellRatio === 0 ? 1.0 : fresh.buySellRatio;
    const freshScore       = scoreCandidate({ candidate: fresh });
    const momentumOk       = fresh.priceChange5m  >= WATCHLIST_PROMO_MOMENTUM;
    const buySellOk        = effectiveBuySell      >= WATCHLIST_PROMO_BUY_SELL;
    const scoreOk          = freshScore.total      >= config.MIN_SCORE;

    logger.info(
      'Bot',
      `[WATCHLIST] recheck ${entry.symbol} (#${entry.rechecks}) — ` +
      `5m ${fresh.priceChange5m >= 0 ? '+' : ''}${fresh.priceChange5m.toFixed(1)}%` +
      `${momentumOk ? '✓' : '✗'} | ` +
      `b/s ${effectiveBuySell.toFixed(2)}x${buySellOk ? '✓' : '✗'} | ` +
      `score ${freshScore.total}/${config.MIN_SCORE}${scoreOk ? '✓' : '✗'} | ` +
      `${minutesLeft}m left`
    );

    if (momentumOk && buySellOk && scoreOk) {
      watchlist.delete(mint);
      logger.info(
        'Bot',
        `[WATCHLIST] promoted to buy ${entry.symbol} — ` +
        `5m +${fresh.priceChange5m.toFixed(1)}%, ` +
        `b/s ${effectiveBuySell.toFixed(2)}x, ` +
        `score ${freshScore.total}/${config.MIN_SCORE}`
      );

      // Apply fresh score to candidate so attemptBuy logs accurate details
      fresh.score        = freshScore.total;
      fresh.scoreDetails = freshScore;

      const mode: 'paper' | 'live' = config.LIVE_TRADING ? 'live' : 'paper';
      pendingBuys.add(mint);
      updateCandidateStatus(mint, 'pending_buy');
      try {
        await attemptBuy(fresh, mode);
      } finally {
        pendingBuys.delete(mint);
      }
    }
  }
}

function startWatchlistTimer(): void {
  if (watchlistTimer) return;
  watchlistTimer = setInterval(() => {
    runWatchlistRecheck().catch((err: unknown) => {
      logger.error('Bot', '[WATCHLIST] recheck threw unexpectedly', { err: String(err) });
    });
  }, WATCHLIST_RECHECK_INTERVAL);
  logger.debug('Bot', `[WATCHLIST] timer started — recheck every ${WATCHLIST_RECHECK_INTERVAL / 1_000}s`);
}

function stopWatchlistTimer(): void {
  if (watchlistTimer) {
    clearInterval(watchlistTimer);
    watchlistTimer = null;
  }
  watchlist.clear();
}

// ─── Cycle diagnostics ────────────────────────────────────────────────────────

function zeroDiag(): FilterDiagnostics {
  return {
    cycleAt: Date.now(),
    // Discovery stage (seeded from lastDiscoveryStats each cycle)
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
    // Pre-filter
    rejectedByZeroLiquidity: 0,
    skippedRepeated: 0,
    // Hard filter stage
    evaluated: 0,
    rejectedByAge: 0,
    rejectedByAgeUnverified: 0,
    rejectedByLiquidityLow: 0,
    rejectedByLiquidityHigh: 0,
    rejectedByVolume: 0,
    rejectedByBuyCount: 0,
    rejectedByBuySellRatio: 0,
    rejectedByPriceChange: 0,
    rejectedBySlippage: 0,
    rejectedByScore: 0,
    passedAllFilters: 0,
  };
}

let cycleDiag: FilterDiagnostics = zeroDiag();

// System state snapshot (exported for API / WS)
export let systemState: SystemState = {
  running: false,
  emergencyStop: false,
  mode: config.LIVE_TRADING ? 'live' : 'paper',
  startTime: 0,
  openPositions: 0,
  todayPnlSol: 0,
  todayTrades: 0,
  discoveredToday: 0,
  rpcHealthy: false,
  birdeyeHealthy: false,
  jupiterHealthy: false,
  discoveryStatus: 'NORMAL',
  completedOneTrade: false,
  completedTradeCount: 0,
};

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function startBot(): void {
  if (running) {
    logger.warn('Bot', 'startBot called but already running');
    return;
  }
  running = true;
  systemState.running = true;
  systemState.startTime = Date.now();
  systemState.completedOneTrade = false;
  systemState.completedTradeCount = 0;
  completedTradeCount = 0;

  logger.info(
    'Bot',
    `Starting in ${systemState.mode.toUpperCase()} mode`,
    { liveEnabled: config.LIVE_TRADING }
  );

  // ── Startup runtime config log ───────────────────────────────────────────
  logger.info('Bot', '── Runtime Configuration ──────────────────────────────');
  logger.info('Bot', `  Require verified age for entry : ${config.REQUIRE_VERIFIED_AGE_FOR_ENTRY}`);
  logger.info('Bot', `  Allow unknown-age entry        : ${config.ALLOW_UNKNOWN_AGE_ENTRY}`);
  logger.info('Bot', '  Unknown-age stricter filters   :');
  logger.info('Bot', `    Min liquidity (USD)          : $${config.MIN_LIQUIDITY_USD_UNKNOWN_AGE.toLocaleString()}`);
  logger.info('Bot', `    Min recent volume (USD)      : $${config.MIN_RECENT_VOLUME_USD_UNKNOWN_AGE.toLocaleString()}`);
  logger.info('Bot', `    Min buy/sell ratio           : ${config.MIN_BUY_SELL_RATIO_UNKNOWN_AGE}x`);
  logger.info('Bot', `    Max slippage (%)             : ${config.MAX_ESTIMATED_SLIPPAGE_PCT_UNKNOWN_AGE}%`);
  logger.info('Bot', `  Max open positions             : ${config.MAX_OPEN_POSITIONS}`);
  logger.info('Bot', `  Position size (SOL)            : ${config.DEFAULT_POSITION_SIZE_SOL} (fixed)`);
  logger.info('Bot', `  Stop after N completed trades  : ${config.STOP_AFTER_N_COMPLETED_TRADES === 0 ? 'disabled' : config.STOP_AFTER_N_COMPLETED_TRADES}`);
  logger.info('Bot', `  Stop loss (%)                  : ${config.STOP_LOSS_PCT}%`);
  logger.info('Bot', `  Max hold time (min)            : ${config.MAX_HOLD_MINUTES}`);
  logger.info('Bot', `  Target multiplier              : ${config.TARGET_MULTIPLIER}x`);
  logger.info('Bot', '───────────────────────────────────────────────────────');

  // ── Register trade-completed callback ────────────────────────────────────
  setOnTradeCompletedCallback((mint: string, symbol: string) => {
    completedTradeCount++;
    systemState.completedTradeCount = completedTradeCount;
    logger.info('Bot', `✅ Trade completed: ${symbol} (${mint}) — total closed: ${completedTradeCount}`);

    // Mark in evalCache so this token is skipped for TRADED_COOLDOWN_MS (2 h)
    const now = Date.now();
    const tEntry = evalCache.get(mint);
    if (tEntry) {
      tEntry.lastOutcome     = 'traded';
      tEntry.lastEvaluatedAt = now; // reset cooldown window from this moment
      tEntry.lastSeenAt      = now;
    } else {
      evalCache.set(mint, {
        firstSeenAt: now, lastSeenAt: now, lastEvaluatedAt: now,
        timesSeen: 0, lastScore: 0, lastOutcome: 'traded',
      });
    }
    logger.debug('Bot', `[CACHE] ${symbol} marked as recently traded — cooldown ${TRADED_COOLDOWN_MS / 60_000}m`);

    const nLimit = config.STOP_AFTER_N_COMPLETED_TRADES;
    const legacyStop = config.STOP_AFTER_ONE_COMPLETED_TRADE && completedTradeCount >= 1;
    const nStop = nLimit > 0 && completedTradeCount >= nLimit;

    if (legacyStop || nStop) {
      systemState.completedOneTrade = true;
      logger.info(
        'Bot',
        `🛑 Stop condition reached (${completedTradeCount}/${nLimit > 0 ? nLimit : 1} trades) — shutting down`
      );
      stopBot();
    }
  });

  startPositionMonitor();
  startWatchlistTimer();
  runPipeline(); // immediate first run
  pipelineTimer = setInterval(runPipeline, config.DISCOVERY_INTERVAL_MS);
}

export function stopBot(): void {
  running = false;
  systemState.running = false;
  stopPositionMonitor();
  stopWatchlistTimer();
  if (pipelineTimer) {
    clearInterval(pipelineTimer);
    pipelineTimer = null;
  }
  if (systemState.completedOneTrade) {
    logger.info('Bot', 'Bot stopped — COMPLETED_ONE_TRADE status reached');
  } else {
    logger.info('Bot', 'Bot stopped');
  }
}

export function getSystemState(): SystemState {
  return {
    ...systemState,
    emergencyStop: isEmergencyStop(),
    openPositions: getOpenPositions().length,
    todayPnlSol: tradeDb.getTodayPnl(),
    todayTrades: tradeDb.getTodayCount(),
    jupiterHealthy,
    discoveryStatus: getDiscoveryStatus(),
    completedTradeCount,
  };
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function runPipeline(): Promise<void> {
  if (!running) return;

  // Update and broadcast state
  const state = getSystemState();
  broadcastType('system_status', state);
  broadcastType('candidates_update', getCandidatesSnapshot());

  // ── Gate 0: N-trades stop ────────────────────────────────────────────────
  if (systemState.completedOneTrade) {
    logger.debug('Bot', `Pipeline gated: trade-count stop reached (${completedTradeCount} completed)`);
    return;
  }

  // ── Gate 1: emergency stop ───────────────────────────────────────────────
  if (isEmergencyStop()) {
    logger.debug('Bot', 'Pipeline gated: emergency stop active');
    return;
  }

  // ── Gate 2: daily loss limit ─────────────────────────────────────────────
  const todayPnl = tradeDb.getTodayPnl();
  if (todayPnl <= -Math.abs(config.MAX_DAILY_LOSS)) {
    logger.warn('Bot', `Daily loss limit hit: ${todayPnl.toFixed(6)} SOL ≤ -${config.MAX_DAILY_LOSS} SOL`);
    return;
  }

  // ── Gate 3: position cap ─────────────────────────────────────────────────
  // With multi-position mode (MAX_OPEN_POSITIONS=5) we only skip the whole
  // pipeline when fully capped. Per-token cap is re-checked inside evaluateCandidate.
  const openCount = getOpenPositions().length;
  if (openCount >= config.MAX_OPEN_POSITIONS) {
    logger.debug('Bot', `Max open positions reached: ${openCount}/${config.MAX_OPEN_POSITIONS}`);
    return;
  }

  // ── Gate 4: cooldown (between pipeline runs, not between individual buys) ─
  // COOLDOWN_SECONDS=0 disables this gate. When > 0 it still guards against
  // rapid pipeline re-runs but does not block multiple buys in the same run.
  const cooldownMs = config.COOLDOWN_SECONDS * 1000;
  if (cooldownMs > 0 && lastBuyTime > 0 && Date.now() - lastBuyTime < cooldownMs) {
    const remaining = Math.ceil((cooldownMs - (Date.now() - lastBuyTime)) / 1000);
    logger.debug('Bot', `Cooldown: ${remaining}s remaining`);
    return;
  }

  // ── Evaluate candidates ──────────────────────────────────────────────────
  // Include previously filtered/rejected tokens so the evalCache cooldown can
  // gate them. Without this, a token's status changes to 'filtered_out' /
  // 'rejected' and the pipeline never visits it again — making the cooldown
  // skip logic unreachable.
  const candidates = getAllCandidates().filter(
    (c) => c.status === 'discovered' || c.status === 'filtered_out' || c.status === 'rejected'
  );
  systemState.discoveredToday = candidates.filter((c) => c.status === 'discovered').length;

  // Reset per-cycle diagnostics and seed with latest discovery stats
  cycleDiag = zeroDiag();
  cycleDiag.cycleAt = Date.now();
  cycleDiag.totalFetched            = lastDiscoveryStats.totalFetched;
  cycleDiag.overviewAttempted       = lastDiscoveryStats.overviewAttempted;
  cycleDiag.overviewSucceeded       = lastDiscoveryStats.overviewSucceeded;
  cycleDiag.overviewFailed          = lastDiscoveryStats.overviewFailed;
  cycleDiag.rateLimitedCount        = lastDiscoveryStats.rateLimitedCount;
  cycleDiag.removedByDiscoveryAge   = lastDiscoveryStats.removedByDiscoveryAge;
  cycleDiag.remainingAfterDiscovery = lastDiscoveryStats.remainingAfterDiscovery;
  cycleDiag.verifiedAgeCount        = lastDiscoveryStats.verifiedAgeCount;
  cycleDiag.estimatedAgeCount       = lastDiscoveryStats.estimatedAgeCount;
  cycleDiag.unknownAgeCount         = lastDiscoveryStats.unknownAgeCount;

  // Evict stale cache entries (unseen for >2 hours) to prevent unbounded growth
  const staleThreshold = Date.now() - 2 * 60 * 60 * 1_000;
  for (const [mint, entry] of evalCache) {
    if (entry.lastSeenAt < staleThreshold) evalCache.delete(mint);
  }

  for (const candidate of candidates) {
    if (!running) break;
    await evaluateCandidate(candidate);
  }

  // ── 70% dominant-filter warning ───────────────────────────────────────────
  if (cycleDiag.evaluated > 0) {
    const filterCounts: Array<[string, number]> = [
      ['age (entry)',       cycleDiag.rejectedByAge],
      ['age-unverified',    cycleDiag.rejectedByAgeUnverified],
      ['liquidity-low',     cycleDiag.rejectedByLiquidityLow],
      ['liquidity-high',    cycleDiag.rejectedByLiquidityHigh],
      ['volume',            cycleDiag.rejectedByVolume],
      ['buy count',         cycleDiag.rejectedByBuyCount],
      ['buy/sell ratio',    cycleDiag.rejectedByBuySellRatio],
      ['price change',      cycleDiag.rejectedByPriceChange],
      ['slippage',          cycleDiag.rejectedBySlippage],
      ['score',             cycleDiag.rejectedByScore],
    ];
    for (const [name, count] of filterCounts) {
      if (count / cycleDiag.evaluated > 0.7) {
        cycleDiag.dominantRejectionFilter = name;
        cycleDiag.dominantRejectionPct = Math.round((count / cycleDiag.evaluated) * 100);
        logger.warn(
          'Bot',
          `⚠️  ${cycleDiag.dominantRejectionPct}% of candidates rejected by [${name}] — ` +
          'filter may be too strict'
        );
        break;
      }
    }
  }

  // ── Discovery summary ─────────────────────────────────────────────────────
  if (cycleDiag.totalFetched > 0) {
    const tradeable = cycleDiag.totalFetched - cycleDiag.rejectedByZeroLiquidity;
    logger.info(
      'Bot',
      `Discovery active — ${cycleDiag.totalFetched} tokens fetched, ` +
      `${tradeable} tradeable, ` +
      `${cycleDiag.rejectedByZeroLiquidity} rejected (liquidity=0)`
    );
  }

  // ── No-candidate notice ───────────────────────────────────────────────────
  if (cycleDiag.evaluated > 0 && cycleDiag.passedAllFilters === 0) {
    logger.info('Bot', 'No tradeable candidates this cycle (low-quality batch)');
  }

  // ── Freshness summary ─────────────────────────────────────────────────────
  if (cycleDiag.skippedRepeated > 0 || cycleDiag.evaluated > 0) {
    logger.info(
      'Bot',
      `${cycleDiag.skippedRepeated} repeated candidates skipped, ` +
      `${cycleDiag.evaluated} fresh candidates evaluated`
    );
  }

  // ── Filter diagnostics summary log ───────────────────────────────────────
  if (cycleDiag.evaluated > 0 || cycleDiag.totalFetched > 0) {
    logger.info('Bot', [
      `Filter summary | fetched=${cycleDiag.totalFetched}`,
      `liq0-skip=${cycleDiag.rejectedByZeroLiquidity}`,
      `repeat-skip=${cycleDiag.skippedRepeated}`,
      `overviews=${cycleDiag.overviewSucceeded}/${cycleDiag.overviewAttempted}(ok/tried)`,
      `rate-limited=${cycleDiag.rateLimitedCount}`,
      `age-verified=${cycleDiag.verifiedAgeCount} est=${cycleDiag.estimatedAgeCount} unknown=${cycleDiag.unknownAgeCount}`,
      `disc-age-removed=${cycleDiag.removedByDiscoveryAge}`,
      `evaluated=${cycleDiag.evaluated}`,
      `age-unverified-rej=${cycleDiag.rejectedByAgeUnverified}`,
      `liq-low=${cycleDiag.rejectedByLiquidityLow}`,
      `liq-high=${cycleDiag.rejectedByLiquidityHigh}`,
      `vol=${cycleDiag.rejectedByVolume}`,
      `buy-count=${cycleDiag.rejectedByBuyCount}`,
      `b/s-ratio=${cycleDiag.rejectedByBuySellRatio}`,
      `slippage=${cycleDiag.rejectedBySlippage}`,
      `price-ext=${cycleDiag.rejectedByPriceChange}`,
      `score=${cycleDiag.rejectedByScore}`,
      `passed=${cycleDiag.passedAllFilters}`,
    ].join(' | '));
  }

  // ── Publish diagnostics (after warning check so dominantRejection is set) ─
  broadcastType('cycle_diagnostics', cycleDiag);
}

async function evaluateCandidate(candidate: TokenCandidate): Promise<void> {
  const { mint, symbol } = candidate;

  // Already buying or open position in this token
  if (pendingBuys.has(mint) || getOpenPositionMints().has(mint)) return;

  // ── Freshness gate ─────────────────────────────────────────────────────────
  // Runs BEFORE the zero-liquidity check so every token (including zero-liq
  // ones) is registered in the cache and its cooldown is respected on subsequent
  // pipeline cycles.
  const now = Date.now();

  // On first sight: create entry.  On subsequent sights: update counters.
  const cachedExisting = evalCache.get(mint);
  const cached: EvalCacheEntry = cachedExisting ?? {
    firstSeenAt:     now,
    lastSeenAt:      now,
    lastEvaluatedAt: 0,
    timesSeen:       0,   // incremented below
    lastScore:       0,
    lastOutcome:     null,
  };
  if (!cachedExisting) evalCache.set(mint, cached);
  cached.lastSeenAt = now;
  cached.timesSeen++;

  // Cooldown check — unconditional: skip any token evaluated within the cooldown window.
  // No material-change bypass; volatile 5m price moves on meme tokens would
  // otherwise trigger re-evaluation every cycle and keep repeat-skip at 0.
  if (cached.lastEvaluatedAt > 0) {
    const cooldownMs =
      cached.lastOutcome === 'traded'   ? TRADED_COOLDOWN_MS   :
      cached.lastOutcome === 'rejected' ? REJECTED_COOLDOWN_MS :
      cached.lastOutcome === 'filtered' ? REJECTED_COOLDOWN_MS :
      EVAL_COOLDOWN_MS;

    if ((now - cached.lastEvaluatedAt) < cooldownMs) {
      const agoMin = Math.round((now - cached.lastEvaluatedAt) / 60_000);
      logger.debug(
        'Bot',
        `[SKIP] ${symbol} — Skipping token — cooldown active ` +
        `(${agoMin}m ago, cooldown ${Math.round(cooldownMs / 60_000)}m, outcome=${cached.lastOutcome ?? 'none'})`
      );
      cycleDiag.skippedRepeated++;
      return;
    }
  }

  // ── Zero-liquidity short-circuit ──────────────────────────────────────────
  // Non-tradeable tokens are rejected immediately. The cache is stamped so
  // the token is skipped (not re-counted) for the next cooldown window.
  if (candidate.liquidityUsd === 0) {
    cycleDiag.rejectedByZeroLiquidity++;
    updateCandidateStatus(mint, 'filtered_out', {
      rejectionReason: 'Non-tradeable: liquidity is zero',
      passedFilters: false,
    });
    cached.lastEvaluatedAt = now;
    cached.lastOutcome     = 'filtered';
    return;
  }

  cycleDiag.evaluated++;

  // Stamp evaluation time in cache
  cached.lastEvaluatedAt = now;

  // ── Log age provenance for every evaluated candidate ─────────────────────
  logger.debug(
    'Bot',
    `[CANDIDATE] ${symbol} | ageState=${candidate.ageState} | ageSource=${candidate.ageSource}`
  );

  // ── Filter ───────────────────────────────────────────────────────────────
  const filterResult = applyHardFilters(candidate);

  if (filterResult.unknownAgeFiltersApplied) {
    logger.warn(
      'Bot',
      `[FILTER] ${symbol} — Warning: unknown-age token allowed — stricter filters applied` +
        ` (ageState=${candidate.ageState}, ageSource=${candidate.ageSource})`
    );
  }

  if (!filterResult.pass) {
    logger.debug('Bot', `[FILTER] ${symbol} rejected: ${filterResult.reason}` +
      ` | ageState=${candidate.ageState} | ageSource=${candidate.ageSource}` +
      (filterResult.unknownAgeFiltersApplied ? ' | filtersUsed=unknown-age-strict' : ''));
    updateCandidateStatus(mint, 'filtered_out', {
      rejectionReason: filterResult.reason,
      redFlags: filterResult.redFlags,
      passedFilters: false,
    });
    persistCandidate(candidate, 'filtered_out', filterResult.reason, filterResult.redFlags);

    // Record outcome so the freshness gate applies the longer rejection cooldown
    const fEntry = evalCache.get(mint);
    if (fEntry) fEntry.lastOutcome = 'filtered';

    // Increment per-category counter
    switch (filterResult.rejectedBy) {
      case 'age':             cycleDiag.rejectedByAge++;              break;
      case 'age_unverified':  cycleDiag.rejectedByAgeUnverified++;   break;
      case 'liquidity_low':   cycleDiag.rejectedByLiquidityLow++;    break;
      case 'liquidity_high':  cycleDiag.rejectedByLiquidityHigh++;   break;
      case 'volume':          cycleDiag.rejectedByVolume++;          break;
      case 'buy_count':       cycleDiag.rejectedByBuyCount++;        break;
      case 'buy_sell_ratio':  cycleDiag.rejectedByBuySellRatio++;    break;
      case 'price_change':    cycleDiag.rejectedByPriceChange++;     break;
      case 'red_flags':       cycleDiag.rejectedByScore++;           break;
      default:                break;
    }

    // Permanently skip tokens whose age will only increase
    if (filterResult.rejectedBy === 'age' && filterResult.reason.includes('> max')) {
      rejectPermanently(mint);
    }
    return;
  }

  candidate.passedFilters = true;
  candidate.redFlags = filterResult.redFlags;

  // ── Score (no pre-quote — Jupiter is only called after score passes) ──────
  const scoreResult = scoreCandidate({ candidate });
  updateCandidateStatus(mint, 'scored', { score: scoreResult.total, scoreDetails: scoreResult });
  persistCandidate(candidate, 'scored', scoreResult.summary, candidate.redFlags);

  // Store score in cache for future near-miss / change-detection reference
  const cacheEntry = evalCache.get(mint);
  if (cacheEntry) cacheEntry.lastScore = scoreResult.total;

  if (scoreResult.grade === 'reject' || scoreResult.total < config.MIN_SCORE) {
    const reason = `Score ${scoreResult.total} < threshold ${config.MIN_SCORE}: ${scoreResult.summary}`;
    const nearMiss = scoreResult.total >= config.MIN_SCORE - 5;
    logger.debug('Bot', `[SCORE] ${symbol} rejected: ${reason} | near-miss=${nearMiss ? 'yes' : 'no'}`);
    updateCandidateStatus(mint, 'rejected', { rejectionReason: reason });
    persistCandidate(candidate, 'rejected', reason, candidate.redFlags);
    // Record outcome so the freshness gate applies the rejection cooldown
    const sEntry = evalCache.get(mint);
    if (sEntry) sEntry.lastOutcome = 'rejected';
    cycleDiag.rejectedByScore++;

    // Near-miss watchlist: token almost passed — monitor for improvement
    if (
      nearMiss &&
      candidate.liquidityUsd >= WATCHLIST_MIN_LIQUIDITY &&
      candidate.pairAgeMinutes >= config.MIN_PAIR_AGE_MINUTES &&
      candidate.pairAgeMinutes <= WATCHLIST_MAX_AGE_MINUTES &&
      !watchlist.has(mint) &&
      !getOpenPositionMints().has(mint) &&
      !pendingBuys.has(mint)
    ) {
      addToWatchlist(candidate, scoreResult.total);
    }
    return;
  }

  // ── Component-level minimums ─────────────────────────────────────────────
  // Even if total score passes, reject tokens with structurally weak components.
  const { liquidityScore, buyPressureScore } = scoreResult.breakdown;
  if (liquidityScore < 5 || buyPressureScore < 5) {
    const reason = `Rejected: weak structure (liquidity/buy pressure) — liquidityScore=${liquidityScore}, buyPressureScore=${buyPressureScore}, total=${scoreResult.total}`;
    logger.info('Bot', `[SCORE] ${symbol} ${reason}`);
    updateCandidateStatus(mint, 'rejected', { rejectionReason: reason });
    persistCandidate(candidate, 'rejected', reason, candidate.redFlags);
    const wEntry = evalCache.get(mint);
    if (wEntry) wEntry.lastOutcome = 'rejected';
    cycleDiag.rejectedByScore++;
    return;
  }

  cycleDiag.passedAllFilters++;
  logger.info('Bot', `[SCORE] ${symbol} passed: ${scoreResult.total}/100 — attempting buy`, {
    ageState: candidate.ageState,
    ageSource: candidate.ageSource,
    filtersUsed: filterResult.unknownAgeFiltersApplied ? 'unknown-age-strict' : 'normal',
    breakdown: scoreResult.breakdown,
  });

  // ── Buy gate: re-check global guards before executing ────────────────────
  if (isEmergencyStop()) return;
  if (systemState.completedOneTrade) return;
  if (getOpenPositions().length >= config.MAX_OPEN_POSITIONS) return;
  if (getOpenPositionMints().has(mint)) return;

  // ── Live mode guard ──────────────────────────────────────────────────────
  const mode: 'paper' | 'live' = config.LIVE_TRADING ? 'live' : 'paper';

  // ── Lock the mint ─────────────────────────────────────────────────────────
  pendingBuys.add(mint);
  updateCandidateStatus(mint, 'pending_buy');

  try {
    await attemptBuy(candidate, mode);
  } finally {
    pendingBuys.delete(mint);
  }
}

async function attemptBuy(
  candidate: TokenCandidate,
  mode: 'paper' | 'live'
): Promise<void> {
  const { mint, symbol, decimals, price: marketPrice, liquidityUsd } = candidate;

  // ── Get executable quote (first and only Jupiter call for this candidate) ─
  const quote = await getBuyQuote(mint, config.DEFAULT_POSITION_SIZE_SOL);
  if (!quote) {
    const reason = 'Could not obtain executable buy quote from Jupiter';
    logger.warn('Bot', `[BUY] ${symbol}: ${reason}`);
    updateCandidateStatus(mint, 'rejected', { rejectionReason: reason });
    persistCandidate(candidate, 'rejected', reason, []);
    const qEntry = evalCache.get(mint);
    if (qEntry) qEntry.lastOutcome = 'rejected';
    return;
  }

  // ── Validate quote ────────────────────────────────────────────────────────
  const validation = validateBuyQuote(quote, marketPrice, decimals);
  if (!validation.valid) {
    const reason = `Quote validation failed: ${validation.reason}`;
    logger.warn('Bot', `[BUY] ${symbol}: ${reason}`);
    updateCandidateStatus(mint, 'rejected', { rejectionReason: reason });
    persistCandidate(candidate, 'rejected', reason, []);
    const vEntry = evalCache.get(mint);
    if (vEntry) vEntry.lastOutcome = 'rejected';
    return;
  }

  logger.info('Bot', `[BUY] ${symbol} — executing ${mode} buy @ ~$${marketPrice.toFixed(8)}`, {
    sol: config.DEFAULT_POSITION_SIZE_SOL,
    priceImpact: validation.priceImpactPct.toFixed(2) + '%',
    score: candidate.score,
    ageState: candidate.ageState,
    ageSource: candidate.ageSource,
  });

  // ── Execute ───────────────────────────────────────────────────────────────
  const buyResult = await executeBuy(quote, decimals, marketPrice, mode === 'paper');

  if (!buyResult.success) {
    const reason = `Buy execution failed: ${buyResult.error}`;
    logger.error('Bot', `[BUY] ${symbol}: ${reason}`);
    updateCandidateStatus(mint, 'rejected', { rejectionReason: reason });
    persistCandidate(candidate, 'rejected', reason, []);
    const eEntry = evalCache.get(mint);
    if (eEntry) eEntry.lastOutcome = 'rejected';
    return;
  }

  // ── Record trade in DB ────────────────────────────────────────────────────
  const entryPrice = buyResult.effectiveEntryPrice ?? marketPrice;
  const tokenAmount = buyResult.tokenAmountReceived ?? 0;
  const now = Date.now();

  const tradeRecord = {
    mint,
    symbol,
    mode,
    status: 'open' as const,
    entryTime: now,
    entryPrice,
    tokenAmount,
    buySizeSol: config.DEFAULT_POSITION_SIZE_SOL,
    buySignature: buyResult.signature,
    entryLiquidityUsd: liquidityUsd,
    entryQuote: JSON.stringify(quote),
  };

  const tradeId = tradeDb.insert(tradeRecord);

  // ── Open position in manager ──────────────────────────────────────────────
  const position: ActivePosition = {
    id: tradeId,
    mint,
    symbol,
    decimals,
    mode,
    entryTime: now,
    entryPrice,
    tokenAmount,
    buySizeSol: config.DEFAULT_POSITION_SIZE_SOL,
    entryLiquidityUsd: liquidityUsd,
    buySignature: buyResult.signature,
    targetPrice: entryPrice * config.TARGET_MULTIPLIER,
    stopLossPrice: entryPrice * (1 - config.STOP_LOSS_PCT / 100),
    maxExitTime: now + config.MAX_HOLD_MINUTES * 60 * 1000,
    beingClosed: false,
  };

  openPosition(position);
  updateCandidateStatus(mint, 'bought');
  persistCandidate(candidate, 'bought', 'Position opened', []);
  // Track as 'passed' — will be promoted to 'traded' when the position closes
  const bEntry = evalCache.get(mint);
  if (bEntry) bEntry.lastOutcome = 'passed';

  lastBuyTime = Date.now();

  broadcastType('trade_opened', {
    id: tradeId,
    mint,
    symbol,
    mode,
    entryPrice,
    tokenAmount,
    buySizeSol: config.DEFAULT_POSITION_SIZE_SOL,
    targetPrice: position.targetPrice,
    stopLossPrice: position.stopLossPrice,
    signature: buyResult.signature,
  });

  logger.info('Bot', `✅ Position opened: ${symbol} [${mode.toUpperCase()}]`, {
    id: tradeId,
    entry: entryPrice,
    target: position.targetPrice,
    stop: position.stopLossPrice,
    tokens: tokenAmount,
    ageState: candidate.ageState,
  });

  // ── Telegram: token found ─────────────────────────────────────────────────
  const modeLabel = mode === 'live' ? '🔴 LIVE' : '📄 PAPER';
  sendTelegram(
    `🟢 <b>TOKEN FOUND</b> — ${modeLabel}\n\n` +
    `<b>${symbol}</b>\n` +
    `Address:   <code>${mint}</code>\n` +
    `Price:     <code>$${entryPrice.toFixed(8)}</code>\n` +
    `Score:     <code>${candidate.score ?? '?'}/100</code>\n` +
    `Liquidity: <code>$${(liquidityUsd / 1_000).toFixed(1)}K</code>\n` +
    `5m:        <code>${candidate.priceChange5m >= 0 ? '+' : ''}${candidate.priceChange5m.toFixed(1)}%</code>\n` +
    `B/S ratio: <code>${candidate.buySellRatio.toFixed(2)}x</code>\n` +
    `Size:      <code>${config.DEFAULT_POSITION_SIZE_SOL} SOL</code>\n` +
    `Target:    <code>$${position.targetPrice.toFixed(8)}</code> (+${((config.TARGET_MULTIPLIER - 1) * 100).toFixed(0)}%)\n` +
    `Stop:      <code>$${position.stopLossPrice.toFixed(8)}</code> (-${config.STOP_LOSS_PCT}%)\n` +
    `Age:       <code>${candidate.pairAgeMinutes.toFixed(1)}m</code>`
  ).catch(() => {}); // already swallowed inside, but belt-and-suspenders
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function persistCandidate(
  c: TokenCandidate,
  status: string,
  reason: string,
  redFlags: string[]
): void {
  try {
    candidateDb.upsert({
      mint: c.mint, symbol: c.symbol, name: c.name, decimals: c.decimals,
      discoveredAt: c.discoveredAt, lastUpdated: Date.now(), status,
      score: c.score, scoreReason: reason,
      scoreBreakdown: c.scoreDetails ? JSON.stringify(c.scoreDetails.breakdown) : undefined,
      liquidityUsd: c.liquidityUsd, volume1h: c.volume1h, volume30m: c.volume30m,
      buyCount30m: c.buyCount30m, sellCount30m: c.sellCount30m, buySellRatio: c.buySellRatio,
      priceChange5m: c.priceChange5m, priceChange15m: c.priceChange15m,
      priceChange30m: c.priceChange30m,
      price: c.price, fdv: c.fdv, mc: c.mc, pairAgeMinutes: c.pairAgeMinutes,
      rejectionReason: reason,
      redFlags: JSON.stringify(redFlags),
    });
  } catch { /* never let DB writes crash the bot */ }
}

function getCandidatesSnapshot(): unknown[] {
  return getAllCandidates().map((c) => ({
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    status: c.status,
    score: c.score,
    scoreGrade: c.scoreDetails?.grade,
    liquidityUsd: c.liquidityUsd,
    volume30m: c.volume30m,
    priceChange5m: c.priceChange5m,
    pairAgeMinutes: Number(c.pairAgeMinutes.toFixed(1)),
    price: c.price,
    buySellRatio: Number(c.buySellRatio.toFixed(2)),
    buyCount30m: c.buyCount30m,
    rejectionReason: c.rejectionReason,
    redFlags: c.redFlags,
    lastUpdated: c.lastUpdated,
    // Age provenance — always included so UI can display filter mode clearly
    ageState: c.ageState,
    ageSource: c.ageSource,
  }));
}
