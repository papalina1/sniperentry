/**
 * WalletService — loads the keypair and manages the Solana connection.
 *
 * The private key NEVER leaves this module. The public key is safe to expose.
 * In paper mode the keypair is never loaded.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../../config';
import { logger } from '../../logger';

// ─── Solana connection (shared) ───────────────────────────────────────────────

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(config.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60_000,
    });
    logger.info('Wallet', `Connected to RPC: ${config.SOLANA_RPC_URL}`);
  }
  return _connection;
}

// ─── Keypair management ───────────────────────────────────────────────────────

let _keypair: Keypair | null = null;

/**
 * Load and cache the keypair from PRIVATE_KEY env var.
 * Accepts either:
 *   - base58-encoded 64-byte secret key  (most common — Phantom export)
 *   - JSON array of 64 integers           (Solana CLI keypair file content)
 * Throws if the key is missing or invalid.
 */
export function loadKeypair(): Keypair {
  if (_keypair) return _keypair;

  const raw = config.PRIVATE_KEY;
  if (!raw) throw new Error('PRIVATE_KEY is not set in .env. Required for live trading.');

  try {
    // Try base58 first (Phantom-style)
    const bytes = bs58.decode(raw);
    _keypair = Keypair.fromSecretKey(bytes);
  } catch {
    try {
      // Fall back to JSON array (Solana CLI style)
      const arr = JSON.parse(raw) as number[];
      _keypair = Keypair.fromSecretKey(new Uint8Array(arr));
    } catch {
      throw new Error(
        'PRIVATE_KEY format unrecognised. Provide a base58 string or a JSON byte array.'
      );
    }
  }

  logger.info('Wallet', `Keypair loaded. Public key: ${_keypair.publicKey.toBase58()}`);
  return _keypair;
}

export function getPublicKey(): PublicKey | null {
  return _keypair?.publicKey ?? null;
}

/** Returns SOL balance in full SOL (not lamports). */
export async function getWalletBalance(): Promise<number> {
  try {
    const keypair = loadKeypair();
    const conn = getConnection();
    const lamports = await conn.getBalance(keypair.publicKey, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  } catch (err: unknown) {
    logger.warn('Wallet', 'Could not fetch wallet balance', { err: String(err) });
    return 0;
  }
}

/** Health check — confirms RPC is reachable. */
export let rpcHealthy = false;
export async function checkRpcHealth(): Promise<boolean> {
  try {
    const conn = getConnection();
    await conn.getSlot();
    rpcHealthy = true;
    return true;
  } catch {
    rpcHealthy = false;
    return false;
  }
}
