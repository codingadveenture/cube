// Firebase app, Auth and Firestore for project cube-e647a. The web config is public client
// configuration; access is controlled by firestore.rules.
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, type Firestore } from 'firebase/firestore';
import { FirestoreStore } from './firestore';
import { ANON_SIGN_IN_FAILED, singleFlight } from './signin';
import type { Store } from './types';

export const firebaseConfig = {
  apiKey: 'AIzaSyAbsbNl39nl5GCOqc-vjcm3foMAvs2kDxo',
  authDomain: 'cube-e647a.firebaseapp.com',
  projectId: 'cube-e647a',
  storageBucket: 'cube-e647a.firebasestorage.app',
  messagingSenderId: '109415744309',
  appId: '1:109415744309:web:bea556694ad06f6f10827c',
};

export interface AuthUser {
  uid: string;
  provider: 'anonymous' | 'google' | 'other';
  displayName: string | null;
}

export interface Backend {
  store: Store;
  watchUser(next: (u: AuthUser | null) => void): () => void;
  /** Sign in anonymously when nobody is signed in. Resolves once a user exists or it failed. */
  ensureSignedIn(): Promise<void>;
  signInAsOwner(): Promise<void>;
  /** Sign out of Google and continue anonymously. */
  signOutToAnonymous(): Promise<void>;
}

function toAuthUser(u: User): AuthUser {
  const providers = u.providerData.map((p) => p.providerId);
  const provider = u.isAnonymous ? 'anonymous' : providers.includes('google.com') ? 'google' : 'other';
  return { uid: u.uid, provider, displayName: u.displayName };
}

/** Popup first (it works on Android Chrome and desktop); redirect when the popup is blocked. */
async function googleSignIn(auth: Auth): Promise<void> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw e;
  }
}

export function createBackend(): Backend {
  const app: FirebaseApp = initializeApp(firebaseConfig);
  const db: Firestore = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  const auth = getAuth(app);
  // Surfaces errors from a redirect sign-in; the user itself arrives through onAuthStateChanged.
  const redirectError = getRedirectResult(auth).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  );

  let redirectReported = false;
  // One attempt at a time; a failed attempt is not kept, so the next call tries again.
  const ensure = singleFlight(async () => {
    await auth.authStateReady();
    const err = await redirectError;
    if (!auth.currentUser) {
      try {
        await signInAnonymously(auth);
      } catch (e) {
        throw new Error(`${ANON_SIGN_IN_FAILED}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (err && !redirectReported) {
      redirectReported = true;
      throw new Error(`Google sign-in did not complete: ${err.message}`);
    }
  });
  // Retry when nobody is signed in: once when the user becomes null (after a sign-out or a
  // failed start) and once per return of the connection. Neither can loop: a failed attempt
  // changes no auth state, and 'online' fires only on a transition.
  const retry = () => {
    if (!auth.currentUser) ensure().catch(() => undefined);
  };
  onAuthStateChanged(auth, (u) => {
    if (!u) retry();
  });
  if (typeof window !== 'undefined') window.addEventListener('online', retry);

  return {
    store: new FirestoreStore(db, () => auth.currentUser?.uid ?? null),
    watchUser(next) {
      return onAuthStateChanged(auth, (u) => next(u ? toAuthUser(u) : null));
    },
    ensureSignedIn: ensure,
    signInAsOwner: () => googleSignIn(auth),
    async signOutToAnonymous() {
      await signOut(auth);
      await ensure();
    },
  };
}
