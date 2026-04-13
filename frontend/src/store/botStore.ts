import { create } from 'zustand';
import {
  Candidate,
  Position,
  Trade,
  LogEntry,
  SystemStatus,
  FilterDiagnostics,
} from '../types';

interface BotStore {
  // Connection
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;

  // System
  status: SystemStatus | null;
  setStatus: (s: SystemStatus) => void;

  // Filter diagnostics (latest cycle)
  filterDiagnostics: FilterDiagnostics | null;
  setFilterDiagnostics: (d: FilterDiagnostics) => void;

  // Candidates
  candidates: Candidate[];
  setCandidates: (c: Candidate[]) => void;

  // Positions
  positions: Position[];
  setPositions: (p: Position[]) => void;

  // Trades
  trades: Trade[];
  setTrades: (t: Trade[]) => void;
  addTrade: (t: Trade) => void;

  // Logs
  logs: LogEntry[];
  addLog: (l: LogEntry) => void;

  // UI
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

export const useBotStore = create<BotStore>((set) => ({
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),

  status: null,
  setStatus: (s) => set({ status: s }),

  filterDiagnostics: null,
  setFilterDiagnostics: (d) => set({ filterDiagnostics: d }),

  candidates: [],
  setCandidates: (c) => set({ candidates: c }),

  positions: [],
  setPositions: (p) => set({ positions: p }),

  trades: [],
  setTrades: (t) => set({ trades: t }),
  addTrade: (t) =>
    set((state) => ({
      trades: [t, ...state.trades].slice(0, 200),
    })),

  logs: [],
  addLog: (l) =>
    set((state) => ({
      logs: [l, ...state.logs].slice(0, 300),
    })),

  activeTab: 'dashboard',
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
