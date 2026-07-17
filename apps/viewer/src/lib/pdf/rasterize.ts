/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * pdf.js rasterization for drawing underlays (D-072 in the AIM repo).
 *
 * pdf.js stays app-side by design: `@ifc-lite/drawing-underlay` consumes
 * plain ImageBitmaps/canvases, so the (heavy) PDF dependency lives here and
 * loads lazily on first use. The worker is bundled from the installed
 * `pdfjs-dist` (self-hosted, version-matched — no CDN fetch, mirroring the
 * AIM app's drawing viewer).
 */

import type { PDFDocumentProxy } from 'pdfjs-dist';

/** Lazy singleton — pdf.js (~1 MB) loads only when a drawing is opened. */
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/**
 * Range-friendly loading: pdf.js pulls only the xref/page tree plus the
 * objects of the rendered page over HTTP Range requests where the server
 * supports them (Supabase Storage does), falling back to a full download.
 */
const DOCUMENT_OPTIONS = {
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: 262144,
} as const;

export interface RasterizedPage {
  /** Rendered page raster, transferred out of the canvas. */
  image: ImageBitmap;
  /** Raster size in device pixels. */
  width: number;
  height: number;
  /** Page size [w, h] in PDF points (the placement/calibration frame). */
  pageSizePts: [number, number];
  /** Raster pixels per PDF point (uniform; needed to map clicks → points). */
  pixelsPerPoint: number;
}

/** Open a PDF document by URL. Caller must `destroy()` it when done. */
export async function openPdfDocument(url: string): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({ url, ...DOCUMENT_OPTIONS }).promise;
}

/**
 * Rasterize a REGION of one page at an exact scale — the "vector zoom" path
 * (D-075): when the whole-page raster's ceiling is passed, the visible crop
 * is re-rendered from the PDF vectors at the current device scale, so text
 * and linework stay sharp at any zoom. The crop is expressed in device
 * pixels of the scaled page (viewport offsets shift the page so the crop
 * lands on the canvas; pdf.js clips to the canvas bounds).
 */
export interface RasterizedRegion {
  image: ImageBitmap;
  /** Region size in device pixels (canvas size). */
  width: number;
  height: number;
}

export async function rasterizePdfRegion(
  doc: PDFDocumentProxy,
  pageNumber: number,
  /** Raster scale: device pixels per PDF point. */
  pixelsPerPoint: number,
  /** Crop origin/size in device pixels of the scaled page (top-left frame). */
  crop: { x: number; y: number; width: number; height: number },
): Promise<RasterizedRegion> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({
    scale: pixelsPerPoint,
    offsetX: -crop.x,
    offsetY: -crop.y,
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(crop.width));
  canvas.height = Math.max(1, Math.ceil(crop.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('rasterizePdfRegion: 2D canvas context unavailable');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvas, canvasContext: ctx, viewport }).promise;

  const image = await createImageBitmap(canvas);
  return { image, width: canvas.width, height: canvas.height };
}

/** Handle for a rendered text layer — cancel stops streaming/layout. */
export interface PdfTextLayerHandle {
  cancel: () => void;
  /** Page width in PDF points — the caller derives `--total-scale-factor`
   *  (CSS px per point) from its layout width to keep spans aligned. */
  pageWidthPts: number;
}

/**
 * Render the selectable text layer for one page into `container` (D-075).
 * pdf.js positions spans in page-relative percentages and scales fonts via
 * the `--total-scale-factor` CSS variable, so zooming needs NO re-render —
 * the caller just updates the variable. Styling contract: the container
 * carries the `.pdf-doc-text-layer` class (see index.css).
 */
export async function renderPdfTextLayer(
  doc: PDFDocumentProxy,
  pageNumber: number,
  container: HTMLElement,
): Promise<PdfTextLayerHandle> {
  const pdfjs = await loadPdfjs();
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const layer = new pdfjs.TextLayer({
    textContentSource: page.streamTextContent(),
    container,
    viewport,
  });
  await layer.render();
  const raw = viewport.rawDims as { pageWidth?: number };
  return {
    cancel: () => layer.cancel(),
    pageWidthPts: raw.pageWidth ?? viewport.width,
  };
}

/** One positioned text run of a page (scale-1 viewport, page points, y-up). */
export interface PdfPageTextItem {
  str: string;
  /** pdf.js text transform [a, b, c, d, e, f]; e/f = baseline origin. */
  transform: number[];
  width: number;
  height: number;
}

/**
 * Map a text-space transform into the VIEWED page frame (scale-1 viewport,
 * bottom-left origin, y-up) — the same frame the rasterized page and the
 * calibration affine live in. pdf.js text transforms are in raw PDF user
 * space, which ignores the page's `/Rotate`; drawings are routinely stored
 * rotated (landscape sheet + Rotate 90), so without this remap every link
 * box lands off-page. For an unrotated page this composition is exactly the
 * identity (flip ∘ viewportTransform = I).
 *
 * Exported for tests.
 */
export function mapTextTransformToViewport(
  itemTransform: number[],
  viewportTransform: number[],
  viewportHeight: number,
): number[] {
  // compose(M2, M1): apply M1 first, then M2 — [a,b,c,d,e,f] row form.
  const compose = (m2: number[], m1: number[]): number[] => [
    m2[0] * m1[0] + m2[2] * m1[1],
    m2[1] * m1[0] + m2[3] * m1[1],
    m2[0] * m1[2] + m2[2] * m1[3],
    m2[1] * m1[2] + m2[3] * m1[3],
    m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
    m2[1] * m1[4] + m2[3] * m1[5] + m2[5],
  ];
  // viewportTransform maps user space → device space (top-left, y-down);
  // the trailing flip converts device space to the y-up frame we use.
  const flip = [1, 0, 0, -1, 0, viewportHeight];
  return compose(compose(flip, viewportTransform), itemTransform);
}

/**
 * Extract the positioned text items of one page (identifier-link scanning,
 * D-076 in the AIM repo). Returns geometry in the scale-1 VIEWPORT frame
 * (page rotation applied, y-up) so boxes can be mapped onto the rendered
 * raster and the calibration affine.
 */
export async function getPdfPageTextItems(
  doc: PDFDocumentProxy,
  pageNumber: number,
): Promise<{ items: PdfPageTextItem[]; pageSizePts: [number, number] }> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: PdfPageTextItem[] = [];
  for (const item of content.items) {
    // Skip TextMarkedContent entries — only real text runs carry `str`.
    if (!('str' in item) || typeof item.str !== 'string' || item.str.length === 0) continue;
    items.push({
      str: item.str,
      transform: mapTextTransformToViewport(item.transform, viewport.transform, viewport.height),
      width: item.width,
      height: item.height,
    });
  }
  return { items, pageSizePts: [viewport.width, viewport.height] };
}

/**
 * Rasterize one page to an ImageBitmap for texture upload.
 *
 * `targetPx` bounds the raster's longest edge; the effective size is further
 * clamped to `maxTextureDimension` (pass the device limit) so the bitmap is
 * always uploadable. Returns the pixels-per-point scale so UI click
 * coordinates can be converted into the resolution-independent PDF-point
 * frame the calibration affine is defined on.
 */
export async function rasterizePdfPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  targetPx: number,
  maxTextureDimension: number,
): Promise<RasterizedPage> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const pageSizePts: [number, number] = [base.width, base.height];

  const longestPts = Math.max(base.width, base.height);
  const cappedPx = Math.min(targetPx, maxTextureDimension);
  const scale = cappedPx / longestPts;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('rasterizePdfPage: 2D canvas context unavailable');

  // Drawings are typically vector linework on a transparent page; fill white
  // so the underlay reads like paper rather than punching a hole in the scene.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvas, canvasContext: ctx, viewport }).promise;

  const image = await createImageBitmap(canvas);
  return {
    image,
    width: canvas.width,
    height: canvas.height,
    pageSizePts,
    pixelsPerPoint: scale,
  };
}
