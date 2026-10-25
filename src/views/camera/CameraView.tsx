// The camera capture view (#/camera): the phone lies on the rig looking down at the sheet, the
// Owner slides slips under it one at a time, and every slip leaves a photo and a recognition.
//
// Everything lives in this component, localStorage (setup) and IndexedDB (shots): the URL does
// not change while scanning. Recognition runs in a Web Worker (src/scan/vision/client.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '../../types';
import {
  DEFAULT_LOOP_OPTIONS,
  greyStats,
  initialLoop,
  loopPhase,
  medianRgb,
  step,
  THUMB_H,
  THUMB_W,
  toGrey,
  type Baseline,
  type LoopPhase,
} from '../../scan/camera/capture';
import { clearShots, deleteShot, loadShots, putShot } from '../../scan/camera/db';
import { guideRect, turnGuide, type Guide } from '../../scan/camera/guide';
import { initialOrientation, LOCK_AFTER, passesFor, recordOrientation } from '../../scan/camera/orientation';
import {
  loadCameraSession,
  loadSettings,
  nextPassMs,
  saveCameraSession,
  saveSettings,
  type CameraSessionMeta,
  type CameraSettings,
} from '../../scan/camera/settings';
import { applyRecognition, needsReview, newShot, sameSlipOf, shotCounts, skipSameSlip, type Shot } from '../../scan/camera/shots';
import { createVisionClient, type VisionClient, type VisionMode } from '../../scan/vision/client';
import type { PrepareInfo, RecogniseRequest } from '../../scan/vision/protocol';
import { GuideOverlay } from './GuideOverlay';
import { CameraReview } from './CameraReview';
import { ArtImage, score, setNumber, ShotPhoto, StatusPill } from './parts';

type Tab = 'setup' | 'scan' | 'review';

/** Long side of the crop sent to recognition (about 896 pixels tall for a portrait box). */
const CROP_LONG = 896;
/** Long side a photo from Try a photo is scaled down to. */
const PHOTO_LONG = 1280;
/**
 * Tick of the capture loop (about 15 a second). Two still frame pairs make a capture, so a slip is
 * taken about 130 ms after it stops moving. Each tick only draws and greys the 32x45 thumbnail.
 */
const LOOP_MS = 66;
/**
 * Most camera slips waiting for recognition at once. Each waiting slip holds its full crop (about
 * 2.3 MB), so when the phone falls behind, a further slip keeps only its photo and goes to Review.
 */
const MAX_WAITING = 4;

type CameraState =
  | { state: 'starting' }
  | { state: 'on'; width: number; height: number }
  | { state: 'error'; message: string; denied: boolean };

type VisionState =
  | { state: 'loading'; fraction: number | null }
  | { state: 'ready'; info: PrepareInfo; mode: VisionMode }
  | { state: 'error'; message: string };

let idCounter = 0;
const newId = () => `${Date.now().toString(36)}-${(++idCounter).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export default function CameraView({ cards }: { cards: Card[] | null }) {
  const [settings, setSettings] = useState<CameraSettings>(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => saveSettings(settings), [settings]);

  const [meta, setMeta] = useState<CameraSessionMeta>(loadCameraSession);
  useEffect(() => saveCameraSession(meta), [meta]);

  const [shots, setShots] = useState<Shot[]>([]);
  const shotsRef = useRef<Shot[]>([]);
  const updateShots = (fn: (s: Shot[]) => Shot[]) => {
    shotsRef.current = fn(shotsRef.current);
    setShots(shotsRef.current);
  };
  const [storeError, setStoreError] = useState<string | null>(null);
  useEffect(() => {
    loadShots()
      .then((loaded) => {
        // Shots captured before the store answered stay in front.
        const known = new Set(shotsRef.current.map((s) => s.id));
        updateShots((cur) => [...cur, ...loaded.filter((s) => !known.has(s.id))]);
      })
      .catch((e: unknown) => {
        console.warn('Could not open the camera session store', e);
        setStoreError('Photos cannot be kept on this device (storage is blocked); they last until the page is closed.');
      });
  }, []);

  const [tab, setTab] = useState<Tab>(() => (settings.baseline ? 'scan' : 'setup'));
  const [latestId, setLatestId] = useState<string | null>(null);
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set());
  /** Slips handed to the recogniser and not answered yet, counted at once (state lags a render). */
  const waitingRef = useRef(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Recognition: the worker loads the model and the catalog once.
  const clientRef = useRef<VisionClient | null>(null);
  const [vision, setVision] = useState<VisionState>({ state: 'loading', fraction: null });
  const [visionAttempt, setVisionAttempt] = useState(0);
  useEffect(() => {
    const client = createVisionClient();
    clientRef.current = client;
    let live = true;
    setVision({ state: 'loading', fraction: null });
    client
      .prepare((p) => {
        if (live && p.stage === 'model') setVision({ state: 'loading', fraction: p.fraction ?? null });
      })
      .then((info) => live && setVision({ state: 'ready', info, mode: client.mode }))
      .catch((e: unknown) => live && setVision({ state: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [visionAttempt]);

  // The In-box Printings, so a match can say whether the slip has the expected art.
  const expected = useMemo(
    () =>
      (cards ?? [])
        .filter((c) => c.in_box)
        .map((c) => [c.oracle_id, { scryfall_id: c.in_box!.scryfall_id, illustration_id: c.in_box!.illustration_id, back_illustration_id: c.in_box!.back_illustration_id }] as [string, { scryfall_id: string; illustration_id: string | null; back_illustration_id: string | null }]),
    [cards],
  );
  useEffect(() => {
    if (expected.length) clientRef.current?.setExpected(expected);
  }, [expected, visionAttempt]);

  // The rear camera.
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState<CameraState>({ state: 'starting' });
  const [cameraAttempt, setCameraAttempt] = useState(0);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let live = true;
    const video = videoRef.current;
    const onSize = () => {
      if (live && video && video.videoWidth) setCamera({ state: 'on', width: video.videoWidth, height: video.videoHeight });
    };
    setCamera({ state: 'starting' });
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no camera API'), { name: 'NotFoundError' });
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (!live) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      if (!video) return;
      video.srcObject = s;
      video.addEventListener('loadedmetadata', onSize);
      video.addEventListener('resize', onSize);
      await video.play().catch(() => undefined);
      onSize();
    })().catch((e: unknown) => {
      if (!live) return;
      const name = e instanceof Error ? e.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setCamera({ state: 'error', denied: true, message: 'The camera is blocked for this site. Allow it in the browser’s site settings, or try a photo.' });
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
        setCamera({
          state: 'error',
          denied: false,
          message: name === 'NotReadableError' ? 'The camera is in use by another app. Close it and try again, or try a photo.' : 'No camera found on this device. Try a photo.',
        });
      } else {
        setCamera({ state: 'error', denied: false, message: `Could not start the camera (${e instanceof Error ? e.message : String(e)}). Try a photo.` });
      }
    });
    return () => {
      live = false;
      video?.removeEventListener('loadedmetadata', onSize);
      video?.removeEventListener('resize', onSize);
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    };
  }, [cameraAttempt]);

  // Keep the screen on while the view is open.
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    if (!nav.wakeLock) return;
    let lock: { release(): Promise<void> } | null = null;
    let live = true;
    const request = () => {
      if (document.visibilityState !== 'visible') return;
      nav.wakeLock!
        .request('screen')
        .then((l) => {
          if (live) lock = l;
          else void l.release();
        })
        .catch(() => undefined);
    };
    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', request);
      void lock?.release().catch(() => undefined);
    };
  }, []);

  // Sound: an AudioContext may only start after a tap.
  const audioRef = useRef<AudioContext | null>(null);
  function ensureAudio() {
    if (audioRef.current || !settingsRef.current.beep) {
      void audioRef.current?.resume().catch(() => undefined);
      return;
    }
    try {
      audioRef.current = new AudioContext();
    } catch {
      // No audio on this device.
    }
  }
  useEffect(() => () => void audioRef.current?.close().catch(() => undefined), []);

  /**
   * Buzz (and beep): one short buzz when a slip is photographed, one long buzz when it matched,
   * two buzzes when it needs review, one short buzz when it was the same slip as the one before
   * (counted once, whichever photo of it is kept). The result comes after the capture, so each slip
   * ends with one of the last three.
   */
  function feedback(kind: 'capture' | 'match' | 'doubt' | 'same') {
    try {
      navigator.vibrate?.(kind === 'capture' || kind === 'same' ? 40 : kind === 'match' ? 180 : [90, 70, 90]);
    } catch {
      // Vibration is not available.
    }
    const ctx = audioRef.current;
    if (!settingsRef.current.beep || !ctx) return;
    const tones =
      kind === 'capture' ? [[0, 880]] : kind === 'same' ? [[0, 660]] : kind === 'match' ? [[0, 1320]] : [[0, 330], [0.16, 330]];
    for (const [at, freq] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq!;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + at!);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at! + 0.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at!);
      osc.stop(ctx.currentTime + at! + 0.11);
    }
  }

  /**
   * Takes one photo: stores the shot at once, then asks the recogniser. `onTaken` is called once
   * the photo is kept (or could not be), before recognition, so the capture loop can go on.
   */
  async function capture(
    source: CanvasImageSource,
    rect: { x: number; y: number; width: number; height: number },
    from: 'camera' | 'photo',
    onTaken?: () => void,
  ) {
    const scale = Math.min(1, (from === 'camera' ? CROP_LONG : PHOTO_LONG) / Math.max(rect.width, rect.height));
    const w = Math.max(1, Math.round(rect.width * scale));
    const h = Math.max(1, Math.round(rect.height * scale));
    const crop = document.createElement('canvas');
    crop.width = w;
    crop.height = h;
    const ctx = crop.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, w, h);
    let thumb: Blob;
    try {
      thumb = await thumbnail(crop);
    } catch (e) {
      setScanError('Could not keep the photo of that slip.');
      console.warn(e);
      return;
    } finally {
      onTaken?.();
    }
    const shot = newShot({ id: newId(), at: new Date().toISOString(), thumb, width: w, height: h, source: from });
    updateShots((cur) => [shot, ...cur]);
    setLatestId(shot.id);
    putShot(shot).catch((e: unknown) => console.warn('Could not store the shot', e));
    if (from === 'camera') feedback('capture');

    const client = clientRef.current;
    if (!client) return;
    if (from === 'camera' && waitingRef.current >= MAX_WAITING) {
      // Recognition is behind: keep only the photo (the shot is already 'review') and say so.
      setScanError('Recognition is behind, so that slip went to Review unrecognised. Slow down a little.');
      feedback('doubt');
      return;
    }
    const image = ctx.getImageData(0, 0, w, h);
    const s = settingsRef.current;
    const request: RecogniseRequest =
      from === 'camera'
        ? { sheet: s.baseline?.sheet ?? null, passes: passesFor(s.orientation), fallbackBoth: s.orientation.locked !== null }
        : { sheet: null, passes: ['upright', 'rotated'], fallbackBoth: false };
    waitingRef.current++;
    setReading((r) => new Set(r).add(shot.id));
    try {
      const result = await client.scan(image, request);
      const current = shotsRef.current.find((x) => x.id === shot.id);
      if (!current) return; // Retaken meanwhile.
      let next = applyRecognition(current, result);
      // A slip put back (or nudged) within a few seconds is the same slip: both photos are kept,
      // and only the better one counts (a thumb over the first photo loses to a clean second one).
      const kept = from === 'camera' && current.status === 'review' ? sameSlipOf(shotsRef.current, next) : null;
      const same = kept ? skipSameSlip(kept, next) : null;
      const changed = same ? [same.next, ...(same.kept === 'next' ? [same.previous] : [])] : [next];
      if (same) next = same.next;
      const byId = new Map(changed.map((x) => [x.id, x]));
      updateShots((cur) => cur.map((x) => byId.get(x.id) ?? x));
      for (const x of changed) putShot(x).catch((e: unknown) => console.warn('Could not store the shot', e));
      setScanError(null);
      // The orientation lock sees each slip once: a better photo only adds to it when the photo it
      // replaced was not a match.
      const countsForLock = same ? same.recordOrientation : true;
      setSettings((cur) => ({
        ...cur,
        passMs: nextPassMs(cur.passMs, result.passMs),
        orientation:
          from === 'camera' && countsForLock && result.decision.status === 'match'
            ? recordOrientation(cur.orientation, result.orientation)
            : cur.orientation,
      }));
      if (from === 'camera') feedback(same ? 'same' : needsReview(next) ? 'doubt' : 'match');
    } catch (e) {
      console.warn('Recognition failed', e);
      setScanError(`Could not recognise the last slip (${e instanceof Error ? e.message : String(e)}). The photo is kept for review.`);
      if (from === 'camera') feedback('doubt');
    } finally {
      waitingRef.current--;
      setReading((r) => {
        const n = new Set(r);
        n.delete(shot.id);
        return n;
      });
    }
  }

  // The capture loop: about 15 frames a second while the Scan tab is open.
  const loopRef = useRef(initialLoop());
  const [phase, setPhase] = useState<LoopPhase>('empty');
  const scanning = tab === 'scan' && camera.state === 'on' && settings.baseline !== null;
  useEffect(() => {
    const video = videoRef.current;
    const baseline = settings.baseline;
    if (!scanning || !video || !baseline) return;
    const guide = settings.guide;
    const canvas = document.createElement('canvas');
    canvas.width = guide.landscape ? THUMB_H : THUMB_W;
    canvas.height = guide.landscape ? THUMB_W : THUMB_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    // Stability is counted afresh, but a slip captured before leaving the tab is not taken again.
    // A last capture of another box shape cannot be compared, so it is forgotten.
    const last = loopRef.current.lastCaptured;
    const sameSize = last !== null && last.width === canvas.width && last.height === canvas.height;
    loopRef.current = { ...loopRef.current, prev: null, stable: 0, lastCaptured: sameSize ? last : null };
    // A tick is skipped while the previous one is still at work (its photo is being kept).
    let busy = false;
    let live = true;
    const timer = window.setInterval(() => {
      if (busy || video.readyState < 2 || document.hidden || !video.videoWidth) return;
      const r = guideRect(guide, video.videoWidth, video.videoHeight);
      ctx.drawImage(video, r.x, r.y, r.width, r.height, 0, 0, canvas.width, canvas.height);
      const res = step(loopRef.current, toGrey(ctx.getImageData(0, 0, canvas.width, canvas.height)), baseline, DEFAULT_LOOP_OPTIONS);
      loopRef.current = res.state;
      setPhase(loopPhase(res.state));
      if (res.capture) {
        busy = true;
        const free = () => {
          if (live) busy = false;
        };
        void capture(video, r, 'camera', free).finally(free);
      }
    }, LOOP_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    // capture reads the latest settings through settingsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning, settings.baseline, settings.guide]);

  // Set the empty sheet: sample the empty box over a few frames.
  const [sampling, setSampling] = useState(false);
  async function setEmptySheet() {
    const video = videoRef.current;
    if (!video || camera.state !== 'on') return;
    setSampling(true);
    try {
      const guide = settings.guide;
      const r = guideRect(guide, video.videoWidth, video.videoHeight);
      const small = document.createElement('canvas');
      small.width = guide.landscape ? THUMB_H : THUMB_W;
      small.height = guide.landscape ? THUMB_W : THUMB_H;
      const sctx = small.getContext('2d', { willReadFrequently: true })!;
      let spread = 0;
      let mean = 0;
      const frames = 6;
      for (let i = 0; i < frames; i++) {
        sctx.drawImage(video, r.x, r.y, r.width, r.height, 0, 0, small.width, small.height);
        const st = greyStats(toGrey(sctx.getImageData(0, 0, small.width, small.height)));
        spread += st.spread / frames;
        mean += st.mean / frames;
        await new Promise((res) => setTimeout(res, 80));
      }
      const big = document.createElement('canvas');
      const k = Math.min(1, 160 / Math.max(r.width, r.height));
      big.width = Math.max(1, Math.round(r.width * k));
      big.height = Math.max(1, Math.round(r.height * k));
      const bctx = big.getContext('2d', { willReadFrequently: true })!;
      bctx.drawImage(video, r.x, r.y, r.width, r.height, 0, 0, big.width, big.height);
      const baseline: Baseline = { spread, mean, sheet: medianRgb(bctx.getImageData(0, 0, big.width, big.height)) };
      setSettings((s) => ({ ...s, baseline }));
      loopRef.current = initialLoop();
      setNotice(
        spread > 25
          ? 'The box does not look empty. Take the slip away and set the empty sheet again.'
          : 'Empty sheet set. Slide a slip under the camera on the Scan tab.',
      );
    } finally {
      setSampling(false);
    }
  }

  async function tryPhoto(file: File | undefined) {
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      await capture(bmp, { x: 0, y: 0, width: bmp.width, height: bmp.height }, 'photo');
      bmp.close();
      setTab((t) => (t === 'review' ? t : 'scan'));
    } catch (e) {
      console.warn(e);
      setScanError('Could not read that picture.');
    }
  }

  async function retake(id: string) {
    updateShots((cur) => cur.filter((s) => s.id !== id));
    await deleteShot(id).catch((e: unknown) => console.warn('Could not delete the shot', e));
  }

  function saveShot(next: Shot) {
    updateShots((cur) => cur.map((s) => (s.id === next.id ? next : s)));
    putShot(next).catch((e: unknown) => console.warn('Could not store the shot', e));
  }

  async function newSession() {
    updateShots(() => []);
    setLatestId(null);
    setMeta({ startedAt: new Date().toISOString(), exported: null });
    await clearShots().catch((e: unknown) => console.warn('Could not clear the shots', e));
  }

  const counts = shotCounts(shots);
  const latest = shots.find((s) => s.id === latestId) ?? shots[0] ?? null;
  const vw = camera.state === 'on' ? camera.width : 0;
  const vh = camera.state === 'on' ? camera.height : 0;
  const setGuide = (g: Guide) => setSettings((s) => ({ ...s, guide: g }));
  const tone = tab !== 'scan' || !settings.baseline ? 'idle' : phase;
  const phaseText: Record<LoopPhase, string> = {
    empty: 'Waiting for a slip',
    settling: 'Hold still',
    captured: 'Taken. Slide the next slip in.',
  };

  return (
    <div className={settings.flipped ? 'camera flipped' : 'camera'} onPointerDown={ensureAudio}>
      <header className="camera-head">
        <a className="camera-back" href="#/scan">
          Scan
        </a>
        <p className="camera-counts num" aria-live="polite">
          <span>{counts.captured} captured</span>
          <span>{counts.matched} matched</span>
          <span className={counts.toReview ? 'warn' : undefined}>{counts.toReview} to review</span>
          {reading.size > 0 && <span className={reading.size >= MAX_WAITING ? 'warn' : undefined}>{reading.size} recognising</span>}
        </p>
        <button
          type="button"
          className="flip"
          aria-pressed={settings.flipped}
          onClick={() => setSettings((s) => ({ ...s, flipped: !s.flipped }))}
        >
          Flip the screen
        </button>
      </header>

      <div className="tabs camera-tabs" role="tablist" aria-label="Camera">
        {(
          [
            ['setup', 'Setup'],
            ['scan', 'Scan'],
            ['review', `Review${counts.toReview ? ` (${counts.toReview})` : ''}`],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {storeError && <p className="notice">{storeError}</p>}

      {/* The camera and the last slip; side by side on a phone held sideways (styles.css). */}
      <div className={`camera-stage ${tab}`}>
      <section className={tab === 'review' ? 'camera-live hidden' : `camera-live ${tab}`} aria-label="Camera">
        {camera.state === 'error' ? (
          <div className="panel">
            <p className="status error">{camera.message}</p>
            {!camera.denied && (
              <button type="button" onClick={() => setCameraAttempt((n) => n + 1)}>
                Try the camera again
              </button>
            )}
          </div>
        ) : null}
        <div
          className="camera-frame"
          style={
            vw && vh
              ? { aspectRatio: `${vw} / ${vh}`, width: `min(100%, calc(var(--frame-h) * ${(vw / vh).toFixed(4)}))` }
              : { display: camera.state === 'error' ? 'none' : undefined }
          }
        >
          <video ref={videoRef} muted playsInline autoPlay />
          {vw > 0 && (
            <GuideOverlay guide={settings.guide} vw={vw} vh={vh} editable={tab === 'setup'} flipped={settings.flipped} tone={tone} onChange={setGuide} />
          )}
          {camera.state === 'starting' && <p className="camera-starting">Starting the camera…</p>}
        </div>
        {tab === 'scan' && camera.state === 'on' && (
          <p className={`loop-phase tone-${tone}`} role="status">
            {settings.baseline ? phaseText[phase] : 'Set the empty sheet first, on the Setup tab.'}
          </p>
        )}
      </section>

      {tab === 'scan' &&
        (latest ? (
          <LatestResult shot={latest} reading={reading.has(latest.id)} onReview={() => setTab('review')} />
        ) : (
          <p className="status">No slips yet. Each slip that lies still in the box is photographed once.</p>
        ))}
      </div>

      <VisionStatus vision={vision} onRetry={() => setVisionAttempt((n) => n + 1)} />
      {notice && (
        <p className="notice" role="status">
          {notice}{' '}
          <button type="button" className="link" onClick={() => setNotice(null)}>
            Close
          </button>
        </p>
      )}
      {scanError && tab !== 'setup' && (
        <p className="status error" role="alert">
          {scanError}
        </p>
      )}

      {tab === 'setup' && (
        <SetupPanel
          settings={settings}
          vision={vision}
          cameraOn={camera.state === 'on'}
          sampling={sampling}
          onSetSheet={() => void setEmptySheet()}
          onTurn={() => vw && setGuide(turnGuide(settings.guide, vw, vh))}
          onBeep={(beep) => {
            setSettings((s) => ({ ...s, beep }));
            if (beep && !audioRef.current) {
              try {
                audioRef.current = new AudioContext();
              } catch {
                // No audio on this device.
              }
            }
          }}
          onResetOrientation={() => setSettings((s) => ({ ...s, orientation: initialOrientation() }))}
          onPhoto={(f) => void tryPhoto(f)}
          onDone={() => setTab('scan')}
        />
      )}

      {tab === 'scan' && <PhotoButton onPhoto={(f) => void tryPhoto(f)} />}

      {tab === 'review' && (
        <CameraReview
          shots={shots}
          reading={reading}
          meta={meta}
          onSave={saveShot}
          onRetake={(id) => void retake(id)}
          onExported={(label, cards) => {
            const next = { ...meta, exported: { at: new Date().toISOString(), label, cards } };
            setMeta(next);
            saveCameraSession(next);
          }}
          onDone={() => {
            window.location.hash = '#/scan';
          }}
          onNewSession={() => void newSession()}
        />
      )}

      <p className="camera-foot muted">
        Recognition by the Milo model from CollectorVision (AGPL-3.0).{' '}
        <a href="https://github.com/codingadveenture/cube" target="_blank" rel="noreferrer">
          Source
        </a>
      </p>
    </div>
  );
}

function thumbnail(crop: HTMLCanvasElement): Promise<Blob> {
  const k = Math.min(240 / Math.min(crop.width, crop.height), 336 / Math.max(crop.width, crop.height), 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(crop.width * k));
  c.height = Math.max(1, Math.round(crop.height * k));
  c.getContext('2d')!.drawImage(crop, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('no JPEG'))), 'image/jpeg', 0.8));
}

function VisionStatus({ vision, onRetry }: { vision: VisionState; onRetry: () => void }) {
  if (vision.state === 'ready') return null;
  if (vision.state === 'error') {
    return (
      <p className="status error" role="alert">
        Could not load the recogniser ({vision.message}). Photos are still kept.{' '}
        <button type="button" className="link" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  return (
    <p className="status num" role="status">
      Loading the recogniser, about 10 MB the first time
      {vision.fraction !== null && <progress max={1} value={vision.fraction} />}
    </p>
  );
}

function PhotoButton({ onPhoto }: { onPhoto: (f: File | undefined) => void }) {
  return (
    <label className="button photo-button">
      Try a photo
      <input
        className="visually-hidden"
        type="file"
        accept="image/*"
        onChange={(e) => {
          onPhoto(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </label>
  );
}

function LatestResult({ shot, reading, onReview }: { shot: Shot; reading: boolean; onReview: () => void }) {
  const pick = shot.chosen ? shot.candidates.find((c) => c.scryfall_id === shot.chosen!.scryfall_id) ?? null : null;
  const top = pick ?? shot.candidates[0] ?? null;
  const shown = shot.chosen ?? top;
  return (
    <section className="latest" aria-label="Last slip">
      <div className="latest-text">
        <StatusPill shot={shot} reading={reading} big />
        {shown ? (
          <>
            <p className="latest-name">
              {shot.status === 'review' || shot.status === 'none' ? `${shown.name}?` : shown.name}
            </p>
            <p className="muted num">
              {setNumber(shown)}
              {top && ` · score ${score(top.score)}`}
              {shot.decision?.verdict === 'other art' && ' · other art than the In-box Printing'}
            </p>
          </>
        ) : (
          <p className="muted">{reading ? 'Recognising…' : 'Not recognised.'}</p>
        )}
        {shot.reason && <p className="muted">{`${shot.reason[0]!.toUpperCase()}${shot.reason.slice(1)}; not counted.`}</p>}
        {(shot.status === 'review' || shot.status === 'none') && (
          <button type="button" className="link" onClick={onReview}>
            Review
          </button>
        )}
      </div>
      <div className="latest-images">
        <ShotPhoto shot={shot} className="latest-photo" />
        {shown ? <ArtImage c={{ scryfall_id: shown.scryfall_id, face: top?.face ?? 'front' }} className="latest-art" /> : <span className="latest-art empty" />}
      </div>
    </section>
  );
}

function SetupPanel({
  settings,
  vision,
  cameraOn,
  sampling,
  onSetSheet,
  onTurn,
  onBeep,
  onResetOrientation,
  onPhoto,
  onDone,
}: {
  settings: CameraSettings;
  vision: VisionState;
  cameraOn: boolean;
  sampling: boolean;
  onSetSheet: () => void;
  onTurn: () => void;
  onBeep: (on: boolean) => void;
  onResetOrientation: () => void;
  onPhoto: (f: File | undefined) => void;
  onDone: () => void;
}) {
  const o = settings.orientation;
  const passMs = settings.passMs ?? (vision.state === 'ready' ? vision.info.warmupMs : null);
  const passes = o.locked ? 1 : 2;
  return (
    <section className="panel camera-setup" aria-label="Setup">
      <p>Put a slip under the camera and fit the box to it, with a little sheet showing around it.</p>
      <div className="actions">
        <button type="button" onClick={onTurn} disabled={!cameraOn}>
          Turn the box
        </button>
      </div>
      <h2>Empty sheet</h2>
      <p className="muted">
        {settings.baseline
          ? `Set. Brightness ${Math.round(settings.baseline.mean)}, spread ${settings.baseline.spread.toFixed(1)}.`
          : 'Take the slip away, then set the empty sheet so the camera knows what an empty box looks like.'}
      </p>
      <div className="actions">
        <button type="button" onClick={onSetSheet} disabled={!cameraOn || sampling}>
          {sampling ? 'Looking…' : 'Set the empty sheet'}
        </button>
        <button type="button" className="primary" onClick={onDone} disabled={!settings.baseline}>
          Start scanning
        </button>
      </div>
      <h2>Slips</h2>
      <p className="muted">
        A new slip is noticed by its content, so the box need not show the sheet between slips; a slip put back within a few seconds is
        not counted twice.
      </p>
      <p>
        {o.locked === 'rotated'
          ? 'Slips are upside down. Only that way round is checked, unless a slip does not match.'
          : o.locked === 'upright'
            ? 'Slips are upright. Only that way round is checked, unless a slip does not match.'
            : `Both ways round are checked until ${LOCK_AFTER} matched slips in a row come the same way (${o.recent.length} so far).`}{' '}
        {(o.locked || o.recent.length > 0) && (
          <button type="button" className="link" onClick={onResetOrientation}>
            Reset
          </button>
        )}
      </p>
      <p className="muted num">
        {vision.state === 'ready'
          ? `${passMs !== null ? `One pass takes about ${Math.round(passMs)} ms` : 'Pass time not measured yet'}, ${passes} ${passes === 1 ? 'pass' : 'passes'} per slip. Recognition runs ${vision.mode === 'worker' ? 'in the background' : 'on the page itself, which may stutter'} on ${vision.info.threads} ${vision.info.threads === 1 ? 'thread' : 'threads'}.`
          : 'The pass time shows once the recogniser has loaded.'}
      </p>
      <h2>Feedback</h2>
      <p className="muted">
        {`The phone buzzes briefly for each photo, then long when the slip matched, twice when it needs review, or briefly again when it was the slip just taken. When recognition falls behind, the header shows how many slips are still recognising; past ${MAX_WAITING}, a slip keeps only its photo and goes to Review.`}
      </p>
      <label className="check">
        <input type="checkbox" checked={settings.beep} onChange={(e) => onBeep(e.target.checked)} />
        Beep too
      </label>
      <h2>Without the camera</h2>
      <p className="muted">Run one picture of a slip through the same recognition, for example a slip the camera missed.</p>
      <PhotoButton onPhoto={onPhoto} />
    </section>
  );
}
