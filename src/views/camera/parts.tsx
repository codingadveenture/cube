// Small pieces shared by the camera view and its review list.
import { useEffect, useState } from 'react';
import { scryfallImage } from '../../store/baseline';
import { REPEAT, type Shot } from '../../scan/camera/shots';
import type { ShotCandidate } from '../../scan/vision/protocol';

/** The photo of a shot, from its JPEG Blob; turned the right way up when the slip lay upside down. */
export function ShotPhoto({ shot, className = 'shot-photo' }: { shot: Shot; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(shot.thumb);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [shot.thumb]);
  const turned = shot.orientation === 'rotated' ? ' turned' : '';
  return url ? <img className={className + turned} src={url} alt="Photo of the slip" /> : <span className={`${className} empty`} />;
}

/** The art of a candidate Printing: Scryfall's small image, the URL pattern cards.json uses. */
export function ArtImage({ c, className = 'shot-art' }: { c: Pick<ShotCandidate, 'scryfall_id' | 'face'>; className?: string }) {
  return (
    <img
      className={className}
      src={scryfallImage(c.scryfall_id, 'small', c.face === 'back' ? 'back' : 'front')}
      alt=""
      loading="lazy"
      decoding="async"
      width={146}
      height={204}
    />
  );
}

export type StatusWord = 'match' | 'confirmed' | 'review' | 'none' | 'skipped' | 'reading';

/** The one-word status of a shot and its colour class. */
export function statusOf(shot: Shot, reading: boolean): { word: string; tone: StatusWord } {
  if (!shot.decision && reading && shot.status === 'review') return { word: 'Reading', tone: 'reading' };
  switch (shot.status) {
    case 'match':
      return { word: 'Match', tone: 'match' };
    case 'confirmed':
      return { word: 'Confirmed', tone: 'confirmed' };
    case 'skipped':
      return { word: 'Skipped', tone: 'skipped' };
    case 'none':
      return { word: 'Unknown', tone: 'none' };
    default:
      return { word: 'Review', tone: 'review' };
  }
}

export function StatusPill({ shot, reading, big = false }: { shot: Shot; reading: boolean; big?: boolean }) {
  const s = statusOf(shot, reading);
  return <span className={`shot-status tone-${s.tone}${big ? ' big' : ''}`}>{s.word}</span>;
}

/** A line that starts with a capital. */
const sentence = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/**
 * Why a shot was set aside, for the Owner: "Repeat of <card>" for a repeat (it always names its
 * card), else the reason as it is; null when the shot was not set aside automatically.
 */
export function reasonText(shot: Pick<Shot, 'reason' | 'chosen'>): string | null {
  if (!shot.reason) return null;
  if (shot.reason === REPEAT && shot.chosen) return `Repeat of ${shot.chosen.name}`;
  return sentence(shot.reason);
}

/** The note beside the reason ("Already in pile ..."), or null. */
export function noteText(shot: Pick<Shot, 'note'>): string | null {
  return shot.note ? sentence(shot.note) : null;
}

export const setNumber = (c: { set: string; collector_number: string }) => `${c.set.toUpperCase()} ${c.collector_number}`;
export const score = (n: number) => n.toFixed(2);
