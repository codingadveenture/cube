# Third-party notices

The cube app is licensed under the GNU AGPL v3 (see LICENSE). It includes or loads the following
third-party work. Sources and facts: research/collectorvision-integration.md, section 5.

## CollectorVision (code adapted in src/scan/vision/)

- Author: HanClinto. Source: https://github.com/HanClinto/CollectorVision at commit
  8b295ab80a997766afc00c640a616c1f2716df21.
- Licence: AGPL-3.0-or-later (pyproject.toml line 10; LICENSE is the GNU AGPL v3 text).
- What we use: the preprocessing and the 180-degree second pass of
  examples/web_scanner/scanner.worker.mjs, re-implemented in src/scan/vision/preprocess.ts and
  src/scan/vision/index.ts. Changed by the cube project on 2026-10-25: no corner detection, our
  own Pillow-style resampler, a closed catalog, top-k search and our own match rules. The files
  carry a header saying so.

## Milo 1.0.0 model (public/models/milo-1.0.0.onnx)

- Source: https://huggingface.co/HanClinto/milo, revision 9bcc5e809e936b8c5630d1e7101aae1de1e76621,
  file model.onnx, 5,191,100 bytes, SHA-256
  bd13d8d60383c69da04dce261f32e93fdaeaa8fd618fbc991e7385f71b3d45df. Copied unchanged.
- Licence: AGPL-3.0 (model card). Notice and full text: public/models/LICENSE-CollectorVision.txt.

## CollectorVision catalog data (public/data/art-catalog.bin and art-catalog.json)

- Source: https://github.com/HanClinto/CollectorVisionCatalog, catalog v2 "scryfall/mtg".
- Licence: MIT, "Copyright (c) 2026 CollectorVision Catalog contributors". Notice and full text:
  public/data/LICENSE-CollectorVisionCatalog.txt.
- Filtered to our cards' Printings by scripts/build-art-catalog.mjs, which also adds rows we
  embedded ourselves with Milo for Printings the hosted catalog lacks.

## onnxruntime-web 1.24.3

- Source: https://www.npmjs.com/package/onnxruntime-web (Microsoft), installed from npm and
  bundled by Vite into the scanner's lazy chunk, with its wasm file.
- Licence: MIT (https://github.com/microsoft/onnxruntime/blob/main/LICENSE).

## Card images and data

- Card data and images come from Scryfall (https://scryfall.com). Magic: The Gathering is
  copyright Wizards of the Coast.
