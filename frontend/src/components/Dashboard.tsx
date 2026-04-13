import { useBotStore } from '../store/botStore';
import { FilterDiagnostics } from '../types';
import clsx from 'clsx';

function StatCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={clsx('text-2xl font-bold mono', color ?? 'text-slate-100')}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

export function Dashboard() {
  const { status, candidates, positions, trades, filterDiagnostics } = useBotStore((s) => ({
    status: s.status,
    candidates: s.candidates,
    positions: s.positions,
    trades: s.trades,
    filterDiagnostics: s.filterDiagnostics,
  }));

  const todayPnl = status?.todayPnlSol ?? 0;
  const pnlColor = todayPnl > 0 ? 'text-green-400' : todayPnl < 0 ? 'text-red-400' : 'text-slate-100';

  const passedCount = candidates.filter((c) => c.passedFilters).length;
  const topCandidates = [...candidates]
    .filter((c) => c.score !== undefined && c.score >= 60)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 8);

  const closedTrades = trades.filter((t) => t.status === 'closed');
  const wins = closedTrades.filter((t) => (t.pnl_sol ?? 0) > 0).length;
  const winRate = closedTrades.length > 0
    ? ((wins / closedTrades.length) * 100).toFixed(0) + '%'
    : 'N/A';

  const uptime = status?.startTime
    ? formatDuration(Date.now() - status.startTime)
    : '—';

  return (
    <div className="space-y-6">
      {/* Status banner */}
      {status?.emergencyStop && (
        <div className="bg-red-900/50 border border-red-600 rounded-lg p-3 text-red-300 font-medium flex items-center gap-2">
          🚨 <span>Emergency stop is active. Bot is halted. Click <strong>Resume</strong> in the top bar to restart.</span>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <div className="col-span-2">
          <StatCard
            label="Today's P&L"
            value={`${todayPnl >= 0 ? '+' : ''}${todayPnl.toFixed(4)} SOL`}
            sub={`${status?.todayTrades ?? 0} trades today`}
            color={pnlColor}
          />
        </div>
        <div className="col-span-2">
          <StatCard
            label="Open Positions"
            value={String(positions.length)}
            sub={`Max: ${status?.config?.maxOpenPositions ?? '—'}`}
            color={positions.length > 0 ? 'text-blue-400' : 'text-slate-100'}
          />
        </div>
        <StatCard label="Discovered" value={String(candidates.length)} sub="this session" />
        <StatCard label="Passed Filter" value={String(passedCount)} sub="candidates" />
        <StatCard label="Win Rate" value={winRate} sub={`${wins}/${closedTrades.length} closed`} color="text-green-400" />
        <StatCard label="Mode" value={(status?.mode ?? 'paper').toUpperCase()} />
        <StatCard label="Uptime" value={uptime} />
      </div>

      {/* Filter diagnostics panel */}
      {filterDiagnostics && (
        <FilterDiagnosticsPanel diag={filterDiagnostics} />
      )}

      {/* Open positions summary */}
      {positions.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Open Positions</h2>
          <div className="space-y-2">
            {positions.map((p) => {
              const mult = p.multiplier ?? 1;
              const pct = p.unrealizedPnlPct ?? 0;
              const timeLeft = Math.max(0, p.maxExitTime - Date.now());
              const color = pct >= 0 ? 'text-green-400' : 'text-red-400';

              return (
                <div key={p.mint} className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-4 flex flex-wrap gap-4 items-center">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white">{p.symbol}</span>
                      <span className={clsx('text-xs px-1.5 py-0.5 rounded', p.mode === 'live' ? 'bg-red-500/20 text-red-400' : 'bg-slate-600 text-slate-300')}>
                        {p.mode}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mono mt-0.5">{p.mint.slice(0, 16)}…</p>
                  </div>

                  <div className="text-center">
                    <p className="text-xs text-slate-500">Entry</p>
                    <p className="mono text-sm">${p.entryPrice.toExponential(3)}</p>
                  </div>

                  <div className="text-center">
                    <p className="text-xs text-slate-500">Current</p>
                    <p className="mono text-sm">${p.currentPrice?.toExponential(3) ?? '…'}</p>
                  </div>

                  <div className="text-center">
                    <p className="text-xs text-slate-500">Target (1.4x)</p>
                    <p className="mono text-sm text-blue-400">${p.targetPrice.toExponential(3)}</p>
                  </div>

                  <div className="text-center">
                    <p className="text-xs text-slate-500">Stop</p>
                    <p className="mono text-sm text-red-400">${p.stopLossPrice.toExponential(3)}</p>
                  </div>

                  <div className="text-center">
                    <p className="text-xs text-slate-500">Mult</p>
                    <p className={clsx('mono font-bold', color)}>{mult.toFixed(3)}x</p>
                  </div>

                  <div className="text-center">
                    <p className="text-xs text-slate-500">PnL</p>
                    <p className={clsx('mono font-bold', color)}>
                      {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                    </p>
                  </div>

                  <div className="text-center">
                    <p className="text-xs text-slate-500">Time left</p>
                    <p className="mono text-sm">{formatDuration(timeLeft)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Top candidates */}
      {topCandidates.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Top Scored Candidates</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1e2d45] text-slate-500 text-xs">
                  <th className="text-left py-2 pr-4">Token</th>
                  <th className="text-right pr-4">Score</th>
                  <th className="text-right pr-4">Liquidity</th>
                  <th className="text-right pr-4">Vol 30m</th>
                  <th className="text-right pr-4">5m Δ</th>
                  <th className="text-right pr-4">B/S Ratio</th>
                  <th className="text-right pr-4">Age</th>
                  <th className="text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {topCandidates.map((c) => (
                  <tr key={c.mint} className="border-b border-[#1e2d45]/50 hover:bg-[#1a2235]">
                    <td className="py-2 pr-4">
                      <div className="font-medium text-white">{c.symbol}</div>
                      <div className="text-xs text-slate-500 mono">{c.mint.slice(0, 12)}…</div>
                    </td>
                    <td className="text-right pr-4">
                      <ScoreBadge score={c.score ?? 0} grade={c.scoreGrade} />
                    </td>
                    <td className="text-right pr-4 mono">${fmtK(c.liquidityUsd)}</td>
                    <td className="text-right pr-4 mono">${fmtK(c.volume30m)}</td>
                    <td className={clsx('text-right pr-4 mono', c.priceChange5m >= 0 ? 'text-green-400' : 'text-red-400')}>
                      {c.priceChange5m >= 0 ? '+' : ''}{c.priceChange5m.toFixed(1)}%
                    </td>
                    <td className="text-right pr-4 mono">{c.buySellRatio.toFixed(1)}x</td>
                    <td className="text-right pr-4 mono">{c.pairAgeMinutes.toFixed(1)}m</td>
                    <td><StatusBadge status={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent trades */}
      {closedTrades.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">Recent Trades</h2>
          <div className="space-y-1">
            {closedTrades.slice(0, 5).map((t) => {
              const pnl = t.pnl_sol ?? 0;
              const color = pnl >= 0 ? 'text-green-400' : 'text-red-400';
              return (
                <div key={t.id} className="bg-[#1a2235] rounded px-4 py-2 flex items-center gap-4 text-sm">
                  <span className="font-medium text-white w-20">{t.symbol}</span>
                  <span className={clsx('mono font-bold', color)}>
                    {pnl >= 0 ? '+' : ''}{pnl.toFixed(5)} SOL
                  </span>
                  <span className={clsx('mono text-xs', color)}>
                    ({(t.pnl_pct ?? 0) >= 0 ? '+' : ''}{(t.pnl_pct ?? 0).toFixed(1)}%)
                  </span>
                  <span className="text-slate-500 text-xs">{t.exit_reason}</span>
                  <span className="ml-auto text-slate-500 text-xs">{formatAgo(t.exit_time ?? t.entry_time)}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Filter Diagnostics Panel ─────────────────────────────────────────────────

function FilterDiagnosticsPanel({ diag }: { diag: FilterDiagnostics }) {
  const filterRows: Array<{ label: string; count: number; color?: string }> = [
    { label: 'Age unverified (no ts)',     count: diag.rejectedByAgeUnverified ?? 0, color: 'text-red-400' },
    { label: 'Rejected by age (entry)',    count: diag.rejectedByAge,                color: 'text-orange-400' },
    { label: 'Rejected by liquidity',      count: diag.rejectedByLiquidity,          color: 'text-red-400' },
    { label: 'Rejected by volume',         count: diag.rejectedByVolume,             color: 'text-red-400' },
    { label: 'Rejected by buy count',      count: diag.rejectedByBuyCount,           color: 'text-red-400' },
    { label: 'Rejected by buy/sell ratio', count: diag.rejectedByBuySellRatio,       color: 'text-red-400' },
    { label: 'Rejected by price change',   count: diag.rejectedByPriceChange,        color: 'text-red-400' },
    { label: 'Rejected by slippage',       count: diag.rejectedBySlippage,           color: 'text-yellow-400' },
    { label: 'Rejected by score',          count: diag.rejectedByScore,              color: 'text-yellow-400' },
    { label: 'Passed all filters',         count: diag.passedAllFilters,             color: 'text-green-400' },
  ];

  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
        Filter Diagnostics — Last Cycle
      </h2>

      {/* Dominant-filter warning */}
      {diag.dominantRejectionFilter && (
        <div className="mb-3 bg-orange-900/40 border border-orange-600 rounded-lg px-4 py-2 text-orange-300 text-sm">
          ⚠️ {diag.dominantRejectionPct}% of candidates rejected by <strong>{diag.dominantRejectionFilter}</strong> — filter may be too strict
        </div>
      )}

      <div className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-4 space-y-4">

        {/* Discovery stage */}
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Discovery Stage</p>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span className="text-slate-400">Fetched: <span className="mono text-slate-200">{diag.totalFetched}</span></span>
            <span className="text-slate-400">
              Overviews: <span className="mono text-green-400">{diag.overviewSucceeded ?? 0}</span>
              <span className="text-slate-600">/{diag.overviewAttempted ?? 0}</span>
              {(diag.overviewFailed ?? 0) > 0 && <span className="mono text-red-400 ml-1">{diag.overviewFailed} failed</span>}
              {(diag.rateLimitedCount ?? 0) > 0 && <span className="mono text-orange-400 ml-1">{diag.rateLimitedCount} rate-ltd</span>}
            </span>
            <span className="text-slate-400">→ Age-cap removed: <span className="mono text-orange-400">{diag.removedByDiscoveryAge}</span></span>
            <span className="text-slate-400">→ Remaining: <span className="mono text-blue-400">{diag.remainingAfterDiscovery}</span></span>
          </div>
        </div>

        {/* Age quality breakdown */}
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Age Quality This Cycle</p>
          <div className="flex flex-wrap gap-4 text-sm">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
              <span className="text-slate-400">Verified: </span>
              <span className="mono text-green-400">{diag.verifiedAgeCount ?? 0}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" />
              <span className="text-slate-400">Estimated: </span>
              <span className="mono text-yellow-400">{diag.estimatedAgeCount ?? 0}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
              <span className="text-slate-400">Unknown: </span>
              <span className="mono text-red-400">{diag.unknownAgeCount ?? 0}</span>
            </span>
          </div>
        </div>

        {/* Hard filter stage */}
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Entry Filter Stage (evaluated: {diag.evaluated})</p>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
            {filterRows.map(({ label, count, color }) => (
              <div key={label} className="bg-[#111827] rounded px-3 py-2">
                <p className="text-xs text-slate-500 leading-tight mb-1">{label}</p>
                <p className={clsx('mono font-bold text-lg', color ?? 'text-slate-200')}>{count}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-slate-600">
          Updated {diag.cycleAt ? formatAgo(diag.cycleAt) : '—'}
        </p>
      </div>
    </section>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ScoreBadge({ score, grade }: { score: number; grade?: string }) {
  const color =
    grade === 'pass' ? 'text-green-400' :
    grade === 'warn' ? 'text-yellow-400' :
    'text-red-400';
  return <span className={clsx('font-bold mono', color)}>{score}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    discovered:   'bg-slate-600 text-slate-300',
    filtered_out: 'bg-red-500/20 text-red-400',
    scored:       'bg-blue-500/20 text-blue-400',
    rejected:     'bg-red-500/20 text-red-400',
    pending_buy:  'bg-yellow-500/20 text-yellow-400',
    bought:       'bg-green-500/20 text-green-400',
  };
  return (
    <span className={clsx('text-xs px-1.5 py-0.5 rounded', map[status] ?? 'bg-slate-600 text-slate-300')}>
      {status.replace('_', ' ')}
    </span>
  );
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(0);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatAgo(ts: number): string {
  return formatDuration(Date.now() - ts) + ' ago';
}
