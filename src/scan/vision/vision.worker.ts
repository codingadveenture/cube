// vision.worker.ts: the recognition worker. It owns the Milo model and the art catalog
// (prepareScanner) and recognises one guide-box crop per message, so the camera loop on the
// main thread keeps drawing while a slip is embedded (about 200 ms per pass on a desktop core,
// unknown on the phone). Created by client.ts as a module worker.
//
// The ORT wasm file is found through new URL(..., import.meta.url) inside onnxruntime-web, which
// Vite rewrites to the emitted asset under the '/cube/' base, so no wasmPaths is needed here.
import { prepare, recognise, setExpected } from './recognise';
import type { FromWorker, ToWorker } from './protocol';

const scope = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};

const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

// Scans run one at a time, in the order they arrive.
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'prepare') {
    prepare((progress) => post({ type: 'progress', progress }))
      .then((info) => post({ type: 'ready', info }))
      .catch((err: unknown) => post({ type: 'prepare-error', message: err instanceof Error ? err.message : String(err) }));
  } else if (msg.type === 'expected') {
    setExpected(msg.entries);
  } else if (msg.type === 'scan') {
    queue = queue.then(() =>
      recognise(msg.image, msg.request)
        .then((result) => post({ type: 'result', id: msg.id, result }, [result.embedding.buffer]))
        .catch((err: unknown) => post({ type: 'scan-error', id: msg.id, message: err instanceof Error ? err.message : String(err) })),
    );
  }
};
