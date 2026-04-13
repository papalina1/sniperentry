import { useWebSocket } from './hooks/useWebSocket';
import { useBotStore } from './store/botStore';
import { Navbar } from './components/Navbar';
import { Dashboard } from './components/Dashboard';
import { TokensTable } from './components/TokensTable';
import { PositionsPanel } from './components/PositionsPanel';
import { TradeHistory } from './components/TradeHistory';
import { LogsPanel } from './components/LogsPanel';
import { SystemHealth } from './components/SystemHealth';
import { SettingsPanel } from './components/SettingsPanel';

export default function App() {
  useWebSocket();

  const activeTab = useBotStore((s) => s.activeTab);

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-slate-200 flex flex-col">
      <Navbar />
      <main className="flex-1 p-4 max-w-[1600px] mx-auto w-full">
        {activeTab === 'dashboard'  && <Dashboard />}
        {activeTab === 'tokens'     && <TokensTable />}
        {activeTab === 'positions'  && <PositionsPanel />}
        {activeTab === 'history'    && <TradeHistory />}
        {activeTab === 'logs'       && <LogsPanel />}
        {activeTab === 'health'     && <SystemHealth />}
        {activeTab === 'settings'   && <SettingsPanel />}
      </main>
    </div>
  );
}
