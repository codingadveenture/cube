// React context for the Store and the sign-in state. Firebase is loaded lazily, so the Cube view
// renders from cards.json at once; when Firebase cannot start, the app stays local-only and says so.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AuthUser, Backend } from './firebase';
import { isOwnerUid, nextOwnerState, type OwnerState } from './owner';
import { ANON_SIGN_IN_FAILED } from './signin';
import {
  EMPTY_CYCLE_ACKS,
  EMPTY_OVERRIDES,
  type CycleAcks,
  type CardState,
  type LogEntry,
  type OnError,
  type Overrides,
  type OwnerConfig,
  type SharedPile,
  type Snapshot,
  type Store,
  type Suggestion,
  type Unsubscribe,
} from './types';

export const OFFLINE_SAVED = 'Saved on this device, syncs when online.';

export interface AuthState {
  uid: string | null;
  provider: AuthUser['provider'] | null;
  displayName: string | null;
  isOwner: boolean;
  /** config/owner, once read; null when it does not exist. */
  owner: OwnerConfig | null;
  ownerLoaded: boolean;
  /** Why signing in failed, shown on About only. */
  error: string | null;
}

export type Connection = 'connecting' | 'ready' | 'unavailable';

export interface Notice {
  text: string;
  error: boolean;
}

interface StoreContextValue {
  store: Store | null;
  connection: Connection;
  unavailableReason: string | null;
  online: boolean;
  auth: AuthState;
  signInAsOwner(): Promise<void>;
  signOut(): Promise<void>;
  /** Run a write and report it: done, saved on this device (offline), or the error. */
  save(write: () => Promise<unknown>, doneText: string): Promise<boolean>;
  notice: Notice | null;
  clearNotice(): void;
}

const NO_AUTH: AuthState = {
  uid: null,
  provider: null,
  displayName: null,
  isOwner: false,
  owner: null,
  ownerLoaded: false,
  error: null,
};

const StoreContext = createContext<StoreContextValue | null>(null);

export function errorText(e: unknown): string {
  const code = (e as { code?: string } | null)?.code ?? '';
  if (code === 'permission-denied' || code === 'firestore/permission-denied') {
    return 'Not allowed. Only the Owner can do that, or the Firestore rules are not published yet.';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Sign-in was cancelled.';
  if (code === 'auth/unauthorized-domain') return 'This site is not an authorized domain for sign-in.';
  return e instanceof Error ? e.message : String(e);
}

const sleep = (ms: number) => new Promise<'slow'>((r) => setTimeout(() => r('slow'), ms));

let backendPromise: Promise<Backend> | null = null;
function loadBackend(): Promise<Backend> {
  backendPromise ??= import('./firebase').then((m) => m.createBackend());
  return backendPromise;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [backend, setBackend] = useState<Backend | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [owner, setOwner] = useState<OwnerState>({ loaded: false, config: null });
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    loadBackend().then(
      (b) => {
        if (!alive) return;
        setBackend(b);
        setConnection('ready');
      },
      (e: unknown) => {
        if (!alive) return;
        setConnection('unavailable');
        setUnavailableReason(errorText(e));
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!backend) return;
    const stopUser = backend.watchUser((u) => {
      setUser(u);
      // A retried anonymous sign-in worked: drop the old failure text.
      if (u) setAuthError((e) => (e?.startsWith(ANON_SIGN_IN_FAILED) ? null : e));
    });
    backend.ensureSignedIn().catch((e: unknown) => setAuthError(errorText(e)));
    const stopOwner = backend.store.subscribeOwner(
      (s) => setOwner((o) => nextOwnerState(o, s)),
      // An error leaves the Owner unknown: Claim Owner stays hidden.
      () => undefined,
    );
    return () => {
      stopUser();
      stopOwner();
    };
  }, [backend]);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const show = useCallback((text: string, error = false) => {
    window.clearTimeout(noticeTimer.current);
    setNotice({ text, error });
    if (!error) noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  }, []);

  const save = useCallback(
    async (write: () => Promise<unknown>, doneText: string) => {
      let p: Promise<unknown>;
      try {
        p = write();
      } catch (e) {
        show(errorText(e), true);
        return false;
      }
      const lateError = (e: unknown) => show(errorText(e), true);
      if (!navigator.onLine) {
        p.catch(lateError);
        show(OFFLINE_SAVED);
        return true;
      }
      const r = await Promise.race([p.then(() => 'ok' as const, (e: unknown) => ({ e })), sleep(5000)]);
      if (r === 'ok') {
        show(doneText);
        return true;
      }
      if (r === 'slow') {
        p.then(() => show(doneText), lateError);
        show(OFFLINE_SAVED);
        return true;
      }
      show(errorText(r.e), true);
      return false;
    },
    [show],
  );

  const signInAsOwner = useCallback(async () => {
    if (!backend) return;
    try {
      await backend.signInAsOwner();
      setAuthError(null);
    } catch (e) {
      const text = errorText(e);
      setAuthError(text);
      show(text, true);
    }
  }, [backend, show]);

  const signOut = useCallback(async () => {
    if (!backend) return;
    try {
      await backend.signOutToAnonymous();
    } catch (e) {
      setAuthError(errorText(e));
    }
  }, [backend]);

  const auth: AuthState = useMemo(
    () =>
      user
        ? {
            uid: user.uid,
            provider: user.provider,
            displayName: user.displayName,
            isOwner: user.provider === 'google' && isOwnerUid(user.uid, owner.config),
            owner: owner.config,
            ownerLoaded: owner.loaded,
            error: authError,
          }
        : { ...NO_AUTH, owner: owner.config, ownerLoaded: owner.loaded, error: authError },
    [user, owner, authError],
  );

  const value = useMemo<StoreContextValue>(
    () => ({
      store: backend?.store ?? null,
      connection,
      unavailableReason,
      online,
      auth,
      signInAsOwner,
      signOut,
      save,
      notice,
      clearNotice: () => setNotice(null),
    }),
    [backend, connection, unavailableReason, online, auth, signInAsOwner, signOut, save, notice],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreContextValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore outside StoreProvider');
  return v;
}

export interface Live<T> {
  status: 'loading' | 'ready' | 'error' | 'unavailable';
  data: T;
  fromCache: boolean;
  pending: boolean;
  error: string | null;
}

type Subscribe<T> = (store: Store, next: (s: Snapshot<T>) => void, error: OnError) => Unsubscribe;

function useLive<T>(subscribe: Subscribe<T>, initial: T): Live<T> {
  const { store, connection } = useStore();
  const [state, setState] = useState<Live<T>>({ status: 'loading', data: initial, fromCache: false, pending: false, error: null });
  useEffect(() => {
    if (!store) return;
    return subscribe(
      store,
      (s) => setState({ status: 'ready', data: s.data, fromCache: s.fromCache, pending: s.hasPendingWrites, error: null }),
      (e) => setState((old) => ({ ...old, status: 'error', error: errorText(e) })),
    );
  }, [store, subscribe]);
  if (connection === 'unavailable') return { ...state, status: 'unavailable' };
  return state;
}

const EMPTY_CARDS = new Map<string, CardState>();
const NONE: never[] = [];

const subCards: Subscribe<Map<string, CardState>> = (s, n, e) => s.subscribeCards(n, e);
const subSuggestions: Subscribe<Suggestion[]> = (s, n, e) => s.subscribeSuggestions(n, e);
const subScans: Subscribe<SharedPile[]> = (s, n, e) => s.subscribeScans(n, e);
const subLog: Subscribe<LogEntry[]> = (s, n, e) => s.subscribeLog(n, e);
const subOverrides: Subscribe<Overrides> = (s, n, e) => s.subscribeOverrides(n, e);
const subCycleAcks: Subscribe<CycleAcks> = (s, n, e) => s.subscribeCycleAcks(n, e);
const subPrintMeta: Subscribe<Record<string, unknown> | null> = (s, n, e) => s.subscribeMetaDoc('print', n, e);
const subUpstreamMeta: Subscribe<Record<string, unknown> | null> = (s, n, e) => s.subscribeMetaDoc('upstream', n, e);
const subUpdatesMeta: Subscribe<Record<string, unknown> | null> = (s, n, e) => s.subscribeMetaDoc('updates', n, e);

export const useCardStates = () => useLive(subCards, EMPTY_CARDS);
export const useSuggestions = () => useLive<Suggestion[]>(subSuggestions, NONE);
export const useScans = () => useLive<SharedPile[]>(subScans, NONE);
export const useLog = () => useLive<LogEntry[]>(subLog, NONE);
export const useOverrides = () => useLive(subOverrides, EMPTY_OVERRIDES);
export const useCycleAcks = () => useLive(subCycleAcks, EMPTY_CYCLE_ACKS);
/** cubes/main/meta/print as stored: print settings, printer profiles and the print history. */
export const usePrintMetaDoc = () => useLive<Record<string, unknown> | null>(subPrintMeta, null);
/** cubes/main/meta/upstream as stored: the last List and Upstream fetch, and the feed decisions. */
export const useUpstreamMetaDoc = () => useLive<Record<string, unknown> | null>(subUpstreamMeta, null);
/** cubes/main/meta/updates as stored: the history of applied Updates. */
export const useUpdatesMetaDoc = () => useLive<Record<string, unknown> | null>(subUpdatesMeta, null);
