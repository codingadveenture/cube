// #/print: the Print batch, Tokens and the Print sheet (settings, calibration, PDF, lists, Mark as printed).
// Loaded on demand; jsPDF is loaded only when a PDF is generated.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '../../types';
import { usePrintMetaDoc, useStore } from '../../store/context';
import { localDateIso } from '../../printings/defaultRule';
import { smallImage } from '../../printings/images';
import {
  composeSlips,
  markPrintedPatches,
  printHistoryEntry,
  mtgprintList,
  proxyGeneratorList,
  newCardLines,
  reprintLines,
  type BatchLine,
  type Slip,
  type TokenLine,
} from '../../print/batch';
import { calibrate } from '../../print/calibration';
import { mergeExtras, resolveExtras, toExtras } from '../../print/extras';
import { plainError } from '../../print/errors';
import { MIN_MARGIN, fits, sheetMargins, slipPages } from '../../print/layout';
import {
  EXTRAS_KEY,
  LOCAL_PROFILES_KEY,
  LOCAL_SETTINGS_KEY,
  TOKENS_KEY,
  RANGES,
  UNCHECKED_KEY,
  effectiveSettings,
  historyLine,
  historyTrim,
  mergeSettings,
  parseSetting,
  readLocal,
  sameSettings,
  toPrintMeta,
  toProfile,
  writeLocal,
  type PrinterProfile,
  type PrintSettings,
} from '../../print/settings';
import { RECOMMENDATION_LABEL, loadTokens, printableTokens, type TokenType } from '../../print/tokens';
import { CopyButton, LiveStatus } from '../common';

function usePersisted<T>(key: string, initial: () => T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  return [
    value,
    (v: T) => {
      setValue(v);
      writeLocal(key, v);
    },
  ];
}

function toTokenLines(v: unknown): TokenLine[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (t): t is TokenLine =>
      !!t && typeof t === 'object' && typeof (t as TokenLine).key === 'string' && typeof (t as TokenLine).image_png === 'string' && typeof (t as TokenLine).count === 'number',
  );
}

function toProfiles(v: unknown): Record<string, PrinterProfile> {
  const out: Record<string, PrinterProfile> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [name, p] of Object.entries(v as Record<string, unknown>)) {
      const prof = toProfile(p, name);
      if (prof) out[name] = { ...prof, name };
    }
  }
  return out;
}

/** The thumbnail for a token's png. */
function tokenThumb(png: string): string {
  return png.replace('/png/', '/small/').replace(/\.png(?=$|\?)/, '.jpg');
}

/** Why the block does not fit on A4, in plain words. */
function tooBigText(s: PrintSettings): string {
  const m = sheetMargins(s);
  const side = Math.min(m.x, m.y);
  return `The 3 x 3 block of slips does not fit on A4: it leaves ${Math.max(0, side).toFixed(1)} mm of margin, and every side needs at least ${MIN_MARGIN} mm or the printer cuts off the outer slips. Make the slips, the gap or the factors smaller.`;
}

interface Generated {
  slips: number;
  pages: number;
  fileName: string;
  url: string;
  failed: { name: string; url: string }[];
  /** The batch lines and tokens that went into the file, for Mark as printed. */
  lines: BatchLine[];
  tokens: TokenLine[];
}

type GenState =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number; current: string | null; what: string }
  | { status: 'error'; message: string };

export default function PrintView({ cards, section }: { cards: Card[]; section: string | null }) {
  const { auth, store, save } = useStore();
  const isOwner = auth.isOwner;
  const metaLive = usePrintMetaDoc();
  const meta = useMemo(() => toPrintMeta(metaLive.data), [metaLive.data]);

  // Batch.
  // New cards (on the List, not printed yet) first, then reprints.
  const reprints = useMemo(() => [...newCardLines(cards), ...reprintLines(cards)], [cards]);
  const [unchecked, setUnchecked] = usePersisted<string[]>(UNCHECKED_KEY, () => {
    const v = readLocal<unknown>(UNCHECKED_KEY, []);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  });
  const [extras, setExtras] = usePersisted<BatchLine[]>(EXTRAS_KEY, () => toExtras(readLocal<unknown>(EXTRAS_KEY, [])));
  const [tokenBatch, setTokenBatch] = usePersisted<TokenLine[]>(TOKENS_KEY, () => toTokenLines(readLocal<unknown>(TOKENS_KEY, [])));
  const skip = useMemo(() => new Set(unchecked), [unchecked]);
  const checkedLines = useMemo(() => [...reprints, ...extras].filter((l) => !skip.has(l.key)), [reprints, extras, skip]);

  // Settings: the Owner edits the shared ones (and saves them); visitors keep theirs on this device.
  const [localSettings, setLocalSettings] = useState<unknown>(() => readLocal<unknown>(LOCAL_SETTINGS_KEY, null));
  const [ownerDraft, setOwnerDraft] = useState<PrintSettings | null>(null);
  const shared = useMemo(() => mergeSettings(meta.settings), [meta.settings]);
  const settings = isOwner ? (ownerDraft ?? shared) : effectiveSettings(meta.settings, localSettings, false);
  const [localProfiles, setLocalProfiles] = usePersisted<Record<string, PrinterProfile>>(LOCAL_PROFILES_KEY, () =>
    toProfiles(readLocal<unknown>(LOCAL_PROFILES_KEY, {})),
  );
  const profiles = isOwner ? meta.profiles : { ...meta.profiles, ...localProfiles };

  function setSettings(next: PrintSettings) {
    if (isOwner) setOwnerDraft(next);
    else {
      setLocalSettings(next);
      writeLocal(LOCAL_SETTINGS_KEY, next);
    }
  }

  const slips = useMemo(() => composeSlips(checkedLines, tokenBatch, settings.quality), [checkedLines, tokenBatch, settings.quality]);
  const pageCount = useMemo(() => slipPages(slips).length, [slips]);

  const [gen, setGen] = useState<GenState>({ status: 'idle' });
  const [generated, setGenerated] = useState<Generated | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => () => (generated ? URL.revokeObjectURL(generated.url) : undefined), [generated]);

  useEffect(() => {
    if (section === 'tokens') document.getElementById('tokens')?.scrollIntoView();
  }, [section]);

  async function makePdf(testOnly: boolean) {
    const date = localDateIso();
    const these: Slip[] = testOnly ? [] : slips;
    const ctl = new AbortController();
    abort.current = ctl;
    setGen({ status: 'running', done: 0, total: 0, current: null, what: testOnly ? 'test page' : 'print sheet' });
    try {
      const { buildPrintPdf, pdfFileName } = await import('../../print/pdf');
      const result = await buildPrintPdf({
        slips: these,
        settings,
        date,
        signal: ctl.signal,
        onProgress: (p) => setGen((g) => (g.status === 'running' ? { ...g, ...p } : g)),
      });
      const fileName = testOnly ? `cube-test-page-${date}.pdf` : pdfFileName(date);
      const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setGenerated({
        slips: these.length,
        pages: result.pages,
        fileName,
        url,
        failed: result.failed,
        lines: testOnly ? [] : checkedLines,
        tokens: testOnly ? [] : tokenBatch,
      });
      setGen({ status: 'idle' });
    } catch (e) {
      if (ctl.signal.aborted) setGen({ status: 'idle' });
      else {
        console.error('Print sheet:', e);
        setGen({ status: 'error', message: plainError(e, 'pdf') });
      }
    }
  }

  async function markPrinted(g: Generated) {
    if (!store) return;
    // In-box comes from the lines that went on the sheet, not the cards' current Wanted.
    const patches = markPrintedPatches(cards, g.lines);
    // A batch of only extras or tokens changes no In-box Printing but is still recorded.
    const entry = printHistoryEntry(g.lines, g.tokens, patches, { date: localDateIso(), at: new Date().toISOString(), printer: settings.profile.name });
    // The entry is appended with arrayUnion, so a stale or empty snapshot never replaces the
    // stored history; old entries are trimmed only from what the server last said.
    const trim = metaLive.status === 'ready' && !metaLive.fromCache ? historyTrim(metaLive.data?.history) : [];
    // One atomic batch: the In-box patches and the history entry land together or not at all.
    const ok = await save(
      () => store.markPrinted(patches, entry ? { ...entry } : null, trim),
      patches.length > 0 ? `Marked ${patches.length} ${patches.length === 1 ? 'card' : 'cards'} as printed.` : 'Print recorded in the history.',
    );
    if (!ok) return;
    const done = new Set(g.lines.map((l) => l.key));
    setExtras(extras.filter((x) => !done.has(x.key)));
    const doneTokens = new Set(g.tokens.map((t) => t.key));
    setTokenBatch(tokenBatch.filter((t) => !doneTokens.has(t.key)));
    setUnchecked(unchecked.filter((k) => !done.has(k)));
    setGenerated(null);
  }

  const backLines = checkedLines.filter((l) => l.back_image_normal);
  const running = gen.status === 'running';
  const sheetFits = fits(settings);

  return (
    <div className="print">
      <h1>Print</h1>
      <p className="muted">
        Build a Print batch, add tokens, then generate one PDF that prints every slip at the right size. Page 1 is always the test page.
      </p>
      <LiveStatus live={metaLive} what="print settings" />

      <section aria-labelledby="batch-head">
        <h2 id="batch-head">Print batch</h2>
        <p className="muted">
          Every new card from an Update (to print) and every card whose Wanted Printing differs from its In-box Printing is here, ticked. Back
          faces of double-faced cards go to the Back pool automatically.
        </p>
        <h3 className="batch-group">
          Fronts: {checkedLines.length} of {reprints.length + extras.length} ticked
        </h3>
        {reprints.length + extras.length === 0 && <p className="status">No new cards or reprints pending. Add more below.</p>}
        <ul className="batch-list">
          {[...reprints, ...extras].map((l) => (
            <li key={l.key}>
              <label>
                <input
                  type="checkbox"
                  checked={!skip.has(l.key)}
                  onChange={(e) => setUnchecked(e.target.checked ? unchecked.filter((k) => k !== l.key) : [...unchecked, l.key])}
                />
                <img src={smallImage(l.image_normal)} alt="" loading="lazy" decoding="async" width={48} height={67} />
                <span className="line-main">
                  <span>
                    {l.quantity > 1 ? `${l.quantity} x ` : ''}
                    {l.name}
                  </span>
                  <span className="num">
                    {l.set.toUpperCase()} {l.collector_number}
                    {l.source === 'extra' ? ' · extra' : l.source === 'new' ? ' · new card' : ''}
                    {l.back_image_normal ? ' · double-faced' : ''}
                  </span>
                </span>
              </label>
              {l.source === 'extra' && (
                <button type="button" onClick={() => setExtras(extras.filter((x) => x.key !== l.key))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        {backLines.length > 0 && (
          <>
            <h3 className="batch-group">Back pool: {backLines.reduce((n, l) => n + l.quantity, 0)} slips</h3>
            <ul className="batch-list">
              {backLines.map((l) => (
                <li key={l.key}>
                  <img src={smallImage(l.back_image_normal!)} alt="" loading="lazy" decoding="async" width={48} height={67} />
                  <span className="line-main">
                    <span>{l.back_name ?? `${l.name} (back)`}</span>
                    <span className="num">back of {l.name}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {tokenBatch.length > 0 && (
          <>
            <h3 className="batch-group">Tokens: {tokenBatch.reduce((n, t) => n + t.count, 0)} slips</h3>
            <ul className="batch-list">
              {tokenBatch.map((t) => (
                <li key={t.key}>
                  <img src={tokenThumb(t.image_png)} alt="" loading="lazy" decoding="async" width={48} height={67} />
                  <span className="line-main">
                    <span>
                      {t.count} x {t.name}
                    </span>
                  </span>
                  <button type="button" onClick={() => setTokenBatch(tokenBatch.filter((x) => x.key !== t.key))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="num">
          {slips.length} slips on {pageCount} {pageCount === 1 ? 'page' : 'pages'}, plus the test page.
        </p>
        <AddMore cards={cards} onAdd={(lines) => setExtras(mergeExtras(extras, lines))} />
        <h3>Lists for other print tools</h3>
        <div className="actions">
          <CopyButton text={mtgprintList(checkedLines)} label="Copy mtgprint list" />
        </div>
        <p className="muted list-note">
          For mtgprint.net: one line per front card, "1 Name (SET) number". mtgprint adds the back face of a double-faced card by itself, so back faces
          and tokens are left out.
        </p>
        <div className="actions">
          <CopyButton text={proxyGeneratorList(checkedLines)} label="Copy MTG Proxy Generator list" />
        </div>
        <p className="muted list-note">
          For MTG Proxy Generator: "1 SET/number -cd" fetches exactly that Printing from Scryfall. A double-faced card comes out as two cards, front
          and back, from its one line; tokens are left out.
        </p>
      </section>

      <TokensSection batch={tokenBatch} onChange={setTokenBatch} />

      <section aria-labelledby="sheet-head">
        <h2 id="sheet-head">Print sheet</h2>
        <SettingsForm settings={settings} profiles={profiles} onChange={setSettings} />
        {isOwner && ownerDraft && !sameSettings(ownerDraft, shared) && (
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={!store}
              onClick={async () => {
                if (store && (await save(() => store.setMeta('print', { settings: ownerDraft }), 'Print settings saved for everyone.'))) setOwnerDraft(null);
              }}
            >
              Save settings for everyone
            </button>
            <button type="button" onClick={() => setOwnerDraft(null)}>
              Undo changes
            </button>
          </div>
        )}
        {!isOwner && <p className="muted">Your settings are kept on this device. The Owner&rsquo;s settings are the starting point.</p>}

        <Calibration
          settings={settings}
          isOwner={isOwner}
          onSave={async (profile) => {
            if (isOwner && store) {
              // Only the factors: other unsaved changes in the draft stay unsaved.
              const ok = await save(
                () => store.setMeta('print', { profiles: { [profile.name]: profile }, settings: { ...shared, profile } }),
                `Factors saved for ${profile.name}.`,
              );
              if (ok) setOwnerDraft((d) => (d ? { ...d, profile } : null));
              return ok;
            }
            setLocalProfiles({ ...localProfiles, [profile.name]: profile });
            setSettings({ ...settings, profile });
            return true;
          }}
        />

        <h3>Generate</h3>
        <div className="actions">
          <button type="button" className="primary" disabled={running || slips.length === 0 || !sheetFits} onClick={() => void makePdf(false)}>
            Generate PDF
          </button>
          <button type="button" disabled={running} onClick={() => void makePdf(true)}>
            Print the test page
          </button>
          {running && (
            <button type="button" onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          )}
        </div>
        <p className="muted">
          {slips.length > 0 ? `${slips.length} slips, ${pageCount + 1} pages with the test page.` : 'Nothing in the batch yet; the test page can still be printed.'}
          {settings.quality === 'best' ? ' Best quality uses the png images: slower and a much larger file.' : ''}
        </p>
        {gen.status === 'running' && (
          <div role="status">
            <p>
              Building the {gen.what}
              {gen.total > 0 ? `: image ${Math.min(gen.done + 1, gen.total)} of ${gen.total}${gen.current ? ` (${gen.current})` : ''}` : '…'}
            </p>
            {gen.total > 0 && <progress max={gen.total} value={gen.done} />}
          </div>
        )}
        {!sheetFits && <p className="status error">{tooBigText(settings)}</p>}
        {gen.status === 'error' && <p className="status error">{gen.message}</p>}
        {generated && (
          <div className="panel" role="status">
            <p>
              Ready: <a href={generated.url} download={generated.fileName}>{generated.fileName}</a>, {generated.pages}{' '}
              {generated.pages === 1 ? 'page' : 'pages'}. Print it at 100 percent (Actual size).
            </p>
            {generated.failed.length > 0 && (
              <>
                <p className="status error">These images could not be fetched; their slots show the card name instead:</p>
                <ul className="failed-list">
                  {generated.failed.map((f) => (
                    <li key={f.url}>{f.name}</li>
                  ))}
                </ul>
              </>
            )}
            {(generated.lines.length > 0 || generated.tokens.length > 0) &&
              (isOwner ? (
                <div className="actions">
                  <button type="button" className="primary" disabled={!store} onClick={() => void markPrinted(generated)}>
                    Mark these as printed
                  </button>
                </div>
              ) : (
                <p className="muted">Once the slips are in the box, the Owner marks them as printed.</p>
              ))}
            {isOwner && generated.lines.length > 0 && (
              <p className="muted">
                Sets the In-box Printing to the Printing on this sheet for the {generated.lines.filter((l) => l.source === 'new').length} new cards and{' '}
                {generated.lines.filter((l) => l.source === 'reprint').length} reprints and removes the extras and tokens from the batch.
              </p>
            )}
          </div>
        )}
        {meta.history.length > 0 && (
          <details>
            <summary>Print history</summary>
            <ul>
              {[...meta.history].reverse().map((h, i) => (
                <li key={i}>
                  {historyLine(h)}
                  {h.names.length > 0 ? ` (${h.names.slice(0, 8).join(', ')}${h.names.length > 8 ? ', …' : ''})` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

function AddMore({ cards, onAdd }: { cards: Card[]; onAdd: (lines: BatchLine[]) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  return (
    <details>
      <summary>Add more</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setBusy(true);
          const r = await resolveExtras(text, cards);
          setBusy(false);
          onAdd(r.lines);
          setFailed(r.failed);
          setText(r.failed.length ? r.failed.map((f) => f.replace(/: .*$/, '')).join('\n') : '');
        }}
      >
        <label className="field">
          <span>One card per line: Name, 2 Name, or Name (SET) 123. A card in the Cube without a set gets its Wanted Printing.</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} spellCheck={false} />
        </label>
        <div className="actions">
          <button type="submit" disabled={busy || !text.trim()}>
            {busy ? 'Looking up…' : 'Add to batch'}
          </button>
        </div>
        {failed.length > 0 && (
          <ul className="failed-list">
            {failed.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </form>
    </details>
  );
}

function TokensSection({ batch, onChange }: { batch: TokenLine[]; onChange: (t: TokenLine[]) => void }) {
  const [tokens, setTokens] = useState<TokenType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    loadTokens().then(
      (f) => alive && setTokens(printableTokens(f)),
      (e: unknown) => {
        console.error('Tokens:', e);
        if (alive) setError(plainError(e, 'tokens'));
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt]);
  return (
    <section id="tokens" aria-labelledby="tokens-head">
      <h2 id="tokens-head">Tokens</h2>
      <p className="muted">Suggested counts cover 9 drafts out of 10. Tap a token for the reasoning.</p>
      {error && (
        <div className="actions">
          <p className="status error">{error}</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      {!tokens && !error && <p className="status">Loading tokens…</p>}
      {tokens && (
        <ul className="token-list">
          {tokens.map((t) => (
            <TokenRow key={t.key} token={t} inBatch={batch.find((b) => b.key === t.key) ?? null} onAdd={(line) => onChange([...batch.filter((b) => b.key !== line.key), line])} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TokenRow({ token, inBatch, onAdd }: { token: TokenType; inBatch: TokenLine | null; onAdd: (t: TokenLine) => void }) {
  const [count, setCount] = useState(String(inBatch?.count ?? token.suggested_count));
  const n = Number.parseInt(count, 10);
  const valid = Number.isFinite(n) && n >= 1 && n <= 200;
  const pt = token.power !== null && token.toughness !== null ? ` ${token.power}/${token.toughness}` : '';
  return (
    <li>
      <img src={tokenThumb(token.image_png)} alt="" loading="lazy" decoding="async" width={48} height={67} />
      <div className="token-body">
        <details>
          <summary>
            <span>
              {token.name}
              {pt} · suggested {token.suggested_count} · <span className={`rec rec-${token.recommendation}`}>{RECOMMENDATION_LABEL[token.recommendation]}</span>
            </span>
          </summary>
          <p>{token.rationale}</p>
          <p className="muted">
            {RECOMMENDATION_LABEL[token.recommendation]}: {token.recommendation_reason}
          </p>
        </details>
        <div className="token-controls">
          <label>
            <span className="visually-hidden">Copies of {token.name}</span>
            <input type="number" inputMode="numeric" min={1} max={200} value={count} onChange={(e) => setCount(e.target.value)} />
          </label>
          <button type="button" disabled={!valid} onClick={() => onAdd({ key: token.key, name: token.name, count: n, image_png: token.image_png })}>
            {inBatch ? (inBatch.count === n ? `In batch: ${n}` : 'Update batch') : 'Add to batch'}
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * A number setting typed as text (so a comma decimal reaches the parser). A value outside the
 * allowed range is not taken: the field goes back to the current value and says what is allowed.
 */
function NumberField({
  id,
  label,
  value,
  min,
  max,
  unit,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  const [hint, setHint] = useState<string | null>(null);
  const hintId = `${id}-hint`;
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        defaultValue={String(value)}
        key={value}
        aria-invalid={hint ? true : undefined}
        aria-describedby={hint ? hintId : undefined}
        onBlur={(e) => {
          const v = parseSetting(e.target.value, min, max);
          if (v === null) {
            if (e.target.value.trim() !== String(value)) setHint(`Allowed: ${min} to ${max}${unit}. Kept ${value}.`);
            e.target.value = String(value);
            return;
          }
          setHint(null);
          if (v === value) e.target.value = String(value);
          else onChange(v);
        }}
      />
      {hint && (
        <span className="field-hint" id={hintId} role="status">
          {hint}
        </span>
      )}
    </label>
  );
}

function SettingsForm({
  settings,
  profiles,
  onChange,
}: {
  settings: PrintSettings;
  profiles: Record<string, PrinterProfile>;
  onChange: (s: PrintSettings) => void;
}) {
  // Every change goes through mergeSettings, so an out-of-range number keeps the old value.
  const set = (patch: Partial<PrintSettings>) => onChange(mergeSettings({ ...settings, ...patch }, settings));
  const names = Object.keys(profiles).sort();
  return (
    <div>
      <h3>Settings</h3>
      <div className="settings-grid">
        <NumberField id="set-slipw" label="Slip width (mm)" value={settings.slipW} {...RANGES.slipW} unit=" mm" onChange={(v) => set({ slipW: v })} />
        <NumberField id="set-sliph" label="Slip height (mm)" value={settings.slipH} {...RANGES.slipH} unit=" mm" onChange={(v) => set({ slipH: v })} />
        <NumberField id="set-gap" label="Gap between slips (mm)" value={settings.gap} {...RANGES.gap} unit=" mm" onChange={(v) => set({ gap: v })} />
        <label className="field">
          <span>Image quality</span>
          <select value={settings.quality} onChange={(e) => set({ quality: e.target.value === 'best' ? 'best' : 'standard' })}>
            <option value="standard">Standard (large jpg, about 270 dpi)</option>
            <option value="best">Best (png, 300 dpi, slower)</option>
          </select>
        </label>
        <label className="check-field">
          <input type="checkbox" checked={settings.cropMarks} onChange={(e) => set({ cropMarks: e.target.checked })} />
          <span>Crop marks</span>
        </label>
      </div>
      <h3>Printer profile</h3>
      <div className="settings-grid">
        {names.length > 0 && (
          <label className="field">
            <span>Saved profiles</span>
            <select
              value={profiles[settings.profile.name] ? settings.profile.name : ''}
              onChange={(e) => {
                const p = profiles[e.target.value];
                if (p) set({ profile: { ...p } });
              }}
            >
              <option value="">Choose…</option>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Profile name</span>
          <input
            type="text"
            defaultValue={settings.profile.name}
            key={settings.profile.name}
            maxLength={60}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== settings.profile.name) set({ profile: { ...settings.profile, name } });
            }}
          />
        </label>
        <NumberField
          id="set-fx"
          label="fx (across)"
          value={settings.profile.fx}
          {...RANGES.factor}
          unit=""
          onChange={(v) => set({ profile: { ...settings.profile, fx: v } })}
        />
        <NumberField
          id="set-fy"
          label="fy (down)"
          value={settings.profile.fy}
          {...RANGES.factor}
          unit=""
          onChange={(v) => set({ profile: { ...settings.profile, fy: v } })}
        />
      </div>
      <p className="muted num">
        Slips are drawn at {(settings.slipW * settings.profile.fx).toFixed(2)} x {(settings.slipH * settings.profile.fy).toFixed(2)} mm.
      </p>
      {!fits(settings) && <p className="status error">{tooBigText(settings)}</p>}
    </div>
  );
}

function Calibration({
  settings,
  isOwner,
  onSave,
}: {
  settings: PrintSettings;
  isOwner: boolean;
  onSave: (p: PrinterProfile) => Promise<boolean>;
}) {
  const [mx, setMx] = useState('');
  const [my, setMy] = useState('');
  const [name, setName] = useState(settings.profile.name);
  const [kept, setKept] = useState<string | null>(null);
  const verdict = mx && my ? calibrate(mx, my) : null;

  async function keep(profile: PrinterProfile) {
    const ok = await onSave(profile);
    // The Owner gets a toast; a visitor's factors change nothing visible, so say it here.
    if (ok && !isOwner) {
      setKept(`Factors kept on this device for ${profile.name}.`);
      setMx('');
      setMy('');
    }
  }
  return (
    <div className="panel calibration">
      <h3>Calibration</h3>
      <p className="muted">
        Print the test page at 100 percent, measure the two lines in mm and enter the lengths. The factors make the next print come out at the
        target size.
      </p>
      <div className="settings-grid">
        <label className="field">
          <span>180 mm line measured (mm)</span>
          <input type="text" inputMode="decimal" value={mx} onChange={(e) => {
              setMx(e.target.value);
              setKept(null);
            }} />
        </label>
        <label className="field">
          <span>260 mm line measured (mm)</span>
          <input type="text" inputMode="decimal" value={my} onChange={(e) => {
              setMy(e.target.value);
              setKept(null);
            }} />
        </label>
      </div>
      {kept && (
        <p className="status" role="status">
          {kept}
        </p>
      )}
      {verdict && <p className={verdict.kind === 'ok' ? '' : 'status error'}>{verdict.message}</p>}
      {verdict?.kind === 'ok' && (
        <div className="inline-fields">
          <label className="field">
            <span>Printer name</span>
            <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="actions">
            <button type="button" className="primary" disabled={!name.trim()} onClick={() => void keep({ name: name.trim(), fx: verdict.fx, fy: verdict.fy })}>
              {isOwner ? 'Save factors for everyone' : 'Keep factors on this device'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
