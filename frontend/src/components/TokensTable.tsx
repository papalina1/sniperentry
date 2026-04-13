import { useState } from 'react';
import { useBotStore } from '../store/botStore';
import { AgeState, Candidate, CandidateStatus } from '../types';
import clsx from 'clsx';

const STATUS_FILTERS: { label: string; value: CandidateStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Discovered', value: 'discovered' },
  { label: 'Passed Filter', value: 'scored' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Filtered Out', value: 'filtered_out' },
  { label: 'Age Filtered', value: 'discovery_age_filtered' },
  { label: 'Bought', value: 'bought' },
];

export function TokensTable() {
  const candidates = useBotStore((s) => s.candidates);
  const [filter, setFilter] = useState<CandidateStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = candidates
    .filter((c) => filter === 'all' || c.status === filter)
    .filter((c) =>
      !search ||
      c.symbol.toLowerCase().includes(search.toLowerCase()) ||
      c.mint.includes(search)
    )
    .sort((a, b) => b.lastUpdated - a.lastUpdated);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center">
        <h1 className="text-lg font-bold text-white">Token Candidates</h1>
        <span className="text-slate-500 text-sm">({filtered.length} shown)</span>

        <div className="flex gap-1 ml-4">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={clsx(
                'px-2 py-1 rounded text-xs font-medium transition-colors',
                filter === f.value ? 'bg-blue-600 text-white' : 'bg-[#1a2235] text-slate-400 hover:text-slate-200'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Search symbol or mint…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto bg-[#1a2235] border border-[#1e2d45] rounded px-3 py-1 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 w-64"
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#1e2d45] text-slate-500 text-xs">
              <th className="text-left py-3 pr-4 font-medium">Token</th>
              <th className="text-right pr-4 font-medium">Score</th>
              <th className="text-right pr-4 font-medium">Liq</th>
              <th className="text-right pr-4 font-medium">Vol 30m</th>
              <th className="text-right pr-4 font-medium">5m Δ</th>
              <th className="text-right pr-4 font-medium">B/S</th>
              <th className="text-right pr-4 font-medium">Buys</th>
              <th className="text-right pr-4 font-medium">Age</th>
              <th className="text-left pr-4 font-medium">Status</th>
              <th className="text-left font-medium">Age Quality / Flags</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <>
                <tr
                  key={c.mint}
                  className="border-b border-[#1e2d45]/40 hover:bg-[#1a2235] cursor-pointer"
                  onClick={() => setExpanded(expanded === c.mint ? null : c.mint)}
                >
                  <td className="py-2.5 pr-4">
                    <div className="font-medium text-white">{c.symbol}</div>
                    <div className="text-xs text-slate-500 mono">{c.mint.slice(0, 14)}…</div>
                  </td>
                  <td className="text-right pr-4">
                    {c.score !== undefined ? (
                      <ScoreBadge score={c.score} grade={c.scoreGrade} />
                    ) : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="text-right pr-4 mono">${fmtK(c.liquidityUsd)}</td>
                  <td className="text-right pr-4 mono">${fmtK(c.volume30m)}</td>
                  <td className={clsx('text-right pr-4 mono',
                    c.priceChange5m > 0 ? 'text-green-400' : c.priceChange5m < 0 ? 'text-red-400' : 'text-slate-400'
                  )}>
                    {c.priceChange5m >= 0 ? '+' : ''}{c.priceChange5m.toFixed(1)}%
                  </td>
                  <td className="text-right pr-4 mono">{c.buySellRatio.toFixed(1)}x</td>
                  <td className="text-right pr-4 mono">{c.buyCount30m}</td>
                  <td className="text-right pr-4 mono">
                    <span>{c.pairAgeMinutes.toFixed(1)}m</span>
                  </td>
                  <td className="pr-4"><StatusBadge status={c.status} /></td>
                  <td className="text-xs max-w-xs truncate">
                    <AgeBadge ageState={c.ageState} ageSource={c.ageSource} />
                    {c.redFlags.length > 0 && (
                      <span className="text-yellow-500 ml-2">⚠ {c.redFlags.length} flag{c.redFlags.length > 1 ? 's' : ''}</span>
                    )}
                    {c.rejectionReason && (
                      <span className="ml-1 text-slate-500">
                        {c.status === 'discovery_age_filtered' && (
                          <span className="text-orange-500 mr-1 font-medium">[DISCOVERY]</span>
                        )}
                        {c.status === 'filtered_out' && (
                          <span className="text-red-500 mr-1 font-medium">[ENTRY]</span>
                        )}
                        <span title={c.rejectionReason}>{c.rejectionReason.slice(0, 50)}{c.rejectionReason.length > 50 ? '…' : ''}</span>
                      </span>
                    )}
                  </td>
                </tr>

                {/* Expanded row */}
                {expanded === c.mint && (
                  <tr key={c.mint + '_exp'} className="bg-[#111827]">
                    <td colSpan={10} className="px-4 py-4">
                      <ExpandedCandidate c={c} />
                    </td>
                  </tr>
                )}
              </>
            ))}

            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="py-12 text-center text-slate-500">
                  No candidates match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExpandedCandidate({ c }: { c: Candidate }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
      <div>
        <p className="text-slate-500 mb-1 uppercase tracking-wider">Market Data</p>
        <p>Price: <span className="mono text-white">${c.price.toExponential(4)}</span></p>
        <p>Liq: <span className="mono text-white">${c.liquidityUsd.toLocaleString()}</span></p>
        <p>Vol 1h: <span className="mono text-white">${fmtK(c.volume1h)}</span></p>
        <p>Vol 30m: <span className="mono text-white">${fmtK(c.volume30m)}</span></p>
        {c.fdv && <p>FDV: <span className="mono text-white">${fmtK(c.fdv)}</span></p>}
      </div>

      <div>
        <p className="text-slate-500 mb-1 uppercase tracking-wider">Trade Activity</p>
        <p>Buys 30m: <span className="mono text-green-400">{c.buyCount30m}</span></p>
        <p>Sells 30m: <span className="mono text-red-400">{c.sellCount30m}</span></p>
        <p>B/S ratio: <span className="mono text-white">{c.buySellRatio.toFixed(2)}x</span></p>
        <p>Age: <span className="mono text-white">{c.pairAgeMinutes.toFixed(1)} min</span>{' '}
          <AgeBadge ageState={c.ageState} ageSource={c.ageSource} showSource />
        </p>
      </div>

      <div>
        <p className="text-slate-500 mb-1 uppercase tracking-wider">Price Changes</p>
        <PctRow label="5m" val={c.priceChange5m} />
        <PctRow label="15m" val={c.priceChange15m} />
        <PctRow label="30m" val={c.priceChange30m} />
      </div>

      {c.scoreBreakdown && (
        <div>
          <p className="text-slate-500 mb-1 uppercase tracking-wider">Score Breakdown</p>
          <ScoreRow label="Liquidity"    val={c.scoreBreakdown.liquidityScore} max={20} />
          <ScoreRow label="Momentum"     val={c.scoreBreakdown.momentumScore} max={20} />
          <ScoreRow label="Buy pressure" val={c.scoreBreakdown.buyPressureScore} max={20} />
          <ScoreRow label="Timing"       val={c.scoreBreakdown.timingScore} max={15} />
          <ScoreRow label="Quote"        val={c.scoreBreakdown.quoteScore} max={10} />
          <ScoreRow label="Vol penalty"  val={c.scoreBreakdown.volatilityPenalty} max={0} />
          <ScoreRow label="Slippage pen" val={c.scoreBreakdown.slippagePenalty} max={0} />
          <ScoreRow label="Suspicious"   val={c.scoreBreakdown.suspiciousPenalty} max={0} />
        </div>
      )}

      {c.redFlags.length > 0 && (
        <div className="col-span-2 md:col-span-4">
          <p className="text-slate-500 mb-1 uppercase tracking-wider">Red Flags</p>
          <ul className="list-disc list-inside space-y-0.5">
            {c.redFlags.map((f, i) => <li key={i} className="text-yellow-400">{f}</li>)}
          </ul>
        </div>
      )}

      {c.scoreSummary && (
        <div className="col-span-2 md:col-span-4">
          <p className="text-slate-500 mb-1 uppercase tracking-wider">Score Summary</p>
          <p className="text-slate-300">{c.scoreSummary}</p>
        </div>
      )}

      <div className="col-span-2 md:col-span-4">
        <a
          href={`https://birdeye.so/token/${c.mint}?chain=solana`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:underline"
        >
          View on Birdeye ↗
        </a>
        {' · '}
        <a
          href={`https://solscan.io/token/${c.mint}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:underline"
        >
          Solscan ↗
        </a>
      </div>
    </div>
  );
}

function PctRow({ label, val }: { label: string; val: number }) {
  const color = val > 0 ? 'text-green-400' : val < 0 ? 'text-red-400' : 'text-slate-400';
  return (
    <p>{label}: <span className={clsx('mono', color)}>{val >= 0 ? '+' : ''}{val.toFixed(1)}%</span></p>
  );
}

function ScoreRow({ label, val, max }: { label: string; val: number; max: number }) {
  const color = val < 0 ? 'text-red-400' : val >= max * 0.7 ? 'text-green-400' : 'text-slate-300';
  return (
    <p>{label}: <span className={clsx('mono', color)}>{val > 0 ? '+' : ''}{val}</span></p>
  );
}

function AgeBadge({
  ageState,
  ageSource,
  showSource = false,
}: {
  ageState: AgeState;
  ageSource: string;
  showSource?: boolean;
}) {
  const map: Record<AgeState, { cls: string; label: string; title: string }> = {
    verified: {
      cls: 'bg-green-500/20 text-green-400',
      label: 'verified',
      title: `Age confirmed by API timestamp (src: ${ageSource})`,
    },
    estimated: {
      cls: 'bg-yellow-500/20 text-yellow-400',
      label: 'est',
      title: `Age estimated from proxy signal (src: ${ageSource}) — may not reflect actual token creation time`,
    },
    unknown: {
      cls: 'bg-red-500/20 text-red-400',
      label: 'unknown',
      title: `No timestamp available (src: ${ageSource}) — age is a synthetic fallback, not trustworthy`,
    },
  };
  const { cls, label, title } = map[ageState] ?? map['unknown'];
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={clsx('text-xs px-1 py-0.5 rounded font-medium', cls)}
        title={title}
      >
        {label}
      </span>
      {showSource && (
        <span className="text-slate-600 text-xs" title={title}>
          {ageSource}
        </span>
      )}
    </span>
  );
}

function ScoreBadge({ score, grade }: { score: number; grade?: string }) {
  const color =
    grade === 'pass' ? 'text-green-400' :
    grade === 'warn' ? 'text-yellow-400' :
    'text-red-400';
  return <span className={clsx('font-bold mono', color)}>{score}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    discovered:              'bg-slate-700 text-slate-300',
    filtering:               'bg-yellow-500/20 text-yellow-400',
    discovery_age_filtered:  'bg-orange-500/20 text-orange-400',
    filtered_out:            'bg-red-500/20 text-red-400',
    scored:                  'bg-blue-500/20 text-blue-400',
    rejected:                'bg-red-500/20 text-red-400',
    pending_buy:             'bg-orange-500/20 text-orange-400',
    bought:                  'bg-green-500/20 text-green-400',
  };
  return (
    <span className={clsx('text-xs px-1.5 py-0.5 rounded font-medium', map[status] ?? 'bg-slate-700 text-slate-300')}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(0);
}
