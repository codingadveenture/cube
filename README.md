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

Status: slice 1 (the Cube view and the Scan diff), slice 2 (shared state in Firestore:
Suggestions, shared Scan piles, the Log and the Owner's confirmations), slice 3a (the Printing
picker and Cycles) and slice 3b (Print batches and print sheets) are built; the rest is in
design. `GLOSSARY.md`
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

## Shared data

The state that changes lives in Firestore (project `cube-e647a`): the In-box and Wanted
Printings, Art flags, Suggestions, shared Scan piles, the Log and the pending List changes.
Card facts (colours, types, images, Cycles) still come from `public/data/cards.json`. Nobody in
the group needs an account: every visitor is signed in anonymously and silently. Only the Owner
signs in, with Google.

Writes made offline are kept on the device and sync when it is back online; the app says
"Saved on this device, syncs when online". If Firestore cannot start at all, the app falls back to
the built-in card data and says so.

### What visitors can do

- Browse the Cube, the Log and all Suggestions.
- Send a Suggestion from a card (Flag the art, Suggest a change) or from the Suggest page
  (add, Ban, Winner's Pick, Printing, other). The name they sign with is remembered on their device.
- Share a scanned pile with Share this pile, tick shared piles to include them in the diff, and
  delete the piles they shared.

### What the Owner can do

- Accept or reject Suggestions, with an optional note. Accepting an Art flag adds the flag,
  accepting a Printing sets the Wanted Printing, and accepting an add, Ban or Winner's Pick puts the
  card on the pending List changes (Bans and Winner's Picks also get a Log entry).
- Copy the pending List changes and make them on CubeCobra by hand, then clear them.
- Flag art directly, clear Art flags, and record the In-box Printing: on a card with
  "Box has a different printing" (set code and collector number), or from a Scan with "Box has this
  printing" on a Different art item. The Wanted Printing is left alone, so a difference becomes a
  reprint.
- Add and edit Log entries and import a log file.
- Delete any shared pile.

### Firestore rules

The rules are in `firestore.rules`. After changing them, open the
[Firebase console](https://console.firebase.google.com/project/cube-e647a/firestore/rules),
go to Firestore, Rules, paste the whole file and press Publish. Without the rules, Firestore in
production mode refuses every read and write.

### Owner setup

1. Open the site, go to About and press "Sign in as Owner" (Google). If the popup is blocked, the
   page switches to a redirect sign-in.
2. Still on About, press "Claim Owner". This works once: the rules let only a Google-signed-in user
   create `config/owner`, only with their own uid, and only while it does not exist. To set the
   Owner by hand instead, copy the user id shown on About and create the document `config/owner`
   with one string field `uid` in the Firebase console (Firestore, Data).
3. Open the Cube view and press "Import baseline". It writes one document per card from
   `cards.json` (in batches of 400) and skips cards that already have one.
4. Open Log and use "Import log from file" with a JSON file of the shape
   `{"winner_picks":[{"card","by","date","note"}],"bans":[{"card","by","date"}]}`. Entries already
   in the Log are skipped. The file is not part of the repository.

The Firebase web config in `src/store/firebase.ts` is public client configuration; access is
controlled by the rules.

## Printings and Cycles

Every card has a Printing picker ("Choose Wanted Printing" on the card, "Suggest a Printing" for visitors) that loads that card's file from `public/data/printings/` and shows one tile per art, with filters for promos, collectors' editions, frame, border and resolution, plus the Printing the default rule would pick (the newest black-bordered, non-promo paper Printing outside Secret Lair and memorabilia).
When the Owner sets Wanted on a card in a Cycle, a sheet offers "This card only" or the whole Cycle, and a whole Cycle gets the same Print run (set and style) in one batch, listing any card with no Printing in that run.
The Cycles view (`#/cycles`) shows each Cycle as uniform, styled (same frame, border and style from different sets) or split, and a Cycle page ranks the Print runs that cover all members, or all but one, so a whole Cycle can be set or reset to its In-box Printings at once.
The Owner can accept a split; the accepted arrangement is stored in `cubes/main/meta/cycles` and shows as a quiet "accepted split" until any member changes.

## Printing

The Print batch on the Print page starts with every card whose Wanted Printing differs from its In-box Printing, plus any extra lines and tokens you add, and the back faces of double-faced cards go to a Back pool automatically.
Generate PDF builds one file in the browser with nine slips per A4 page at the target size, and page 1 is always a test page, which "Print the test page" also gives on its own.
Print the test page from a computer at 100 percent or Actual size and measure its two lines: the 180 mm line across and the 260 mm line down.
Enter both lengths in the Calibration box: if either is off by more than about 2 percent the print dialog is still scaling, otherwise the box gives the correction factors fx and fy.
The Owner saves the factors under a printer name in Firestore (`cubes/main/meta/print`, next to the print settings and history) for everyone, while a visitor keeps them on their own device.
For other print tools, "Copy mtgprint list" gives `1 Name (SET) number` lines for mtgprint.net and "Copy MTG Proxy Generator list" gives `1 SET/number -cd` lines, both without tokens or back faces.

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
(`#/cube`, `#/cycles`, `#/scan`, `#/print`, `#/suggestions`, `#/log`, `#/about`). The service worker in `public/sw.js` only receives files shared
to the app; it caches nothing else.

## Licence

GNU Affero General Public License v3.0, see `LICENSE`.
