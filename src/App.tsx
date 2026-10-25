import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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

// The Printing picker and the Cycles view load on demand, in their own chunks.
const PickerView = lazy(() => import('./views/printings/PickerView'));
const CyclesView = lazy(() => import('./views/printings/CyclesView'));
// The Print view (and jsPDF, which it imports on demand) stays out of the main chunk.
const PrintView = lazy(() => import('./views/print/PrintView'));
// The Update view (CubeCobra, Scryfall and the CSV export) loads on demand too.
const UpstreamView = lazy(() => import('./views/upstream/UpstreamView'));
// The camera capture view; the recogniser (onnxruntime-web, the model) loads from it, in a worker.
const CameraView = lazy(() => import('./views/camera/CameraView'));

const NAV = [
  { view: 'cube', href: '#/cube', label: 'Cube' },
  { view: 'cycles', href: '#/cycles', label: 'Cycles' },
  { view: 'scan', href: '#/scan', label: 'Scan' },
  { view: 'print', href: '#/print', label: 'Print' },
  { view: 'suggestions', href: '#/suggestions', label: 'Suggest' },
  { view: 'upstream', href: '#/upstream', label: 'Update' },
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
  const { auth } = useStore();
  const base = cards.status === 'ready' ? cards.data.cards : null;
  // The stored card state laid over cards.json; cards.json alone until the store has answered.
  const merged = useMemo(() => (base ? mergeCards(base, states.data) : null), [base, states.data]);
  const onList = useMemo(() => merged?.filter((c) => c.in_list) ?? null, [merged]);

  const detailId = route.view === 'cube' || route.view === 'printings' ? route.oracleId : route.view === 'cycles' ? route.cycle : null;
  useEffect(() => {
    if (detailId) window.scrollTo(0, 0);
  }, [detailId]);

  let body: ReactNode;
  if (route.view === 'about') {
    body = <AboutView data={cards.status === 'ready' ? cards.data : null} />;
  } else if (route.view === 'log') {
    body = <LogView />;
  } else if (route.view === 'camera') {
    // Works before the card data has loaded; the In-box Printings join in when it has.
    body = <CameraView cards={merged} />;
  } else if (cards.status === 'loading' || !base || !merged) {
    body =
      cards.status === 'error' ? (
        <p className="status error">Could not load the card data. {cards.message}</p>
      ) : (
        <p className="status">Loading card data…</p>
      );
  } else if (route.view === 'scan') {
    body = <ScanView cards={merged} query={route.query} />;
  } else if (route.view === 'printings') {
    body = <PickerView key={route.oracleId} cards={merged} oracleId={route.oracleId} />;
  } else if (route.view === 'cycles') {
    // Cycles are planned for the cards on the List; retired cards and cards to pull are left out.
    body = <CyclesView cards={onList ?? merged} cycle={route.cycle} />;
  } else if (route.view === 'print') {
    body = <PrintView cards={merged} section={route.query.get('section')} />;
  } else if (route.view === 'suggestions') {
    body = <SuggestionsView cards={merged} />;
  } else if (route.view === 'upstream') {
    // Only a server snapshot of the card state counts: on cards.json alone (loading, error, cache) the
    // Update would treat stored cards as new and the CSV would roll the List back.
    body = <UpstreamView cards={merged} cardsReady={states.status === 'ready' && !states.fromCache && auth.ownerLoaded} />;
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
            <a key={n.view} href={n.href} aria-current={navView(route.view) === n.view ? 'page' : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
        <AccountChip />
      </header>
      <main className="main">
        <Suspense fallback={<p className="status">Loading…</p>}>{body}</Suspense>
      </main>
      <Toast />
    </>
  );
}

/** The nav entry a view belongs to: the picker is part of the Cube and the camera of Scan; About and Log have no bar entry (they are in the account menu). */
function navView(view: string): string | null {
  if (view === 'about' || view === 'log') return null;
  if (view === 'camera') return 'scan';
  return view === 'printings' ? 'cube' : view;
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

/** The account chip in the header: a small menu with Log, About and Sign in as Owner or Sign out. */
function AccountChip() {
  const { auth, connection, signInAsOwner, signOut } = useStore();
  const view = useRoute().view;
  const onAbout = view === 'about';
  const onLog = view === 'log';
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onHash = () => setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onHash);
    };
  }, [open]);
  const label = auth.isOwner ? 'Owner' : auth.provider === 'google' ? 'Signed in' : 'Account';
  return (
    <div className="account-wrap" ref={box}>
      <button ref={button} type="button" className={onAbout || onLog ? 'account current' : 'account'} aria-expanded={open} aria-controls="account-menu" onClick={() => setOpen((o) => !o)}>
        {label}
      </button>
      {open && (
        <div className="account-menu" id="account-menu">
          <a href="#/log" aria-current={onLog ? 'page' : undefined} onClick={() => setOpen(false)}>
            Log
          </a>
          <a href="#/about" aria-current={onAbout ? 'page' : undefined} onClick={() => setOpen(false)}>
            About
          </a>
          {connection === 'ready' && auth.provider === 'google' && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void signOut();
              }}
            >
              Sign out
            </button>
          )}
          {connection === 'ready' && auth.provider !== 'google' && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void signInAsOwner();
              }}
            >
              Sign in as Owner
            </button>
          )}
          {connection !== 'ready' && <p className="muted">{connection === 'connecting' ? 'Connecting…' : 'Sign-in is not available on this device.'}</p>}
        </div>
      )}
    </div>
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
