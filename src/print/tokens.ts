// public/data/tokens.json (a copy of data/tokens.json), loaded on demand by the Print view.

export type TokenRecommendation = 'print' | 'buy' | 'either';

export interface TokenMaker {
  card: string;
  oracle_id: string;
  repeatable: boolean;
  peak: number;
  note: string;
}

export interface TokenType {
  key: string;
  name: string;
  type_line: string;
  power: string | null;
  toughness: string | null;
  scryfall_id: string;
  image_png: string;
  made_by: TokenMaker[];
  suggested_count: number;
  rationale: string;
  recommendation: TokenRecommendation;
  recommendation_reason: string;
}

export interface TokensFile {
  generated_at: string;
  tokens: TokenType[];
}

let pending: Promise<TokensFile> | null = null;

export function loadTokens(): Promise<TokensFile> {
  pending ??= fetch(`${import.meta.env.BASE_URL}data/tokens.json`).then((res) => {
    if (!res.ok) throw new Error(`tokens.json: HTTP ${res.status}`);
    return res.json() as Promise<TokensFile>;
  });
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

/** Token types with an image, in file order (most needed first). */
export function printableTokens(file: Pick<TokensFile, 'tokens'>): TokenType[] {
  return file.tokens.filter((t) => typeof t.image_png === 'string' && t.image_png.length > 0);
}

export const RECOMMENDATION_LABEL: Record<TokenRecommendation, string> = {
  print: 'Print',
  buy: 'Buy',
  either: 'Print or buy',
};
