// The Firestore implementation of the Store.
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDocsFromServer,
  onSnapshot,
  setDoc,
  updateDoc,
  writeBatch,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import { chunk, withoutExisting } from './baseline';
import { cardPatchWrite, listChangeWrite } from './writes';
import { ownerFromDoc } from './owner';
import {
  CUBE_ID,
  EMPTY_OVERRIDES,
  type AcceptPlan,
  type CardPatch,
  type CardState,
  type CubeDoc,
  type LogEntry,
  type ListChange,
  type LogEntryInput,
  type OnError,
  type Overrides,
  type SharedPile,
  type SharedPileInput,
  type Snapshot,
  type Store,
  type Suggestion,
  type SuggestionInput,
} from './types';

const now = () => new Date().toISOString();

function strOr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function toSuggestion(id: string, d: DocumentData): Suggestion {
  return {
    id,
    type: d.type,
    card_name: strOr(d.card_name),
    oracle_id: d.oracle_id ?? null,
    printing: d.printing ?? null,
    by: strOr(d.by),
    note: strOr(d.note),
    status: d.status ?? 'open',
    createdAt: strOr(d.createdAt),
    createdByUid: strOr(d.createdByUid),
    resolvedAt: d.resolvedAt ?? null,
    resolution_note: d.resolution_note ?? null,
  };
}

function toPile(id: string, d: DocumentData): SharedPile {
  const rows = Array.isArray(d.rows) ? d.rows : [];
  return {
    id,
    label: strOr(d.label, 'Shared pile'),
    by: strOr(d.by),
    rows,
    row_count: typeof d.row_count === 'number' ? d.row_count : rows.length,
    createdAt: strOr(d.createdAt),
    createdByUid: strOr(d.createdByUid),
  };
}

function toLog(id: string, d: DocumentData): LogEntry {
  return {
    id,
    type: d.type === 'ban' ? 'ban' : 'winner_pick',
    card_name: d.card_name ?? null,
    by: strOr(d.by),
    date: d.date ?? null,
    cut: d.cut ?? null,
    note: strOr(d.note),
    createdAt: strOr(d.createdAt),
  };
}

function toOverrides(d: DocumentData | undefined): Overrides {
  if (!d) return EMPTY_OVERRIDES;
  return {
    adds: Array.isArray(d.adds) ? d.adds : [],
    bans: Array.isArray(d.bans) ? d.bans : [],
    updatedAt: d.updatedAt ?? null,
  };
}

const META = { includeMetadataChanges: true } as const;

/** The data for a merge-set of one card: the changed fields only, flags through arrayUnion. */
function cardData(patch: CardPatch, t: string): DocumentData {
  const w = cardPatchWrite(patch, t);
  const data: DocumentData = { ...w.fields };
  if (w.unionFlags) data.flags = arrayUnion(...w.unionFlags);
  return data;
}

/** The data for a merge-set of the overrides: arrayUnion and arrayRemove, never whole lists. */
function listData(change: ListChange, t: string): DocumentData {
  const w = listChangeWrite(change);
  return { [w.union.field]: arrayUnion(...w.union.values), [w.remove.field]: arrayRemove(...w.remove.values), updatedAt: t };
}

export class FirestoreStore implements Store {
  private readonly db: Firestore;
  private readonly uid: () => string | null;

  constructor(db: Firestore, uid: () => string | null) {
    this.db = db;
    this.uid = uid;
  }

  private col(name: 'cards' | 'suggestions' | 'scans' | 'log') {
    return collection(this.db, 'cubes', CUBE_ID, name);
  }
  private cubeRef() {
    return doc(this.db, 'cubes', CUBE_ID);
  }
  private overridesRef() {
    // A document needs an even path, so the overrides live at cubes/main/meta/overrides.
    return doc(this.db, 'cubes', CUBE_ID, 'meta', 'overrides');
  }
  private ownerRef() {
    return doc(this.db, 'config', 'owner');
  }
  private requireUid(): string {
    const uid = this.uid();
    if (!uid) throw new Error('Not signed in yet. Try again in a moment.');
    return uid;
  }

  private watchCollection<T>(
    name: 'cards' | 'suggestions' | 'scans' | 'log',
    map: (docs: { id: string; data: DocumentData }[]) => T,
    next: (s: Snapshot<T>) => void,
    error: OnError,
  ) {
    return onSnapshot(
      this.col(name),
      META,
      (snap) =>
        next({
          data: map(snap.docs.map((d) => ({ id: d.id, data: d.data() }))),
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites,
        }),
      error,
    );
  }

  subscribeCards(next: (s: Snapshot<Map<string, CardState>>) => void, error: OnError) {
    return this.watchCollection('cards', (docs) => new Map(docs.map((d) => [d.id, d.data as CardState])), next, error);
  }
  subscribeSuggestions(next: (s: Snapshot<Suggestion[]>) => void, error: OnError) {
    return this.watchCollection('suggestions', (docs) => docs.map((d) => toSuggestion(d.id, d.data)), next, error);
  }
  subscribeScans(next: (s: Snapshot<SharedPile[]>) => void, error: OnError) {
    return this.watchCollection(
      'scans',
      (docs) => docs.map((d) => toPile(d.id, d.data)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      next,
      error,
    );
  }
  subscribeLog(next: (s: Snapshot<LogEntry[]>) => void, error: OnError) {
    return this.watchCollection('log', (docs) => docs.map((d) => toLog(d.id, d.data)), next, error);
  }
  subscribeOverrides(next: (s: Snapshot<Overrides>) => void, error: OnError) {
    return onSnapshot(
      this.overridesRef(),
      META,
      (snap) =>
        next({ data: toOverrides(snap.data()), fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites }),
      error,
    );
  }
  subscribeOwner(next: (s: Snapshot<ReturnType<typeof ownerFromDoc>>) => void, error: OnError) {
    return onSnapshot(
      this.ownerRef(),
      META,
      (snap) =>
        next({ data: ownerFromDoc(snap.data()), fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites }),
      error,
    );
  }

  async importBaseline(all: [string, CardState][]): Promise<number> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new Error('Import baseline needs a connection to the server. Try again when online.');
    }
    // Which docs exist is asked of the server, never the local cache, so nothing stored is replaced.
    const onServer = await getDocsFromServer(this.col('cards'));
    const docs = withoutExisting(all, new Set(onServer.docs.map((d) => d.id)));
    const t = now();
    const cube: CubeDoc = {
      name: 'Vintage Cube',
      cubecobraId: 'MTGVintageCube',
      upstreamId: 'modovintage',
      baselineImportedAt: t,
      updatedAt: t,
    };
    const chunks = chunk(docs);
    if (chunks.length === 0) chunks.push([]);
    const commits: Promise<void>[] = [];
    chunks.forEach((part, i) => {
      const batch = writeBatch(this.db);
      for (const [id, state] of part) batch.set(doc(this.col('cards'), id), state);
      if (i === chunks.length - 1) batch.set(this.cubeRef(), cube, { merge: true });
      commits.push(batch.commit());
    });
    await Promise.all(commits);
    return docs.length;
  }

  updateCard(oracleId: string, patch: CardPatch): Promise<void> {
    return setDoc(doc(this.col('cards'), oracleId), cardData(patch, now()), { merge: true });
  }

  async createSuggestion(input: SuggestionInput): Promise<void> {
    const uid = this.requireUid();
    await addDoc(this.col('suggestions'), {
      type: input.type,
      card_name: input.card_name.trim(),
      oracle_id: input.oracle_id,
      printing: input.printing,
      by: input.by.trim(),
      note: input.note.trim(),
      status: 'open',
      createdAt: now(),
      createdByUid: uid,
      resolvedAt: null,
      resolution_note: null,
    });
  }

  resolveSuggestion(id: string, status: 'accepted' | 'rejected', note: string | null, plan: AcceptPlan | null): Promise<void> {
    const t = now();
    const batch = writeBatch(this.db);
    batch.update(doc(this.col('suggestions'), id), { status, resolvedAt: t, resolution_note: note || null });
    if (status === 'accepted' && plan) {
      if (plan.card) batch.set(doc(this.col('cards'), plan.card.oracle_id), cardData(plan.card.patch, t), { merge: true });
      if (plan.list) batch.set(this.overridesRef(), listData(plan.list, t), { merge: true });
      if (plan.log) batch.set(doc(this.col('log')), { ...plan.log, createdAt: t });
    }
    return batch.commit();
  }

  createScanPile(input: SharedPileInput): { id: string; written: Promise<void> } {
    const uid = this.requireUid();
    const ref = doc(this.col('scans'));
    const written = setDoc(ref, {
      label: input.label,
      by: input.by.trim(),
      rows: input.rows,
      row_count: input.rows.length,
      createdAt: now(),
      createdByUid: uid,
    });
    return { id: ref.id, written };
  }

  deleteScanPile(id: string): Promise<void> {
    return deleteDoc(doc(this.col('scans'), id));
  }

  async addLogEntry(entry: LogEntryInput): Promise<void> {
    await addDoc(this.col('log'), { ...entry, createdAt: now() });
  }

  async addLogEntries(entries: LogEntryInput[]): Promise<void> {
    const t = now();
    await Promise.all(
      chunk(entries).map((part) => {
        const batch = writeBatch(this.db);
        for (const e of part) batch.set(doc(this.col('log')), { ...e, createdAt: t });
        return batch.commit();
      }),
    );
  }

  updateLogEntry(id: string, entry: LogEntryInput): Promise<void> {
    return updateDoc(doc(this.col('log'), id), { ...entry });
  }

  setOverrides(o: Overrides): Promise<void> {
    return setDoc(this.overridesRef(), { adds: o.adds, bans: o.bans, updatedAt: now() });
  }

  claimOwner(): Promise<void> {
    return setDoc(this.ownerRef(), { uid: this.requireUid() });
  }
}
