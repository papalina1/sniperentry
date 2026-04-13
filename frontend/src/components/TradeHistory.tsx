import { useBotStore } from '../store/botStore';
import clsx from 'clsx';

export function TradeHistory() {
  const trades = useBotStore((s) => s.trades);
  const closed = trades.filter((t) => t.status === 'closed');

  const totalPnl = closed.reduce((a, t) => a + (t.pnl_sol ?? 0), 0);
  const wins     = closed.filter((t) => (t.pnl_sol ?? 0) > 0).length;
  const losses   = closed.filter((t) => (t.pnl_sol ?? 0) < 0).length;
  const avgPnl   = closed.length ? totalPnl / closed.length : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold text-white">Trade History</h1>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCell label="Total Trades" value={String(closed.length)} />
        <StatCell label="Wins" value={String(wins)} color="text-green-400" />
        <StatCell label="Losses" value={String(losses)} color="text-red-400" />
        <StatCell
          label="Win Rate"
          value={closed.length ? ((wins / closed.length) * 100).toFixed(1) + '%' : '—'}
          color="text-blue-400"
        />
        <StatCell
          label="Total P&L"
          value={`${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(5)} SOL`}
          color={totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}
        />
      </div>

      {/* Table */}
      {closed.length === 0 ? (
        <div className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-12 text-center text-slate-500">
          No closed trades yet. Run the bot in paper mode to see results here.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#1e2d45] text-slate-500 text-xs">
                <th className="text-left py-3 pr-4 font-medium">#</th>
                <th className="text-left pr-4 font-medium">Token</th>
                <th className="text-right pr-4 font-medium">Entry</th>
                <th className="text-right pr-4 font-medium">Exit</th>
                <th className="text-right pr-4 font-medium">Size (SOL)</th>
                <th className="text-right pr-4 font-medium">P&L (SOL)</th>
                <th className="text-right pr-4 font-medium">P&L %</th>
                <th className="text-left pr-4 font-medium">Exit Reason</th>
                <th className="text-right pr-4 font-medium">Mode</th>
                <th className="text-right font-medium">Closed</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((t, i) => {
                const pnl = t.pnl_sol ?? 0;
                const pct = t.pnl_pct ?? 0;
                const color = pnl >= 0 ? 'text-green-400' : 'text-red-400';
                const bg = pnl >= 0 ? 'border-l-2 border-green-500/40' : 'border-l-2 border-red-500/40';

                return (
                  <tr key={t.id} className={clsx('border-b border-[#1e2d45]/40 hover:bg-[#1a2235]', bg)}>
                    <td className="py-2.5 pr-4 text-slate-600 mono">{i + 1}</td>
                    <td className="pr-4 font-medium text-white">{t.symbol}</td>
                    <td className="text-right pr-4 mono text-slate-300">${t.entry_price.toExponential(3)}</td>
                    <td className="text-right pr-4 mono text-slate-300">${(t.exit_price ?? 0).toExponential(3)}</td>
                    <td className="text-right pr-4 mono">{t.buy_size_sol}</td>
                    <td className={clsx('text-right pr-4 mono font-bold', color)}>
                      {pnl >= 0 ? '+' : ''}{pnl.toFixed(5)}
                    </td>
                    <td className={clsx('text-right pr-4 mono font-bold', color)}>
                      {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                    </td>
                    <td className="pr-4 text-xs text-slate-500 max-w-xs">{t.exit_reason}</td>
                    <td className="text-right pr-4">
                      <span className={clsx(
                        'text-xs px-1.5 py-0.5 rounded',
                        t.mode === 'live' ? 'bg-red-500/20 text-red-400' : 'bg-slate-700 text-slate-400'
                      )}>
                        {t.mode}
                      </span>
                    </td>
                    <td className="text-right text-xs text-slate-500 mono">
                      {t.exit_time ? new Date(t.exit_time).toLocaleTimeString() : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Avg P&L note */}
      {closed.length > 0 && (
        <p className="text-xs text-slate-500 text-right">
          Avg P&L per trade: <span className={clsx('mono', avgPnl >= 0 ? 'text-green-400' : 'text-red-400')}>
            {avgPnl >= 0 ? '+' : ''}{avgPnl.toFixed(5)} SOL
          </span>
        </p>
      )}
    </div>
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={clsx('text-xl font-bold mono', color ?? 'text-slate-100')}>{value}</p>
    </div>
  );
}
