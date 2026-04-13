// ─── Mirrored from backend types (frontend-only copy, no server imports) ──────

export type CandidateStatus =
  | 'discovered'
  | 'filtering'
  | 'discovery_age_filtered'
  | 'filtered_out'
  | 'scored'
  | 'pending_buy'
  | 'bought'
  | 'rejected';

export interface FilterDiagnostics {
  cycleAt: number;
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
  // Hard filter stage
  evaluated: number;
  rejectedByAge: number;
  rejectedByAgeUnverified: number;
  rejectedByLiquidity: number;
  rejectedByVolume: number;
  rejectedByBuyCount: number;
  rejectedByBuySellRatio: number;
  rejectedByPriceChange: number;
  rejectedBySlippage: number;
  rejectedByScore: number;
  passedAllFilters: number;
  // Warning
  dominantRejectionFilter?: string;
  dominantRejectionPct?: number;
}

export interface ScoreBreakdown {
  liquidityScore: number;
  momentumScore: number;
  buyPressureScore: number;
  timingScore: number;
  quoteScore: number;
  volatilityPenalty: number;
  lateEntryPenalty: number;
  slippagePenalty: number;
  suspiciousPenalty: number;
  concentrationPenalty: number;
}

export type AgeState = 'verified' | 'estimated' | 'unknown';

export interface Candidate {
  mint: string;
  symbol: string;
  name: string;
  status: CandidateStatus;
  score?: number;
  scoreGrade?: 'pass' | 'warn' | 'reject';
  scoreSummary?: string;
  scoreBreakdown?: ScoreBreakdown;
  liquidityUsd: number;
  volume30m: number;
  volume1h: number;
  priceChange5m: number;
  priceChange15m: number;
  priceChange30m: number;
  pairAgeMinutes: number;
  ageState: AgeState;
  ageSource: string;
  price: number;
  fdv?: number;
  mc?: number;
  buySellRatio: number;
  buyCount30m: number;
  sellCount30m: number;
  rejectionReason?: string;
  redFlags: string[];
  passedFilters: boolean;
  discoveredAt: number;
  lastUpdated: number;
}

export interface Position {
  id: number;
  mint: string;
  symbol: string;
  mode: 'paper' | 'live';
  entryTime: number;
  entryPrice: number;
  currentPrice: number;
  targetPrice: number;
  stopLossPrice: number;
  tokenAmount: number;
  buySizeSol: number;
  multiplier: number;
  unrealizedPnlPct: number;
  timeInTradeSec: number;
  maxExitTime: number;
  entryLiquidityUsd: number;
  currentLiquidityUsd?: number;
}

export interface Trade {
  id: number;
  mint: string;
  symbol: string;
  mode: string;
  status: 'open' | 'closed';
  entry_time: number;
  exit_time?: number;
  entry_price: number;
  exit_price?: number;
  token_amount: number;
  buy_size_sol: number;
  exit_reason?: string;
  pnl_sol?: number;
  pnl_pct?: number;
}

export interface LogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  message: string;
  data?: unknown;
}

export interface SystemStatus {
  running: boolean;
  emergencyStop: boolean;
  mode: 'paper' | 'live';
  startTime: number;
  openPositions: number;
  todayPnlSol: number;
  todayTrades: number;
  discoveredToday: number;
  walletBalanceSol?: number;
  rpcHealthy: boolean;
  birdeyeHealthy: boolean;
  jupiterHealthy: boolean;
  lastDiscoveryAt?: number;
  config?: Record<string, unknown>;
}

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
  ts: number;
}
