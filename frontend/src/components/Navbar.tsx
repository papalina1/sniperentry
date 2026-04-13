import { useBotStore } from '../store/botStore';
import clsx from 'clsx';

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'tokens',    label: 'Tokens' },
  { id: 'positions', label: 'Positions' },
  { id: 'history',   label: 'History' },
  { id: 'logs',      label: 'Logs' },
  { id: 'health',    label: 'Health' },
  { id: 'settings',  label: 'Settings' },
];

export function Navbar() {
  const { status, wsConnected, activeTab, setActiveTab } = useBotStore((s) => ({
    status: s.status,
    wsConnected: s.wsConnected,
    activeTab: s.activeTab,
    setActiveTab: s.setActiveTab,
  }));

  const mode = status?.mode ?? 'paper';
  const emergency = status?.emergencyStop ?? false;

  async function handleEmergencyStop() {
    if (!confirm('Trigger emergency stop? This will close all open positions immediately.')) return;
    await fetch('/api/emergency-stop', { method: 'POST' }).catch(() => {});
  }

  async function handleResume() {
    await fetch('/api/resume', { method: 'POST' }).catch(() => {});
  }

  return (
    <header className="bg-[#111827] border-b border-[#1e2d45] sticky top-0 z-50">
      <div className="max-w-[1600px] mx-auto px-4 h-14 flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2 mr-2 shrink-0">
          <span className="text-blue-400 font-bold text-lg tracking-tight">⚡ SolSniper</span>
        </div>

        {/* Mode badge */}
        <span className={clsx(
          'px-2 py-0.5 rounded text-xs font-bold shrink-0',
          mode === 'live'
            ? 'bg-red-500/20 text-red-400 border border-red-500/30'
            : 'bg-green-500/20 text-green-400 border border-green-500/30'
        )}>
          {mode === 'live' ? '🔴 LIVE' : '📄 PAPER'}
        </span>

        {/* WS status */}
        <span className={clsx(
          'w-2 h-2 rounded-full shrink-0',
          wsConnected ? 'bg-green-400' : 'bg-red-500 animate-pulse'
        )} title={wsConnected ? 'Connected' : 'Disconnected'} />

        {/* Nav tabs */}
        <nav className="flex gap-1 flex-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'px-3 py-1.5 rounded text-sm font-medium whitespace-nowrap transition-colors',
                activeTab === tab.id
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-[#1a2235]'
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Emergency controls */}
        <div className="flex gap-2 shrink-0">
          {emergency ? (
            <button
              onClick={handleResume}
              className="px-3 py-1.5 rounded text-xs font-bold bg-green-600 hover:bg-green-500 text-white transition-colors"
            >
              ▶ Resume
            </button>
          ) : (
            <button
              onClick={handleEmergencyStop}
              className="px-3 py-1.5 rounded text-xs font-bold bg-red-700 hover:bg-red-600 text-white transition-colors border border-red-500"
            >
              🚨 E-STOP
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
