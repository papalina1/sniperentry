# SolSniper — Production-grade Solana Token Sniper Bot

A strict rules-based local application that discovers Solana tokens in real time,
filters and scores them, auto-buys under configurable conditions, then
**auto-sells 100% at 2× entry** with full stop-loss, timeout, and emergency-exit protection.

---

## Architecture

```
solsniper/
├── backend/               Node.js + TypeScript + Express + SQLite
│   └── src/
│       ├── config/        Environment config loader
│       ├── types/         Shared TypeScript types
│       ├── logger/        Winston logger + WebSocket broadcaster
│       ├── db/            SQLite schema + typed query helpers
│       ├── api/           REST routes + WebSocket server
│       ├── services/
│       │   ├── discovery/ Birdeye polling (token discovery)
│       │   ├── filtering/ Hard filter rules
│       │   ├── scoring/   0–100 composite scoring engine
│       │   ├── execution/ Jupiter quotes + swap execution + wallet
│       │   └── position/  Position manager + exit logic
│       └── bot/           Main orchestration pipeline
└── frontend/              React + Vite + Tailwind + Zustand
    └── src/
        ├── components/    Dashboard, TokensTable, PositionsPanel, ...
        ├── hooks/         useWebSocket — real-time updates
        ├── store/         Zustand global state
        └── types/         Frontend-local type definitions
```

---

## Prerequisites

- **Node.js 20+**
- **npm 10+**
- On **Windows**, `better-sqlite3` requires native compilation:
  ```
  npm install --global windows-build-tools
  # or install "Desktop development with C++" workload from Visual Studio Installer
  ```

---

## Install

```bash
# 1. Clone / extract the project
cd solsniper

# 2. Backend
cd backend
npm install

# 3. Frontend
cd ../frontend
npm install
```

---

## Configure

```bash
# In the backend directory:
cp ../.env.example .env
```

Edit `.env` and fill in at minimum:

| Key | Required | Notes |
|-----|----------|-------|
| `SOLANA_RPC_URL` | Yes | Use a paid RPC (Helius, QuickNode, Triton) for production |
| `BIRDEYE_API_KEY` | Yes | Get from https://birdeye.so/api |
| `PRIVATE_KEY` | Live mode only | Base58 private key (never share) |
| `LIVE_TRADING` | — | Defaults to `false` (paper mode) |

All other settings have safe defaults (see `.env.example`).

---

## Run

Open **two terminals**:

**Terminal 1 — Backend:**
```bash
cd backend
npm run dev
```
Backend starts at `http://localhost:3001`

**Terminal 2 — Frontend:**
```bash
cd frontend
npm run dev
```
Dashboard available at `http://localhost:5173`

---

## Paper Mode (default)

Paper mode is active by default (`LIVE_TRADING=false`).

In paper mode:
- All discovery, filtering, and scoring runs **exactly as in live mode**
- Jupiter quotes are requested and validated
- Buy/sell execution is **simulated** — no real transactions are sent
- P&L is calculated using quoted prices
- All positions, trades, and logs are stored identically to live mode

**Run the bot exclusively in paper mode for at least 24–48 hours before enabling live.**

---

## Enable Live Mode

Only enable live mode after you have:
1. Verified the bot discovers and scores tokens correctly in paper mode
2. Seen realistic P&L outcomes in paper mode
3. Confirmed your RPC URL is fast and reliable
4. Confirmed your wallet has enough SOL
5. Set appropriate `MAX_DAILY_LOSS` and `MAX_OPEN_POSITIONS`

```bash
# In backend/.env:
LIVE_TRADING=true
PRIVATE_KEY=your_base58_private_key_here
```

Then restart the backend. The mode badge in the top bar will turn red: `🔴 LIVE`.

**The private key is loaded server-side only and is never sent to the frontend.**

---

## Emergency Stop

Click **🚨 E-STOP** in the top navigation bar to:
1. Halt all new buy attempts immediately
2. Trigger market-price close on all open positions
3. Suspend the pipeline until you click **▶ Resume**

You can also call the API directly:
```
POST http://localhost:3001/api/emergency-stop
POST http://localhost:3001/api/resume
```

---

## Configuration Reference

### Position Sizing & Risk

| Key | Default | Meaning |
|-----|---------|---------|
| `DEFAULT_POSITION_SIZE_SOL` | `0.024` | SOL spent per trade |
| `MAX_OPEN_POSITIONS` | `1` | Maximum concurrent open positions |
| `MAX_DAILY_LOSS` | `0.1` | Bot halts if daily P&L drops below −this SOL |
| `COOLDOWN_SECONDS` | `60` | Minimum seconds between consecutive buys |

### Age Verification

| Key | Default | Meaning |
|-----|---------|---------|
| `REQUIRE_VERIFIED_AGE_FOR_ENTRY` | `false` | When true, reject any token without a confirmed API timestamp |
| `ALLOW_UNKNOWN_AGE_ENTRY` | `true` | When true, unknown-age tokens are allowed with stricter filters |

### Hard Filters

| Key | Default | Meaning |
|-----|---------|---------|
| `MIN_LIQUIDITY_USD` | `25000` | Reject tokens below this liquidity |
| `MAX_LIQUIDITY_USD` | `250000` | Reject tokens that are already over-extended |
| `MIN_RECENT_VOLUME_USD` | `40000` | Minimum 30m trading volume |
| `MIN_RECENT_BUY_COUNT` | `35` | Minimum buy transactions in last 30m |
| `MIN_BUY_SELL_RATIO` | `1.8` | Minimum buys/sells ratio |
| `MAX_5M_PRICE_CHANGE_PCT` | `120` | Reject if 5m move is too extreme |
| `MAX_15M_PRICE_CHANGE_PCT` | `250` | Reject if 15m move is too extreme |
| `MAX_ESTIMATED_SLIPPAGE_PCT` | `12` | Reject if Jupiter price impact exceeds this |
| `MIN_PAIR_AGE_MINUTES` | `3` | Token must be at least 3 minutes old |
| `MAX_PAIR_AGE_MINUTES` | `45` | Ignore tokens older than 45 minutes |

### Unknown-Age Stricter Filters

Applied **only** when `ageState=unknown` and `ALLOW_UNKNOWN_AGE_ENTRY=true`.  
These replace the standard thresholds above for that candidate.

| Key | Default | Meaning |
|-----|---------|---------|
| `MIN_LIQUIDITY_USD_UNKNOWN_AGE` | `30000` | Higher liquidity floor for unverified tokens |
| `MIN_RECENT_VOLUME_USD_UNKNOWN_AGE` | `10000` | Higher volume floor for unverified tokens |
| `MIN_BUY_SELL_RATIO_UNKNOWN_AGE` | `1.3` | Stricter buy-side bias requirement |
| `MAX_ESTIMATED_SLIPPAGE_PCT_UNKNOWN_AGE` | `12` | Stricter slippage cap |

### One-Trade-Only Mode

| Key | Default | Meaning |
|-----|---------|---------|
| `STOP_AFTER_ONE_COMPLETED_TRADE` | `true` | Bot stops completely after the first trade closes |

### Scoring

| Key | Default | Meaning |
|-----|---------|---------|
| `MIN_SCORE` | `80` | Minimum 0–100 score to attempt a buy |

### Exit Rules

| Key | Default | Meaning |
|-----|---------|---------|
| `TARGET_MULTIPLIER` | `2.0` | Sell 100% when price = entry × 2.0 |
| `SELL_TRIGGER_BUFFER_LOW` | `1.90` | Begin preparing exit at 1.90× |
| `SELL_TRIGGER_BUFFER_HIGH` | `1.95` | Execute exit at 1.95× (avoids missing 2×) |
| `STOP_LOSS_PCT` | `25` | Close position if price falls 25% from entry |
| `MAX_HOLD_MINUTES` | `20` | Force-close after 20 minutes regardless |
| `LIQUIDITY_DROP_EXIT_PCT` | `30` | Exit if liquidity drops 30% from entry level |

---

## How Unknown-Age Entry Works

Every token discovered by the bot is assigned an `ageState`:

| ageState | Meaning | Filter mode |
|----------|---------|-------------|
| `verified` | Age confirmed by an explicit API timestamp (`listing_time`, `listingTime`, `createdAt`) | Normal filters |
| `estimated` | Age inferred from a proxy signal (e.g. `lastTradeUnixTime`) | Normal filters + red flag |
| `unknown` | No timestamp available; age is synthetic | Stricter filters (if allowed) or rejected |

### Entry logic for unknown-age tokens

When `ALLOW_UNKNOWN_AGE_ENTRY=true` (default) and a token's `ageState` is `unknown`:

1. The token is **not rejected automatically** at the age gate.
2. The bot logs:  
   `Warning: unknown-age token allowed — stricter filters applied (ageState=unknown, ageSource=...)`
3. The following **stricter thresholds** replace the standard ones:
   - Liquidity ≥ `MIN_LIQUIDITY_USD_UNKNOWN_AGE` (default: $30,000 vs standard $25,000)
   - 30m volume ≥ `MIN_RECENT_VOLUME_USD_UNKNOWN_AGE` (default: $10,000)
   - Buy/sell ratio ≥ `MIN_BUY_SELL_RATIO_UNKNOWN_AGE` (default: 1.3×)
   - Jupiter price impact ≤ `MAX_ESTIMATED_SLIPPAGE_PCT_UNKNOWN_AGE` (default: 12%)
4. If all stricter filters pass, the token proceeds to scoring as normal.
5. The UI and logs display `ageState`, `ageSource`, and which filter mode was applied
   (`normal` or `unknown-age-strict`) for every candidate.

To disable unknown-age entries entirely:
```
ALLOW_UNKNOWN_AGE_ENTRY=false
```

To require a verified timestamp for all entries (most restrictive):
```
REQUIRE_VERIFIED_AGE_FOR_ENTRY=true
```

---

## How One-Trade-Only Mode Works

When `STOP_AFTER_ONE_COMPLETED_TRADE=true` (default), the bot is designed for a single
full trade cycle, then exits cleanly.

### What counts as a completed trade

A trade is considered **completed** when:
1. A position was successfully **opened** (a buy executed), AND
2. The position was later **fully closed** by any of:
   - **2× take-profit** — price reached `TARGET_MULTIPLIER` (or the pre-target buffer)
   - **Stop-loss** — price fell ≥ `STOP_LOSS_PCT` below entry
   - **Timeout** — position held longer than `MAX_HOLD_MINUTES`
   - **Emergency exit** — operator triggered E-STOP
   - **Liquidity collapse** — liquidity dropped ≥ `LIQUIDITY_DROP_EXIT_PCT` from entry
   - **Sell-pressure spike** or **momentum collapse**

A partial scenario (e.g. buy attempted but failed) does **not** count.

### Exactly how and when the bot stops

| State | Bot behaviour |
|-------|---------------|
| No trade opened yet | Scans normally; no restrictions |
| One trade currently open | Will NOT open any other trade (`MAX_OPEN_POSITIONS=1`); continues monitoring |
| First trade closes | Callback fires → `systemState.completedOneTrade = true` → `stopBot()` called |

After `stopBot()` is called:
- Discovery loop timer is cleared — no more candidate polling
- Pipeline timer is cleared — no more scoring cycles
- Position monitor timer is cleared — no further position checks after current cycle completes
- System status switches to `completedOneTrade: true`
- The log line `One completed trade reached — bot stopped by config` is emitted

The shutdown is clean: the current monitor cycle finishes normally (broadcasting the
final position state), then no new cycles are scheduled.

To run the bot continuously (standard mode):
```
STOP_AFTER_ONE_COMPLETED_TRADE=false
```

---

## How Discovery Works

The discovery engine polls Birdeye's `/defi/v3/token/new-listing` endpoint every
`DISCOVERY_INTERVAL_MS` (15 seconds by default). For each new token mint returned,
it requests a full token overview (`/defi/token_overview`) to get price, liquidity,
volume, buy/sell counts, and price changes.

Tokens are cached in a Map keyed by mint address. Once discovered, a token stays
in the cache for the entire session and has its market data refreshed continuously.

---

## How Filtering Works

Every candidate is run through `applyHardFilters()` which checks (in order):

1. **Pair age** — must be between `MIN_PAIR_AGE_MINUTES` and `MAX_PAIR_AGE_MINUTES`
2. **Liquidity** — must be between `MIN_LIQUIDITY_USD` and `MAX_LIQUIDITY_USD`
3. **Recent volume** — 30m volume must exceed `MIN_RECENT_VOLUME_USD`
4. **Buy count** — at least `MIN_RECENT_BUY_COUNT` buys in last 30m
5. **Buy/sell ratio** — must exceed `MIN_BUY_SELL_RATIO`
6. **Price change caps** — reject extreme vertical moves
7. **Missing price** — reject if price data is absent
8. **Suspicious signals** — accumulate red flags; reject on severe combinations

The first failure short-circuits and logs a plain-English reason.

---

## How Scoring Works

Scoring produces a composite **0–100 score** from five positive factors and five penalties.

**Positive factors (85 pts max):**
- Liquidity quality: +0–20
- Momentum quality: +0–20 (controlled upward move, not spike or flat)
- Buy pressure: +0–20 (high buy count + strong ratio)
- Timing/age: +0–15 (sweet spot: 5–15 min old)
- Quote/execution quality: +0–10 (low price impact from Jupiter)

**Penalties (−35 pts max):**
- Volatility penalty: −0–5 (extreme short-term moves)
- Late entry penalty: −0–5 (token too old in session)
- Slippage penalty: −0–10 (high Jupiter price impact)
- Suspicious behaviour: −0–10 (red flags, sell-side spikes)
- Concentration penalty: −0–5 (volume/liquidity ratio too high)

Tokens below `MIN_SCORE` (default 80) are rejected and logged.

---

## How the Buy Decision Works

A buy is only attempted if ALL of the following are true simultaneously:
1. Emergency stop is **not** active
2. Daily loss has **not** exceeded `MAX_DAILY_LOSS`
3. Open positions < `MAX_OPEN_POSITIONS`
4. Cooldown since last buy has elapsed
5. No existing open position in the same token
6. `LIVE_TRADING=true` (or paper mode simulation)
7. Token passed all hard filters
8. Token score ≥ `MIN_SCORE`
9. Jupiter buy quote was obtained successfully
10. Quote price impact < `MAX_ESTIMATED_SLIPPAGE_PCT`
11. Quote output amount is non-zero

If any condition fails, the token is rejected with a logged reason.

---

## How the 2× Target Works

After a buy:
```
targetPrice = entryPrice × TARGET_MULTIPLIER   (default: entryPrice × 2.0)
```

The position monitor checks the current price every 5 seconds.

When `currentPrice ≥ targetPrice × SELL_TRIGGER_BUFFER_LOW (1.90×)`:
- The bot begins evaluating exit aggressively

When `currentPrice ≥ targetPrice × SELL_TRIGGER_BUFFER_HIGH (1.95×)`:
- The bot executes a sell immediately without waiting for the exact 2.00× print
- This prevents missing the target due to execution delay on fast-moving tokens

When `currentPrice ≥ targetPrice (2.00×)`:
- Always triggers sell

---

## How Selling Works

The position manager evaluates all exit conditions in priority order:

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | Emergency stop active | Sell immediately, urgent |
| 2 | Price ≥ 2.0× target | Sell, normal urgency |
| 2b | Price ≥ 1.95× (buffer) | Sell aggressively |
| 3 | Price ≤ stop loss (−25%) | Sell, urgent |
| 4 | Hold time > 20 minutes | Sell, normal |
| 5 | Liquidity dropped >30% | Sell, urgent |
| 6 | Sell pressure spike | Sell, urgent |
| 7 | Momentum collapse | Sell, normal |

For each sell, the bot:
1. Requests an exit quote from Jupiter (token → SOL)
2. Executes the swap (or simulates in paper mode)
3. Calculates realised P&L
4. Closes the DB record
5. Removes the position from the in-memory map
6. Broadcasts the result to the frontend

---

## What to Test in Paper Mode Before Going Live

Run for at least 24–48 hours in paper mode and verify:

- [ ] Discovery cycle logs new tokens regularly
- [ ] Filter rejection reasons are sensible (not rejecting valid tokens, not passing garbage)
- [ ] Scores look reasonable (most tokens score < 60, good setups score > 80)
- [ ] Buys trigger only on genuinely interesting candidates
- [ ] Take-profit at 2× triggers and closes correctly
- [ ] Stop-loss triggers correctly at −25%
- [ ] Max hold time forces close after 20 min
- [ ] Daily loss limit halts the bot correctly
- [ ] Emergency stop closes all positions
- [ ] Paper P&L is positive over a meaningful sample (>10 trades)
- [ ] No duplicate position opens for the same token
- [ ] RPC, Birdeye, and Jupiter all show healthy in the dashboard

Only proceed to live mode after all of the above are confirmed.

---

## Known Limitations (v1)

1. **Birdeye API rate limits** — free tier limits are respected via per-call delays, but
   if you run multiple bots or have heavy other usage, you may hit limits.
2. **5m/15m price change data** — Birdeye may not always return granular intraday OHLCV
   for very new tokens; the service falls back to 30m data in that case.
3. **Jupiter routing** — on extremely low-liquidity tokens, Jupiter may return poor routes
   or fail. The bot rejects these rather than executing at bad prices.
4. **RPC latency** — on a slow or congested RPC, live transaction confirmation can take
   several seconds, during which the price may move. Use a paid RPC in live mode.
5. **Token decimals** — the bot reads decimals from Birdeye and defaults to 6 if missing.
   Tokens with non-standard decimals should be verified.
6. **No partial exits** — the bot always exits 100%. Partial take-profit is not implemented.
7. **No rug-pull oracle** — the bot does not use an on-chain rug detection service. It relies
   on its own filter logic. Do not rely on it to catch sophisticated rugs.

---

## Speed Improvement Roadmap (Future Versions)

1. **WebSocket instead of polling** — replace Birdeye REST polling with their WebSocket stream
   for near-instant token discovery (removes the 15s polling lag).
2. **Pre-built transaction caching** — prepare and pre-sign a Jupiter swap transaction as soon
   as a candidate enters the buffer zone, so execution is near-instant when the trigger fires.
3. **Dedicated RPC node** — run a local Solana validator snapshot or use a geographically close
   dedicated RPC to minimise network round-trip time.
4. **Parallel candidate evaluation** — process multiple candidates concurrently using
   `Promise.all` with a concurrency limiter instead of the current serial loop.
5. **gRPC / Geyser streams** — subscribe to on-chain Raydium/Orca pool creation events
   directly via Geyser for the fastest possible new-pool detection (sub-second).
6. **MEV protection** — use Jito bundles or similar to protect buy/sell transactions
   from sandwich attacks.
7. **Adaptive position sizing** — size positions based on score confidence and liquidity depth
   rather than using a fixed SOL amount.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | System state + config summary |
| GET | `/api/candidates` | All in-memory candidates |
| GET | `/api/positions/open` | Live position data |
| GET | `/api/trades` | Trade history (DB) |
| GET | `/api/logs` | Recent log buffer |
| GET | `/api/settings` | Current config (keys only, no secrets) |
| GET | `/api/health` | RPC/Birdeye/Jupiter health check |
| POST | `/api/emergency-stop` | Trigger emergency stop |
| POST | `/api/resume` | Clear emergency stop |
| POST | `/api/bot/start` | Start the bot pipeline |
| POST | `/api/bot/stop` | Stop the bot pipeline |

---

## Security Notes

- The `PRIVATE_KEY` is loaded in `walletService.ts` and **never forwarded to the frontend**.
- The `/api/settings` endpoint explicitly excludes `PRIVATE_KEY`, `BIRDEYE_API_KEY`, and
  `JUPITER_API_KEY` from its response.
- CORS is open (`*`) by default; restrict it to your local IP in production.
- The SQLite database is stored locally at `./data/solsniper.db`.
- Do not commit your `.env` file to version control.
