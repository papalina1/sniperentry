import { useState, useEffect } from 'react';
import { useBotStore } from '../store/botStore';
import clsx from 'clsx';

export function SystemHealth() {
  const status = useBotStore((s) => s.status);
  const [health, setHealth] = useState<{
    rpc: boolean; birdeye: boolean; jupiter: boolean; ts?: number;
  } | null>(null);

  useEffect(() => {
    const fetchHealth = () => {
      fetch('/api/health')
        .then((r) => r.json())
        .then(setHealth)
        .catch(() => {});
    };
    fetchHealth();
    const t = setInterval(fetchHealth, 10_000);
    return () => clearInterval(t);
  }, []);

  const uptime = status?.startTime
    ? formatDuration(Date.now() - status.startTime)
    : '—';

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold text-white">System Health</h1>

      {/* Connection indicators */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <HealthCard
          title="Solana RPC"
          healthy={health?.rpc ?? status?.rpcHealthy ?? false}
          detail={status ? 'Connected' : 'Checking…'}
        />
        <HealthCard
          title="Birdeye API"
          healthy={health?.birdeye ?? status?.birdeyeHealthy ?? false}
          detail="Discovery source"
        />
        <HealthCard
          title="Jupiter API"
          healthy={health?.jupiter ?? status?.jupiterHealthy ?? false}
          detail="Swap execution"
        />
      </div>

      {/* Bot state */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <InfoCard label="Bot Running" value={status?.running ? '✅ Yes' : '❌ No'} />
        <InfoCard label="Emergency Stop" value={status?.emergencyStop ? '🚨 ACTIVE' : '—'} />
        <InfoCard label="Mode" value={(status?.mode ?? 'paper').toUpperCase()} />
        <InfoCard label="Uptime" value={uptime} />
        <InfoCard label="Open Positions" value={String(status?.openPositions ?? 0)} />
        <InfoCard label="Today Trades" value={String(status?.todayTrades ?? 0)} />
        <InfoCard
          label="Today P&L"
          value={`${(status?.todayPnlSol ?? 0) >= 0 ? '+' : ''}${(status?.todayPnlSol ?? 0).toFixed(5)} SOL`}
          color={(status?.todayPnlSol ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}
        />
        <InfoCard
          label="Wallet Balance"
          value={status?.walletBalanceSol !== undefined
            ? `${status.walletBalanceSol.toFixed(4)} SOL`
            : '—'}
        />
      </div>

      {/* Bot controls */}
      <div className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Bot Controls</h2>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => fetch('/api/bot/start', { method: 'POST' })}
            className="px-4 py-2 bg-green-700 hover:bg-green-600 text-white rounded text-sm font-medium"
          >
            ▶ Start Bot
          </button>
          <button
            onClick={() => fetch('/api/bot/stop', { method: 'POST' })}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm font-medium"
          >
            ⏹ Stop Bot
          </button>
          <button
            onClick={() => {
              if (confirm('Trigger emergency stop? This will close all positions.')) {
                fetch('/api/emergency-stop', { method: 'POST' });
              }
            }}
            className="px-4 py-2 bg-red-700 hover:bg-red-600 text-white rounded text-sm font-medium border border-red-500"
          >
            🚨 Emergency Stop
          </button>
          <button
            onClick={() => fetch('/api/resume', { method: 'POST' })}
            className="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white rounded text-sm font-medium"
          >
            ▶ Resume
          </button>
        </div>
        <p className="text-xs text-slate-500">
          Emergency Stop immediately halts all new buys and closes open positions at market.
          Use Resume to restart normal operation.
        </p>
      </div>

      {/* Current config summary */}
      {status?.config && (
        <div className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-5">
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Active Configuration</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            {Object.entries(status.config).map(([k, v]) => (
              <div key={k}>
                <p className="text-xs text-slate-500">{k.replace(/_/g, ' ')}</p>
                <p className="mono text-slate-200 font-medium">{String(v)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HealthCard({ title, healthy, detail }: { title: string; healthy: boolean; detail?: string }) {
  return (
    <div className={clsx(
      'bg-[#1a2235] border rounded-lg p-5 flex items-center gap-4',
      healthy ? 'border-green-500/30' : 'border-red-500/30'
    )}>
      <div className={clsx('w-3 h-3 rounded-full', healthy ? 'bg-green-400' : 'bg-red-500 animate-pulse')} />
      <div>
        <p className="font-semibold text-white">{title}</p>
        {detail && <p className="text-xs text-slate-500 mt-0.5">{detail}</p>}
      </div>
      <span className={clsx(
        'ml-auto text-sm font-bold',
        healthy ? 'text-green-400' : 'text-red-400'
      )}>
        {healthy ? 'OK' : 'DOWN'}
      </span>
    </div>
  );
}

function InfoCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-4">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={clsx('font-bold mono', color ?? 'text-slate-100')}>{value}</p>
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
