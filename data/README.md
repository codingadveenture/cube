# Cube data record

This folder holds the starting record of the paper Cube: for every card on the List, which
Printing is believed to be physically in the box, and which Printing is wanted. Terms (List,
Printing, Proxy, Cycle, Art flag, Winner's Pick, Ban) are defined in `../GLOSSARY.md`.

| File | What it is |
|---|---|
| `cube-record.json` | One entry per card on the List, with the in-box and wanted Printings |
| `log.json` | Winner's Picks, Bans and the open questions found while building the record |
| `README.md` | This file |

The record was generated once from the sources below. From here on it is meant to be edited as
the Cube changes (new print batches, Scans, art decisions), not regenerated.

## Sources

- **CubeCobra** cube `MTGVintageCube` (JSON export, 536 mainboard cards). Each card's `cardID` is a
  Scryfall printing id; `details` carries the oracle id and the oracle tags.
- **The group's Google Sheet**, exported as `book.xlsx`:
  - `diffchecker`: column A New List (537 names, the List; it includes Bazaar of Baghdad, which
    CubeCobra lacks), column B In (99 cards printed in the last print batch), column C Out
    (102 cards removed), column E the mtgprint lines `1 Name (SET) number` that were sent to the
    printer for the In cards.
  - `TheCube`: column D holds `comRain` on six rows (Art flags).
  - `Adds and Bans`: Added / By / Banned / By.
- **Scryfall** API: `POST /cards/collection` to resolve printings by id or by set and collector
  number, and `GET /cards/search` to find the default Printing of a card.
- **`../research/cycles.json`**: `members_in_cube` for each Cycle.

## Rules

### In box (`in_box`)

1. If the card's printing appears in the `diffchecker` printed lines (column E), that Printing is
   in the box: `source: "sheet-printed"`, `confidence: "high"`. Lines are matched to List cards by
   Scryfall oracle id, so double-faced names (`Front // Back`) and the Through the Omenpaths
   renames on CubeCobra (for example Ademi of the Silkchutes = Spectacular Spider-Man) match.
2. Otherwise the Printing CubeCobra records (`cardID`) is assumed: `source: "cubecobra"`,
   `confidence: "medium"`. CubeCobra is known to disagree with what was actually printed for about
   a third of the last batch, hence medium.
3. If neither applies (Bazaar of Baghdad, which is not on CubeCobra), the in-box Printing is unknown;
   it is filled with the default Printing below: `source: "default-rule"`, `confidence: "low"`.

### Wanted (`wanted`)

`wanted` equals `in_box` (`reason: "same-as-box"`) except:

- `reason: "non-paper-replacement"`: the in-box Printing was never sold on paper (Scryfall `games`
  lacks `paper`, for example Magic Online promos `PRM`, Through the Omenpaths `OM1`, Historic
  Anthology `HA7`, Jumpstart: Historic Horizons `J21`, Treasure Chest `PZ2`). Wanted becomes the
  default Printing.
- `reason: "default-rule-unknown-box"`: the in-box Printing is unknown; wanted is the default
  Printing.
- `reason: "unresolved-no-paper-printing"`: the in-box Printing is not on paper and the card has
  no Printing that passes the default rule; wanted is left equal to in-box until someone decides.

No Cycle styling (one Print run per Cycle) has been applied yet; that is a later decision.

### Default Printing

The newest Printing (by Scryfall `released_at`) that is:

- English (`lang: "en"`), sold on paper (`games` includes `paper`), not `digital`;
- black border (`border_color: "black"`);
- not a promo (`promo: false`) and not Secret Lair (set code `sld`);
- not oversized;
- not an art-series, token, double-faced-token or emblem layout, and not from a memorabilia,
  token or minigame set type.

Ties on the same release date go to the lowest set code, then the lowest collector number
(usually the regular-frame version within a set).

## `cube-record.json`

```
{
  "generated_at": "ISO 8601 timestamp (UTC)",
  "sources":   { "cubecobra": {...}, "sheet": {...}, "scryfall": {...}, "cycles": {...} },
  "counts":    { "cards", "in_list", "list_source", "in_box_source", "in_box_confidence",
                 "in_box_not_paper", "wanted_reason", "wanted_differs_from_box", "flags",
                 "cards_with_cycles", "cards_with_oracle_cycle_tags" },
  "cards": [ card, ... ]          // sorted by name, case-insensitive
}
```

A `card`:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Card name as on the List (sheet New List; identical to CubeCobra's name) |
| `oracle_id` | string | Scryfall oracle id (same for every Printing of the card) |
| `in_list` | bool | `true` for every card on the List. `false` is reserved for cards found in the box that are not on the List (none at the start) |
| `list_source` | `"cubecobra"` or `"sheet-adds"` | Where the List entry comes from; `sheet-adds` means on the sheet's New List but not on CubeCobra |
| `cubecobra_card_id` | string or null | CubeCobra's `cardID` (a Scryfall printing id); null for `sheet-adds` |
| `in_box` | printing | The Printing believed to be physically in the box |
| `wanted` | printing + `reason` | The Printing that should be in the box |
| `cycles` | string[] | Cycle names from `research/cycles.json` whose `members_in_cube` contains this card |
| `oracle_cycle_tags` | string[] | CubeCobra `details.oracle_tags` that start with `cycle-` (Scryfall Tagger slugs) |
| `flags` | object[] | Art flags, `{"type": "art", "by": "comRain"}` |

A `printing`:

| Field | Type | Meaning |
|---|---|---|
| `scryfall_id` | string | Scryfall printing id |
| `name` | string | Scryfall's name for that Printing. Differs from the card `name` for double-faced cards (full `Front // Back`) and for the four Through the Omenpaths renames, where the paper card is a Spider-Man card |
| `set`, `set_name` | string | Scryfall set code (lower case) and set name |
| `collector_number` | string | Collector number within the set |
| `released_at` | string | Release date of the Printing (YYYY-MM-DD) |
| `lang` | string | Language code (`en` throughout) |
| `paper` | bool | Scryfall `games` includes `paper` |
| `image_normal` | string | Scryfall `normal` image URL (front face for double-faced cards) |
| `source` | string | `sheet-printed`, `cubecobra` or `default-rule` |
| `confidence` | string | `high`, `medium` or `low`; on `wanted` it is copied from `in_box` when the reason is `same-as-box`, and `high` when the default rule chose it |
| `reason` | string | `wanted` only: `same-as-box`, `non-paper-replacement`, `default-rule-unknown-box` or `unresolved-no-paper-printing` |

## `log.json`

```
{
  "winner_picks": [ { "card", "by", "date", "note" } ],   // from the Added / By columns
  "bans":         [ { "card", "by", "date" } ],           // from the Banned / By columns
  "ambiguities":  [ "free-text open questions" ]
}
```

Dates are `null` because the sheet does not record them. Entries without a name in the `By` column
have `by: null`. The `Gadd` row (a name in the Added-By column with no card) is recorded as an
ambiguity, not as a pick.

## Regenerating

The builder scripts live outside the repo, in the session scratchpad
(`.../scratchpad/dl/baseline/`). Python 3.11 with `openpyxl` and `requests` from the user site,
run with `python -E -P` (not `-I`, which hides the user site):

1. Export the Google Sheet to `scratchpad/sheet/book.xlsx` and the CubeCobra cube JSON to
   `scratchpad/cubecobra/cube.json`.
2. `python -E -P read_inputs.py` writes `inputs.json` (List, In, Out, printed lines, flags,
   adds and bans, CubeCobra cards).
3. `python -E -P build_record.py` resolves printings against Scryfall and writes
   `data/cube-record.json` and `data/log.json`.

`scry.py` caches every raw Scryfall response under `cache/`, so reruns make no API calls; delete
the cache to refetch. It sends `User-Agent: cube-record-builder/1.0` and
`Accept: application/json`, batches collection lookups 75 at a time, waits at least 0.55 s between
requests and pauses 65 s after a 429.

Regenerating overwrites any hand edits made to the record since, so do it only to rebuild the
starting point.
