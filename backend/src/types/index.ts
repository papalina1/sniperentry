// ─── Birdeye raw API shapes ───────────────────────────────────────────────────

export interface BirdeyeNewListingItem {
  address: string;
  symbol: string;
  name: string;
  decimals?: number;
  listing_time?: number;        // unix seconds — from v3 new-listing endpoint
  listingTime?: number;
  lastTradeUnixTime?: number;   // unix seconds — from tokenlist / token_overview
  liquidity?: number;
  volume24h?: number;
}

export interface BirdeyeTokenOverview {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  price: number;
  liquidity: number;

  // Volume windows — Birdeye exposes various windows; we prefer shorter
  volume24h?: number;
  v24hUSD?: number;
  volume1h?: number;
  v1hUSD?: number;
  volume30m?: number;
  v30mUSD?: number;
  vBuy30mUSD?: number;
  vSell30mUSD?: number;

  // Price changes (percent)
  priceChange5mPercent?: number;
  priceChange15mPercent?: number;
  priceChange30mPercent?: number;
  priceChange1hPercent?: number;
  priceChange24hPercent?: number;

  // Trade counts
  trade30m?: number;
  buy30m?: number;
  sell30m?: number;
  trade1h?: number;
  buy1h?: number;
  sell1h?: number;
  uniqueWallet30m?: number;
  uniqueWallet1h?: number;

  // Valuation
  mc?: number;
  fdv?: number;
  holder?: number;

  // Metadata
  extensions?: Record<string, unknown>;
}

// ─── Jupiter raw API shapes ───────────────────────────────────────────────────

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null | { amount: string; feeBps: number };
  priceImpactPct: string;
  routePlan: JupiterRoutePlan[];
  contextSlot: number;
  timeTaken: number;
}

export interface JupiterRoutePlan {
  swapInfo: {
    ammKey: string;
    label?: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface JupiterSwapResponse {
  swapTransaction: string; // base64-encoded VersionedTransaction
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
}

// ─── Candidate status lifecycle ──────────────────────────────────────────────

export type CandidateStatus =
  | 'discovered'            // just seen, not yet filtered
  | 'filtering'             // currently being evaluated
  | 'discovery_age_filtered'// removed at discovery stage — older than MAX_DISCOVERY_AGE_MINUTES
  | 'filtered_out'          // failed hard entry filters
  | 'scored'                // passed filters; has a score
  | 'pending_buy'           // buy is in-flight
  | 'bought'                // position opened
  | 'rejected';             // scored but did not meet threshold or other runtime check

// ─── Age state ───────────────────────────────────────────────────────────────

/**
 * Describes how trustworthy the token's age figure is.
 *
 * verified  — age comes from an explicit listing/creation timestamp returned
 *             by the API (listing_time, listingTime, firstTradeUnixTime, createdAt).
 *             The value can be used directly in entry filters.
 *
 * estimated — age is inferred from a proxy signal (lastTradeUnixTime) or
 *             carried forward from the previous cycle.  May be close to correct
 *             but has not been confirmed by an explicit creation event.
 *
 * unknown   — no timestamp was available; the age is a synthetic fallback
 *             value.  Treat as completely untrustworthy for entry decisions.
 */
export type AgeState = 'verified' | 'estimated' | 'unknown';

// ─── Filter rejection categories ─────────────────────────────────────────────

export type FilterRejectionCategory =
  | 'age'
  | 'age_unverified'
  | 'liquidity_low'
  | 'liquidity_high'
  | 'volume'
  | 'buy_count'
  | 'buy_sell_ratio'
  | 'price_change'
  | 'price'
  | 'red_flags'
  | 'slippage'
  | 'score';

// ─── Score breakdown ──────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  liquidityScore: number;       // 0–20
  momentumScore: number;        // 0–20
  buyPressureScore: number;     // 0–20
  timingScore: number;          // 0–15
  quoteScore: number;           // 0–10
  volatilityPenalty: number;    // 0 to -5
  lateEntryPenalty: number;     // 0 to -5
  slippagePenalty: number;      // 0 to -10
  suspiciousPenalty: number;    // 0 to -10
  concentrationPenalty: number; // 0 to -5
}

export interface ScoreResult {
  total: number;
  grade: 'pass' | 'warn' | 'reject';
  summary: string;
  breakdown: ScoreBreakdown;
}

// ─── Filter result ────────────────────────────────────────────────────────────

export interface FilterResult {
  pass: boolean;
  reason: string;
  redFlags: string[];
  rejectedBy?: FilterRejectionCategory;
  /** True when the token had unknown age and was evaluated against stricter thresholds */
  unknownAgeFiltersApplied?: boolean;
}

// ─── Filter diagnostics (per cycle) ──────────────────────────────────────────

export interface FilterDiagnostics {
  cycleAt: number;               // ms timestamp
  // Discovery stage
  totalFetched: number;
  overviewAttempted: number;
  overviewSucceeded: number;
  overviewFailed: number;
  rateLimitedCount: number;
  removedByDiscoveryAge: number;
  remainingAfterDiscovery: number;
  // Age quality
  verifiedAgeCount: number;
  estimatedAgeCount: number;
  unknownAgeCount: number;
  // Pre-filter: zero-liquidity short-circuit (not counted in evaluated)
  rejectedByZeroLiquidity: number;
  // Freshness gate: repeated unchanged candidates skipped (not counted in evaluated)
  skippedRepeated: number;
  // Hard filter stage
  evaluated: number;
  rejectedByAge: number;
  rejectedByAgeUnverified: number;
  rejectedByLiquidityLow: number;
  rejectedByLiquidityHigh: number;
  rejectedByVolume: number;
  rejectedByBuyCount: number;
  rejectedByBuySellRatio: number;
  rejectedByPriceChange: number;
  rejectedBySlippage: number;
  rejectedByScore: number;
  passedAllFilters: number;
  // Dominant rejection warning
  dominantRejectionFilter?: string;
  dominantRejectionPct?: number;
}

// ─── Token candidate ──────────────────────────────────────────────────────────

export interface TokenCandidate {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  discoveredAt: number;        // ms timestamp
  lastUpdated: number;         // ms timestamp
  status: CandidateStatus;

  // Market data (refreshed continuously)
  price: number;
  liquidityUsd: number;
  volume24h: number;
  volume1h: number;
  volume30m: number;
  priceChange5m: number;
  priceChange15m: number;
  priceChange30m: number;
  priceChange1h: number;
  buyCount30m: number;
  sellCount30m: number;
  buySellRatio: number;
  pairAgeMinutes: number;
  fdv?: number;
  mc?: number;

  // Age provenance — always present after buildCandidate()
  ageState: AgeState;
  ageSource: string;

  // Decision data
  score?: number;
  scoreDetails?: ScoreResult;
  rejectionReason?: string;
  redFlags: string[];
  passedFilters: boolean;
}

// ─── Active position (in-memory) ──────────────────────────────────────────────

export interface ActivePosition {
  id: number;
  mint: string;
  symbol: string;
  decimals: number;
  mode: 'paper' | 'live';

  entryTime: number;           // ms
  entryPrice: number;          // USD per token
  tokenAmount: number;         // tokens received
  buySizeSol: number;
  entryLiquidityUsd: number;

  buySignature?: string;

  targetPrice: number;         // entryPrice × TARGET_MULTIPLIER
  stopLossPrice: number;       // entryPrice × (1 − STOP_LOSS_PCT/100)
  maxExitTime: number;         // entryTime + MAX_HOLD_MINUTES × 60000

  // Monitoring state (updated in monitor loop)
  currentPrice?: number;
  currentLiquidityUsd?: number;
  lastChecked?: number;

  // Prevents duplicate close attempts
  beingClosed: boolean;

  // Profit protection state (set by positionManager during monitoring)
  breakEvenActivated?: boolean;    // stop raised to entry price at BREAK_EVEN_TRIGGER_PCT
  profitLockActivated?: boolean;   // stop locked at +PROFIT_LOCK_FLOOR_PCT at PROFIT_LOCK_TRIGGER_PCT
  partialSellExecuted?: boolean;   // partial sell (50%) already completed
  partialSolReceived?: number;     // total SOL received from partial sell(s)
  originalBuySizeSol?: number;     // buySizeSol snapshot before partial sell (for accurate PnL)
}

// ─── Position decision ────────────────────────────────────────────────────────

export interface PositionDecision {
  action: 'hold' | 'sell';
  reason?: string;
  urgency: 'normal' | 'urgent';
}

// ─── Trade record (DB row) ────────────────────────────────────────────────────

export interface TradeRecord {
  id?: number;
  mint: string;
  symbol: string;
  mode: 'paper' | 'live';
  status: 'open' | 'closed';

  entryTime: number;
  exitTime?: number;
  entryPrice: number;
  exitPrice?: number;
  tokenAmount: number;
  buySizeSol: number;

  buySignature?: string;
  sellSignature?: string;
  exitReason?: string;

  pnlSol?: number;
  pnlPct?: number;
  entryLiquidityUsd: number;

  // JSON-serialised quote details
  entryQuote?: string;
  exitQuote?: string;
}

// ─── System state ─────────────────────────────────────────────────────────────

export interface SystemState {
  running: boolean;
  emergencyStop: boolean;
  mode: 'paper' | 'live';
  startTime: number;

  openPositions: number;
  todayPnlSol: number;
  todayTrades: number;
  discoveredToday: number;

  lastBuyTime?: number;
  walletBalanceSol?: number;

  rpcHealthy: boolean;
  birdeyeHealthy: boolean;
  jupiterHealthy: boolean;
  lastDiscoveryAt?: number;

  /**
   * Current state of the Birdeye discovery loop.
   * NORMAL           — running normally
   * DISCOVERY_RATE_LIMITED — 429 received; short backoff active
   * DISCOVERY_CU_EXCEEDED  — compute-unit quota hit; long backoff active
   */
  discoveryStatus: 'NORMAL' | 'DISCOVERY_RATE_LIMITED' | 'DISCOVERY_CU_EXCEEDED';

  /** Number of trades fully closed this session. */
  completedTradeCount: number;
  /** Set to true once STOP_AFTER_N_COMPLETED_TRADES is reached (or legacy STOP_AFTER_ONE_COMPLETED_TRADE). */
  completedOneTrade?: boolean;
}

// ─── WebSocket message envelope ───────────────────────────────────────────────

export type WSMessageType =
  | 'system_status'
  | 'candidates_update'
  | 'positions_update'
  | 'trade_opened'
  | 'trade_closed'
  | 'log_entry'
  | 'settings_update'
  | 'cycle_diagnostics'
  | 'pong';

export interface WSMessage {
  type: WSMessageType;
  data: unknown;
  ts: number; // unix ms
}

// ─── Log entry ────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id?: number;
  ts: number;
  level: LogLevel;
  component: string;
  message: string;
  data?: unknown;
}

// ─── Buy execution result ─────────────────────────────────────────────────────

export interface BuyResult {
  success: boolean;
  signature?: string;
  tokenAmountReceived?: number;   // in token units
  effectiveEntryPrice?: number;   // USD per token at execution time
  error?: string;
  quoteUsed?: JupiterQuoteResponse;
}

// ─── Sell execution result ────────────────────────────────────────────────────

export interface SellResult {
  success: boolean;
  signature?: string;
  solReceived?: number;
  error?: string;
  quoteUsed?: JupiterQuoteResponse;
}
