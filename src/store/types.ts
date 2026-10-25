// The shared data model in Firestore and the Store interface the views use.
// Paths: config/owner, cubes/main, cubes/main/{cards,suggestions,scans,log}/{id},
// cubes/main/meta/overrides. Immutable card facts stay in public/data/cards.json, except for cards
// that came In with an Update, whose facts are on their doc.
import type { ColorCategory, TypeCategory } from '../types';

export const CUBE_ID = 'main';

export interface OwnerConfig {
  uid: string;
}

export interface CubeDoc {
  name: string;
  cubecobraId: string;
  upstreamId: string;
  baselineImportedAt: string | null;
  updatedAt: string;
}

export interface InBoxState {
  scryfall_id: string;
  set: string;
  collector_number: string;
  illustration_id: string | null;
  name: string | null;
  source: string;
  confidence: string;
  /** Scryfall's normal image, written when a Wanted Printing is marked as printed. */
  image_normal?: string | null;
}

export interface WantedState {
  scryfall_id: string;
  set: string;
  collector_number: string;
  illustration_id: string | null;
  name: string | null;
  /** A WantedReason for writes made in the app; cards.json also has other reasons. */
  reason: string;
  /** Scryfall's normal image, so the Cube view can show Wanted without the printings index. */
  image_normal?: string | null;
}

/** Why the Owner set a Wanted Printing in the app. */
export type WantedReason = 'picked' | 'cycle' | 'default-rule' | 'reset-to-box' | 'upstream-pick';

/** cubes/main/meta/cycles: the splits the Owner accepted, Cycle name to signature. */
export interface CycleAcks {
  ack: Record<string, string>;
}

export const EMPTY_CYCLE_ACKS: CycleAcks = { ack: {} };

/** One card's change in a batch of card writes. */
export interface CardPatchFor {
  oracle_id: string;
  patch: CardPatch;
}

export interface FlagState {
  type: string;
  by: string;
  note: string;
  createdAt: string | null;
}

/**
 * The static facts of a card that is not in cards.json, stored on its doc when it comes In with an
 * Update. Cards in cards.json take their facts from there.
 */
export interface CardFacts {
  name: string;
  type_line: string;
  mana_cost: string;
  cmc: number;
  colors: string[];
  color_identity: string[];
  color_category: ColorCategory;
  type_category: TypeCategory;
  layout: string;
  rarity?: string;
  image_normal: string | null;
  back_name: string | null;
  back_image_normal: string | null;
  oracle_cycle_tags: string[];
  produces_tokens: { name: string; scryfall_id: string }[];
}

/** cubes/main/cards/{oracle_id}: the mutable state of one card. */
export interface CardState {
  name: string;
  /** null: not printed yet, or pulled. A doc without the field keeps the cards.json In-box. */
  in_box: InBoxState | null;
  wanted: WantedState;
  flags: FlagState[];
  in_list: boolean;
  list_source: string;
  /** Only for cards that are not in cards.json. */
  facts?: CardFacts | null;
  oracle_cycle_tags?: string[];
  /** The In-box Printing before a pull, or null. */
  retired_printing?: InBoxState | null;
  added_at?: string | null;
  retired_at?: string | null;
  updatedAt: string;
}

export type SuggestionType = 'add' | 'ban' | 'art_flag' | 'printing' | 'winner_pick' | 'other';
export type SuggestionStatus = 'open' | 'accepted' | 'rejected';

export const SUGGESTION_TYPES: SuggestionType[] = ['add', 'ban', 'art_flag', 'printing', 'winner_pick', 'other'];

export const SUGGESTION_LABEL: Record<SuggestionType, string> = {
  add: 'Add to the List',
  ban: 'Ban',
  art_flag: 'Art flag',
  printing: 'Wanted Printing',
  winner_pick: "Winner's Pick",
  other: 'Other',
};

export interface SuggestionPrinting {
  set: string;
  collector_number: string;
  scryfall_id: string | null;
}

export interface SuggestionInput {
  type: SuggestionType;
  card_name: string;
  oracle_id: string | null;
  printing: SuggestionPrinting | null;
  by: string;
  note: string;
}

export interface Suggestion extends SuggestionInput {
  id: string;
  status: SuggestionStatus;
  createdAt: string;
  createdByUid: string;
  resolvedAt: string | null;
  resolution_note: string | null;
}

export interface SharedPileRow {
  name: string;
  quantity: number;
  scryfall_id: string | null;
  set: string | null;
  collector_number: string | null;
}

export interface SharedPileInput {
  label: string;
  by: string;
  rows: SharedPileRow[];
}

export interface SharedPile extends SharedPileInput {
  id: string;
  row_count: number;
  createdAt: string;
  createdByUid: string;
}

export type LogType = 'winner_pick' | 'ban';

export interface LogEntryInput {
  type: LogType;
  /** null while a Winner's Pick is still pending. */
  card_name: string | null;
  by: string;
  /** YYYY-MM-DD or null. */
  date: string | null;
  cut: string | null;
  note: string;
}

export interface LogEntry extends LogEntryInput {
  id: string;
  createdAt: string;
}

export interface Overrides {
  adds: string[];
  bans: string[];
  updatedAt: string | null;
}

export const EMPTY_OVERRIDES: Overrides = { adds: [], bans: [], updatedAt: null };

/** What a subscription delivers: the data plus whether it came from the local cache only. */
export interface Snapshot<T> {
  data: T;
  fromCache: boolean;
  hasPendingWrites: boolean;
}

export type Unsubscribe = () => void;
export type OnError = (e: Error) => void;

/**
 * A change to one card document. Only the named fields are written (set with merge), so the
 * result never depends on how current the client's copy of the card is.
 */
export type CardPatch =
  | { kind: 'in_box'; in_box: InBoxState }
  | { kind: 'wanted'; wanted: WantedState }
  /** seedFlags: the cards.json flags, only when the card has no stored doc yet; null otherwise. */
  | { kind: 'add_flag'; flag: FlagState; seedFlags: FlagState[] | null }
  | { kind: 'clear_flags' }
  /** A card that comes In and has no doc yet: the whole doc. */
  | { kind: 'new_card'; state: Omit<CardState, 'updatedAt'> }
  /** A card that has a doc (or is in cards.json) comes In again; wanted null keeps its Wanted. */
  | { kind: 'list_in'; list_source: string; added_at: string; wanted: WantedState | null }
  /** A card goes Out: off the List; it stays in the box until it is pulled. */
  | { kind: 'list_out' }
  /** The card was taken out of the box. */
  | { kind: 'pull'; retired_printing: InBoxState; at: string }
  /** The card is on the List but not in the box (never printed, or lost): it goes to the print batch. */
  | { kind: 'not_in_box' };

/**
 * A change to the pending List changes: `name` joins `field` and every name in `drop` leaves the
 * other list. Written with arrayUnion and arrayRemove, so earlier entries are never lost.
 */
export interface ListChange {
  field: 'adds' | 'bans';
  name: string;
  drop: string[];
}

/** The result of accepting a Suggestion, written in one batch. */
export interface AcceptPlan {
  suggestionId: string;
  resolution_note: string | null;
  card: { oracle_id: string; patch: CardPatch } | null;
  list: ListChange | null;
  log: LogEntryInput | null;
}

export interface Store {
  subscribeCards(next: (s: Snapshot<Map<string, CardState>>) => void, error: OnError): Unsubscribe;
  subscribeSuggestions(next: (s: Snapshot<Suggestion[]>) => void, error: OnError): Unsubscribe;
  subscribeScans(next: (s: Snapshot<SharedPile[]>) => void, error: OnError): Unsubscribe;
  subscribeLog(next: (s: Snapshot<LogEntry[]>) => void, error: OnError): Unsubscribe;
  subscribeOverrides(next: (s: Snapshot<Overrides>) => void, error: OnError): Unsubscribe;
  subscribeOwner(next: (s: Snapshot<OwnerConfig | null>) => void, error: OnError): Unsubscribe;
  /**
   * Write the given card docs, in chunks of 400, skipping every doc the server already has.
   * Refuses to run offline. Resolves with the number of docs written.
   */
  importBaseline(docs: [string, CardState][]): Promise<number>;
  /** Write only the fields the patch changes. */
  updateCard(oracleId: string, patch: CardPatch): Promise<void>;
  /** Owner only: merge-write several card docs, in writeBatches of at most 400. */
  updateCards(patches: CardPatchFor[]): Promise<void>;
  subscribeCycleAcks(next: (s: Snapshot<CycleAcks>) => void, error: OnError): Unsubscribe;
  /** A meta doc as stored (null when it does not exist), for example cubes/main/meta/print. */
  subscribeMetaDoc(docId: string, next: (s: Snapshot<Record<string, unknown> | null>) => void, error: OnError): Unsubscribe;
  /**
   * Owner only: Mark as printed in one atomic writeBatch: the In-box patches, the history entry
   * appended to cubes/main/meta/print with arrayUnion, and `trim` (stored entries) removed with
   * arrayRemove. Queued locally at once when offline.
   */
  markPrinted(patches: CardPatchFor[], entry: Record<string, unknown> | null, trim: unknown[]): Promise<void>;
  /** Owner only: merge fields into cubes/main/meta/{docId}; nested maps merge key by key. */
  setMeta(docId: string, data: Record<string, unknown>): Promise<void>;
  createSuggestion(input: SuggestionInput): Promise<void>;
  /** Reject (plan null) or accept with the plan computed by applySuggestion. */
  resolveSuggestion(id: string, status: 'accepted' | 'rejected', note: string | null, plan: AcceptPlan | null): Promise<void>;
  /** Starts the write and returns the new id at once; `written` settles when the server has it. */
  createScanPile(input: SharedPileInput): { id: string; written: Promise<void> };
  deleteScanPile(id: string): Promise<void>;
  addLogEntry(entry: LogEntryInput): Promise<void>;
  addLogEntries(entries: LogEntryInput[]): Promise<void>;
  updateLogEntry(id: string, entry: LogEntryInput): Promise<void>;
  setOverrides(o: Overrides): Promise<void>;
  /**
   * Owner only: apply an Update. The card writes go in writeBatches of at most 400, committed in
   * order; the decisions (meta/upstream) and the history entry (meta/updates) go in the last batch.
   */
  applyUpdate(writes: UpdateWrites): Promise<void>;
  /**
   * Owner only: store a Refresh snapshot in meta/upstream and delete the named decisions (stale
   * ones, whose item is no longer in the feed).
   */
  saveUpstreamSnapshot(snapshot: { fetched_at: string; list_names: string[]; upstream_names: string[] }, dropDecisions: string[]): Promise<void>;
  claimOwner(): Promise<void>;
}

/** An Owner's decision on one Upstream feed item, in cubes/main/meta/upstream.decisions by name. */
export type DecisionStatus = 'accepted' | 'rejected' | 'later';

export interface Decision {
  status: DecisionStatus;
  /** Which side of the feed the decision was made on. */
  side: 'add' | 'cut';
  at: string;
  note: string;
  /** Set when an accepted item went into an applied Update. */
  applied_at?: string | null;
}

/** One entry of cubes/main/meta/updates.history. */
export interface UpdateHistoryEntry {
  date: string;
  at: string;
  in: string[];
  out: string[];
  source: 'upstream' | 'manual';
}

/** Everything one Update writes. */
export interface UpdateWrites {
  cards: CardPatchFor[];
  /** Merged into meta/upstream.decisions, key by key. */
  decisions: Record<string, Decision>;
  history: UpdateHistoryEntry;
  /** Stored history entries to remove (arrayRemove) so meta/updates.history stays bounded. */
  trim?: unknown[];
}

/** cubes/main/meta/upstream: the last fetch of the List and Upstream, and the decisions. */
export interface UpstreamMeta {
  fetched_at: string | null;
  list_names: string[];
  upstream_names: string[];
  decisions: Record<string, Decision>;
}
