/**
 * Database layer — uses Node.js built-in `node:sqlite` (available Node 22.5+).
 * No native compilation required.
 *
 * The module is currently flagged as experimental in Node 22 but unflagged
 * in Node 23+. For Node 22, add --experimental-sqlite to ts-node-dev args.
 * Node 24 (which you are running) has it available by default.
 */

// @ts-ignore — node:sqlite typings are bundled with @types/node >= 22
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../logger';
import { TradeRecord, LogEntry } from '../types';

let _db: InstanceType<typeof DatabaseSync>;

export function getDb(): InstanceType<typeof DatabaseSync> {
  if (!_db) throw new Error('Database not initialised. Call initDb() first.');
  return _db;
}

export function initDb(): void {
  const dbPath = path.resolve(config.DB_PATH);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new DatabaseSync(dbPath);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _db.exec('PRAGMA synchronous = NORMAL');

  applySchema(_db);
  logger.info('DB', `SQLite ready at ${dbPath}`);
}

function applySchema(db: InstanceType<typeof DatabaseSync>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      mint             TEXT    UNIQUE NOT NULL,
      symbol           TEXT,
      name             TEXT,
      decimals         INTEGER DEFAULT 6,
      discovered_at    INTEGER NOT NULL,
      last_updated     INTEGER NOT NULL,
      status           TEXT    NOT NULL DEFAULT 'discovered',
      score            REAL,
      score_reason     TEXT,
      score_breakdown  TEXT,
      liquidity_usd    REAL    DEFAULT 0,
      volume_usd_1h    REAL    DEFAULT 0,
      volume_usd_30m   REAL    DEFAULT 0,
      buy_count_30m    INTEGER DEFAULT 0,
      sell_count_30m   INTEGER DEFAULT 0,
      buy_sell_ratio   REAL    DEFAULT 0,
      price_change_5m  REAL    DEFAULT 0,
      price_change_15m REAL    DEFAULT 0,
      price_change_30m REAL    DEFAULT 0,
      price            REAL    DEFAULT 0,
      fdv              REAL,
      mc               REAL,
      pair_age_minutes REAL    DEFAULT 0,
      rejection_reason TEXT,
      red_flags        TEXT,
      raw_overview     TEXT
    );

    CREATE TABLE IF NOT EXISTS trades (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      mint                TEXT    NOT NULL,
      symbol              TEXT,
      mode                TEXT    NOT NULL DEFAULT 'paper',
      status              TEXT    NOT NULL DEFAULT 'open',
      entry_time          INTEGER NOT NULL,
      exit_time           INTEGER,
      entry_price         REAL    NOT NULL,
      exit_price          REAL,
      token_amount        REAL    NOT NULL,
      buy_size_sol        REAL    NOT NULL,
      buy_signature       TEXT,
      sell_signature      TEXT,
      exit_reason         TEXT,
      pnl_sol             REAL,
      pnl_pct             REAL,
      entry_liquidity_usd REAL    DEFAULT 0,
      entry_quote         TEXT,
      exit_quote          TEXT
    );

    CREATE TABLE IF NOT EXISTS logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      level     TEXT    NOT NULL,
      component TEXT,
      message   TEXT    NOT NULL,
      data      TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS performance (
      date         TEXT PRIMARY KEY,
      total_trades INTEGER DEFAULT 0,
      wins         INTEGER DEFAULT 0,
      losses       INTEGER DEFAULT 0,
      pnl_sol      REAL    DEFAULT 0,
      largest_win  REAL    DEFAULT 0,
      largest_loss REAL    DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
    CREATE INDEX IF NOT EXISTS idx_trades_status     ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_mint       ON trades(mint);
    CREATE INDEX IF NOT EXISTS idx_logs_ts           ON logs(ts DESC);
  `);
}

// ─── Candidate operations ─────────────────────────────────────────────────────

export const candidateDb = {
  upsert(c: {
    mint: string; symbol: string; name: string; decimals: number;
    discoveredAt: number; lastUpdated: number; status: string;
    score?: number; scoreReason?: string; scoreBreakdown?: string;
    liquidityUsd: number; volume1h: number; volume30m: number;
    buyCount30m: number; sellCount30m: number; buySellRatio: number;
    priceChange5m: number; priceChange15m: number; priceChange30m: number;
    price: number; fdv?: number; mc?: number; pairAgeMinutes: number;
    rejectionReason?: string; redFlags?: string; rawOverview?: string;
  }): void {
    getDb().prepare(`
      INSERT INTO candidates (
        mint, symbol, name, decimals, discovered_at, last_updated, status,
        score, score_reason, score_breakdown,
        liquidity_usd, volume_usd_1h, volume_usd_30m,
        buy_count_30m, sell_count_30m, buy_sell_ratio,
        price_change_5m, price_change_15m, price_change_30m,
        price, fdv, mc, pair_age_minutes,
        rejection_reason, red_flags, raw_overview
      ) VALUES (
        :mint, :symbol, :name, :decimals, :discoveredAt, :lastUpdated, :status,
        :score, :scoreReason, :scoreBreakdown,
        :liquidityUsd, :volume1h, :volume30m,
        :buyCount30m, :sellCount30m, :buySellRatio,
        :priceChange5m, :priceChange15m, :priceChange30m,
        :price, :fdv, :mc, :pairAgeMinutes,
        :rejectionReason, :redFlags, :rawOverview
      )
      ON CONFLICT(mint) DO UPDATE SET
        symbol           = excluded.symbol,
        name             = excluded.name,
        last_updated     = excluded.last_updated,
        status           = excluded.status,
        score            = excluded.score,
        score_reason     = excluded.score_reason,
        score_breakdown  = excluded.score_breakdown,
        liquidity_usd    = excluded.liquidity_usd,
        volume_usd_1h    = excluded.volume_usd_1h,
        volume_usd_30m   = excluded.volume_usd_30m,
        buy_count_30m    = excluded.buy_count_30m,
        sell_count_30m   = excluded.sell_count_30m,
        buy_sell_ratio   = excluded.buy_sell_ratio,
        price_change_5m  = excluded.price_change_5m,
        price_change_15m = excluded.price_change_15m,
        price_change_30m = excluded.price_change_30m,
        price            = excluded.price,
        fdv              = excluded.fdv,
        mc               = excluded.mc,
        pair_age_minutes = excluded.pair_age_minutes,
        rejection_reason = excluded.rejection_reason,
        red_flags        = excluded.red_flags,
        raw_overview     = excluded.raw_overview
    `).run({
      mint: c.mint, symbol: c.symbol, name: c.name, decimals: c.decimals,
      discoveredAt: c.discoveredAt, lastUpdated: c.lastUpdated, status: c.status,
      score: c.score ?? null, scoreReason: c.scoreReason ?? null,
      scoreBreakdown: c.scoreBreakdown ?? null,
      liquidityUsd: c.liquidityUsd, volume1h: c.volume1h, volume30m: c.volume30m,
      buyCount30m: c.buyCount30m, sellCount30m: c.sellCount30m, buySellRatio: c.buySellRatio,
      priceChange5m: c.priceChange5m, priceChange15m: c.priceChange15m,
      priceChange30m: c.priceChange30m,
      price: c.price, fdv: c.fdv ?? null, mc: c.mc ?? null,
      pairAgeMinutes: c.pairAgeMinutes,
      rejectionReason: c.rejectionReason ?? null,
      redFlags: c.redFlags ?? null, rawOverview: c.rawOverview ?? null,
    });
  },

  getAll(): unknown[] {
    return getDb().prepare('SELECT * FROM candidates ORDER BY last_updated DESC LIMIT 500').all() as unknown[];
  },

  getByStatus(status: string): unknown[] {
    return getDb().prepare('SELECT * FROM candidates WHERE status = ? ORDER BY score DESC LIMIT 100').all(status) as unknown[];
  },
};

// ─── Trade operations ─────────────────────────────────────────────────────────

export const tradeDb = {
  insert(t: TradeRecord): number {
    const result = getDb().prepare(`
      INSERT INTO trades (
        mint, symbol, mode, status,
        entry_time, exit_time, entry_price, exit_price,
        token_amount, buy_size_sol, buy_signature, sell_signature,
        exit_reason, pnl_sol, pnl_pct, entry_liquidity_usd,
        entry_quote, exit_quote
      ) VALUES (
        :mint, :symbol, :mode, :status,
        :entryTime, :exitTime, :entryPrice, :exitPrice,
        :tokenAmount, :buySizeSol, :buySignature, :sellSignature,
        :exitReason, :pnlSol, :pnlPct, :entryLiquidityUsd,
        :entryQuote, :exitQuote
      )
    `).run({
      mint: t.mint, symbol: t.symbol ?? null, mode: t.mode, status: t.status,
      entryTime: t.entryTime, exitTime: t.exitTime ?? null,
      entryPrice: t.entryPrice, exitPrice: t.exitPrice ?? null,
      tokenAmount: t.tokenAmount, buySizeSol: t.buySizeSol,
      buySignature: t.buySignature ?? null, sellSignature: t.sellSignature ?? null,
      exitReason: t.exitReason ?? null,
      pnlSol: t.pnlSol ?? null, pnlPct: t.pnlPct ?? null,
      entryLiquidityUsd: t.entryLiquidityUsd,
      entryQuote: t.entryQuote ?? null, exitQuote: t.exitQuote ?? null,
    });
    return Number((result as { lastInsertRowid: bigint | number }).lastInsertRowid);
  },

  close(id: number, fields: {
    exitTime: number; exitPrice: number; sellSignature?: string;
    exitReason: string; pnlSol: number; pnlPct: number; exitQuote?: string;
  }): void {
    getDb().prepare(`
      UPDATE trades SET
        status        = 'closed',
        exit_time     = :exitTime,
        exit_price    = :exitPrice,
        sell_signature = :sellSignature,
        exit_reason   = :exitReason,
        pnl_sol       = :pnlSol,
        pnl_pct       = :pnlPct,
        exit_quote    = :exitQuote
      WHERE id = :id
    `).run({
      exitTime: fields.exitTime,
      exitPrice: fields.exitPrice,
      sellSignature: fields.sellSignature ?? null,
      exitReason: fields.exitReason,
      pnlSol: fields.pnlSol,
      pnlPct: fields.pnlPct,
      exitQuote: fields.exitQuote ?? null,
      id,
    });
  },

  getOpen(): unknown[] {
    return getDb().prepare("SELECT * FROM trades WHERE status = 'open'").all() as unknown[];
  },

  getHistory(limit = 100): unknown[] {
    return getDb().prepare("SELECT * FROM trades ORDER BY entry_time DESC LIMIT ?").all(limit) as unknown[];
  },

  getTodayPnl(): number {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const row = getDb().prepare(
      "SELECT COALESCE(SUM(pnl_sol), 0) as total FROM trades WHERE status='closed' AND exit_time >= ?"
    ).get(midnight.getTime()) as { total: number };
    return row?.total ?? 0;
  },

  getTodayCount(): number {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const row = getDb().prepare(
      "SELECT COUNT(*) as cnt FROM trades WHERE exit_time >= ?"
    ).get(midnight.getTime()) as { cnt: number };
    return row?.cnt ?? 0;
  },
};

// ─── Log persistence ──────────────────────────────────────────────────────────

export function persistLog(entry: LogEntry): void {
  try {
    getDb().prepare(
      'INSERT INTO logs (ts, level, component, message, data) VALUES (?, ?, ?, ?, ?)'
    ).run(
      entry.ts,
      entry.level,
      entry.component ?? null,
      entry.message,
      entry.data ? JSON.stringify(entry.data) : null
    );
  } catch { /* swallow — log persistence must never crash the bot */ }
}

// ─── Performance ──────────────────────────────────────────────────────────────

export function updateDailyPerformance(pnlSol: number, isWin: boolean): void {
  const date = new Date().toISOString().slice(0, 10);
  getDb().prepare(`
    INSERT INTO performance (date, total_trades, wins, losses, pnl_sol, largest_win, largest_loss)
    VALUES (:date, 1, :win, :loss, :pnl, :lw, :ll)
    ON CONFLICT(date) DO UPDATE SET
      total_trades = total_trades + 1,
      wins         = wins + :win,
      losses       = losses + :loss,
      pnl_sol      = pnl_sol + :pnl,
      largest_win  = MAX(largest_win, :lw),
      largest_loss = MIN(largest_loss, :ll)
  `).run({
    date,
    win: isWin ? 1 : 0,
    loss: isWin ? 0 : 1,
    pnl: pnlSol,
    lw: isWin ? pnlSol : 0,
    ll: isWin ? 0 : pnlSol,
  });
}
