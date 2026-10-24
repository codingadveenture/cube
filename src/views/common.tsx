// Small pieces shared by the store-backed views.
import { useState, type ReactNode } from 'react';
import { useStore, type Live } from '../store/context';
import { loadDisplayName, saveDisplayName } from '../store/name';

/** Loading, unavailable, error, offline and pending-sync lines for a store-backed list. */
export function LiveStatus<T>({ live, what }: { live: Live<T>; what: string }) {
  const { online, unavailableReason } = useStore();
  if (live.status === 'loading') return <p className="status">Loading {what}…</p>;
  if (live.status === 'unavailable') {
    return (
      <p className="status error">
        Shared {what} are not available on this device{unavailableReason ? ` (${unavailableReason})` : ''}. Only what is
        on this device is shown.
      </p>
    );
  }
  if (live.status === 'error') return <p className="status error">Could not load the {what}: {live.error}</p>;
  return (
    <>
      {live.fromCache && !online && <p className="notice">Offline: showing what this device last saw.</p>}
      {live.pending && <p className="notice">Some changes are saved on this device and sync when online.</p>}
    </>
  );
}

/** The free-text name people sign with, remembered on this device. */
export function useDisplayName(): [string, (v: string) => void] {
  const [name, setName] = useState(loadDisplayName);
  return [
    name,
    (v: string) => {
      setName(v);
      saveDisplayName(v);
    },
  ];
}

export function NameField({ value, onChange, label = 'Your name' }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="nickname" maxLength={80} required />
    </label>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function CopyButton({ text, label, disabled }: { text: string; label: string; disabled?: boolean }) {
  const [done, setDone] = useState<string | null>(null);
  return (
    <button
      type="button"
      disabled={disabled || !text}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setDone('Copied'),
          () => setDone('Copying was blocked'),
        );
        setTimeout(() => setDone(null), 2500);
      }}
    >
      {done ?? label}
    </button>
  );
}
