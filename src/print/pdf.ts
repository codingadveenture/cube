// The print sheet PDF, built in the browser with jsPDF (loaded on demand). Page 1 is always the
// test page; then the slip pages from layout.ts. Images are fetched one at a time, 50 ms apart,
// with one retry; a JPEG is embedded as it is, without re-encoding.
import type { jsPDF as JsPDF } from 'jspdf';
import {
  CROP_GREY,
  CROP_WIDTH,
  cropMarks,
  labelPosition,
  slipPages,
  slipRects,
  testPageGeometry,
  type Line,
} from './layout';
import type { Slip } from './batch';
import type { PrintSettings } from './settings';

export interface PdfProgress {
  done: number;
  total: number;
  current: string | null;
}

export interface PdfInput {
  slips: Slip[];
  settings: PrintSettings;
  /** YYYY-MM-DD, printed on the test page and in the metadata. */
  date: string;
  fetchImage?: (url: string) => Promise<Uint8Array>;
  onProgress?: (p: PdfProgress) => void;
  /** Pause between image requests, in ms (default 50). */
  gapMs?: number;
  signal?: AbortSignal;
}

export interface PdfResult {
  bytes: ArrayBuffer;
  pages: number;
  /** Images that could not be fetched; their slots carry the card name instead. */
  failed: { name: string; url: string }[];
}

export function pdfFileName(date: string): string {
  return `cube-print-${date}.pdf`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function defaultFetch(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export const TEST_PAGE_INSTRUCTIONS: string[] = [
  '1. Print this from a computer, not from a phone.',
  '2. In the print dialog, set the scale to 100 percent or Actual size. Chrome: More settings, Scale, Default. Acrobat and Edge: Actual size. macOS Preview: Scale 100 percent. Leave Fit to page and borderless printing off.',
  '3. Measure the two lines with a ruler, from end tick to end tick.',
  '4. If either line is off by more than about 2 percent (about 3.6 mm on the 180 mm line or 5 mm on the 260 mm line), the print dialog is still scaling. Fix the setting and print again.',
  '5. If both are off by less, enter the two measured lengths in the Calibration box in the Print view of the app.',
];

function drawLine(doc: JsPDF, l: Line) {
  doc.line(l.x1, l.y1, l.x2, l.y2);
}

/** Page 1: the two measuring lines, one slip at the target size, the profile, the date and the instructions. */
export function drawTestPage(doc: JsPDF, settings: PrintSettings, date: string): void {
  const g = testPageGeometry(settings);
  doc.setDrawColor(0);
  doc.setTextColor(0);
  doc.setLineWidth(0.3);
  drawLine(doc, g.horizontal);
  drawLine(doc, g.vertical);
  for (const t of g.ticks) drawLine(doc, t);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('180 mm', g.horizontalLabel.x, g.horizontalLabel.y, { align: 'center' });
  // Written along the line, so it stays clear of the text on the page.
  doc.text('260 mm', g.verticalLabel.x, g.verticalLabel.y, { angle: 90 });
  doc.setLineWidth(0.2);
  doc.rect(g.slip.x, g.slip.y, g.slip.w, g.slip.h, 'S');
  doc.setFontSize(9);
  doc.text(['one slip at the target size', `${settings.slipW} x ${settings.slipH} mm`], g.slipLabel.x, g.slipLabel.y);

  let y = g.text.y;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Test page: check the print size', g.text.x, y);
  y += 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const head = [
    `Date: ${date}`,
    `Printer profile: ${settings.profile.name}`,
    `Factors: fx ${settings.profile.fx.toFixed(4)}, fy ${settings.profile.fy.toFixed(4)}`,
    `Slip: ${settings.slipW} x ${settings.slipH} mm, gap ${settings.gap} mm`,
  ];
  doc.text(head, g.text.x, y);
  y += head.length * 5 + 4;
  for (const para of TEST_PAGE_INSTRUCTIONS) {
    const lines = doc.splitTextToSize(para, g.text.w) as string[];
    doc.text(lines, g.text.x, y);
    y += lines.length * 4.6 + 2.5;
  }
  const below = g.slipLabel.y + 16;
  doc.setFontSize(9);
  doc.setTextColor(90);
  doc.text(
    doc.splitTextToSize(
      'The two lines are drawn at their true length, with no printer correction, so the measurement shows what the printer does. The slip rectangle has the printer profile applied, like the slips on the following pages.',
      Math.max(60, g.text.x - g.slipLabel.x - 6),
    ) as string[],
    g.slipLabel.x,
    below,
  );
  doc.setTextColor(0);
}

/** Build the whole PDF: the test page, then fronts, the Back pool and Tokens. */
export async function buildPrintPdf(input: PdfInput): Promise<PdfResult> {
  const { slips, settings, date, onProgress, signal } = input;
  const fetchImage = input.fetchImage ?? defaultFetch;
  const gap = input.gapMs ?? 50;
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  doc.setProperties({
    title: `Cube print sheet ${date}`,
    subject: `${slips.length} slips at ${settings.slipW} x ${settings.slipH} mm, printer ${settings.profile.name}, ${date}`,
    author: 'Cube',
    creator: 'Cube',
    keywords: `cube print ${date}`,
  });
  doc.viewerPreferences({ PrintScaling: 'None' });
  drawTestPage(doc, settings, date);

  const format = settings.quality === 'best' ? 'PNG' : 'JPEG';
  const urls = [...new Set(slips.map((s) => s.url))];
  const images = new Map<string, Uint8Array>();
  const failedUrls = new Set<string>();
  onProgress?.({ done: 0, total: urls.length, current: null });
  for (let i = 0; i < urls.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = urls[i]!;
    const name = slips.find((s) => s.url === url)?.name ?? url;
    onProgress?.({ done: i, total: urls.length, current: name });
    if (i > 0) await sleep(gap);
    try {
      images.set(url, await fetchImage(url));
    } catch {
      await sleep(Math.max(gap, 500));
      try {
        images.set(url, await fetchImage(url));
      } catch {
        failedUrls.add(url);
      }
    }
  }
  onProgress?.({ done: urls.length, total: urls.length, current: null });

  const rects = slipRects(settings);
  const label = labelPosition(rects);
  const pages = slipPages(slips);
  for (const page of pages) {
    doc.addPage('a4', 'portrait');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(120);
    doc.text(`${page.label} - ${date}`, label.x, label.y);
    doc.setTextColor(0);
    page.items.forEach((slip, i) => {
      const r = rects[i]!;
      const data = images.get(slip.url);
      let drawn = false;
      if (data) {
        try {
          // Explicit width and height: the image fills the slip exactly.
          doc.addImage(data, format, r.x, r.y, r.w, r.h, slip.url, format === 'PNG' ? 'FAST' : 'NONE');
          drawn = true;
        } catch {
          failedUrls.add(slip.url);
        }
      }
      if (!drawn) {
        doc.setDrawColor(150);
        doc.setLineWidth(0.2);
        doc.rect(r.x, r.y, r.w, r.h, 'S');
        doc.setFontSize(9);
        doc.text(doc.splitTextToSize(`${slip.name}: image missing`, r.w - 8) as string[], r.x + 4, r.y + 10);
      }
    });
    // Crop marks around the filled slots only.
    const marks = settings.cropMarks ? cropMarks(rects.slice(0, page.items.length)) : [];
    if (marks.length) {
      doc.setDrawColor(CROP_GREY);
      doc.setLineWidth(CROP_WIDTH);
      for (const m of marks) drawLine(doc, m);
    }
  }
  const failed = [...failedUrls].map((url) => ({ url, name: slips.find((s) => s.url === url)?.name ?? url }));
  return { bytes: doc.output('arraybuffer'), pages: 1 + pages.length, failed };
}

/** Only the test page. */
export async function buildTestPagePdf(settings: PrintSettings, date: string): Promise<PdfResult> {
  return buildPrintPdf({ slips: [], settings, date });
}
