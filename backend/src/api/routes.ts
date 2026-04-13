import { Router, Request, Response } from 'express';
import { config, patchConfig, PatchableFilterSettings } from '../config';
import { logger } from '../logger';
import { candidateDb, tradeDb } from '../db';
import { getAllCandidates } from '../services/discovery/birdeyeService';
import {
  getOpenPositions,
  serializePositions,
  triggerEmergencyStop,
  clearEmergencyStop,
  isEmergencyStop,
} from '../services/position/positionManager';
import { getSystemState, startBot, stopBot } from '../bot/sniperBot';
import { getWalletBalance, checkRpcHealth, rpcHealthy } from '../services/execution/walletService';
import { jupiterHealthy } from '../services/execution/jupiterService';
import { birdeyeHealthy } from '../services/discovery/birdeyeService';

const router = Router();

// ─── System status ────────────────────────────────────────────────────────────

router.get('/status', async (_req: Request, res: Response) => {
  const state = getSystemState();
  let balance: number | undefined;

  if (config.PRIVATE_KEY) {
    balance = await getWalletBalance().catch(() => undefined);
  }

  res.json({
    ...state,
    walletBalanceSol: balance,
    rpcHealthy,
    birdeyeHealthy,
    jupiterHealthy,
    config: {
      mode: config.LIVE_TRADING ? 'live' : 'paper',
      positionSizeSol: config.DEFAULT_POSITION_SIZE_SOL,
      maxOpenPositions: config.MAX_OPEN_POSITIONS,
      minScore: config.MIN_SCORE,
      stopLossPct: config.STOP_LOSS_PCT,
      maxHoldMinutes: config.MAX_HOLD_MINUTES,
      targetMultiplier: config.TARGET_MULTIPLIER,
      cooldownSeconds: config.COOLDOWN_SECONDS,
    },
  });
});

// ─── Candidates ───────────────────────────────────────────────────────────────

router.get('/candidates', (_req: Request, res: Response) => {
  const all = getAllCandidates().map((c) => ({
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    status: c.status,
    score: c.score,
    scoreGrade: c.scoreDetails?.grade,
    scoreSummary: c.scoreDetails?.summary,
    scoreBreakdown: c.scoreDetails?.breakdown,
    liquidityUsd: c.liquidityUsd,
    volume30m: c.volume30m,
    volume1h: c.volume1h,
    priceChange5m: c.priceChange5m,
    priceChange15m: c.priceChange15m,
    priceChange30m: c.priceChange30m,
    pairAgeMinutes: Number(c.pairAgeMinutes.toFixed(1)),
    price: c.price,
    fdv: c.fdv,
    mc: c.mc,
    buySellRatio: c.buySellRatio,
    buyCount30m: c.buyCount30m,
    sellCount30m: c.sellCount30m,
    rejectionReason: c.rejectionReason,
    redFlags: c.redFlags,
    passedFilters: c.passedFilters,
    discoveredAt: c.discoveredAt,
    lastUpdated: c.lastUpdated,
  }));

  res.json({ candidates: all, total: all.length });
});

router.get('/candidates/db', (_req: Request, res: Response) => {
  res.json({ candidates: candidateDb.getAll() });
});

// ─── Positions ────────────────────────────────────────────────────────────────

router.get('/positions/open', (_req: Request, res: Response) => {
  res.json({ positions: serializePositions() });
});

router.get('/positions/closed', (_req: Request, res: Response) => {
  res.json({ trades: tradeDb.getOpen() });
});

// ─── Trade history ────────────────────────────────────────────────────────────

router.get('/trades', (req: Request, res: Response) => {
  const limit = parseInt((req.query.limit as string) ?? '100', 10);
  res.json({ trades: tradeDb.getHistory(limit) });
});

// ─── Logs ─────────────────────────────────────────────────────────────────────

router.get('/logs', (req: Request, res: Response) => {
  const limit = parseInt((req.query.limit as string) ?? '200', 10);
  const all = logger.getBuffer();
  res.json({ logs: all.slice(-limit) });
});

// ─── Settings (read-only in this version; write requires restart) ─────────────

router.get('/settings', (_req: Request, res: Response) => {
  // Never expose PRIVATE_KEY or API keys
  res.json({
    PORT: config.PORT,
    LIVE_TRADING: config.LIVE_TRADING,
    DEFAULT_POSITION_SIZE_SOL: config.DEFAULT_POSITION_SIZE_SOL,
    MAX_OPEN_POSITIONS: config.MAX_OPEN_POSITIONS,
    MAX_DAILY_LOSS: config.MAX_DAILY_LOSS,
    COOLDOWN_SECONDS: config.COOLDOWN_SECONDS,
    MIN_LIQUIDITY_USD: config.MIN_LIQUIDITY_USD,
    MAX_LIQUIDITY_USD: config.MAX_LIQUIDITY_USD,
    MIN_RECENT_VOLUME_USD: config.MIN_RECENT_VOLUME_USD,
    MIN_RECENT_BUY_COUNT: config.MIN_RECENT_BUY_COUNT,
    MIN_BUY_SELL_RATIO: config.MIN_BUY_SELL_RATIO,
    MAX_5M_PRICE_CHANGE_PCT: config.MAX_5M_PRICE_CHANGE_PCT,
    MAX_15M_PRICE_CHANGE_PCT: config.MAX_15M_PRICE_CHANGE_PCT,
    MAX_ESTIMATED_SLIPPAGE_PCT: config.MAX_ESTIMATED_SLIPPAGE_PCT,
    MAX_DISCOVERY_AGE_MINUTES: config.MAX_DISCOVERY_AGE_MINUTES,
    MIN_PAIR_AGE_MINUTES: config.MIN_PAIR_AGE_MINUTES,
    MAX_PAIR_AGE_MINUTES: config.MAX_PAIR_AGE_MINUTES,
    MIN_SCORE: config.MIN_SCORE,
    TARGET_MULTIPLIER: config.TARGET_MULTIPLIER,
    SELL_TRIGGER_BUFFER_LOW: config.SELL_TRIGGER_BUFFER_LOW,
    SELL_TRIGGER_BUFFER_HIGH: config.SELL_TRIGGER_BUFFER_HIGH,
    STOP_LOSS_PCT: config.STOP_LOSS_PCT,
    MAX_HOLD_MINUTES: config.MAX_HOLD_MINUTES,
    LIQUIDITY_DROP_EXIT_PCT: config.LIQUIDITY_DROP_EXIT_PCT,
    SLIPPAGE_BPS: config.SLIPPAGE_BPS,
    PRIORITY_FEE_LAMPORTS: config.PRIORITY_FEE_LAMPORTS,
    DISCOVERY_INTERVAL_MS: config.DISCOVERY_INTERVAL_MS,
    POSITION_MONITOR_INTERVAL_MS: config.POSITION_MONITOR_INTERVAL_MS,
  });
});

// ─── Settings (PATCH applies runtime overrides to filter settings) ────────────

router.patch('/settings', (req: Request, res: Response) => {
  const allowed: Set<keyof PatchableFilterSettings> = new Set([
    'MAX_DISCOVERY_AGE_MINUTES',
    'MIN_PAIR_AGE_MINUTES',
    'MAX_PAIR_AGE_MINUTES',
    'MIN_LIQUIDITY_USD',
    'MAX_LIQUIDITY_USD',
    'MIN_RECENT_VOLUME_USD',
    'MIN_RECENT_BUY_COUNT',
    'MIN_BUY_SELL_RATIO',
    'MAX_5M_PRICE_CHANGE_PCT',
    'MAX_15M_PRICE_CHANGE_PCT',
    'MAX_ESTIMATED_SLIPPAGE_PCT',
    'MIN_SCORE',
  ]);

  const body = req.body as Record<string, unknown>;
  const updates: Partial<PatchableFilterSettings> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key as keyof PatchableFilterSettings)) {
      rejected.push(key);
      continue;
    }
    const n = Number(value);
    if (!isFinite(n)) { rejected.push(key); continue; }
    (updates as Record<string, number>)[key] = n;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ ok: false, error: 'No valid patchable fields provided', rejected });
    return;
  }

  patchConfig(updates);
  logger.info('API', 'Filter settings patched at runtime', updates as Record<string, unknown>);

  res.json({ ok: true, applied: updates, rejected: rejected.length ? rejected : undefined });
});

// ─── Emergency stop / resume ──────────────────────────────────────────────────

router.post('/emergency-stop', (_req: Request, res: Response) => {
  triggerEmergencyStop();
  logger.warn('API', '🚨 Emergency stop triggered via API');
  res.json({ ok: true, emergencyStop: true });
});

router.post('/resume', (_req: Request, res: Response) => {
  if (isEmergencyStop()) {
    clearEmergencyStop();
    logger.info('API', 'Emergency stop cleared via API');
  }
  res.json({ ok: true, emergencyStop: false });
});

// ─── Bot lifecycle ────────────────────────────────────────────────────────────

router.post('/bot/start', (_req: Request, res: Response) => {
  startBot();
  res.json({ ok: true, running: true });
});

router.post('/bot/stop', (_req: Request, res: Response) => {
  stopBot();
  res.json({ ok: true, running: false });
});

// ─── Health check ─────────────────────────────────────────────────────────────

router.get('/health', async (_req: Request, res: Response) => {
  const rpc = await checkRpcHealth();
  res.json({
    ok: true,
    rpc,
    birdeye: birdeyeHealthy,
    jupiter: jupiterHealthy,
    ts: Date.now(),
  });
});

export default router;
