# CollectorVision integration facts

Research date: 2026-10-25. Question: what exactly do we need to know to run CollectorVision's Milo
embedder and its hosted catalog inside our own Scan page, with a fixed guide-box crop instead of the
Cornelius corner detector?

All file references are to https://github.com/HanClinto/CollectorVision at commit
`8b295ab80a997766afc00c640a616c1f2716df21` (main on 2026-10-25), read through
`https://raw.githubusercontent.com/HanClinto/CollectorVision/main/<path>`. Line numbers are from
that commit. Other sources are given as full URLs. Numbers marked "measured" were computed on
2026-10-25 from the downloaded files, not copied from documentation.

Note on file locations: `ARCHITECTURE.md` and the applet are not at the repository root. They are at
`examples/web_scanner/ARCHITECTURE.md` and `examples/web_scanner/lib/collectorvision-scanner-applet.mjs`.
There is no `catalog/` file that defines the hosted catalog format; `catalog/README.md` covers only
custom NPZ catalogs. The hosted catalog format lives in
`examples/web_scanner/lib/collectorvision-catalog-v2.mjs`, `docs/catalog-v2-client.md` and the
separate repository https://github.com/HanClinto/CollectorVisionCatalog.

## 1. Milo, the embedder

### Files and sizes

| What | Value | Source |
|---|---|---|
| Registry entry | `milo-1.0.0`, family `milo`, task `card-embedding`, architecture `mobilevit-xxs-arcface`, input_size 448 | `collector_vision/data/model_registry.json` lines 26-37 |
| Hugging Face repo and revision | `HanClinto/milo`, revision `9bcc5e809e936b8c5630d1e7101aae1de1e76621`, filename `model.onnx` | same, lines 32-34 |
| Size | 5,191,100 bytes | same, line 36; confirmed by `x-linked-size: 5191100` on the URL below (measured) |
| SHA-256 | `bd13d8d60383c69da04dce261f32e93fdaeaa8fd618fbc991e7385f71b3d45df` | same, line 35; the downloaded file matches (measured) |
| Download URL (immutable) | https://huggingface.co/HanClinto/milo/resolve/9bcc5e809e936b8c5630d1e7101aae1de1e76621/model.onnx | built from the registry entry the way `docs/model_registry_hub.md` lines 7-19 describe |
| CORS | The URL answers 302 with `access-control-allow-origin` echoing our origin, then 200 from a CDN with `access-control-allow-origin: *` (measured with `Origin: https://codingadveenture.github.io`) | curl, 2026-10-25 |
| Licence of the weights | `license: agpl-3.0` | https://huggingface.co/HanClinto/milo (model card front matter) |
| Copy inside the code repo | `collector_vision/weights/milo.onnx` | repository tree |

Cornelius, for reference only (we do not use it): `cornelius-2.12`, `HanClinto/cornelius`, revision
`9280009f5a66f75f952820d9dadb894909b759b7`, `cornelius-2.12.onnx`, 4,407,545 bytes
(`collector_vision/data/model_registry.json` lines 14-25).

### ONNX graph facts (measured from the downloaded file)

- IR version 10, producer PyTorch 2.10.0, default-domain opset 18.
- Metadata: `version=1.0.0`, `codename=milo`, `task=card-embedding`,
  `base_model=apple/mobilevit-xx-small`, `input_size=448`, `embedding_dim=128`.
- Input: name **`image`**, float32, shape `[1, 3, 448, 448]` (static batch of 1, NCHW).
- Output: name **`embedding`**, float32, shape `[1, 128]`.
- The graph ends in `ReduceL2`, `Clip`, `Expand`, `Div`, so it already L2-normalises inside the
  model. Both runtimes normalise again anyway (see below), which is harmless.
- Operators used: Conv, Sigmoid, Mul, Add, Reshape, Transpose, LayerNormalization, MatMul, Slice,
  Squeeze, Softmax, Concat, ReduceMean, Gemm, ReduceL2, Clip, Expand, Div. LayerNormalization needs
  opset 17 or later; ORT-Web 1.24.3 supports opset 18 on the WASM backend (the upstream demo runs
  this exact file on it).

The Hugging Face model card's "Direct ONNX usage" snippet feeds `{"pixel_values": x}`. That name is
wrong for this file; the input is `image`. Both runtimes avoid the problem by reading the name from
the session (`collector_vision/embedders/neural.py` lines 131-132, `examples/web_scanner/scanner.worker.mjs`
line 648). We should do the same.

### Exact preprocessing

Python reference, `collector_vision/embedders/neural.py`:
- Lines 19-20: ImageNet mean `[0.485, 0.456, 0.406]`, std `[0.229, 0.224, 0.225]`.
- Lines 23-27: `_ensure_portrait` rotates a landscape image by 90 degrees (PIL `ROTATE_90`,
  counter-clockwise) so it is portrait.
- Lines 30-49: convert to RGB, `resize((448, 448), Image.BILINEAR)` (a plain squash to a square,
  no crop, no padding, aspect ratio not kept), divide by 255, subtract mean, divide by std, transpose
  HWC to CHW, add a batch axis.
- Lines 166-170: L2-normalise the output.
- Docstring lines 1-8: "Input 448x448 RGB, outputs a L2-normalised 128-d float32 embedding."

Browser reference, `examples/web_scanner/scanner.worker.mjs`:
- Lines 26-31: `EMBEDDER_SIZE = 448`, dewarp target 448x448, same mean and std.
- Lines 826-882: the dewarp maps the four card corners onto a 448x448 square with bilinear sampling,
  so the card is stretched from about 63:88 to 1:1. The corner ordering (lines 65-110) puts the
  shortest edge on top, which gives a portrait card.
- Lines 884-917 (`embed`): draw the crop canvas onto a 448x448 `OffscreenCanvas` with
  `drawImage(crop, 0, 0, 448, 448)` (optionally rotated 180 degrees first), then lines 508-522 read
  RGBA, divide by 255, normalise per channel and write planar R, G, B into a `Float32Array` of
  1x3x448x448. Line 905 L2-normalises the output again.
- `docs/edge_model_optimization.md` line 55: "RGB, ImageNet mean/std, Cornelius 384x384, Milo 448x448."

So for our fixed guide box: crop the card-shaped rectangle from the frame, rotate to portrait if
needed, squash it to 448x448 (do not letterbox or centre-crop), RGB order, scale to 0-1, ImageNet
mean and std, planar NCHW float32.

### The 180-degree pass

It is part of the browser pipeline and on by default:
- `examples/web_scanner/ARCHITECTURE.md` line 19: "The worker can also embed a 180-degree rotation
  and keep the stronger match."
- `scanner.worker.mjs` lines 919-936 (`identify`): embed upright, search; if `rotationInvariant`,
  embed the 180-degree rotation, search, keep the higher score (`chooseBetterMatch`, lines 255-257).
- Line 1146: `data.rotationInvariant !== false`, so it is on unless the init message turns it off.
- Python has the same option (`collector_vision/transforms.py` lines 8-10, `examples/quickstart_rot_invariant.py`).

It doubles the Milo cost per slip. On our rig the slip lands in the guide box face up but possibly
upside down, so keep it unless the feeding routine fixes the orientation.

## 2. The hosted catalog

### Where it lives

Catalog v2 is the default for the browser scanner (`examples/web_scanner/README.md` lines 12-17) and
recommended in the root `README.md` (lines 7-10).

- Feed URL: https://hanclinto.github.io/CollectorVisionCatalog/catalog-v2/catalog-feed-v2.json
  (`examples/web_scanner/lib/collectorvision-catalog-v2.mjs` lines 10-11). 341,371 bytes on
  2026-10-25 (measured). CORS `access-control-allow-origin: *` (measured).
- The feed holds, per embedding family (`milo1`), the embedding description and every catalog. For
  MTG from Scryfall (`families.milo1.catalogs["scryfall/mtg"]`, measured on 2026-10-25):
  - `embedding`: model `milo-1.0.0@sha256:bd13d8d6...` (the same file as above), `dimensions: 128`,
    `dtype: "float16"`, `byte_order: "little"`, `layout: "row-major"`.
  - `descriptor.description`: "English-first paper printings from Scryfall default cards.",
    `result_identifier: "scryfall_card"`.
  - `current_version: 66`, `rows: 113936`.
  - `base`: version 60, 113,628 rows, two gzip assets:
    - embeddings https://hanclinto.github.io/CollectorVisionCatalog/catalog-v2/scryfall-mtg/version/60/base/embeddings.f16.gz,
      26,593,195 bytes, sha256 `a3635d57...`
    - records https://hanclinto.github.io/CollectorVisionCatalog/catalog-v2/scryfall-mtg/version/60/base/records.jsonl.gz,
      9,089,318 bytes, sha256 `5d013dd2...`
  - `updates`: daily deltas keyed by version (37 to 66 listed), each with
    `.../version/<n>/delta-from-<n-1>/embeddings.f16.gz` and `records.jsonl.gz`.
- The base version and the URLs move, so code must read them from the feed, not hard-code them.
- The catalog repository is MIT-licensed (https://api.github.com/repos/HanClinto/CollectorVisionCatalog).
- Its build config says `"bulk_type": "default_cards"`, `"paper_only": true`
  (https://raw.githubusercontent.com/HanClinto/CollectorVisionCatalog/main/config/catalogs.json lines 10-17).
- An older v1 format (one NPZ per catalog on Hugging Face) still exists:
  https://huggingface.co/HanClinto/milo/resolve/main/catalogs/manifest.json lists
  `milo1-scryfall-mtg-2026-07-09.npz` as the latest `scryfall-mtg` file. The v1 browser bundle is a
  GitHub release asset, not a public URL we should depend on (`examples/web_scanner/README.md`
  lines 26-34).

### Binary layout

- Embeddings asset: gzip of raw little-endian float16, row-major, `rows x 128` values, **no header**.
  After gunzip the byte length must equal `rows * 128 * 2`
  (`collectorvision-catalog-v2.mjs` lines 963-973, `parseFloat16Matrix`). Row size is 256 bytes.
  The base embeddings unpack to 113,628 x 256 = 29,088,768 bytes (computed).
- Records asset: gzip of JSON Lines, one object per embedding row, in the same order: line r of
  `records.jsonl` belongs to row r of `embeddings.f16` (`collectorvision-catalog-v2.mjs` lines 401-426).
- Gzip is unpacked with `DecompressionStream("gzip")` and each asset is checked against the feed's
  size and SHA-256 (`collectorvision-catalog-v2.mjs` lines 711-720 and 1154-1163).
- After loading, rows are sorted by `id`, then `id:face:<n>` (lines 429-432 and 951-957).
- Deltas are JSON Lines of `{"op": "upsert" | "delete", "record": {...}, "embedding_index": n}`;
  `embedding_index` points into that delta's own embeddings file (lines 480-600; first row of
  version 61 measured).

### What a record contains (measured from base version 60)

Example row:

```json
{"finishes":["foil","nonfoil"],"id":"0000419b-0bba-4488-8f7a-6194544ce91e",
 "identifiers":{"scryfall_oracle":"b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6","tcgplayer_product":"558404"},
 "metadata":{"cmc":0,"collector_number":"280","colors":[],"lang":"en","layout":"normal","promo":false,
 "rarity":"common","set":"blb","set_name":"Bloomburrow"},"name":"Forest"}
```

- `id` is the Scryfall card id (printing id). `identifiers.scryfall_oracle` is the oracle id.
- `name`, `metadata.set`, `metadata.set_name`, `metadata.collector_number`, `metadata.lang`,
  `metadata.layout`, `metadata.promo`, `metadata.rarity` are present.
- **No `illustration_id`** and **no `digital` flag**. We join to illustration ids through our own
  `public/data/printings/<oracle_id>.json` by Scryfall id.
- Faces: `face_index` is omitted for face 0 and is `1` for the back face. Base 60 has 109,564
  face-0 rows and 4,064 face-1 rows (113,628 rows, 109,564 distinct ids). Face-1 rows by layout:
  art_series 2,608, transform 991, modal_dfc 261, double_faced_token 121, reversible_card 83. A
  face-1 row's `name` is the face name (for example "Balamb Garden, Airborne"), not the full card
  name. The builder makes one row per `card_faces[]` entry that has its own image
  (https://raw.githubusercontent.com/HanClinto/CollectorVisionCatalog/main/src/collectorvision_catalog/sources/scryfall.py
  lines 41-63).
- Reference images come from Scryfall `image_uris`, preferring `png`, then `large`, then `normal`
  (same file, line 11).
- Contents beyond real cards: 3,049 token rows, 5,221 art_series rows, 140 emblems, plus planar,
  scheme and vanguard. Languages: 110,992 `en`, the rest mostly `es`, `ja`, `fr` (where Scryfall
  default_cards has no English printing).
- 999 distinct set codes.

### Coverage of our printings (measured)

Checked every printing in `public/data/printings/*.json` (537 files, 5,082 printings) against the
base version 60 ids:

| Printings in our files | Count | In the catalog |
|---|---:|---:|
| Paper (`digital: false`) | 4,485 | 4,484 |
| Digital-only (`digital: true`) | 597 | 0 |

- The one missing paper printing is Bristly Bill, Spine Sower `sds` 15
  (`9845bd74-326f-4506-87f9-ead7d2fa6cfa`), released 2026-11-13, so not yet published.
- All 72 paper printings in our files that have a `back_image_normal` have both a face-0 and a
  face-1 row in the catalog.
- Gleemox has no paper printing at all (only `prm` 26584, digital), so it has no catalog row.
- The deltas from version 61 to 66 (517 operations) contain no `vma` rows.

### Tropical Island VMA 321 and Scrubland VMA 313

| Card | Scryfall id (from our printings files) | `digital` | In the catalog |
|---|---|---|---|
| Tropical Island, VMA 321 | `47033ba4-8f26-4a6b-97bd-5b366327325e` | true | **no** |
| Scrubland, VMA 313 | `9d471e36-a3ab-4a96-ba4b-8eca921ea37a` | true | **no** |

The base has zero rows with `set: "vma"`. This matches the miss in the Owner's demo run: a slip
whose art exists only in a digital-only set cannot be found in this catalog. To recognise such slips
we must embed those 597 digital printings ourselves with Milo from the Scryfall images (ideally the
`png` or `large` size, to match how the catalog was built) and append them to our filtered catalog.

## 3. ONNX Runtime Web

- Version: **onnxruntime-web 1.24.3**, taken from the npm tarball
  `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.24.3.tgz`
  (`scripts/export_web_scanner_assets.py` lines 41-43).
- Files vendored into `vendor/onnxruntime-web/` (same file, lines 55-60):
  `ort.webgpu.min.mjs`, `ort.webgpu.min.mjs.map`, `ort-wasm-simd-threaded.asyncify.mjs`,
  `ort-wasm-simd-threaded.asyncify.wasm`.
- The worker imports `./vendor/onnxruntime-web/ort.webgpu.min.mjs` (`scanner.worker.mjs` line 20)
  and does not set `ort.env.wasm.wasmPaths`, so ORT loads the `.wasm` and its `.mjs` loader from
  the same folder as the bundle (same origin).
- Why that bundle: `ort.all.min.mjs` with the JSEP backend returned all zeros for Conv on Android in
  1.20 to 1.24.3 (`scripts/export_web_scanner_assets.py` lines 45-53;
  `examples/web_scanner/ARCHITECTURE.md` lines 59-70).
- Execution provider: `wasm` by default; `webgpu` only if the init message asks and WebGPU is
  available (`scanner.worker.mjs` lines 639-645, 1128-1135). WebGPU gives wrong output on Android
  ARM (issues #9 and #12) and is disabled in Firefox (lines 533-539). We should use `wasm` only.
- Threads: `ort.env.wasm.numThreads = isIOS() ? 1 : min(hardwareConcurrency, 4)` (lines 624-634).

### Cross-origin isolation

- Multi-threaded WASM needs `SharedArrayBuffer`, which needs `crossOriginIsolated`. The worker's
  own comment, lines 625-628: "multi-threaded WASM requires SharedArrayBuffer / COOP+COEP headers.
  Without them ort-web silently falls back to 1 thread."
- GitHub Pages cannot send COOP and COEP headers, so the demo registers
  `examples/web_scanner/coi-serviceworker.js` (from `index.html` lines 28-70). It adds
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Resource-Policy: cross-origin` to same-origin responses only, and reloads the page
  once on the first visit (`coi-serviceworker.js` lines 1-17 and 40-75). It is based on
  https://github.com/gzuidhof/coi-serviceworker (MIT).
- The demo shows "1 of N (not isolated - COI SW pending?)" when isolation is missing
  (`examples/web_scanner/app.js` lines 2288-2290).
- Without isolation nothing breaks; inference simply runs on one thread. iOS is forced to one thread
  anyway.
- Under `require-corp`, cross-origin loads must be CORS or carry CORP. The catalog feed and
  `cards.scryfall.io` images both answer with `access-control-allow-origin: *` and no CORP header
  (measured), so `fetch()` and `<img crossorigin>` work, but a plain `<img src>` without
  `crossorigin` would be blocked. Firebase traffic is CORS and should be fine, but this is
  untested in our app.

## 4. Embedding one already-cropped card, without Cornelius

The upstream worker has no message for "embed this crop". Its protocol (`scanner.worker.mjs` lines
5-18 and 1125-1180) is:

- main to worker: `{type: "init", manifest, assetBasePath, enableWebGpu, rotationInvariant,
  minCornerConfidence, catalogMode, catalogLimit}`; `{type: "frame", bitmap, captureRequested,
  includeDebugBitmaps}` with the `ImageBitmap` transferred; `{type: "config", minCornerConfidence}`.
- worker to main: `progress`, `ready` (with `inferenceMode`, `numThreads`, `catalogRows`, ...),
  `result` (with `cardId`, `cardName`, `secondaryId` = oracle id, `score`, `orientation`, timings),
  `error`.
- A `frame` always runs Cornelius first (`processFrame`, lines 980-1105). Bypassing it means
  writing our own small worker around the reusable parts:
  - `WorkerRuntime.embed(cropCanvas, rotate180)` (lines 884-917): any canvas or bitmap of any size
    is drawn onto a 448x448 canvas, so the crop size and aspect are free; it is squashed to a
    square. Feeding a portrait card-shaped crop (about 63:88) matches what the dewarp produces.
  - `fillInputTensorFromContext` (lines 508-522), `normalizeEmbedding` (lines 241-253).
  - `identify` (lines 919-936) for the optional 180-degree pass.
- The upstream search returns **top-1 only** (`search`, lines 938-968): a linear scan over all rows,
  dot product of the float16 row (through a 65,536-entry float16-to-float32 lookup table, lines
  306-337) with the float32 query. `BrowserCatalogV2.search(query, k)` also takes a top-k
  (`docs/catalog-v2-client.md` lines 86-88; `collectorvision-catalog-v2.mjs` lines 92-107).
  The Python reference is `collector_vision/retrieval.py` lines 14-55: score = catalog @ query on
  L2-normalised vectors, top-k by `argpartition`.
- Since both sides are L2-normalised, the dot product is the cosine similarity. For our review
  queue we need top-k with candidates grouped by name, which is a small change to that loop.
- Applet defaults, for reference: `scanIntervalMs: 900`, `matchThreshold: 0.5`,
  `consecutiveMatches: 2`, `cooldownMs: 3500`, camera 1280x720 ideal
  (`examples/web_scanner/lib/collectorvision-scanner-applet.mjs` lines 7-31).

## 5. Licence obligations

- Code: AGPL-3.0, "AGPL-3.0-or-later" in `pyproject.toml` line 10; `LICENSE` is the GNU AGPL v3
  text; root `README.md` lines 212-214. Author: HanClinto (`pyproject.toml` line 12).
- Milo weights: `license: agpl-3.0` on https://huggingface.co/HanClinto/milo.
- Catalog data (CollectorVisionCatalog): MIT.
- onnxruntime-web: MIT (https://github.com/microsoft/onnxruntime/blob/main/LICENSE).
- coi-serviceworker: MIT (https://github.com/gzuidhof/coi-serviceworker).
- A commercial and a free noncommercial licence are also offered (`COMMERCIAL_LICENSE.md`); we do
  not need them because our repo is AGPL-3.0 and public.

What the AGPL asks of us when we vendor the model and adapt parts of the worker
(https://www.gnu.org/licenses/agpl-3.0.html, sections 4, 5 and 13):

1. Keep the upstream copyright and licence notices on what we copy (section 4).
2. Mark modified files with a prominent notice that we changed them and when (section 5a). A
   header comment in our worker file such as "Adapted from HanClinto/CollectorVision
   examples/web_scanner/scanner.worker.mjs at commit 8b295ab, AGPL-3.0-or-later; changed by the
   cube project on <date>: removed corner detection, added top-k search."
3. License the whole combined work under the AGPL (section 5c); our repo already is.
4. Offer the Corresponding Source to everyone who uses the page over the network (section 13): a
   visible link on the Scan page (or the app footer) to https://github.com/codingadveenture/cube.
   The source must include the vendored `.onnx` file or exact instructions to fetch it.
5. Add a third-party notices file (for example `THIRD_PARTY_NOTICES.md`) listing: CollectorVision
   (HanClinto, AGPL-3.0-or-later, source URL and commit), the Milo model (Hugging Face
   `HanClinto/milo`, revision, SHA-256, AGPL-3.0), the catalog data (CollectorVisionCatalog, MIT,
   with its copyright line), onnxruntime-web 1.24.3 (MIT, with its licence text if we vendor the
   files instead of installing them from npm) and coi-serviceworker (MIT, if vendored).

This is a reading of the licence text, not legal advice.

## 6. Corrections to `browser-scanner.md` (sections 3c and 4)

- Catalog size: "~108k reference embeddings" is out of date. The live catalog has 113,936 rows
  (version 66), of which 4,064 in the base are back faces, so 109,564 distinct printings. Full
  float16 size is about 29.2 MB unpacked, downloaded as a 26.6 MB gzip plus small deltas.
- The hosted catalog contains no digital-only printings (`paper_only: true`). Filtering it by our
  Scryfall ids covers 4,484 of our 4,485 paper printings and 0 of our 597 digital-only printings.
  Slips printed from digital-only art (for example VMA Tropical Island and Scrubland) need
  embeddings we compute ourselves.
- The catalog records carry no `illustration_id`; the same-art grouping in section 4.3 must join
  through our printings files.
- Section 4.3 says to embed back faces ourselves. Not needed for paper printings: the catalog
  already has a face-1 row for every paper double-faced printing in our files. Note that face-1 rows
  carry the face name, so map by Scryfall id, not by name.
- Section 4.1 "CollectorVision already streams and caches it in IndexedDB": the v2 client downloads
  each gzip asset whole, checks its SHA-256 and caches the rebuilt snapshot in IndexedDB. It does not
  stream rows.
- "Models: about 9.6 MB": without Cornelius we need only Milo, 5,191,100 bytes. (The 8.23 MiB for
  Cornelius in `docs/edge_model_optimization.md` lines 7-10 is also out of date; the registry says
  4,407,545 bytes.)
- The crop is a 448x448 square: the card is squashed to 1:1, not kept at card aspect. Our guide-box
  crop must be squashed the same way.
- The upstream worker returns only the best match. The margin and grouping rules in section 4.2
  need our own top-k search.
- The Hugging Face card's example uses input name `pixel_values`; the real input is `image`.
- `research/01-scanning-synthesis.md` section 3 matches these facts except for the same catalog
  points (size, digital printings, models 9.6 MB).

## 7. Open questions

- Canvas `drawImage` downscaling (browser default smoothing) is not the same filter as PIL
  `BILINEAR` with antialiasing, which the catalog was presumably built with. The effect on scores
  for a large camera crop is unmeasured; downscaling in steps or setting
  `imageSmoothingQuality = "high"` may matter.
- Whether we may add `onnxruntime-web@1.24.3` as an npm dependency, or must vendor the four files
  like upstream.
- Whether to ship a filtered catalog file in our repo (about 5,082 rows x 256 bytes, about 1.3 MB)
  built by a script, or load the hosted feed at run time. The feed changes daily; a frozen file
  needs a refresh step.
- How to compute embeddings for the 597 digital-only printings: in the browser with the same worker,
  or in a Node script with `onnxruntime-node`. Either way the preprocessing must match exactly.
- Whether the COI service worker interferes with Firebase or the existing hash routing on GitHub
  Pages, and whether one thread is fast enough for one slip at a time.
- Whether to keep the 180-degree pass (doubles Milo time) or orient slips consistently.
- Milo latency on the Owner's phone with WASM, one thread and four threads.
