import { useState, useEffect } from 'react';
import clsx from 'clsx';

interface Settings {
  LIVE_TRADING: boolean;
  DEFAULT_POSITION_SIZE_SOL: number;
  MAX_OPEN_POSITIONS: number;
  MAX_DAILY_LOSS: number;
  COOLDOWN_SECONDS: number;
  MAX_DISCOVERY_AGE_MINUTES: number;
  MIN_LIQUIDITY_USD: number;
  MAX_LIQUIDITY_USD: number;
  MIN_RECENT_VOLUME_USD: number;
  MIN_RECENT_BUY_COUNT: number;
  MIN_BUY_SELL_RATIO: number;
  MAX_5M_PRICE_CHANGE_PCT: number;
  MAX_15M_PRICE_CHANGE_PCT: number;
  MAX_ESTIMATED_SLIPPAGE_PCT: number;
  MIN_PAIR_AGE_MINUTES: number;
  MAX_PAIR_AGE_MINUTES: number;
  MIN_SCORE: number;
  TARGET_MULTIPLIER: number;
  SELL_TRIGGER_BUFFER_LOW: number;
  SELL_TRIGGER_BUFFER_HIGH: number;
  STOP_LOSS_PCT: number;
  MAX_HOLD_MINUTES: number;
  LIQUIDITY_DROP_EXIT_PCT: number;
  SLIPPAGE_BPS: number;
  PRIORITY_FEE_LAMPORTS: number;
  DISCOVERY_INTERVAL_MS: number;
  POSITION_MONITOR_INTERVAL_MS: number;
}

// Keys that can be edited live without a restart
const PATCHABLE_KEYS = new Set<keyof Settings>([
  'MAX_DISCOVERY_AGE_MINUTES',
  'MIN_PAIR_AGE_MINUTES',
  'MAX_PAIR_AGE_MINUTES',
  'MIN_LIQUIDITY_USD',
  'MAX_LIQUIDITY_USD',
  'MIN_RECENT_VOLUME_USD',
  'MIN_RECENT_BUY_COUNT',
  'MIN_BUY_SELL_RATIO',
  'MAX_5M_PRICE_CHANGE_PCT',
  'MAX_15M_PRICE_CHANGE_PCT',
  'MAX_ESTIMATED_SLIPPAGE_PCT',
  'MIN_SCORE',
]);

type SectionSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [edits, setEdits] = useState<Partial<Record<keyof Settings, string>>>({});
  const [sectionStatus, setSectionStatus] = useState<Record<string, SectionSaveStatus>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d: Settings) => { setSettings(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="text-slate-500 p-8">Loading settings…</p>;
  }

  if (!settings) {
    return <p className="text-red-400 p-8">Could not load settings. Is the backend running?</p>;
  }

  // Merge live settings with any in-progress edits for display
  function displayValue(k: keyof Settings): string {
    return edits[k] !== undefined ? edits[k]! : String(settings![k]);
  }

  function handleEdit(k: keyof Settings, v: string) {
    setEdits((prev) => ({ ...prev, [k]: v }));
  }

  async function saveSection(title: string, keys: (keyof Settings)[]) {
    const patchableKeys = keys.filter((k) => PATCHABLE_KEYS.has(k));
    if (patchableKeys.length === 0) return;

    const body: Record<string, number> = {};
    for (const k of patchableKeys) {
      const raw = edits[k] !== undefined ? edits[k]! : String(settings![k]);
      const n = Number(raw);
      if (!isFinite(n)) {
        setSectionStatus((s) => ({ ...s, [title]: 'error' }));
        return;
      }
      body[k] = n;
    }

    setSectionStatus((s) => ({ ...s, [title]: 'saving' }));
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json() as { applied: Partial<Settings> };
      // Merge confirmed values back into settings
      setSettings((s) => s ? { ...s, ...data.applied } : s);
      // Clear edits for this section
      setEdits((prev) => {
        const next = { ...prev };
        for (const k of patchableKeys) delete next[k];
        return next;
      });
      setSectionStatus((s) => ({ ...s, [title]: 'saved' }));
      setTimeout(() => setSectionStatus((s) => ({ ...s, [title]: 'idle' })), 2000);
    } catch {
      setSectionStatus((s) => ({ ...s, [title]: 'error' }));
      setTimeout(() => setSectionStatus((s) => ({ ...s, [title]: 'idle' })), 3000);
    }
  }

  const sections: { title: string; description: string; keys: (keyof Settings)[] }[] = [
    {
      title: 'Trading Mode',
      description: 'Live mode must be enabled in .env and requires a PRIVATE_KEY. Changes require restart.',
      keys: ['LIVE_TRADING'],
    },
    {
      title: 'Position Sizing & Risk',
      description: 'Controls how much SOL is spent per trade and when the bot stops trading for the day.',
      keys: ['DEFAULT_POSITION_SIZE_SOL', 'MAX_OPEN_POSITIONS', 'MAX_DAILY_LOSS', 'COOLDOWN_SECONDS'],
    },
    {
      title: 'Discovery Filter',
      description: 'Tokens older than MAX_DISCOVERY_AGE_MINUTES are dropped at the discovery stage, before hard filters and scoring.',
      keys: ['MAX_DISCOVERY_AGE_MINUTES'],
    },
    {
      title: 'Hard Entry Filters',
      description: 'Tokens failing any of these are immediately rejected without scoring. Changes apply to the next pipeline cycle.',
      keys: [
        'MIN_PAIR_AGE_MINUTES', 'MAX_PAIR_AGE_MINUTES',
        'MIN_LIQUIDITY_USD', 'MAX_LIQUIDITY_USD', 'MIN_RECENT_VOLUME_USD',
        'MIN_RECENT_BUY_COUNT', 'MIN_BUY_SELL_RATIO',
        'MAX_5M_PRICE_CHANGE_PCT', 'MAX_15M_PRICE_CHANGE_PCT',
        'MAX_ESTIMATED_SLIPPAGE_PCT',
      ],
    },
    {
      title: 'Scoring',
      description: 'Minimum score a token must achieve to trigger a buy attempt.',
      keys: ['MIN_SCORE'],
    },
    {
      title: 'Exit Rules',
      description: 'Controls when the bot closes a position.',
      keys: [
        'TARGET_MULTIPLIER', 'SELL_TRIGGER_BUFFER_LOW', 'SELL_TRIGGER_BUFFER_HIGH',
        'STOP_LOSS_PCT', 'MAX_HOLD_MINUTES', 'LIQUIDITY_DROP_EXIT_PCT',
      ],
    },
    {
      title: 'Execution',
      description: 'Jupiter swap execution parameters.',
      keys: ['SLIPPAGE_BPS', 'PRIORITY_FEE_LAMPORTS'],
    },
    {
      title: 'Timing',
      description: 'How frequently the bot polls for new tokens and checks positions.',
      keys: ['DISCOVERY_INTERVAL_MS', 'POSITION_MONITOR_INTERVAL_MS'],
    },
  ];

  const descriptions: Partial<Record<keyof Settings, string>> = {
    LIVE_TRADING: 'Must be true in .env to send real transactions',
    DEFAULT_POSITION_SIZE_SOL: 'SOL spent per trade',
    MAX_OPEN_POSITIONS: 'Hard cap on concurrent open positions',
    MAX_DAILY_LOSS: 'Stop trading if total daily loss exceeds this (SOL)',
    COOLDOWN_SECONDS: 'Wait time between consecutive buys',
    MIN_LIQUIDITY_USD: 'Minimum pool liquidity to consider a token',
    MAX_LIQUIDITY_USD: 'Reject tokens already extended beyond this liquidity',
    MIN_RECENT_VOLUME_USD: 'Minimum 30m trading volume',
    MIN_RECENT_BUY_COUNT: 'Minimum buy transactions in last 30m',
    MIN_BUY_SELL_RATIO: 'Minimum buys/sells ratio (e.g. 1.2 = 20% more buys than sells)',
    MAX_5M_PRICE_CHANGE_PCT: 'Reject if 5m absolute move exceeds this %',
    MAX_15M_PRICE_CHANGE_PCT: 'Reject if 15m absolute move exceeds this %',
    MAX_ESTIMATED_SLIPPAGE_PCT: 'Maximum acceptable Jupiter price impact %',
    MAX_DISCOVERY_AGE_MINUTES: 'Discovery pre-filter: tokens older than this (minutes) are dropped before hard filters.',
    MIN_PAIR_AGE_MINUTES: 'Entry filter: token must be at least this old (minutes)',
    MAX_PAIR_AGE_MINUTES: 'Entry filter: reject tokens older than this (minutes)',
    MIN_SCORE: 'Minimum composite score (0-100) to trigger a buy',
    TARGET_MULTIPLIER: 'Sell all when price reaches this multiple of entry (1.4 = 40% profit)',
    SELL_TRIGGER_BUFFER_LOW: 'Begin preparing sell execution at this multiplier',
    SELL_TRIGGER_BUFFER_HIGH: 'Execute sell aggressively at this multiplier (below target)',
    STOP_LOSS_PCT: 'Close position if price drops this % from entry',
    MAX_HOLD_MINUTES: 'Force-close position after this many minutes',
    LIQUIDITY_DROP_EXIT_PCT: 'Exit if liquidity drops this % from entry level',
    SLIPPAGE_BPS: 'Jupiter slippage tolerance in basis points (300 = 3%)',
    PRIORITY_FEE_LAMPORTS: 'Solana priority fee in lamports for faster inclusion',
    DISCOVERY_INTERVAL_MS: 'Birdeye poll interval in milliseconds',
    POSITION_MONITOR_INTERVAL_MS: 'Position check interval in milliseconds',
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-white">Settings</h1>
        <div className="text-xs text-slate-500 bg-[#1a2235] border border-[#1e2d45] rounded px-3 py-2">
          Filter settings can be tuned live. Other settings require a restart.
        </div>
      </div>

      {settings.LIVE_TRADING && (
        <div className="bg-red-900/40 border border-red-600 rounded-lg p-4 text-red-300">
          <strong>LIVE TRADING IS ENABLED.</strong> Real SOL will be spent on qualifying trades.
          Set <code>LIVE_TRADING=false</code> in .env to return to paper mode.
        </div>
      )}

      {sections.map((sec) => {
        const hasPatchable = sec.keys.some((k) => PATCHABLE_KEYS.has(k));
        const isDirty = sec.keys.some((k) => PATCHABLE_KEYS.has(k) && edits[k] !== undefined);
        const status = sectionStatus[sec.title] ?? 'idle';

        return (
          <div key={sec.title} className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-white">{sec.title}</h2>
                  {hasPatchable && (
                    <span className="text-xs bg-blue-900/40 text-blue-300 border border-blue-700/40 rounded px-1.5 py-0.5">
                      live-tunable
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5">{sec.description}</p>
              </div>
              {hasPatchable && (
                <button
                  onClick={() => saveSection(sec.title, sec.keys)}
                  disabled={!isDirty || status === 'saving'}
                  className={clsx(
                    'flex-shrink-0 text-xs font-medium px-3 py-1.5 rounded border transition-colors',
                    status === 'saved'
                      ? 'bg-green-900/40 border-green-600 text-green-300'
                      : status === 'error'
                      ? 'bg-red-900/40 border-red-600 text-red-300'
                      : isDirty
                      ? 'bg-blue-700 border-blue-500 text-white hover:bg-blue-600 cursor-pointer'
                      : 'bg-[#0a0e1a] border-[#1e2d45] text-slate-600 cursor-not-allowed'
                  )}
                >
                  {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Error' : 'Apply'}
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {sec.keys.map((k) => {
                const editable = PATCHABLE_KEYS.has(k);
                const isDirtyField = edits[k] !== undefined;
                const val = displayValue(k);
                return (
                  <div key={k} className="space-y-1">
                    <label className={clsx(
                      'text-xs font-medium flex items-center gap-1',
                      editable ? 'text-blue-300' : 'text-slate-400'
                    )}>
                      {k}
                      {editable && <span className="text-slate-600 font-normal">(editable)</span>}
                    </label>
                    <div className="flex items-center gap-2">
                      {editable ? (
                        <input
                          type="number"
                          value={val}
                          onChange={(e) => handleEdit(k, e.target.value)}
                          className={clsx(
                            'flex-1 bg-[#0a0e1a] border rounded px-3 py-2 text-sm mono text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500',
                            isDirtyField ? 'border-blue-500/60' : 'border-[#1e2d45]'
                          )}
                        />
                      ) : (
                        <div className={clsx(
                          'flex-1 bg-[#0a0e1a] border border-[#1e2d45] rounded px-3 py-2 text-sm mono',
                          k === 'LIVE_TRADING' && settings[k]
                            ? 'text-red-400 border-red-500/50'
                            : 'text-slate-400'
                        )}>
                          {val}
                        </div>
                      )}
                    </div>
                    {descriptions[k] && (
                      <p className="text-xs text-slate-600">{descriptions[k]}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="bg-[#1a2235] border border-[#1e2d45] rounded-lg p-5 text-sm text-slate-400">
        <p className="font-medium text-slate-300 mb-2">To change non-filter settings:</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>Edit <code className="text-blue-400">.env</code> in the backend directory</li>
          <li>Restart the backend: <code className="text-blue-400">npm run dev</code></li>
          <li>Settings will be re-read on startup</li>
        </ol>
        <p className="mt-3 text-xs text-slate-600">
          Filter settings marked <span className="text-blue-300">editable</span> take effect immediately without restart.
        </p>
      </div>
    </div>
  );
}
