import { useBotStore } from '../store/botStore';
import clsx from 'clsx';

export function PositionsPanel() {
  const { positions, trades } = useBotStore((s) => ({
    positions: s.positions,
    trades: s.trades,
  }));

  const closed = trades.filter((t) => t.status === 'closed');
  const totalPnl = closed.reduce((acc, t) => acc + (t.pnl_sol ?? 0), 0);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold text-white">Positions</h1>

      {/* Open positions */}
      <section>
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Open ({positions.length})
        </h2>

        {positions.length === 0 ? (
          <div className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-8 text-center text-slate-500">
            No open positions
          </div>
        ) : (
          <div className="space-y-3">
            {positions.map((p) => {
              const pct = p.unrealizedPnlPct ?? 0;
              const pctColor = pct >= 0 ? 'text-green-400' : 'text-red-400';
              const progressToTarget = Math.min(100, ((p.multiplier - 1) / 0.4) * 100); // 0% → 1x, 100% → 1.4x
              const timeLeftMs = Math.max(0, p.maxExitTime - Date.now());
              const timeLeftPct = 100 - Math.min(100, ((Date.now() - p.entryTime) / (p.maxExitTime - p.entryTime)) * 100);

              return (
                <div key={p.mint} className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-5 space-y-4">
                  {/* Header */}
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xl font-bold text-white">{p.symbol}</span>
                        <ModeTag mode={p.mode} />
                      </div>
                      <p className="text-xs text-slate-500 mono mt-0.5">{p.mint}</p>
                    </div>
                    <div className="text-right">
                      <p className={clsx('text-3xl font-bold mono', pctColor)}>
                        {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
                      </p>
                      <p className="text-slate-500 text-xs">{p.multiplier.toFixed(4)}x</p>
                    </div>
                  </div>

                  {/* Progress to 1.4x */}
                  <div>
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>Progress to 1.4x target (40%)</span>
                      <span>{progressToTarget.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 bg-[#0a0e1a] rounded-full overflow-hidden">
                      <div
                        className={clsx('h-full rounded-full transition-all', pct >= 0 ? 'bg-green-500' : 'bg-red-500')}
                        style={{ width: `${Math.max(0, progressToTarget)}%` }}
                      />
                    </div>
                  </div>

                  {/* Time remaining */}
                  <div>
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>Time remaining</span>
                      <span>{formatDuration(timeLeftMs)}</span>
                    </div>
                    <div className="h-1.5 bg-[#0a0e1a] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all"
                        style={{ width: `${timeLeftPct}%` }}
                      />
                    </div>
                  </div>

                  {/* Price grid */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
                    <PriceCell label="Entry" val={p.entryPrice} />
                    <PriceCell label="Current" val={p.currentPrice} highlight />
                    <PriceCell label="Target (1.4x)" val={p.targetPrice} color="text-blue-400" />
                    <PriceCell label="Stop Loss" val={p.stopLossPrice} color="text-red-400" />
                    <div>
                      <p className="text-xs text-slate-500 mb-1">Buy Size</p>
                      <p className="mono font-medium text-white">{p.buySizeSol} SOL</p>
                    </div>
                  </div>

                  {/* Meta */}
                  <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                    <span>Entered: {new Date(p.entryTime).toLocaleTimeString()}</span>
                    <span>Liq entry: ${p.entryLiquidityUsd?.toLocaleString()}</span>
                    {p.currentLiquidityUsd && (
                      <span>Liq now: ${p.currentLiquidityUsd.toLocaleString()}</span>
                    )}
                    <span>Tokens: {p.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Closed positions summary */}
      {closed.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
              Closed ({closed.length})
            </h2>
            <span className={clsx('font-bold mono', totalPnl >= 0 ? 'text-green-400' : 'text-red-400')}>
              Total: {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(5)} SOL
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1e2d45] text-slate-500 text-xs">
                  <th className="text-left py-2 pr-4">Token</th>
                  <th className="text-right pr-4">Entry</th>
                  <th className="text-right pr-4">Exit</th>
                  <th className="text-right pr-4">P&L (SOL)</th>
                  <th className="text-right pr-4">P&L %</th>
                  <th className="text-left pr-4">Exit Reason</th>
                  <th className="text-right">Mode</th>
                </tr>
              </thead>
              <tbody>
                {closed.slice(0, 50).map((t) => {
                  const pnl = t.pnl_sol ?? 0;
                  const pct = t.pnl_pct ?? 0;
                  const color = pnl >= 0 ? 'text-green-400' : 'text-red-400';
                  return (
                    <tr key={t.id} className="border-b border-[#1e2d45]/40 hover:bg-[#1a2235]">
                      <td className="py-2 pr-4 font-medium text-white">{t.symbol}</td>
                      <td className="text-right pr-4 mono">${t.entry_price.toExponential(3)}</td>
                      <td className="text-right pr-4 mono">${(t.exit_price ?? 0).toExponential(3)}</td>
                      <td className={clsx('text-right pr-4 mono font-bold', color)}>
                        {pnl >= 0 ? '+' : ''}{pnl.toFixed(5)}
                      </td>
                      <td className={clsx('text-right pr-4 mono', color)}>
                        {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                      </td>
                      <td className="pr-4 text-xs text-slate-500">{t.exit_reason}</td>
                      <td className="text-right">
                        <ModeTag mode={t.mode as 'paper' | 'live'} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function PriceCell({ label, val, color, highlight }: {
  label: string; val: number; color?: string; highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={clsx('mono font-medium', color ?? (highlight ? 'text-white' : 'text-slate-300'))}>
        ${val.toExponential(3)}
      </p>
    </div>
  );
}

function ModeTag({ mode }: { mode: 'paper' | 'live' }) {
  return (
    <span className={clsx(
      'text-xs px-1.5 py-0.5 rounded font-medium',
      mode === 'live'
        ? 'bg-red-500/20 text-red-400'
        : 'bg-slate-700 text-slate-400'
    )}>
      {mode}
    </span>
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
