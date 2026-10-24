import { useEffect, useMemo, type ReactNode } from 'react';
import { useRoute } from './router';
import { useCards } from './data';
import type { Card } from './types';
import { mergeCards } from './store/baseline';
import { StoreProvider, useCardStates, useStore, type Live } from './store/context';
import type { CardState } from './store/types';
import { CubeView } from './views/CubeView';
import { CardDetail } from './views/CardDetail';
import { ScanView } from './views/ScanView';
import { AboutView } from './views/AboutView';
import { SuggestionsView } from './views/SuggestionsView';
import { LogView } from './views/LogView';
import { BaselinePanel } from './views/BaselinePanel';

const NAV = [
  { view: 'cube', href: '#/cube', label: 'Cube' },
  { view: 'scan', href: '#/scan', label: 'Scan' },
  { view: 'suggestions', href: '#/suggestions', label: 'Suggest' },
  { view: 'log', href: '#/log', label: 'Log' },
  { view: 'about', href: '#/about', label: 'About' },
] as const;

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const route = useRoute();
  const cards = useCards();
  const states = useCardStates();
  const base = cards.status === 'ready' ? cards.data.cards : null;
  // The stored card state laid over cards.json; cards.json alone until the store has answered.
  const merged = useMemo(() => (base ? mergeCards(base, states.data) : null), [base, states.data]);

  const detailId = route.view === 'cube' ? route.oracleId : null;
  useEffect(() => {
    if (detailId) window.scrollTo(0, 0);
  }, [detailId]);

  let body: ReactNode;
  if (route.view === 'about') {
    body = <AboutView data={cards.status === 'ready' ? cards.data : null} />;
  } else if (route.view === 'log') {
    body = <LogView />;
  } else if (cards.status === 'loading' || !base || !merged) {
    body =
      cards.status === 'error' ? (
        <p className="status error">Could not load the card data. {cards.message}</p>
      ) : (
        <p className="status">Loading card data…</p>
      );
  } else if (route.view === 'scan') {
    body = <ScanView cards={merged} query={route.query} />;
  } else if (route.view === 'suggestions') {
    body = <SuggestionsView cards={merged} />;
  } else if (route.oracleId) {
    body = <CardDetail cards={merged} oracleId={route.oracleId} />;
  } else {
    body = (
      <>
        <CardSource states={states} base={base} />
        <CubeView cards={merged} initialQuery={route.query.get('q') ?? ''} />
      </>
    );
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
        <AccountChip />
      </header>
      <main className="main">{body}</main>
      <Toast />
    </>
  );
}

/** Where the Cube view's card state comes from, and the Owner's Import baseline. */
function CardSource({ states, base }: { states: Live<Map<string, CardState>>; base: Card[] }) {
  const { auth } = useStore();
  const missing = states.status === 'ready' ? base.filter((c) => !states.data.has(c.oracle_id)).length : 0;
  return (
    <>
      {states.status === 'unavailable' && (
        <p className="notice">Shared data is not available on this device; showing the built-in card data. Changes cannot be saved here.</p>
      )}
      {states.status === 'error' && <p className="notice">Could not read the shared card state ({states.error}); showing the built-in card data.</p>}
      {states.status === 'ready' && states.fromCache && !navigator.onLine && <p className="notice">Offline: showing what this device last saw.</p>}
      {/* Only from a server snapshot: an empty cached snapshot must not offer the import. */}
      {states.status === 'ready' && !states.fromCache && missing > 0 && auth.isOwner && (
        <BaselinePanel base={base} existing={states.data} missing={missing} />
      )}
    </>
  );
}

function AccountChip() {
  const { auth, connection, signInAsOwner } = useStore();
  if (connection !== 'ready') return null;
  if (auth.isOwner) {
    return (
      <a className="account" href="#/about">
        Owner
      </a>
    );
  }
  if (auth.provider === 'google') {
    return (
      <a className="account" href="#/about">
        Signed in
      </a>
    );
  }
  return (
    <button type="button" className="account" onClick={() => void signInAsOwner()}>
      Sign in as Owner
    </button>
  );
}

function Toast() {
  const { notice, clearNotice } = useStore();
  if (!notice) return null;
  return (
    <div className={notice.error ? 'toast error' : 'toast'} role={notice.error ? 'alert' : 'status'}>
      <span>{notice.text}</span>
      <button type="button" className="link" onClick={clearNotice}>
        Close
      </button>
    </div>
  );
}
