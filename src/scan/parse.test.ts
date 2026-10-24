import { describe, expect, it } from 'vitest';
import { looksLikeCsv, parseManabox, parsePlainText, parseScanText } from './parse';

const OLD_17 = [
  'Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency',
  'Cube A,binder,Lightning Bolt,LEA,Limited Edition Alpha,161,normal,common,1,123,AAAA-1111,0.5,false,false,near_mint,en,EUR',
  'Cube A,binder,"Fire // Ice",MH2,Modern Horizons 2,290,foil,uncommon,2,124,bbbb-2222,0.5,false,false,near_mint,en,EUR',
].join('\n');

const NEW_20 = [
  'Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Signed,Condition,Language,Proxy,Purchase price currency,Added',
  'Cube B,binder,Black Lotus,LEA,Limited Edition Alpha,232,normal,rare,1,9,cccc-3333,0,false,false,false,near_mint,en,true,EUR,2026-10-24',
  'Cube B,binder,"Jace, the Mind Sculptor",WWK,Worldwake,31,normal,mythic,,10,dddd-4444,0,false,false,false,near_mint,de,true,EUR,2026-10-24',
].join('\r\n');

// Exporting a single binder leaves out the two Binder columns.
const SINGLE_BINDER = [
  'Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Signed,Condition,Language,Proxy,Purchase price currency,Added',
  'Sol Ring,C21,Commander 2021,263,normal,uncommon,3,11,eeee-5555,0,false,false,false,near_mint,en,true,EUR,2026-10-24',
  '',
].join('\n');

describe('parseManabox', () => {
  it('reads the older 17-column header', () => {
    const rows = parseManabox(OLD_17);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: 'Lightning Bolt',
      quantity: 1,
      scryfall_id: 'aaaa-1111',
      set: 'lea',
      collector_number: '161',
      foil: 'normal',
      language: 'en',
    });
    expect(rows[1]?.name).toBe('Fire // Ice');
    expect(rows[1]?.quantity).toBe(2);
    expect(rows[1]?.foil).toBe('foil');
  });

  it('reads the current 20-column header with CRLF and defaults an empty quantity to 1', () => {
    const rows = parseManabox(NEW_20);
    expect(rows.map((r) => r.name)).toEqual(['Black Lotus', 'Jace, the Mind Sculptor']);
    expect(rows[1]?.quantity).toBe(1);
    expect(rows[1]?.language).toBe('de');
    expect(rows[1]?.scryfall_id).toBe('dddd-4444');
  });

  it('reads a single-binder export without Binder columns and skips empty lines', () => {
    const rows = parseManabox(SINGLE_BINDER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Sol Ring', quantity: 3, set: 'c21', collector_number: '263' });
  });

  it('matches headers case-insensitively, ignores unknown columns and defaults a missing Quantity column', () => {
    const rows = parseManabox('NAME,whatever,SCRYFALL ID\nOpt,x,FFFF\n﻿');
    expect(rows).toEqual([
      { name: 'Opt', quantity: 1, scryfall_id: 'ffff', set: null, collector_number: null, foil: null, language: null },
    ]);
  });

  it('strips a byte order mark before the header', () => {
    expect(parseManabox('﻿Name,Quantity\nOpt,2')[0]).toMatchObject({ name: 'Opt', quantity: 2 });
  });
});

describe('parsePlainText', () => {
  it('reads the four line forms', () => {
    const rows = parsePlainText('Lightning Bolt\n2 Counterspell\n3x Brainstorm\nSol Ring (C21) 263\n\n# comment\n');
    expect(rows.map((r) => [r.name, r.quantity, r.set, r.collector_number])).toEqual([
      ['Lightning Bolt', 1, null, null],
      ['Counterspell', 2, null, null],
      ['Brainstorm', 3, null, null],
      ['Sol Ring', 1, 'c21', '263'],
    ]);
  });

  it('keeps commas and split names intact', () => {
    const rows = parsePlainText('1 Jace, the Mind Sculptor (WWK) 31\nFire // Ice');
    expect(rows[0]).toMatchObject({ name: 'Jace, the Mind Sculptor', set: 'wwk', collector_number: '31' });
    expect(rows[1]?.name).toBe('Fire // Ice');
  });
});

describe('parseScanText', () => {
  it('detects CSV by its Name header and falls back to plain text', () => {
    expect(looksLikeCsv(OLD_17)).toBe(true);
    expect(looksLikeCsv('Jace, the Mind Sculptor')).toBe(false);
    expect(parseScanText(SINGLE_BINDER)[0]?.name).toBe('Sol Ring');
    expect(parseScanText('Jace, the Mind Sculptor')[0]?.name).toBe('Jace, the Mind Sculptor');
  });
});
