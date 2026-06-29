import { useState, useCallback } from 'react';
import TopBar from './components/TopBar';
import Dashboard from './components/Dashboard';
import Capacity from './components/Capacity';
import Topology from './components/Topology';

export default function App() {
  const [view, setView] = useState('dashboard');
  const [ipToHostname, setIpToHostname] = useState({});

  const handleIpMap = useCallback((map) => {
    setIpToHostname(prev => Object.keys(map).length ? { ...prev, ...map } : prev);
  }, []);

  return (
    <div className="app">
      <TopBar view={view} onNavigate={setView} />
      <main className="main-content">
        <Dashboard active={view === 'dashboard'} onIpMapReady={handleIpMap} />
        {view === 'capacity'  && <Capacity ipToHostname={ipToHostname} />}
        {view === 'topology'  && <Topology />}
      </main>
    </div>
  );
}
