// milo-node.mjs: run the Milo embedder in node, for build-art-catalog.mjs and
// eval-art-catalog.mjs.
//
// Uses the same onnxruntime-web 1.24.3 package and wasm backend as the page (its node build),
// the vendored model public/models/milo-1.0.0.onnx, and the page's own preprocessing,
// src/scan/vision/preprocess.ts, which node 24 loads directly by stripping the types. Images
// are decoded with jimp (devDependency).

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import * as ort from 'onnxruntime-web';
import { Jimp } from 'jimp';
import { preprocess, l2Normalize, MILO_SIZE } from '../../src/scan/vision/preprocess.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MODEL_PATH = join(ROOT, 'public', 'models', 'milo-1.0.0.onnx');

let session = null;

export async function loadMilo({ threads = Math.min(cpus().length, 4) } = {}) {
  if (session) return session;
  ort.env.wasm.numThreads = threads;
  ort.env.logLevel = 'error';
  const model = await readFile(MODEL_PATH);
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  return session;
}

/** Decodes an image file (JPEG or PNG bytes) into { data, width, height } RGBA. */
export async function decodeImage(bytes) {
  const img = await Jimp.read(Buffer.from(bytes));
  return { data: img.bitmap.data, width: img.bitmap.width, height: img.bitmap.height };
}

/** Embeds an RGBA image; returns an L2-normalised Float32Array(128). */
export async function embedImage(img, { rotate180 = false } = {}) {
  const s = await loadMilo();
  const data = preprocess(img, { rotate180 });
  const tensor = new ort.Tensor('float32', data, [1, 3, MILO_SIZE, MILO_SIZE]);
  const out = await s.run({ [s.inputNames[0]]: tensor });
  return l2Normalize(out[s.outputNames[0]].data);
}

export { Jimp };
