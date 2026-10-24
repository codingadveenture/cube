// Plain sentences for the errors the Print view can meet. The raw error goes to the console only.

export type ErrorContext = 'pdf' | 'tokens' | 'scryfall';

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A stale lazy chunk after a deploy: the browser asks for a file that no longer exists. */
function isStaleChunk(m: string): boolean {
  return /dynamically imported module|importing a module script failed|module script|chunkloaderror|loading chunk/i.test(m);
}

/** A request that never got an answer: offline, DNS, CORS, a dropped connection. */
function isNetwork(e: unknown, m: string): boolean {
  return /failed to fetch|networkerror|load failed|network request failed/i.test(m) || (e instanceof TypeError && /fetch/i.test(m));
}

/** One plain sentence for an error, for the person using the Print view. */
export function plainError(e: unknown, context: ErrorContext): string {
  const m = messageOf(e);
  if (isStaleChunk(m)) return 'The app was updated; reload the page.';
  if (isNetwork(e, m)) {
    if (context === 'scryfall') return 'Could not reach Scryfall; check the connection and try again.';
    if (context === 'tokens') return 'Could not load the tokens; check the connection and try again.';
    return 'Could not fetch what the PDF needs; check the connection and try again.';
  }
  if (/\b429\b/.test(m)) return 'Scryfall is busy; wait a minute and try again.';
  if (/HTTP 404\b/.test(m)) return 'The app was updated; reload the page.';
  if (context === 'scryfall' && /Scryfall answered/.test(m)) return 'Scryfall did not answer properly; try again later.';
  if (context === 'tokens') return 'Could not load the tokens; try again.';
  if (context === 'scryfall') return 'The lookup failed; try again.';
  return 'Could not build the PDF; try again, or reload the page.';
}
