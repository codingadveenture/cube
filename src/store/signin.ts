// One sign-in attempt at a time. Calls while an attempt runs share it; once it has settled,
// failed or not, the next call starts a new attempt, so a failure is never kept for good.
export function singleFlight(attempt: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () => {
    running ??= attempt().finally(() => {
      running = null;
    });
    return running;
  };
}

/** Prefix of the error when the silent anonymous sign-in fails; cleared once a user arrives. */
export const ANON_SIGN_IN_FAILED = 'Could not sign in';
