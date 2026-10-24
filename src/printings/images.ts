// Other image sizes of a Scryfall image, derived from its "normal" URL.

/** The small (thumbnail) image for a normal image URL. */
export function smallImage(normal: string): string {
  return normal.replace('/normal/', '/small/');
}

/** The print-quality PNG for a normal image URL; keeps any ?timestamp query. */
export function pngImage(normal: string): string {
  return normal.replace('/normal/', '/png/').replace(/\.jpg(?=$|\?)/, '.png');
}

/** The large JPEG (672 x 936, about 270 dpi at 63 x 88 mm) for a normal image URL. */
export function largeImage(normal: string): string {
  return normal.replace('/normal/', '/large/');
}

/** The large JPEG for a png image URL (token images in tokens.json are png). */
export function largeFromPng(png: string): string {
  return png.replace('/png/', '/large/').replace(/\.png(?=$|\?)/, '.jpg');
}
