import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { WSMessage, WSMessageType } from '../types';
import { logger, registerBroadcast } from '../logger';

let wss: WebSocketServer;

export function initWsServer(server: HttpServer): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    logger.info('WS', `Client connected from ${ip}`);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', data: null, ts: Date.now() }));
        }
      } catch { /* ignore malformed messages */ }
    });

    ws.on('error', (err) => logger.error('WS', 'Client socket error', { err: err.message }));
    ws.on('close', () => logger.info('WS', `Client disconnected from ${ip}`));
  });

  // Register broadcast so the logger can push events to clients
  registerBroadcast(broadcast);

  logger.info('WS', 'WebSocket server ready at /ws');
}

export function broadcast(msg: WSMessage): void {
  if (!wss) return;
  const payload = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

export function broadcastType(type: WSMessageType, data: unknown): void {
  broadcast({ type, data, ts: Date.now() });
}
