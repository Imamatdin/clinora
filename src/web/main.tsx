import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) }).then(async response => {
      if (!response.ok) throw new Error('unavailable');
      const health: unknown = await response.json();
      if (!health || typeof health !== 'object' || !('service' in health) || health.service !== 'clinora') throw new Error('invalid');
      setStatus('ready');
    }).catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    return () => controller.abort();
  }, []);
  return <main>
    <header><p className="eyebrow">CLINORA / DEVELOPMENT</p><span>Increment 0</span></header>
    <h1>A foundation for the clinical workspace.</h1>
    <p className="intro">Project checks and shared contracts are in place. Patient care workflows will arrive in the next increments.</p>
    <section aria-labelledby="status"><h2 id="status">Foundation status</h2>
      <p role="status" aria-live="polite">{status === 'loading' ? 'Checking the server…' : status === 'ready' ? 'Server connected' : 'Server unavailable. Start the API server and reload.'}</p>
      <dl><div><dt>Patient records</dt><dd>Not implemented</dd></div><div><dt>Doctor sign-in</dt><dd>Not implemented</dd></div><div><dt>Clinical integrations</dt><dd>Unavailable</dd></div></dl>
    </section>
    <aside>No patient data is stored here. This build is an engineering foundation and has not been clinically validated.</aside>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
