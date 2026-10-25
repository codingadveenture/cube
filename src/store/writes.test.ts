import { describe, expect, it } from 'vitest';
import { cardPatchWrite } from './writes';

const NOW = '2026-10-25T12:00:00.000Z';

describe('cardPatchWrite not_in_box', () => {
  it('clears only the In-box Printing and leaves the retired fields alone', () => {
    const w = cardPatchWrite({ kind: 'not_in_box' }, NOW);
    expect(w).toEqual({ fields: { in_box: null, updatedAt: NOW }, unionFlags: null });
    expect(w.fields).not.toHaveProperty('retired_printing');
    expect(w.fields).not.toHaveProperty('retired_at');
    expect(w.fields).not.toHaveProperty('in_list');
  });
});
