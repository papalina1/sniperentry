import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function env(key: string, fallback?: string): string {
  const val = process.env[key];
  if (val === undefined || val === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return isNaN(n) ? fallback : n;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return isNaN(n) ? fallback : n;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === 'true';
}

export const config = {
  // Server
  PORT: envInt('PORT', 3001),
  NODE_ENV: env('NODE_ENV', 'development'),

  // Solana RPC -- required at startup
  SOLANA_RPC_URL: env('SOLANA_RPC_URL', ''),

  // Private key -- only consumed server-side, never sent to frontend
  PRIVATE_KEY: env('PRIVATE_KEY', ''),

  // External APIs
  BIRDEYE_API_KEY: env('BIRDEYE_API_KEY', ''),
  JUPITER_API_KEY: env('JUPITER_API_KEY', ''),

  // Trading mode
  // LIVE_TRADING is false by default. Must be explicitly set to "true" in .env
  // AND confirmed at runtime to switch to live mode.
  LIVE_TRADING: envBool('LIVE_TRADING', false),

  // Position sizing — always fixed; never auto-adjusted
  DEFAULT_POSITION_SIZE_SOL: envFloat('DEFAULT_POSITION_SIZE_SOL', 0.1),
  POSITION_SIZE_MODE: process.env['POSITION_SIZE_MODE'] ?? 'fixed',

  // Risk controls
  MAX_OPEN_POSITIONS: envInt('MAX_OPEN_POSITIONS', 5),
  MAX_DAILY_LOSS: envFloat('MAX_DAILY_LOSS', 0.1),
  COOLDOWN_SECONDS: envInt('COOLDOWN_SECONDS', 0),

  // Discovery pre-filter
  // Tokens older than this are dropped at discovery, before hard filters.
  MAX_DISCOVERY_AGE_MINUTES: envFloat('MAX_DISCOVERY_AGE_MINUTES', 180),

  // Age verification gate.
  // When false (default), estimated/unknown-age tokens are allowed through;
  // unknown-age tokens are subject to stricter safety filters (see below).
  // Set to true to reject any token whose age was not confirmed by an explicit
  // API timestamp.
  REQUIRE_VERIFIED_AGE_FOR_ENTRY: envBool('REQUIRE_VERIFIED_AGE_FOR_ENTRY', false),

  // When true (default), tokens with ageState=unknown are allowed to continue
  // past the age gate provided they pass the stricter unknown-age filters below.
  // When false, unknown-age tokens are always rejected.
  ALLOW_UNKNOWN_AGE_ENTRY: envBool('ALLOW_UNKNOWN_AGE_ENTRY', true),

  // Hard entry filters
  MIN_LIQUIDITY_USD: envFloat('MIN_LIQUIDITY_USD', 20_000),   // strict entry guard — raised from 5 000
  MAX_LIQUIDITY_USD: envFloat('MAX_LIQUIDITY_USD', 750_000),
  MIN_RECENT_VOLUME_USD: envFloat('MIN_RECENT_VOLUME_USD', 500),
  MIN_RECENT_BUY_COUNT: envInt('MIN_RECENT_BUY_COUNT', 0),
  MIN_BUY_SELL_RATIO: envFloat('MIN_BUY_SELL_RATIO', 1.0),   // strict entry guard — raised from 0.7
  MIN_5M_PRICE_CHANGE_PCT: envFloat('MIN_5M_PRICE_CHANGE_PCT', 2),  // momentum floor
  MAX_5M_PRICE_CHANGE_PCT: envFloat('MAX_5M_PRICE_CHANGE_PCT', 120),
  MAX_15M_PRICE_CHANGE_PCT: envFloat('MAX_15M_PRICE_CHANGE_PCT', 250),
  MAX_ESTIMATED_SLIPPAGE_PCT: envFloat('MAX_ESTIMATED_SLIPPAGE_PCT', 15),
  MIN_PAIR_AGE_MINUTES: envFloat('MIN_PAIR_AGE_MINUTES', 2),
  MAX_PAIR_AGE_MINUTES: envFloat('MAX_PAIR_AGE_MINUTES', 60),

  // Stricter filters applied only to tokens with ageState=unknown.
  // These thresholds are tighter than the standard ones to compensate for
  // the missing age confirmation.
  MIN_LIQUIDITY_USD_UNKNOWN_AGE: envFloat('MIN_LIQUIDITY_USD_UNKNOWN_AGE', 5_000),
  MIN_RECENT_VOLUME_USD_UNKNOWN_AGE: envFloat('MIN_RECENT_VOLUME_USD_UNKNOWN_AGE', 100),
  MIN_BUY_SELL_RATIO_UNKNOWN_AGE: envFloat('MIN_BUY_SELL_RATIO_UNKNOWN_AGE', 0.7),
  MAX_ESTIMATED_SLIPPAGE_PCT_UNKNOWN_AGE: envFloat('MAX_ESTIMATED_SLIPPAGE_PCT_UNKNOWN_AGE', 12),

  // Trade-count stop.
  // Bot stops cleanly once this many trades have fully closed (0 = run forever).
  STOP_AFTER_N_COMPLETED_TRADES: envInt('STOP_AFTER_N_COMPLETED_TRADES', 20),

  // Legacy single-trade stop (false = disabled; use STOP_AFTER_N_COMPLETED_TRADES instead).
  STOP_AFTER_ONE_COMPLETED_TRADE: envBool('STOP_AFTER_ONE_COMPLETED_TRADE', false),

  // Scoring
  MIN_SCORE: envInt('MIN_SCORE', 35),

  // Exit rules
  TARGET_MULTIPLIER: envFloat('TARGET_MULTIPLIER', 1.4),
  SELL_TRIGGER_BUFFER_LOW: envFloat('SELL_TRIGGER_BUFFER_LOW', 1.35),
  SELL_TRIGGER_BUFFER_HIGH: envFloat('SELL_TRIGGER_BUFFER_HIGH', 1.38),
  STOP_LOSS_PCT: envFloat('STOP_LOSS_PCT', 30),
  MAX_HOLD_MINUTES: envInt('MAX_HOLD_MINUTES', 20),
  LIQUIDITY_DROP_EXIT_PCT: envFloat('LIQUIDITY_DROP_EXIT_PCT', 30),

  // Profit protection — dynamic stop loss adjustment and optional partial sell
  PROFIT_PROTECTION_ENABLED: envBool('PROFIT_PROTECTION_ENABLED', true),
  // Move stop to break-even when unrealized gain reaches this %
  BREAK_EVEN_TRIGGER_PCT: envFloat('BREAK_EVEN_TRIGGER_PCT', 15),
  // Lock minimum profit when unrealized gain reaches this %
  PROFIT_LOCK_TRIGGER_PCT: envFloat('PROFIT_LOCK_TRIGGER_PCT', 25),
  // Minimum profit % to lock in (stop set to entry × (1 + this/100))
  PROFIT_LOCK_FLOOR_PCT: envFloat('PROFIT_LOCK_FLOOR_PCT', 10),
  // Sell 50% of position when unrealized gain reaches PARTIAL_SELL_TRIGGER_PCT
  PARTIAL_SELL_ENABLED: envBool('PARTIAL_SELL_ENABLED', false),
  PARTIAL_SELL_TRIGGER_PCT: envFloat('PARTIAL_SELL_TRIGGER_PCT', 20),

  // Jupiter execution
  JUPITER_QUOTE_API: 'https://api.jup.ag/swap/v1',
  SLIPPAGE_BPS: envInt('SLIPPAGE_BPS', 300),
  PRIORITY_FEE_LAMPORTS: envInt('PRIORITY_FEE_LAMPORTS', 100_000),
  MAX_RETRY_COUNT: envInt('MAX_RETRY_COUNT', 3),
  QUOTE_RETRY_DELAY_MS: envInt('QUOTE_RETRY_DELAY_MS', 1000),

  // Birdeye
  BIRDEYE_API_BASE: 'https://public-api.birdeye.so',
  DISCOVERY_INTERVAL_MS: envInt('DISCOVERY_INTERVAL_MS', 60_000),
  POSITION_MONITOR_INTERVAL_MS: envInt('POSITION_MONITOR_INTERVAL_MS', 5_000),
  // When true, discovery pauses for CU_LIMIT_BACKOFF_MS after a compute-unit-limit 400
  DISCOVERY_PAUSE_ON_CU_LIMIT: envBool('DISCOVERY_PAUSE_ON_CU_LIMIT', true),
  // How long (ms) to pause discovery after a CU-limit hit — default 20 min
  CU_LIMIT_BACKOFF_MS: envInt('CU_LIMIT_BACKOFF_MS', 20 * 60 * 1000),

  // Telegram notifications (optional — leave blank to disable)
  TELEGRAM_BOT_TOKEN: env('TELEGRAM_BOT_TOKEN', ''),
  TELEGRAM_CHAT_ID: env('TELEGRAM_CHAT_ID', ''),

  // Database
  DB_PATH: env('DB_PATH', './data/solsniper.db'),

  // Solana constants
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  LAMPORTS_PER_SOL: 1_000_000_000,
};

export type AppConfig = typeof config;

// Keys that can be patched at runtime via the settings API (filter-related only).
// Trading amounts, API keys, and infrastructure settings require a restart.
export type PatchableFilterKeys =
  | 'MAX_DISCOVERY_AGE_MINUTES'
  | 'MIN_PAIR_AGE_MINUTES'
  | 'MAX_PAIR_AGE_MINUTES'
  | 'MIN_LIQUIDITY_USD'
  | 'MAX_LIQUIDITY_USD'
  | 'MIN_RECENT_VOLUME_USD'
  | 'MIN_RECENT_BUY_COUNT'
  | 'MIN_BUY_SELL_RATIO'
  | 'MIN_5M_PRICE_CHANGE_PCT'
  | 'MAX_5M_PRICE_CHANGE_PCT'
  | 'MAX_15M_PRICE_CHANGE_PCT'
  | 'MAX_ESTIMATED_SLIPPAGE_PCT'
  | 'MIN_SCORE';

export type PatchableFilterSettings = Pick<AppConfig, PatchableFilterKeys>;

/**
 * Apply runtime overrides to the live config object.
 * Only filter-related settings are accepted; all values are validated
 * as finite numbers before being applied.
 */
export function patchConfig(updates: Partial<PatchableFilterSettings>): void {
  const allowed: Record<PatchableFilterKeys, true> = {
    MAX_DISCOVERY_AGE_MINUTES: true,
    MIN_PAIR_AGE_MINUTES: true,
    MAX_PAIR_AGE_MINUTES: true,
    MIN_LIQUIDITY_USD: true,
    MAX_LIQUIDITY_USD: true,
    MIN_RECENT_VOLUME_USD: true,
    MIN_RECENT_BUY_COUNT: true,
    MIN_BUY_SELL_RATIO: true,
    MIN_5M_PRICE_CHANGE_PCT: true,
    MAX_5M_PRICE_CHANGE_PCT: true,
    MAX_15M_PRICE_CHANGE_PCT: true,
    MAX_ESTIMATED_SLIPPAGE_PCT: true,
    MIN_SCORE: true,
  };

  for (const [key, value] of Object.entries(updates) as Array<[PatchableFilterKeys, number]>) {
    if (!allowed[key]) continue;
    if (typeof value !== 'number' || !isFinite(value)) continue;
    (config as Record<string, unknown>)[key] = value;
  }
}
