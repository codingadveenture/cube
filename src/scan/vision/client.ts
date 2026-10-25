// client.ts: the camera view's handle on recognition. It starts vision.worker.ts as a module
// worker; when no module worker can be started (an old browser, or the script fails to load) it
// falls back to running recognise.ts on the main thread, which works but blocks the page during
// each pass. The view never imports the scanner itself, so the model code stays in the worker's
// chunk (or a lazy chunk for the fallback).
import type { PrepareProgress } from './index';
import type { ExpectedEntries, FromWorker, PrepareInfo, RecogniseRequest, RecogniseResult, ToWorker } from './protocol';

export type VisionMode = 'worker' | 'main';

export interface VisionClient {
  /** 'worker' until the worker fails to start, then 'main'. */
  readonly mode: VisionMode;
  prepare(onProgress?: (p: PrepareProgress) => void): Promise<PrepareInfo>;
  setExpected(entries: ExpectedEntries): void;
  /** Recognises one crop. The image's pixel buffer is transferred to the worker. */
  scan(image: ImageData, request: RecogniseRequest): Promise<RecogniseResult>;
  dispose(): void;
}

interface Backend {
  prepare(onProgress?: (p: PrepareProgress) => void): Promise<PrepareInfo>;
  setExpected(entries: ExpectedEntries): void;
  scan(image: ImageData, request: RecogniseRequest): Promise<RecogniseResult>;
  dispose(): void;
}

/** The worker could not be started or crashed while loading. */
class WorkerStartError extends Error {}

function workerBackend(): Backend {
  const worker = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module' });
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: RecogniseResult) => void; reject: (e: Error) => void }>();
  let preparing: {
    resolve: (i: PrepareInfo) => void;
    reject: (e: Error) => void;
    onProgress?: (p: PrepareProgress) => void;
  } | null = null;
  let ready: Promise<PrepareInfo> | null = null;
  let started = false;

  worker.addEventListener('message', (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === 'progress') preparing?.onProgress?.(m.progress);
    else if (m.type === 'ready') {
      started = true;
      preparing?.resolve(m.info);
      preparing = null;
    } else if (m.type === 'prepare-error') {
      started = true;
      preparing?.reject(new Error(m.message));
      preparing = null;
      ready = null;
    } else if (m.type === 'result' || m.type === 'scan-error') {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.type === 'result') p?.resolve(m.result);
      else p?.reject(new Error(m.message));
    }
  });
  worker.addEventListener('error', (e) => {
    e.preventDefault();
    const err = started ? new Error(e.message || 'The recogniser stopped.') : new WorkerStartError(e.message || 'The worker did not start.');
    preparing?.reject(err);
    preparing = null;
    ready = null;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });

  const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

  return {
    prepare(onProgress) {
      if (!ready) {
        ready = new Promise<PrepareInfo>((resolve, reject) => {
          preparing = { resolve, reject, onProgress };
        });
        send({ type: 'prepare' });
      } else if (preparing) {
        preparing.onProgress = onProgress;
      }
      return ready;
    },
    setExpected(entries) {
      send({ type: 'expected', entries });
    },
    scan(image, request) {
      const id = nextId++;
      return new Promise<RecogniseResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const data = image.data;
        send({ type: 'scan', id, image: { data, width: image.width, height: image.height }, request }, [data.buffer]);
      });
    },
    dispose() {
      worker.terminate();
      for (const p of pending.values()) p.reject(new Error('closed'));
      pending.clear();
    },
  };
}

function mainBackend(): Backend {
  const mod = import('./recognise');
  let queue: Promise<unknown> = Promise.resolve();
  return {
    prepare: (onProgress) => mod.then((m) => m.prepare(onProgress)),
    setExpected: (entries) => void mod.then((m) => m.setExpected(entries)),
    scan(image, request) {
      const run = queue.then(() => mod.then((m) => m.recognise(image, request)));
      queue = run.catch(() => undefined);
      return run;
    },
    dispose() {},
  };
}

export function createVisionClient(): VisionClient {
  let mode: VisionMode = 'worker';
  let backend: Backend;
  let expected: ExpectedEntries | null = null;
  try {
    backend = typeof Worker === 'undefined' ? mainBackend() : workerBackend();
    if (typeof Worker === 'undefined') mode = 'main';
  } catch (e) {
    console.warn('Recognition worker could not be created; running on the main thread', e);
    backend = mainBackend();
    mode = 'main';
  }

  const fallBack = (why: unknown) => {
    console.warn('Recognition worker failed to start; running on the main thread', why);
    backend.dispose();
    backend = mainBackend();
    mode = 'main';
    if (expected) backend.setExpected(expected);
  };

  return {
    get mode() {
      return mode;
    },
    async prepare(onProgress) {
      try {
        return await backend.prepare(onProgress);
      } catch (e) {
        if (!(e instanceof WorkerStartError)) throw e;
        fallBack(e);
        return backend.prepare(onProgress);
      }
    },
    setExpected(entries) {
      expected = entries;
      backend.setExpected(entries);
    },
    async scan(image, request) {
      try {
        return await backend.scan(image, request);
      } catch (e) {
        if (!(e instanceof WorkerStartError)) throw e;
        fallBack(e);
        // The buffer went to the dead worker; the caller keeps its own copy for a retry.
        throw new Error('The recogniser restarted; try again.');
      }
    },
    dispose() {
      backend.dispose();
    },
  };
}
