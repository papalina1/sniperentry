/**
 * Entry point — wires together HTTP server, WebSocket server, database,
 * and the sniper bot.
 *
 * Start order:
 *   1. Validate config / environment
 *   2. Initialise SQLite
 *   3. Start Express + WebSocket server
 *   4. Start Birdeye discovery
 *   5. Start the sniper bot pipeline
 */

import http from 'http';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config';
import { logger } from './logger';
import { initDb } from './db';
import { initWsServer } from './api/wsServer';
import apiRoutes from './api/routes';
import { startDiscovery } from './services/discovery/discoveryManager';
import { startBot } from './bot/sniperBot';
import { checkRpcHealth } from './services/execution/walletService';
import { checkJupiterEndpoint } from './services/execution/jupiterService';

// ─── Basic validation ─────────────────────────────────────────────────────────

function validateEnvironment(): void {
  const warnings: string[] = [];

  if (!config.BIRDEYE_API_KEY) {
    warnings.push('BIRDEYE_API_KEY is not set — discovery will be disabled');
  }

  if (config.LIVE_TRADING && !config.PRIVATE_KEY) {
    throw new Error(
      'LIVE_TRADING=true but PRIVATE_KEY is not set. ' +
      'Provide your wallet private key in .env or set LIVE_TRADING=false for paper mode.'
    );
  }

  if (!config.SOLANA_RPC_URL) {
    throw new Error('SOLANA_RPC_URL is not set in .env');
  }

  if (config.LIVE_TRADING) {
    logger.warn(
      'Main',
      '⚠️  LIVE TRADING MODE ENABLED — real SOL will be spent. ' +
      'Ensure you have tested thoroughly in paper mode first.'
    );
  } else {
    logger.info('Main', '📄 Paper mode active — no real transactions will be sent');
  }

  warnings.forEach((w) => logger.warn('Main', w));
}

// ─── Application bootstrap ────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    validateEnvironment();
  } catch (err: unknown) {
    console.error('[FATAL]', String(err));
    process.exit(1);
  }

  // 1. Database
  initDb();

  // 2. Express app
  const app = express();
  app.use(cors({ origin: '*' })); // restrict in production
  app.use(express.json());
  app.use('/api', apiRoutes);

  // Serve frontend build in production
  if (config.NODE_ENV === 'production') {
    const frontendDist = path.resolve(__dirname, '../../frontend/dist');
    app.use(express.static(frontendDist));
    app.get('*', (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));
  }

  // 3. HTTP + WebSocket server (shared underlying server)
  const server = http.createServer(app);
  initWsServer(server);

  server.listen(config.PORT, () => {
    logger.info('Main', `Server listening on http://localhost:${config.PORT}`);
    logger.info('Main', `WebSocket available at ws://localhost:${config.PORT}/ws`);
  });

  // 4. RPC + Jupiter health checks (non-blocking)
  checkRpcHealth().then((ok) => {
    if (ok) logger.info('Main', '✅ Solana RPC reachable');
    else logger.warn('Main', '⚠️  Solana RPC not reachable — check SOLANA_RPC_URL');
  });
  checkJupiterEndpoint().then((ok) => {
    if (!ok) logger.warn('Main', '⚠️  Jupiter quote API unreachable — buy quotes will fail until connectivity is restored');
  });

  // 5. Discovery + bot
  // Multi-source discovery runs regardless of BIRDEYE_API_KEY
  // (DexScreener and Jupiter require no key; Birdeye is best-effort)
  if (!config.BIRDEYE_API_KEY) {
    logger.warn('Main', 'BIRDEYE_API_KEY not set — Birdeye discovery disabled; DexScreener + Jupiter still active');
  }
  await startDiscovery();
  startBot();
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  logger.info('Main', 'SIGINT received — shutting down gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Main', 'SIGTERM received — shutting down');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Main', 'Uncaught exception', { err: err.message, stack: err.stack });
  // Do NOT exit — keep the bot running unless it's truly unrecoverable
});

process.on('unhandledRejection', (reason) => {
  logger.error('Main', 'Unhandled promise rejection', { reason: String(reason) });
});

main();
