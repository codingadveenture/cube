// normalizeName: the key used to match scanned names against the List.
// Text before " // ", Unicode NFKD, combining marks stripped, lower-case, whitespace collapsed.
export function normalizeName(s: string): string {
  const front = s.split(' // ')[0] ?? '';
  return front
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
