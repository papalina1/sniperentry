import { useState, useRef, useEffect } from 'react';
import { useBotStore } from '../store/botStore';
import { LogEntry } from '../types';
import clsx from 'clsx';

const LEVEL_COLORS: Record<string, string> = {
  debug: 'text-slate-500',
  info:  'text-blue-400',
  warn:  'text-yellow-400',
  error: 'text-red-400',
};

const LEVEL_BG: Record<string, string> = {
  warn:  'bg-yellow-500/10',
  error: 'bg-red-500/10',
};

export function LogsPanel() {
  const logs = useBotStore((s) => s.logs);
  const [filter, setFilter] = useState<string>('all');
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const filtered = logs.filter((l) => {
    if (filter !== 'all' && l.level !== filter) return false;
    if (search && !l.message.toLowerCase().includes(search.toLowerCase()) &&
        !l.component.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, paused]);

  return (
    <div className="space-y-3 h-[calc(100vh-120px)] flex flex-col">
      <div className="flex flex-wrap gap-2 items-center">
        <h1 className="text-lg font-bold text-white">Logs</h1>
        <span className="text-slate-500 text-sm">({filtered.length})</span>

        <div className="flex gap-1">
          {['all', 'info', 'warn', 'error', 'debug'].map((l) => (
            <button
              key={l}
              onClick={() => setFilter(l)}
              className={clsx(
                'px-2 py-1 rounded text-xs font-medium transition-colors capitalize',
                filter === l
                  ? 'bg-blue-600 text-white'
                  : 'bg-[#1a2235] text-slate-400 hover:text-slate-200'
              )}
            >
              {l}
            </button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-[#1a2235] border border-[#1e2d45] rounded px-3 py-1 text-sm text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 w-48"
        />

        <button
          onClick={() => setPaused((p) => !p)}
          className={clsx(
            'px-2 py-1 rounded text-xs font-medium ml-auto',
            paused ? 'bg-yellow-600/40 text-yellow-300' : 'bg-[#1a2235] text-slate-400'
          )}
        >
          {paused ? '▶ Resume scroll' : '⏸ Pause scroll'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto bg-[#0a0e1a] border border-[#1e2d45] rounded-lg font-mono text-xs">
        {filtered.length === 0 ? (
          <p className="text-center text-slate-500 p-8">No log entries</p>
        ) : (
          <table className="w-full">
            <tbody>
              {[...filtered].reverse().map((entry, i) => (
                <LogRow key={i} entry={entry} />
              ))}
            </tbody>
          </table>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const d = new Date(entry.ts);
  const time = d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }) + '.' + String(d.getMilliseconds()).padStart(3, '0');

  return (
    <>
      <tr
        className={clsx(
          'border-b border-[#1e2d45]/30 cursor-pointer hover:bg-[#111827]',
          LEVEL_BG[entry.level] ?? ''
        )}
        onClick={() => entry.data && setOpen((o) => !o)}
      >
        <td className="px-3 py-1 text-slate-600 whitespace-nowrap w-24">{time}</td>
        <td className={clsx('px-2 py-1 uppercase w-12', LEVEL_COLORS[entry.level])}>
          {entry.level.slice(0, 4)}
        </td>
        <td className="px-2 py-1 text-slate-500 w-28">[{entry.component}]</td>
        <td className={clsx('px-2 py-1', LEVEL_COLORS[entry.level])}>{entry.message}</td>
        {entry.data != null && <td className="px-2 py-1 text-slate-600 w-4">▶</td>}
      </tr>
      {open && entry.data && (
        <tr className="bg-[#111827]">
          <td colSpan={5} className="px-8 py-2 text-slate-400">
            <pre className="whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(entry.data, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
