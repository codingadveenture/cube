// eval-art-catalog.mjs: offline proof that the scanner's preprocessing, model and search are
// wired right, and the source of the default thresholds in src/scan/vision/match.ts.
//
// Usage (from the repo root, after build-art-catalog.mjs):
//   node scripts/eval-art-catalog.mjs [--threads N] [--seed S]
//
// 1. Samples 60 rows of public/data/art-catalog.json with a fixed seed, one per card: 20 front
//    faces of paper printings released before 2003 (old frame), 25 front faces of paper
//    printings from 2003 on, 10 digital printings (set vma or prm, embedded by
//    build-art-catalog.mjs) and 5 back faces. It also takes 20 impostors: printings of cards
//    that are not in our catalog (15 cards and 5 tokens from the hosted CollectorVision catalog),
//    which stand for stray cards in the box, and two empty frames (the white sheet, and the sheet
//    with sensor noise).
// 2. Downloads each printing's Scryfall "normal" JPG into scripts/.cache/eval-images/, 100 ms
//    apart.
// 3. Makes these inputs per image: "clean" (the JPG itself); "rig", which imitates a phone
//    15 cm above a slip (scaled to 60 percent, rotated 2 degrees either way with white corners,
//    blurred with a gaussian of radius 1, brightness and contrast each jittered by up to
//    15 percent, re-encoded as JPEG quality 70); "rig + margin", the same with 5 percent of white
//    sheet around the slip before the rotation (a guide box a little larger than the slip); and
//    "clean, refined", "rig, refined" and "rig + margin, refined", each of those cropped to
//    refineCardBox() from preprocess.ts (the path the camera view runs: on a slip that fills the
//    crop, refineCardBox should return the whole crop).
//    A framing check then embeds each clean image with one change at a time (scale, margin,
//    inset, rotation, blur, JPEG, jitter). Image work uses jimp (devDependency) and plain
//    pixel loops.
// 4. Runs the page's pipeline on each input: src/scan/vision/preprocess.ts (loaded directly by
//    node), Milo on onnxruntime-web (scripts/lib/milo-node.mjs), both orientations as
//    scanCrop() does, a top-100 cosine search (the loop below repeats ArtCatalog.search in
//    src/scan/vision/catalog.ts, which node cannot import because of import.meta.env), and
//    decide() from src/scan/vision/match.ts.
// 5. Reports accuracy, score distributions, the thresholds with zero wrong names, and the time
//    per embed, a held-out check of the threshold rule, into research/art-catalog-eval.md and scripts/.cache/eval-results.json.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { decodeFloat16 } from '../src/scan/vision/float16.ts';
import { resizeBilinear, cropImage, refineCardBox, luminanceSpread } from '../src/scan/vision/preprocess.ts';
import { decide, groupByCard, printingVerdict } from '../src/scan/vision/match.ts';
import { loadMilo, decodeImage, embedImage, Jimp } from './lib/milo-node.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'public', 'data');
const CACHE = join(ROOT, 'scripts', '.cache');
const IMAGES = join(CACHE, 'eval-images');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const THREADS = arg('--threads', 1);
const SEED = arg('--seed', 20261025);
const UA = { 'User-Agent': 'cube-app-build/0.1 (github.com/codingadveenture/cube)' };

// Small seeded generator (mulberry32), so the sample and the jitter are repeatable.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(SEED);
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- catalog ----
const catalogJson = JSON.parse(await readFile(join(DATA, 'art-catalog.json'), 'utf8'));
const vectors = decodeFloat16(await readFile(join(DATA, 'art-catalog.bin')));
const entries = catalogJson.rows.map(([id, card, set, cn, illustration, digital, face, source], row) => ({
  row,
  scryfall_id: id,
  oracle_id: catalogJson.cards[card][0],
  name: catalogJson.cards[card][1],
  on_list: catalogJson.cards[card][2] === 1,
  set,
  collector_number: cn,
  illustration_id: illustration,
  digital: digital === 1,
  face: face === 1 ? 'back' : 'front',
  source: source === 1 ? 'self' : 'hosted',
}));
function search(embedding, k = 100) {
  const n = entries.length;
  const scores = new Float32Array(n);
  for (let r = 0, o = 0; r < n; r++, o += 128) {
    let s = 0;
    for (let i = 0; i < 128; i++) s += vectors[o + i] * embedding[i];
    scores[r] = s;
  }
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  return idx.slice(0, k).map((r) => ({ ...entries[r], score: scores[r] }));
}

// Printing details (release date, image URLs) from the printings files.
const printings = new Map();
for (const oracleId of new Set(entries.map((e) => e.oracle_id))) {
  const file = JSON.parse(await readFile(join(DATA, 'printings', `${oracleId}.json`), 'utf8'));
  for (const p of file.printings) printings.set(p.id, p);
}

// ---- 1. sample ----
const usedCards = new Set();
function take(filter, n) {
  const out = [];
  for (const e of shuffle(entries.filter(filter))) {
    if (out.length === n) break;
    if (usedCards.has(e.oracle_id)) continue;
    usedCards.add(e.oracle_id);
    out.push(e);
  }
  return out;
}
const released = (e) => printings.get(e.scryfall_id)?.released_at || '';
const groups = {
  old: take((e) => e.face === 'front' && !e.digital && released(e) < '2003-01-01', 20),
  modern: take((e) => e.face === 'front' && !e.digital && released(e) >= '2003-01-01', 25),
  digital: take((e) => e.digital && (e.set === 'vma' || e.set === 'prm'), 10),
  back: take((e) => e.face === 'back', 5),
};
const sample = Object.entries(groups).flatMap(([group, list]) =>
  list.map((e) => {
    const p = printings.get(e.scryfall_id);
    return { group, entry: e, url: e.face === 'back' ? p.back_image_normal : p.image_normal };
  }),
);

// Impostors: printings in the hosted catalog of cards that are not in ours.
const ours = new Set(entries.map((e) => e.oracle_id));
const baseDir = join(CACHE, 'cv-catalog', `v${catalogJson.hosted_catalog.base_version}-base`);
const records = gunzipSync(await readFile(join(baseDir, 'records.jsonl.gz')))
  .toString('utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => !r.face_index && r.metadata?.lang === 'en' && !ours.has(r.identifiers?.scryfall_oracle));
const pickImpostors = (filter, n) =>
  shuffle(records.filter(filter))
    .slice(0, n)
    .map((r) => ({
      group: r.metadata.layout === 'token' ? 'impostor token' : 'impostor card',
      entry: { scryfall_id: r.id, name: r.name, set: r.metadata.set, collector_number: r.metadata.collector_number, face: 'front' },
      url: `https://cards.scryfall.io/normal/front/${r.id[0]}/${r.id[1]}/${r.id}.jpg`,
    }));
const impostors = [
  ...pickImpostors((r) => r.metadata.layout === 'normal', 15),
  ...pickImpostors((r) => r.metadata.layout === 'token', 5),
];

// ---- 2. images ----
await mkdir(IMAGES, { recursive: true });
let lastFetch = 0;
async function image(item) {
  const file = join(IMAGES, `${item.entry.scryfall_id}${item.entry.face === 'back' ? '_back' : ''}.jpg`);
  if (existsSync(file)) return readFile(file);
  const wait = lastFetch + 100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();
  const res = await fetch(item.url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${item.url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFile(file, bytes);
  return bytes;
}

// ---- 3. the rig versions ----
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
function rotateWhite(img, degrees) {
  const { width: w, height: h } = img;
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const sx = cos * dx + sin * dy + cx - 0.5;
      const sy = -sin * dx + cos * dy + cy - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < 3; c++) {
        const p = (yy, xx) => img.data[(yy * w + xx) * 4 + c];
        const top = p(y0, x0) * (1 - fx) + p(y0, x0 + 1) * fx;
        const bottom = p(y0 + 1, x0) * (1 - fx) + p(y0 + 1, x0 + 1) * fx;
        out[(y * w + x) * 4 + c] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return { data: out, width: w, height: h };
}
function pad(img, fraction) {
  const mx = Math.round(img.width * fraction);
  const my = Math.round(img.height * fraction);
  const W = img.width + 2 * mx;
  const H = img.height + 2 * my;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < img.height; y++) data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((y + my) * W + mx) * 4);
  return { data, width: W, height: H };
}
const inset = (img, f) =>
  cropImage(img, { x: img.width * f, y: img.height * f, width: img.width * (1 - 2 * f), height: img.height * (1 - 2 * f) });
const scale = (img, f) => resizeBilinear(img, Math.round(img.width * f), Math.round(img.height * f));
function jitter(img, brightness, contrast) {
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) data[i + c] = clamp((data[i + c] * brightness - 128) * contrast + 128);
  }
  return { data, width: img.width, height: img.height };
}
const toJimp = (img) => Jimp.fromBitmap({ data: Buffer.from(img.data), width: img.width, height: img.height });
function blur(img) {
  const j = toJimp(img);
  j.gaussian(1);
  return { data: new Uint8ClampedArray(j.bitmap.data), width: img.width, height: img.height };
}
async function jpeg(img) {
  const bytes = await toJimp(img).getBuffer('image/jpeg', { quality: 70 });
  return { img: await decodeImage(bytes), bytes };
}
function rigParams() {
  return { degrees: random() < 0.5 ? -2 : 2, brightness: 0.85 + random() * 0.3, contrast: 0.85 + random() * 0.3 };
}
async function rigVersion(clean, params, margin) {
  let img = scale(clean, 0.6);
  if (margin) img = pad(img, margin);
  img = rotateWhite(img, params.degrees);
  img = blur(jitter(img, params.brightness, params.contrast));
  return jpeg(img);
}

function emptyFrames() {
  const w = 320;
  const h = 448;
  const white = { data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h };
  const noisy = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 0; i < noisy.data.length; i += 4) {
    const v = 225 + (random() - 0.5) * 30;
    noisy.data[i] = v;
    noisy.data[i + 1] = v - 3;
    noisy.data[i + 2] = v - 8;
    noisy.data[i + 3] = 255;
  }
  return [
    { name: 'white sheet', img: white },
    { name: 'sheet with noise', img: noisy },
  ];
}

// ---- 4. run ----
const KINDS = ['clean', 'clean_refined', 'rig', 'rig_refined', 'rig_margin', 'rig_margin_refined'];
const KIND_LABEL = {
  clean: 'Clean',
  clean_refined: 'Clean, refined',
  rig: 'Rig',
  rig_refined: 'Rig, refined',
  rig_margin: 'Rig + margin',
  rig_margin_refined: 'Rig + margin, refined',
};
// The inputs a real pipeline feeds to decide(): the camera view crops every guide box to
// refineCardBox(), so the refined inputs are its path. The unrefined clean and rig inputs stay in
// as well, for a setting that holds either way. The threshold search uses these.
const THRESHOLD_KINDS = ['clean', 'clean_refined', 'rig', 'rig_refined', 'rig_margin_refined'];

await loadMilo({ threads: THREADS });
const embedTimes = [];
async function recognise(img) {
  let best = null;
  let upright = null;
  for (const rotate180 of [false, true]) {
    const t = performance.now();
    const embedding = await embedImage(img, { rotate180 });
    embedTimes.push(performance.now() - t);
    const hits = search(embedding);
    if (!rotate180) upright = hits;
    if (!best || hits[0].score > best[0].score) best = hits;
  }
  return { hits: best, upright };
}

const isArt = (expected) => (h) =>
  h.scryfall_id === expected.scryfall_id ||
  (!!h.illustration_id && (h.illustration_id === expected.illustration_id || h.illustration_id === expected.back_illustration_id));
const expectedOf = (id) => {
  const p = printings.get(id);
  return p ? { scryfall_id: p.id, illustration_id: p.illustration_id, back_illustration_id: p.back_illustration_id } : null;
};

function measure(item, hits) {
  const truth = item.entry;
  const cards = groupByCard(hits);
  const trueCard = cards.find((c) => c.oracle_id === truth.oracle_id);
  const otherCard = cards.find((c) => c.oracle_id !== truth.oracle_id);
  const top = hits[0];
  const lowest = hits[hits.length - 1].score;
  const expected = expectedOf(truth.scryfall_id);
  const trueHits = hits.filter((h) => h.oracle_id === truth.oracle_id);
  const best = trueHits[0];
  const nameOk = top.oracle_id === truth.oracle_id;
  let artGap = null;
  if (best && expected) {
    const art = trueHits.find(isArt(expected));
    const other = trueHits.find((h) => !isArt(expected)(h));
    if (other) artGap = other.score - (art ? art.score : lowest);
  }
  return {
    top1_name: nameOk,
    exact: nameOk && best.scryfall_id === truth.scryfall_id,
    same_art: nameOk && !!expected && isArt(expected)(best),
    true_score: trueCard ? trueCard.score : null,
    other_score: otherCard ? otherCard.score : lowest,
    // Cosine between this input and the sampled row itself.
    row_score: hits.find((h) => h.row === truth.row)?.score ?? null,
    top_score: top.score,
    top_margin: top.score - (cards[1] ? cards[1].score : lowest),
    // Lead of the best other illustration of the true card over the true art (for printingMargin).
    art_gap: artGap,
    top: `${top.name} ${top.set} ${top.collector_number}${top.face === 'back' ? ' (back)' : ''}`,
  };
}

const results = [];
const started = Date.now();
const all = [...sample, ...impostors];
for (const item of all) {
  const clean = await decodeImage(await image(item));
  const params = rigParams();
  const rig = await rigVersion(clean, params, 0);
  const rigMargin = await rigVersion(clean, params, 0.05);
  const refinedBox = refineCardBox(rigMargin.img);
  const cleanBox = refineCardBox(clean);
  const rigBox = refineCardBox(rig.img);
  const inputs = {
    clean,
    clean_refined: cropImage(clean, cleanBox),
    rig: rig.img,
    rig_refined: cropImage(rig.img, rigBox),
    rig_margin: rigMargin.img,
    rig_margin_refined: cropImage(rigMargin.img, refinedBox),
  };
  if (results.length < 2) {
    await writeFile(join(IMAGES, `rig-example-${results.length + 1}.jpg`), rig.bytes);
    await writeFile(join(IMAGES, `rig-margin-example-${results.length + 1}.jpg`), rigMargin.bytes);
  }
  const out = {
    group: item.group,
    oracle_id: item.entry.oracle_id,
    row: item.entry.row,
    source: item.entry.source,
    name: item.entry.name,
    set: item.entry.set,
    cn: item.entry.collector_number,
    face: item.entry.face,
    scryfall_id: item.entry.scryfall_id,
    rig_params: { degrees: params.degrees, brightness: +params.brightness.toFixed(3), contrast: +params.contrast.toFixed(3) },
    refined_box: refinedBox,
    clean_box: cleanBox,
    rig_box: rigBox,
    clean_size: [clean.width, clean.height],
    rig_size: [rig.img.width, rig.img.height],
    spread: luminanceSpread(inputs.rig),
  };
  for (const kind of KINDS) {
    const { hits, upright } = await recognise(inputs[kind]);
    const cards = groupByCard(hits);
    out[kind] = item.group.startsWith('impostor')
      ? {
          top_score: hits[0].score,
          top_margin: hits[0].score - (cards[1]?.score ?? hits[hits.length - 1].score),
          top: `${hits[0].name} ${hits[0].set}`,
          hits,
        }
      : { ...measure(item, hits), upright_top1: upright[0].oracle_id === item.entry.oracle_id, hits };
  }
  results.push(out);
  if (results.length % 10 === 0) console.log(`${results.length}/${all.length} images`);
}
const empties = [];
for (const item of emptyFrames()) {
  const { hits } = await recognise(item.img);
  empties.push({ name: item.name, top_score: hits[0].score, top: `${hits[0].name} ${hits[0].set}`, spread: luminanceSpread(item.img) });
}

const real = results.filter((r) => !r.group.startsWith('impostor'));
const imps = results.filter((r) => r.group.startsWith('impostor'));

// Framing check: one change at a time, upright pass only, score of the sampled row.
const FRAMING = {
  'none (clean)': (i) => i,
  'scaled to 60%': (i) => scale(i, 0.6),
  '2% white margin': (i) => pad(i, 0.02),
  '5% white margin': (i) => pad(i, 0.05),
  '2% cut off each side': (i) => inset(i, 0.02),
  'rotated 1 degree': (i) => rotateWhite(i, 1),
  'rotated 2 degrees': (i) => rotateWhite(i, 2),
  'gaussian blur radius 1': (i) => blur(i),
  'JPEG quality 70': async (i) => (await jpeg(i)).img,
  'brightness 1.12, contrast 0.88': (i) => jitter(i, 1.12, 0.88),
};
const cleanImages = [];
for (const r of real) {
  cleanImages.push({ r, img: await decodeImage(await readFile(join(IMAGES, `${r.scryfall_id}${r.face === 'back' ? '_back' : ''}.jpg`))) });
}
const framing = [];
for (const [label, fn] of Object.entries(FRAMING)) {
  let ok = 0;
  const scores = [];
  for (const { r, img } of cleanImages) {
    const e = await embedImage(await fn(img));
    let s = 0;
    for (let i = 0; i < 128; i++) s += vectors[r.row * 128 + i] * e[i];
    scores.push(s);
    if (search(e, 1)[0].oracle_id === r.oracle_id) ok++;
  }
  scores.sort((a, b) => a - b);
  framing.push({ label, top1: ok / cleanImages.length, median: scores[scores.length >> 1], p10: scores[Math.floor(0.1 * (scores.length - 1) + 0.5)] });
}

// How often refineCardBox cut a real part of the card off an input with no sheet margin.
const cutFrac = (box, w, h) => 1 - (box.width * box.height) / (w * h);
const refineCut = { clean: 0, rig: 0, list: [] };
for (const r of results) {
  const c = cutFrac(r.clean_box, r.clean_size[0], r.clean_size[1]) > 0.01;
  const g = cutFrac(r.rig_box, r.rig_size[0], r.rig_size[1]) > 0.01;
  if (c) refineCut.clean++;
  if (g) refineCut.rig++;
  if (c || g) refineCut.list.push(`${r.name} ${r.set}`);
}

// ---- 5. report ----
const rate = (list, kind, key) => list.filter((r) => r[kind][key]).length / list.length;
const quant = (values) => {
  const v = values.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!v.length) return { min: null, p10: null, median: null, p90: null, max: null };
  const q = (f) => v[Math.min(v.length - 1, Math.floor(f * (v.length - 1) + 0.5))];
  return { min: v[0], p10: q(0.1), median: q(0.5), p90: q(0.9), max: v[v.length - 1] };
};

// Threshold search. Each input of a THRESHOLD_KINDS kind is a point (best score, lead over the
// next card). A setting names a point when both are at least the setting. "Right" points are real
// slips whose best card is right; "wrong" points are real slips whose best card is wrong, and
// every impostor. A setting qualifies when it names no wrong point.
function points(realList, impList) {
  const right = [];
  const wrong = [];
  for (const kind of THRESHOLD_KINDS) {
    for (const r of realList) (r[kind].top1_name ? right : wrong).push({ s: r[kind].top_score, m: r[kind].top_margin });
    for (const r of impList) wrong.push({ s: r[kind].top_score, m: r[kind].top_margin });
  }
  return { right, wrong };
}
const names = (p, accept, margin) => p.s >= accept && p.m >= margin;
function tally(accept, margin, pts) {
  return {
    correct: pts.right.filter((p) => names(p, accept, margin)).length,
    wrong: pts.wrong.filter((p) => names(p, accept, margin)).length,
  };
}
// Slack: how far the nearest wrong point is from being named (in score or lead, whichever it
// misses by more), minimised over the wrong points.
const slackOf = (accept, margin, pts) => Math.min(...pts.wrong.map((p) => Math.max(accept - p.s, margin - p.m)));
// The rule: among the qualifying settings that name at least KEEP of the best count, take the one
// farthest from every wrong point (largest slack), then the most matches, then the lower accept.
// This gives up a few matches (they go to review) so that no wrong point sits on the edge.
const KEEP = 0.98;
function choose(realList, impList) {
  const pts = points(realList, impList);
  const feasible = [];
  for (let a = 30; a <= 95; a++) {
    for (let m = 0; m <= 30; m++) {
      const t = tally(a / 100, m / 100, pts);
      if (!t.wrong) feasible.push({ accept: a / 100, margin: m / 100, ...t, slack: slackOf(a / 100, m / 100, pts) });
    }
  }
  const best = Math.max(...feasible.map((f) => f.correct));
  const chosen = feasible
    .filter((f) => f.correct >= KEEP * best)
    .sort((x, y) => y.slack - x.slack || y.correct - x.correct || x.accept - y.accept || x.margin - y.margin)[0];
  const atBest = feasible.filter((f) => f.correct === best).sort((x, y) => y.slack - x.slack)[0];
  return { feasible: feasible.length, best, chosen, atBest, total: pts.right.length + pts.wrong.length };
}
const fit = choose(real, imps);
const chosenAccept = fit.chosen.accept;
const chosenMargin = fit.chosen.margin;
// Held-out check: split the slips and the impostors into two halves (alternate items, so each
// group is in both), fit the rule on one half and count wrong names on the other, both ways round.
const half = (list, k) => list.filter((_, i) => i % 2 === k);
const holdout = [0, 1].map((k) => {
  const f = choose(half(real, k), half(imps, k));
  const testPts = points(half(real, 1 - k), half(imps, 1 - k));
  const t = tally(f.chosen.accept, f.chosen.margin, testPts);
  return {
    fit_on: k === 0 ? 'A' : 'B',
    accept: f.chosen.accept,
    margin: f.chosen.margin,
    test_right: testPts.right.length,
    test_wrong_points: testPts.wrong.length,
    test_correct: t.correct,
    test_wrong: t.wrong,
  };
});

// printingMargin: the largest lead of another illustration over the true art in the sample, plus
// 0.01, and at least 0.02, so 'other art' does not fire on a slip whose art is right.
const gaps = real.flatMap((r) => THRESHOLD_KINDS.map((k) => r[k].art_gap)).filter((g) => g !== null);
const maxGap = Math.max(0, ...gaps);
const printingMargin = Math.max(0.02, Math.ceil((maxGap + 0.01) * 100) / 100);
// floor: below every real input of every kind, so no slip is ever dropped as "no card".
const lowestReal = Math.min(...real.flatMap((r) => KINDS.map((k) => r[k].top_score)));
const highestEmpty = Math.max(...empties.map((e) => e.top_score));
const floor = Math.max(0, Math.floor((lowestReal - 0.02) * 100) / 100);

const options = { accept: chosenAccept, margin: chosenMargin, printingMargin, floor };
function statusCounts(kind) {
  const counts = { match: 0, review: 0, none: 0, wrong: 0 };
  for (const r of real) {
    const d = decide(r[kind].hits, options);
    counts[d.status]++;
    if (d.status === 'match' && d.card.oracle_id !== r.oracle_id) counts.wrong++;
  }
  return counts;
}
const status = Object.fromEntries(KINDS.map((k) => [k, statusCounts(k)]));
const impostorStatus = Object.fromEntries(
  KINDS.map((k) => {
    const c = { match: 0, review: 0, none: 0 };
    for (const r of imps) c[decide(r[k].hits, options).status]++;
    return [k, c];
  }),
);
const verdicts = {};
for (const r of real) {
  const d = decide(r.rig.hits, { ...options, expected: () => expectedOf(r.scryfall_id) });
  if (d.status === 'match') verdicts[d.verdict] = (verdicts[d.verdict] || 0) + 1;
}

const embedMs = quant(embedTimes);
const summary = {
  generated_at: new Date().toISOString(),
  seed: SEED,
  threads: THREADS,
  catalog_rows: entries.length,
  n: real.length,
  impostors: imps.length,
  groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
  accuracy: Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      {
        top1_name: rate(real, kind, 'top1_name'),
        exact_printing: rate(real, kind, 'exact'),
        same_art: rate(real, kind, 'same_art'),
        top1_name_upright_only: rate(real, kind, 'upright_top1'),
      },
    ]),
  ),
  by_group: Object.fromEntries(
    Object.keys(groups).map((g) => {
      const list = real.filter((r) => r.group === g);
      return [
        g,
        Object.fromEntries(KINDS.map((k) => [k, { top1_name: rate(list, k, 'top1_name'), exact: rate(list, k, 'exact'), same_art: rate(list, k, 'same_art') }])),
      ];
    }),
  ),
  scores: Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      {
        true_card: quant(real.map((r) => r[kind].true_score)),
        best_other_card: quant(real.map((r) => r[kind].other_score)),
        true_card_margin: quant(real.map((r) => (r[kind].top1_name ? r[kind].top_margin : null))),
        sampled_row_hosted: quant(real.filter((r) => r.source === 'hosted').map((r) => r[kind].row_score)),
        sampled_row_self: quant(real.filter((r) => r.source === 'self').map((r) => r[kind].row_score)),
        impostor_top: quant(imps.map((r) => r[kind].top_score)),
        impostor_margin: quant(imps.map((r) => r[kind].top_margin)),
      },
    ]),
  ),
  framing,
  empty_frames: empties,
  slip_spread: quant(results.map((r) => r.spread)),
  thresholds: {
    ...options,
    threshold_kinds: THRESHOLD_KINDS,
    feasible_settings: fit.feasible,
    best_correct: fit.best,
    chosen_correct: fit.chosen.correct,
    chosen_slack: fit.chosen.slack,
    best_count_setting: fit.atBest,
    keep: KEEP,
    holdout,
    max_art_gap: maxGap,
    lowest_real_score: lowestReal,
    highest_empty_score: highestEmpty,
  },
  refine_cut: refineCut,
  status_with_thresholds: status,
  impostor_status_with_thresholds: impostorStatus,
  rig_printing_verdicts: verdicts,
  embed_ms: embedMs,
  wall_s: (Date.now() - started) / 1000,
};
const failures = real.flatMap((r) =>
  KINDS.filter((k) => !r[k].top1_name || !r[k].same_art).map((k) => ({
    input: k,
    group: r.group,
    truth: `${r.name} ${r.set} ${r.cn}${r.face === 'back' ? ' (back)' : ''}`,
    got: r[k].top,
    score: r[k].top_score.toFixed(3),
    name_ok: r[k].top1_name,
  })),
);
const slim = (x) => ({ ...x, hits: x.hits.slice(0, 5).map((h) => [h.name, h.set, h.collector_number, h.face, +h.score.toFixed(4)]) });
await writeFile(
  join(CACHE, 'eval-results.json'),
  JSON.stringify({ summary, failures, results: results.map((r) => ({ ...r, ...Object.fromEntries(KINDS.map((k) => [k, slim(r[k])])) })) }, null, 1),
);
console.log(JSON.stringify(summary, null, 1));
console.log('failures:', JSON.stringify(failures, null, 1));

// ---- research/art-catalog-eval.md ----
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const f3 = (x) => (x === undefined || x === null ? '-' : x.toFixed(3));
const qrow = (label, q) => `| ${label} | ${f3(q.min)} | ${f3(q.p10)} | ${f3(q.median)} | ${f3(q.p90)} | ${f3(q.max)} |`;
const acc = summary.accuracy;
const plural = THREADS === 1 ? '' : 's';
const missTable = failures.length
  ? [
      'Misses (wrong name, or right name with another illustration):',
      '',
      '| Input | Group | Slip | Best hit | Score | Name right |',
      '|---|---|---|---|---:|---|',
      ...failures.map((f) => `| ${KIND_LABEL[f.input]} | ${f.group} | ${f.truth} | ${f.got} | ${f.score} | ${f.name_ok ? 'yes' : 'no'} |`),
    ].join('\n')
  : 'No misses.';
const lowRows = real
  .filter((r) => r.clean.row_score !== null && r.clean.row_score < 0.95)
  .map((r) => `${r.name} ${r.set} ${r.cn}${r.face === 'back' ? ' (back face)' : ''}, ${r.clean.row_score.toFixed(3)}, best hit ${r.clean.top} (${r.clean.top_score.toFixed(3)})`);
const md = `# Art catalog eval

Generated by \`node scripts/eval-art-catalog.mjs --threads ${THREADS}\` on ${summary.generated_at.slice(0, 10)} (seed ${SEED}).
Rerun the script rather than editing the numbers by hand. The method is described at the top of
the script; the pipeline it runs is src/scan/vision/.

## What was tested

- Catalog: public/data/art-catalog.bin and art-catalog.json, ${entries.length} rows, built by
  scripts/build-art-catalog.mjs from CollectorVision hosted catalog v${catalogJson.hosted_catalog.current_version}
  (feed https://hanclinto.github.io/CollectorVisionCatalog/catalog-v2/catalog-feed-v2.json) plus our
  own Milo embeddings of the ${entries.filter((e) => e.source === 'self').length} printings it lacks (all digital-only).
- Pipeline: the page's preprocessing (src/scan/vision/preprocess.ts), Milo 1.0.0 on
  onnxruntime-web 1.24.3 (wasm backend, ${THREADS} thread${plural}, node ${process.version}),
  upright and 180-degree passes keeping the better one (as scanCrop() does), top-100 cosine search,
  decide() from match.ts.
- Sample: ${real.length} catalog rows, one per card: ${groups.old.length} paper printings from before 2003,
  ${groups.modern.length} from 2003 on, ${groups.digital.length} digital (vma or prm), ${groups.back.length} back faces.
  Images: Scryfall "normal" JPGs (488x680) from the printings files.
- Impostors: ${imps.length} printings of cards that are not in our catalog (15 cards and 5 tokens,
  taken from the hosted catalog), standing for stray cards in the box; and two empty frames.
- Inputs per image:
  - Clean: the JPG itself.
  - Rig: scaled to 60 percent, rotated 2 degrees either way with white corners, gaussian blur
    radius 1, brightness and contrast each jittered by up to 15 percent, JPEG quality 70.
  - Rig + margin: the same, with 5 percent of white sheet around the slip before rotating.
  - Clean, refined; Rig, refined; Rig + margin, refined: each input cropped to refineCardBox()
    (preprocess.ts), which finds the slip against the sheet colour, as the camera view does. It
    returns the whole crop when the crop's outer ring is not sheet (a slip that fills the crop).
    It cut more than 1 percent of the area off ${refineCut.clean} of ${results.length} clean and ${refineCut.rig} of ${results.length} rig inputs${refineCut.list.length ? ` (${refineCut.list.join(', ')})` : ''}:
    a white-bordered card cannot be told from a white sheet by colour, so its border is taken for
    sheet and cut off.

## Check of the pipeline against the hosted catalog

A clean Scryfall image of a hosted row should score close to 1 against that row, which
CollectorVision embedded with its own Python code from Scryfall's PNG or large image. A mistake in
resizing, channel order, mean, std or layout would pull these scores well below 0.95.

| Clean input against the sampled row itself | Min | P10 | Median | P90 | Max |
|---|---:|---:|---:|---:|---:|
${qrow('Hosted rows', summary.scores.clean.sampled_row_hosted)}
${qrow('Rows embedded by build-art-catalog.mjs', summary.scores.clean.sampled_row_self)}

A separate check before the build (seven paper printings, one per sixty printings files) compared
our node embedding of Scryfall's normal, large and png images with the hosted row: large scored
0.9992 to 0.9998 on six of them, png 0.9974 to 1.0000, normal 0.9947 to 0.9994; the seventh (an sld
printing whose Scryfall image has presumably changed since) scored about 0.908 for all three sizes.
That is why build-art-catalog.mjs embeds the missing printings from the large image.

## Accuracy

| Input | Top-1 name | Exact printing | Same art | Top-1 name, upright pass only |
|---|---:|---:|---:|---:|
${KINDS.map((k) => `| ${KIND_LABEL[k]} | ${pct(acc[k].top1_name)} | ${pct(acc[k].exact_printing)} | ${pct(acc[k].same_art)} | ${pct(acc[k].top1_name_upright_only)} |`).join('\n')}

"Exact printing" means the best row of the right card is the sampled printing itself; "same art"
also counts a printing with the same illustration_id. Many printings share an illustration, so
exact can only be as good as the art allows.

| Group, rig input | Top-1 name | Exact | Same art |
|---|---:|---:|---:|
${Object.entries(summary.by_group).map(([g, v]) => `| ${g} | ${pct(v.rig.top1_name)} | ${pct(v.rig.exact)} | ${pct(v.rig.same_art)} |`).join('\n')}

${missTable}

## Framing matters most

Each clean image with one change, upright pass only. "Score" is the cosine to the sampled row.

| Change | Top-1 name | Median score | P10 score |
|---|---:|---:|---:|
${framing.map((f) => `| ${f.label} | ${pct(f.top1)} | ${f3(f.median)} | ${f3(f.p10)} |`).join('\n')}

Blur, JPEG, brightness and scale barely move the score. Framing does: a thin margin of sheet
around the card, or cutting a little off it, costs far more than any of them, and a 2 degree tilt
costs a little. Milo was trained on crops that end at the card edge (CollectorVision finds the
corners and dewarps), so the camera view should crop to the slip (refineCardBox) rather than feed
the whole guide box, and should help the Owner keep slips square to it. refineCardBox leaves a
slip that already fills the crop alone, except a white-bordered one (see the inputs above).

## Score distributions

Cosine scores. "True card" is the best row of the right card; "best other card" the best row of any
other card; "margin" the lead of the right card over the next card when the name is right;
impostor lines are the best hit, and its lead, for a card we do not have.

| Scores | Min | P10 | Median | P90 | Max |
|---|---:|---:|---:|---:|---:|
${KINDS.flatMap((k) => [
  qrow(`${KIND_LABEL[k]}, true card`, summary.scores[k].true_card),
  qrow(`${KIND_LABEL[k]}, best other card`, summary.scores[k].best_other_card),
  qrow(`${KIND_LABEL[k]}, margin`, summary.scores[k].true_card_margin),
  qrow(`${KIND_LABEL[k]}, impostor best hit`, summary.scores[k].impostor_top),
  qrow(`${KIND_LABEL[k]}, impostor margin`, summary.scores[k].impostor_margin),
]).join('\n')}

Empty frames: ${empties.map((e) => `${e.name}, best hit ${f3(e.top_score)} (${e.top}), luminance spread ${e.spread.toFixed(1)}`).join('; ')}.
Luminance spread of the rig inputs (luminanceSpread in preprocess.ts): min ${summary.slip_spread.min.toFixed(1)}, median ${summary.slip_spread.median.toFixed(1)}.
The score cannot tell an empty frame from a badly framed slip, so the camera view should detect
an empty guide box by its luminance spread, not by the score.

## Thresholds (the defaults in match.ts)

A grid over accept 0.30 to 0.95 and margin 0.00 to 0.30 (steps of 0.01), over the ${THRESHOLD_KINDS.map((k) => KIND_LABEL[k].toLowerCase()).join(', ')}
inputs together (${fit.total} inputs). A setting qualifies only if it names no wrong card: no slip named as another card and no
impostor named at all. ${fit.feasible} settings qualify; the best of them names ${fit.best} inputs correctly (at accept
${fit.atBest.accept.toFixed(2)}, margin ${fit.atBest.margin.toFixed(2)}, where the nearest wrong input misses being named by only ${f3(fit.atBest.slack)}).
The script does not take that edge point. Among the settings that name at least ${Math.round(KEEP * 100)} percent of the best count,
it takes the one farthest from every wrong input: the chosen setting names ${fit.chosen.correct} and the nearest wrong
input misses it by ${f3(fit.chosen.slack)} (in score or in lead, whichever is larger). The slips it gives up go to review.

This search was fitted on the same slips and impostors it is tested on, so "no wrong name" below
is in-sample by construction. For an honest check the script also splits the slips and the
impostors into two halves, fits the same rule on one half and counts wrong names on the other:

| Fitted on | Accept | Margin | Held-out right inputs named | Held-out wrong names |
|---|---:|---:|---:|---:|
${holdout.map((h) => `| half ${h.fit_on} | ${h.accept.toFixed(2)} | ${h.margin.toFixed(2)} | ${h.test_correct} of ${h.test_right} | ${h.test_wrong} of ${h.test_wrong_points} |`).join('\n')}

| Setting | Value | Rule |
|---|---:|---|
| accept | ${options.accept.toFixed(2)} | best score at least this |
| margin | ${options.margin.toFixed(2)} | best card leads the next card by at least this |
| printingMargin | ${options.printingMargin.toFixed(2)} | largest lead of another illustration of the right card over the true art in the sample (${f3(maxGap)}), plus 0.01, at least 0.02 |
| floor | ${options.floor.toFixed(2)} | below every real input (lowest best score ${f3(lowestReal)}), so a slip is never dropped as "no card" |

Results with these defaults:

| Input | Match | Review | None | Wrong name | Impostors: match | Impostors: review | Impostors: none |
|---|---:|---:|---:|---:|---:|---:|---:|
${KINDS.map((k) => `| ${KIND_LABEL[k]} | ${status[k].match} | ${status[k].review} | ${status[k].none} | ${status[k].wrong} | ${impostorStatus[k].match} | ${impostorStatus[k].review} | ${impostorStatus[k].none} |`).join('\n')}

Printing verdicts of the rig matches, with the sampled printing as the expected one:
${Object.entries(verdicts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.

## Speed

Milo embed time in node on this desktop, ${THREADS} thread${plural}, ${embedTimes.length} embeds: median
${embedMs.median.toFixed(0)} ms, P90 ${embedMs.p90.toFixed(0)} ms (preprocessing included). The page runs two embeds per slip by
default (upright and 180 degrees). A phone will be slower; measure it there before setting the
feeding pace.

${lowRows.length ? `Clean inputs that scored under 0.95 against their own row: ${lowRows.join('; ')}. Scryfall's image differs from the one the catalog row was made from (for a back face, the catalog's face rows may be the other way round); the name and Printing were still right.

` : ''}## Limits of this eval

- The rig inputs are synthetic. They lack the sleeve glare, the printer's colour shift and the
  paper texture of a real slip; photos from the real rig are the next test.
- ${real.length} slips and ${imps.length} impostors are a small sample, so the thresholds are a starting point.
- Digital rows were embedded from Scryfall's large image and tested with its normal image of the
  same art, so they are easier than a printed slip.
`;
await writeFile(join(ROOT, 'research', 'art-catalog-eval.md'), md);
console.log('wrote research/art-catalog-eval.md');
