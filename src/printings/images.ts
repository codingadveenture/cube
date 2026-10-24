// Other image sizes of a Scryfall image, derived from its "normal" URL.

/** The small (thumbnail) image for a normal image URL. */
export function smallImage(normal: string): string {
  return normal.replace('/normal/', '/small/');
}

/** The print-quality PNG for a normal image URL; keeps any ?timestamp query. */
export function pngImage(normal: string): string {
  return normal.replace('/normal/', '/png/').replace(/\.jpg(?=$|\?)/, '.png');
}
