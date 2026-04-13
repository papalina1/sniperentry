import { useEffect, useRef, useCallback } from 'react';
import { useBotStore } from '../store/botStore';
import { WSMessage, Candidate, Position, Trade, LogEntry, SystemStatus, FilterDiagnostics } from '../types';

const WS_URL = `ws://${window.location.hostname}:3001/ws`;
const PING_INTERVAL = 20_000;
const RECONNECT_DELAY = 3_000;

export function useWebSocket(): void {
  const wsRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const {
    setWsConnected,
    setStatus,
    setCandidates,
    setPositions,
    setTrades,
    addLog,
    setFilterDiagnostics,
  } = useBotStore();

  const handleMessage = useCallback(
    (msg: WSMessage) => {
      switch (msg.type) {
        case 'system_status':
          setStatus(msg.data as SystemStatus);
          break;

        case 'candidates_update':
          setCandidates(msg.data as Candidate[]);
          break;

        case 'positions_update':
          setPositions(msg.data as Position[]);
          break;

        case 'trade_opened':
        case 'trade_closed':
          // Re-fetch trades from REST endpoint on trade events
          fetch('/api/trades?limit=100')
            .then((r) => r.json())
            .then((j) => setTrades(j.trades as Trade[]))
            .catch(() => {});
          break;

        case 'log_entry':
          addLog(msg.data as LogEntry);
          break;

        case 'cycle_diagnostics':
          setFilterDiagnostics(msg.data as FilterDiagnostics);
          break;

        default:
          break;
      }
    },
    [setStatus, setCandidates, setPositions, setTrades, addLog, setFilterDiagnostics]
  );

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      setWsConnected(true);
      // Start ping loop
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WSMessage;
        handleMessage(msg);
      } catch { /* ignore parse errors */ }
    };

    ws.onerror = () => {
      // The close handler will trigger reconnect
    };

    ws.onclose = () => {
      setWsConnected(false);
      if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
      if (!mountedRef.current) return;
      // Auto-reconnect
      reconnectRef.current = setTimeout(connect, RECONNECT_DELAY);
    };
  }, [handleMessage, setWsConnected]);

  useEffect(() => {
    mountedRef.current = true;

    // Initial REST fetches to pre-populate state before WS delivers updates
    Promise.all([
      fetch('/api/status').then((r) => r.json()).catch(() => null),
      fetch('/api/candidates').then((r) => r.json()).catch(() => null),
      fetch('/api/positions/open').then((r) => r.json()).catch(() => null),
      fetch('/api/trades?limit=100').then((r) => r.json()).catch(() => null),
      fetch('/api/logs?limit=200').then((r) => r.json()).catch(() => null),
    ]).then(([statusData, candidatesData, positionsData, tradesData, logsData]) => {
      if (statusData) setStatus(statusData as SystemStatus);
      if (candidatesData?.candidates) setCandidates(candidatesData.candidates as Candidate[]);
      if (positionsData?.positions) setPositions(positionsData.positions as Position[]);
      if (tradesData?.trades) setTrades(tradesData.trades as Trade[]);
      if (logsData?.logs) {
        const reversed = [...(logsData.logs as LogEntry[])].reverse();
        reversed.forEach(addLog);
      }
    });

    connect();

    return () => {
      mountedRef.current = false;
      if (pingRef.current) clearInterval(pingRef.current);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect, setStatus, setCandidates, setPositions, setTrades, addLog]);
}
