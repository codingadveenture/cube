# Cube

A small web app for keeping a paper Vintage Cube of about 540 proxy cards in order.

It is meant to replace a spreadsheet and a lot of copy-pasting. The intended card list lives on
[CubeCobra](https://cubecobra.com/cube/overview/MTGVintageCube); the paper cube is the thing that
matters. The app will:

- keep the record of what is physically in the cube, card by card, including which printing;
- verify the cube from phone scans instead of sorting 540 cards by hand, ending in a diff;
- turn list changes and winners' picks into an in/out/reprint update;
- let you pick printings quickly, with whole cycles (fetchlands, duals, Moxen, Talismans) on one
  print run and warnings when a cycle gets split;
- produce print sheets that come out at the right physical size on the first try;
- keep the winners and bans log.

Status: slice 1 (the Cube view and the Scan diff) is built; the rest is in design. `GLOSSARY.md`
holds the vocabulary the code follows.

Card data and images come from [Scryfall](https://scryfall.com/docs/api). This project is not
affiliated with Wizards of the Coast, CubeCobra or Scryfall.

The site is at <https://codingadveenture.github.io/cube/>.

## Scan the Cube with a phone

1. In ManaBox, make a binder for the Cube (or one binder per box or pile).
2. Scan the cards into it with Quick Mode, in any order.
3. Open the binder and export it as CSV.
4. Share the CSV file to Cube (install the site to the home screen first: Chrome menu, "Add to
   Home screen"), or open the Scan view and pick the file with "Choose files". Add one file per
   pile; quantities are summed.
5. Read the diff: Missing, Unexpected, Different art, Duplicates. Tick "Resolved" as you fix each
   card; the session stays in the browser until you clear it, and "Export session JSON" saves it.

A plain list also works, pasted or as a .txt file, one card per line: `Name`, `2 Name`,
`2x Name` or `Name (SET) 123`.

## Development

Needs Node 22 or later.

```
npm install
npm run dev        # http://localhost:5173/cube/
npm test           # unit tests (vitest)
npm run typecheck
npm run build      # static site in dist/
npm run preview    # serve dist/
```

### Card data

`public/data/cards.json` is built from `data/cube-record.json` and Scryfall:

```
npm run build:data              # reuses cached Scryfall responses in scripts/.cache/
node scripts/build-cards.mjs --refresh
```

The app icons are drawn by `node scripts/make-icons.mjs`.

### Deployment

Every push to `main` runs `.github/workflows/deploy.yml`: `npm ci`, the tests, `npm run build`,
and a deploy of `dist/` to GitHub Pages (repository settings: Pages, source "GitHub Actions").
The site lives under `/cube/`, so Vite's `base` is `/cube/` and routes are hash based
(`#/cube`, `#/scan`, `#/about`). The service worker in `public/sw.js` only receives files shared
to the app; it caches nothing else.

## Licence

GNU Affero General Public License v3.0, see `LICENSE`.
