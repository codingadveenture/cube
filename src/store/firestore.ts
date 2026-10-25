// The Firestore implementation of the Store.
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  runTransaction,
  setDoc,
  updateDoc,
  writeBatch,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import { baselineCubeDoc, chunk, shouldStampBaseline, withoutExisting } from './baseline';
import { cardBatches, cardPatchWrite, listChangeWrite, markPrintedWrites, type CardWrite } from './writes';
import { ownerFromDoc } from './owner';
import { MAX_PILE_ROWS, scanPileDoc } from './piles';
import { applyShotDecision, chunkId, countToReview, parseShotChunk, shotChunkDoc } from './shotChunks';
import { guardNewCards, updateBatches } from '../upstream/update';
import {
  CUBE_ID,
  EMPTY_CYCLE_ACKS,
  EMPTY_OVERRIDES,
  type AcceptPlan,
  type CardPatch,
  type CardPatchFor,
  type CycleAcks,
  type CardState,
  type LogEntry,
  type ListChange,
  type LogEntryInput,
  type OnError,
  type Overrides,
  type SharedPile,
  type SharedPileInput,
  type ShotChunk,
  type ShotDecisionInput,
  type Snapshot,
  type Store,
  type Suggestion,
  type SuggestionInput,
  type UpdateWrites,
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
    ...(typeof d.shot_count === 'number' ? { shot_count: d.shot_count } : {}),
    ...(typeof d.to_review === 'number' ? { to_review: d.to_review } : {}),
    ...(d.camera === true ? { camera: true } : {}),
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : null,
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

function toCycleAcks(d: DocumentData | undefined): CycleAcks {
  const ack = d?.ack;
  if (!ack || typeof ack !== 'object') return EMPTY_CYCLE_ACKS;
  return { ack: Object.fromEntries(Object.entries(ack as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> };
}

const META = { includeMetadataChanges: true } as const;

/** The data for a merge-set of one card: the changed fields only, flags through arrayUnion. */
function cardData(patch: CardPatch, t: string): DocumentData {
  return writeData(cardPatchWrite(patch, t));
}

function writeData(w: CardWrite): DocumentData {
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
  private metaRef(docId: string) {
    return doc(this.db, 'cubes', CUBE_ID, 'meta', docId);
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
    // Which docs exist, and whether cubes/main has baselineImportedAt, is asked of the server,
    // never the local cache, so nothing stored is replaced.
    const [onServer, cubeOnServer] = await Promise.all([getDocsFromServer(this.col('cards')), getDocFromServer(this.cubeRef())]);
    const docs = withoutExisting(all, new Set(onServer.docs.map((d) => d.id)));
    const cube = baselineCubeDoc(now(), shouldStampBaseline(onServer.size, cubeOnServer.data()));
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

  async updateCards(patches: CardPatchFor[]): Promise<void> {
    const t = now();
    await Promise.all(
      cardBatches(patches, t).map((part) => {
        const batch = writeBatch(this.db);
        for (const { oracle_id, write } of part) batch.set(doc(this.col('cards'), oracle_id), writeData(write), { merge: true });
        return batch.commit();
      }),
    );
  }

  subscribeCycleAcks(next: (s: Snapshot<CycleAcks>) => void, error: OnError) {
    return onSnapshot(
      this.metaRef('cycles'),
      META,
      (snap) =>
        next({ data: toCycleAcks(snap.data()), fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites }),
      error,
    );
  }

  subscribeMetaDoc(docId: string, next: (s: Snapshot<Record<string, unknown> | null>) => void, error: OnError) {
    return onSnapshot(
      this.metaRef(docId),
      META,
      (snap) =>
        next({ data: (snap.data() as Record<string, unknown> | undefined) ?? null, fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites }),
      error,
    );
  }

  markPrinted(patches: CardPatchFor[], entry: Record<string, unknown> | null, trim: unknown[]): Promise<void> {
    const t = now();
    const batch = writeBatch(this.db);
    for (const { oracle_id, write } of markPrintedWrites(patches, t)) batch.set(doc(this.col('cards'), oracle_id), writeData(write), { merge: true });
    if (entry) {
      // Two writes to one doc: Firestore allows one transform per field per write.
      if (trim.length) batch.set(this.metaRef('print'), { history: arrayRemove(...trim) }, { merge: true });
      batch.set(this.metaRef('print'), { history: arrayUnion(entry), updatedAt: t }, { merge: true });
    }
    return batch.commit();
  }

  setMeta(docId: string, data: Record<string, unknown>): Promise<void> {
    return setDoc(this.metaRef(docId), { ...data, updatedAt: now() }, { merge: true });
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
    // Optional camera fields are only written when set, so a pile from a file looks as it always did.
    const data = scanPileDoc(input, uid, now());
    const written = setDoc(ref, data);
    return { id: ref.id, written };
  }

  private shotsCol(pileId: string) {
    return collection(this.db, 'cubes', CUBE_ID, 'scans', pileId, 'shots');
  }

  async deleteScanPile(id: string): Promise<void> {
    // A subcollection outlives its parent, so the shot chunks are deleted with it. The cache
    // answers offline; a pile without photos has none.
    const chunks = await getDocs(this.shotsCol(id)).catch(() => null);
    if (!chunks || chunks.empty) return deleteDoc(doc(this.col('scans'), id));
    const batch = writeBatch(this.db);
    for (const c of chunks.docs) batch.delete(c.ref);
    batch.delete(doc(this.col('scans'), id));
    return batch.commit();
  }

  async shotChunkIndexes(pileId: string): Promise<number[]> {
    const snap = await getDocsFromServer(this.shotsCol(pileId));
    return snap.docs.map((d) => parseShotChunk(d.id, d.data()).index);
  }

  writeShotChunk(pileId: string, chunk: Omit<ShotChunk, 'createdAt' | 'createdByUid'>): Promise<void> {
    const uid = this.requireUid();
    return setDoc(doc(this.shotsCol(pileId), chunkId(chunk.index)), shotChunkDoc(chunk, uid, now()));
  }

  subscribeShotChunks(pileId: string, next: (s: Snapshot<ShotChunk[]>) => void, error: OnError) {
    return onSnapshot(
      this.shotsCol(pileId),
      META,
      (snap) =>
        next({
          data: snap.docs.map((d) => parseShotChunk(d.id, d.data())).sort((a, b) => a.index - b.index),
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites,
        }),
      error,
    );
  }

  async decideShot(pileId: string, chunkIndex: number, shotId: string, decision: ShotDecisionInput): Promise<void> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new Error('Deciding a photo needs a connection to the server. Try again when online.');
    }
    const pileRef = doc(this.col('scans'), pileId);
    const chunkRef = doc(this.shotsCol(pileId), chunkId(chunkIndex));
    await runTransaction(this.db, async (tx) => {
      const pileSnap = await tx.get(pileRef);
      const chunkSnap = await tx.get(chunkRef);
      if (!pileSnap.exists() || !chunkSnap.exists()) throw new Error('This pile or its photos were deleted.');
      const pile = toPile(pileSnap.id, pileSnap.data());
      const chunk = parseShotChunk(chunkSnap.id, chunkSnap.data());
      const i = chunk.shots.findIndex((x) => x.id === shotId);
      if (i < 0) throw new Error('That photo is not in this pile any more.');
      const was = chunk.shots[i]!;
      const r = applyShotDecision(pile.rows, was, decision);
      if (r.rows.length > MAX_PILE_ROWS) throw new Error(`A shared pile holds at most ${MAX_PILE_ROWS} rows.`);
      const shots = chunk.shots.map((x, j) => (j === i ? r.shot : x));
      // to_review moves by this one shot; the other chunks are not read.
      const delta = countToReview([r.shot]) - countToReview([was]);
      tx.update(pileRef, {
        rows: r.rows,
        row_count: r.rows.length,
        shot_count: Math.max(pile.shot_count ?? 0, chunk.shots.length),
        to_review: Math.max(0, (pile.to_review ?? countToReview(chunk.shots)) + delta),
        updatedAt: now(),
      });
      tx.update(chunkRef, { shots });
    });
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

  async applyUpdate(input: UpdateWrites): Promise<void> {
    let w = input;
    const fresh = w.cards.filter((p) => p.patch.kind === 'new_card').map((p) => p.oracle_id);
    if (fresh.length) {
      // A new card doc is only written where the server has none; whether one exists is asked of
      // the server, never the local cache, so a stored In-box is never reset.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        throw new Error('An Update with new cards needs a connection to the server. Try again when online.');
      }
      const snaps = await Promise.all(fresh.map((id) => getDocFromServer(doc(this.col('cards'), id))));
      const existing = new Map<string, CardState>();
      for (const snap of snaps) if (snap.exists()) existing.set(snap.id, snap.data() as CardState);
      if (existing.size) w = { ...w, cards: guardNewCards(w.cards, existing) };
    }
    const t = now();
    const trim = w.trim ?? [];
    // Committed in order without waiting between batches, so an offline Update is queued whole;
    // Firestore applies one client's batches in the order they were committed.
    const commits = updateBatches(w, t).map((part) => {
      const batch = writeBatch(this.db);
      for (const { oracle_id, write } of part.cards) batch.set(doc(this.col('cards'), oracle_id), writeData(write), { merge: true });
      if (part.meta) {
        if (Object.keys(w.decisions).length) batch.set(this.metaRef('upstream'), { decisions: w.decisions, updatedAt: t }, { merge: true });
        // Two writes to one doc: Firestore allows one transform per field per write.
        if (trim.length) batch.set(this.metaRef('updates'), { history: arrayRemove(...trim) }, { merge: true });
        batch.set(this.metaRef('updates'), { history: arrayUnion(w.history), updatedAt: t }, { merge: true });
      }
      return batch.commit();
    });
    await Promise.all(commits);
  }

  saveUpstreamSnapshot(snapshot: { fetched_at: string; list_names: string[]; upstream_names: string[] }, dropDecisions: string[]): Promise<void> {
    const data: Record<string, unknown> = { ...snapshot, updatedAt: now() };
    if (dropDecisions.length) data.decisions = Object.fromEntries(dropDecisions.map((name) => [name, deleteField()]));
    return setDoc(this.metaRef('upstream'), data, { merge: true });
  }

  claimOwner(): Promise<void> {
    return setDoc(this.ownerRef(), { uid: this.requireUid() });
  }
}
