import { useEffect, type ReactNode } from 'react';
import { useRoute } from './router';
import { useCards } from './data';
import { CubeView } from './views/CubeView';
import { CardDetail } from './views/CardDetail';
import { ScanView } from './views/ScanView';
import { AboutView } from './views/AboutView';

const NAV = [
  { view: 'cube', href: '#/cube', label: 'Cube' },
  { view: 'scan', href: '#/scan', label: 'Scan' },
  { view: 'about', href: '#/about', label: 'About' },
] as const;

export function App() {
  const route = useRoute();
  const cards = useCards();

  const detailId = route.view === 'cube' ? route.oracleId : null;
  useEffect(() => {
    if (detailId) window.scrollTo(0, 0);
  }, [detailId]);

  let body: ReactNode;
  if (route.view === 'about') {
    body = <AboutView data={cards.status === 'ready' ? cards.data : null} />;
  } else if (cards.status === 'loading') {
    body = <p className="status">Loading card data…</p>;
  } else if (cards.status === 'error') {
    body = <p className="status error">Could not load the card data. {cards.message}</p>;
  } else if (route.view === 'scan') {
    body = <ScanView cards={cards.data.cards} query={route.query} />;
  } else if (route.oracleId) {
    body = <CardDetail cards={cards.data.cards} oracleId={route.oracleId} />;
  } else {
    body = <CubeView cards={cards.data.cards} initialQuery={route.query.get('q') ?? ''} />;
  }

  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/cube">
          Cube
        </a>
        <nav className="nav" aria-label="Views">
          {NAV.map((n) => (
            <a key={n.view} href={n.href} aria-current={route.view === n.view ? 'page' : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="main">{body}</main>
    </>
  );
}
