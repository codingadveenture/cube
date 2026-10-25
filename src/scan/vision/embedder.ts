// embedder.ts: the Milo embedder on onnxruntime-web.
//
// Facts from research/collectorvision-integration.md sections 1 and 3:
// - model milo-1.0.0 (HanClinto/milo, revision 9bcc5e8, sha256 bd13d8d6...45df, AGPL-3.0),
//   vendored at public/models/milo-1.0.0.onnx (5,191,100 bytes);
// - input [1, 3, 448, 448] float32, output [1, 128] float32; the input is named "image", but the
//   name is read from the session because the model card says "pixel_values";
// - onnxruntime-web 1.24.3 on the plain wasm backend. We import "onnxruntime-web/wasm", which
//   has no WebGPU/JSEP code: upstream avoids the JSEP bundle because it returned all-zero Conv
//   output on Android, and WebGPU is broken on Android ARM;
// - more than one thread needs cross-origin isolation (SharedArrayBuffer); without it ORT runs
//   on one thread, which works but is slower. iOS is held to one thread, as upstream does.
// onnxruntime-web is imported lazily, so it is never part of the main bundle.
import { l2Normalize, MILO_SIZE } from './preprocess';

export const MODEL_FILE = 'models/milo-1.0.0.onnx';

export interface Embedder {
  embed(input: Float32Array): Promise<Float32Array>;
  readonly threads: number;
  readonly inputName: string;
}

type Ort = typeof import('onnxruntime-web/wasm');

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function threadCount(): number {
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  if (!isolated || isIOS()) return 1;
  return Math.max(1, Math.min(navigator.hardwareConcurrency || 1, 4));
}

/** Downloads a URL, reporting the fraction received when the size is known. */
async function fetchWithProgress(url: string, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > out.length) {
      // Content-Length was the compressed size; fall back to collecting chunks.
      const rest: Uint8Array[] = [out.subarray(0, received), value];
      received += value.length;
      for (;;) {
        const more = await reader.read();
        if (more.done) break;
        rest.push(more.value);
        received += more.value.length;
      }
      const all = new Uint8Array(received);
      let o = 0;
      for (const c of rest) {
        all.set(c, o);
        o += c.length;
      }
      onProgress(1);
      return all;
    }
    out.set(value, received);
    received += value.length;
    onProgress(received / total);
  }
  return out.subarray(0, received);
}

let embedderPromise: Promise<Embedder> | null = null;

/** Loads onnxruntime-web and the Milo model once per session. */
export function loadEmbedder(onProgress?: (fraction: number) => void): Promise<Embedder> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const ort: Ort = await import('onnxruntime-web/wasm');
      const threads = threadCount();
      ort.env.wasm.numThreads = threads;
      const model = await fetchWithProgress(`${import.meta.env.BASE_URL}${MODEL_FILE}`, onProgress);
      const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
      const inputName = session.inputNames[0];
      const outputName = session.outputNames[0];
      return {
        threads,
        inputName,
        async embed(input: Float32Array): Promise<Float32Array> {
          const tensor = new ort.Tensor('float32', input, [1, 3, MILO_SIZE, MILO_SIZE]);
          const out = await session.run({ [inputName]: tensor });
          const data = out[outputName].data as Float32Array;
          tensor.dispose();
          return l2Normalize(data);
        },
      };
    })();
    embedderPromise.catch(() => {
      embedderPromise = null;
    });
  }
  return embedderPromise;
}
