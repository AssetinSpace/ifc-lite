/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drawing-underlays panel (D-072 in the AIM repo) — attach georeferenced PDF
 * floor plans to building storeys.
 *
 * Registered as the `drawing-underlay` workspace panel, so it docks / floats /
 * pops out like every other panel. The panel lists known drawings (pushed by
 * the embedding host over the AIM bridge, or added locally as files), exposes
 * per-drawing opacity/visibility, and drives the 2-point calibration flow:
 *
 *   pick point A on the PDF preview → click matching model point in 3D →
 *   pick point B on the PDF → click matching model point → Save.
 *
 * Page points live in PDF page coordinates (points, y-up) so the calibration
 * is raster-resolution independent; model points arrive from the 3D click
 * interception in selectionHandlers.ts as IFC plan metres.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Eye, EyeOff, FilePlus2, Map as MapIcon, Trash2, X } from 'lucide-react';
import {
  createDrawingPlacement,
  solveSimilarityFromCalibration,
  type CalibrationPair,
  type Point2,
} from '@ifc-lite/drawing-underlay';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/toast';
import { useViewerStore, type UnderlayDrawing } from '@/store';
import { useFloorplanView } from '@/hooks/useFloorplanView';
import { useIfc } from '@/hooks/useIfc';
import { openPdfDocument, rasterizePdfPage } from '@/lib/pdf/rasterize';

interface DrawingUnderlayPanelProps {
  onClose: () => void;
}

/** Longest preview edge (CSS px is decided by layout; this is raster quality). */
const PREVIEW_RASTER_PX = 1400;

interface PreviewState {
  canvas: HTMLCanvasElement;
  /** Raster pixels per PDF point (uniform). */
  pixelsPerPoint: number;
  /** Page size [w, h] in PDF points. */
  pageSizePts: [number, number];
}

/** A storey option with its resolved GlobalId (placements bind to GUIDs). */
interface StoreyOption {
  key: string;
  name: string;
  elevation: number;
  guid: string;
}

export function DrawingUnderlayPanel({ onClose }: DrawingUnderlayPanelProps) {
  const drawings = useViewerStore((s) => s.underlayDrawings);
  const calibration = useViewerStore((s) => s.underlayCalibration);
  const startCalibration = useViewerStore((s) => s.startUnderlayCalibration);
  const cancelCalibration = useViewerStore((s) => s.cancelUnderlayCalibration);
  const setCalibrationPageSize = useViewerStore((s) => s.setUnderlayCalibrationPageSize);
  const addPagePoint = useViewerStore((s) => s.addUnderlayCalibrationPagePoint);
  const setPlacement = useViewerStore((s) => s.setUnderlayPlacement);
  const setOpacity = useViewerStore((s) => s.setUnderlayOpacity);
  const setVisible = useViewerStore((s) => s.setUnderlayVisible);
  const upsertDrawing = useViewerStore((s) => s.upsertUnderlayDrawing);
  const removeDrawing = useViewerStore((s) => s.removeUnderlayDrawing);

  const { models, ifcDataStore } = useIfc();
  const { availableStoreys, enterDrawingView, exitDrawingView } = useFloorplanView();
  const viewLocked = useViewerStore((s) => s.underlayViewLocked);

  // Storeys with resolved GlobalIds — placements are keyed to the storey GUID
  // (stable across loads), never the session-scoped expressId.
  const storeyOptions = useMemo((): StoreyOption[] => {
    const options: StoreyOption[] = [];
    for (const s of availableStoreys) {
      const store =
        s.modelId === 'legacy' ? ifcDataStore : models.get(s.modelId)?.ifcDataStore;
      const guid = store?.entities.getGlobalId(s.expressId) ?? '';
      if (!guid) continue; // no GUID → placement couldn't be re-resolved later
      options.push({
        key: `${s.modelId}:${s.expressId}`,
        name: s.name,
        elevation: s.elevation,
        guid,
      });
    }
    return options;
  }, [availableStoreys, models, ifcDataStore]);

  const [storeyKey, setStoreyKey] = useState<string>('');
  const selectedStorey =
    storeyOptions.find((s) => s.key === storeyKey) ?? storeyOptions[0] ?? null;

  const drawingList = useMemo(() => [...drawings.values()], [drawings]);
  const calibratingDrawing = calibration ? drawings.get(calibration.drawingId) : undefined;

  // ── Local PDF import (standalone use + testing without a host) ──────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const onFilePicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      upsertDrawing({
        id: `local:${file.name}:${file.size}`,
        name: file.name,
        pdfUrl: URL.createObjectURL(file),
        placement: null,
      });
    },
    [upsertDrawing],
  );

  // ── Calibration preview raster ───────────────────────────────────────────
  const previewHostRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!calibration || !calibratingDrawing) return;
    let stale = false;
    void (async () => {
      try {
        const doc = await openPdfDocument(calibratingDrawing.pdfUrl);
        try {
          const raster = await rasterizePdfPage(
            doc,
            calibration.page,
            PREVIEW_RASTER_PX,
            PREVIEW_RASTER_PX,
          );
          if (stale) {
            raster.image.close();
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = raster.width;
          canvas.height = raster.height;
          canvas.getContext('2d')?.drawImage(raster.image, 0, 0);
          raster.image.close();
          setPreview({
            canvas,
            pixelsPerPoint: raster.pixelsPerPoint,
            pageSizePts: raster.pageSizePts,
          });
          setCalibrationPageSize(raster.pageSizePts);
        } finally {
          void doc.destroy();
        }
      } catch (err) {
        console.error('drawing-underlay: preview rasterization failed', err);
        if (!stale) setPreviewError('Could not render the PDF page.');
      }
    })();
    return () => {
      stale = true;
    };
    // Re-rasterize when the drawing or page changes, not on point picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calibration?.drawingId, calibration?.page, calibratingDrawing?.pdfUrl]);

  // Mount the preview canvas into the DOM host.
  useEffect(() => {
    const host = previewHostRef.current;
    if (!host || !preview) return;
    preview.canvas.style.width = '100%';
    preview.canvas.style.height = 'auto';
    preview.canvas.style.display = 'block';
    host.replaceChildren(preview.canvas);
    return () => host.replaceChildren();
  }, [preview]);

  /** Whose turn is it? Alternation: page → model → page → model. */
  const awaiting: 'page' | 'model' | 'done' = !calibration
    ? 'done'
    : calibration.pagePoints.length > calibration.modelPoints.length
      ? 'model'
      : calibration.pagePoints.length < 2
        ? 'page'
        : 'done';

  const onPreviewClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!calibration || !preview || awaiting !== 'page') return;
      const host = previewHostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      // CSS px → raster px → PDF page points (bottom-left origin, y up).
      const rasterX = ((e.clientX - rect.left) / rect.width) * preview.canvas.width;
      const rasterY = ((e.clientY - rect.top) / rect.height) * preview.canvas.height;
      const pagePt: Point2 = {
        x: rasterX / preview.pixelsPerPoint,
        y: (preview.canvas.height - rasterY) / preview.pixelsPerPoint,
      };
      addPagePoint(pagePt);
    },
    [calibration, preview, awaiting, addPagePoint],
  );

  const canSave =
    !!calibration &&
    calibration.pagePoints.length === 2 &&
    calibration.modelPoints.length === 2 &&
    !!calibration.pageSize &&
    !!selectedStorey;

  const onSave = useCallback(() => {
    if (!calibration || !calibration.pageSize || !selectedStorey || !calibratingDrawing) return;
    const pairs: [CalibrationPair, CalibrationPair] = [
      { page: calibration.pagePoints[0], model: calibration.modelPoints[0] },
      { page: calibration.pagePoints[1], model: calibration.modelPoints[1] },
    ];
    try {
      const affine = solveSimilarityFromCalibration(pairs);
      const placement = createDrawingPlacement({
        storeyGuid: selectedStorey.guid,
        storeyZ: selectedStorey.elevation,
        page: calibration.page,
        pageSize: calibration.pageSize,
        affine,
        calibration: pairs,
        calibratedAt: new Date().toISOString(),
      });
      setPlacement(calibration.drawingId, placement);
      toast.success(`"${calibratingDrawing.name}" placed on ${selectedStorey.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Calibration failed');
    }
  }, [calibration, selectedStorey, calibratingDrawing, setPlacement]);

  /** Marker position (CSS %) for a picked page point on the preview. */
  const markerStyle = useCallback(
    (p: Point2): React.CSSProperties | null => {
      if (!preview) return null;
      const [w, h] = preview.pageSizePts;
      if (w <= 0 || h <= 0) return null;
      return {
        left: `${(p.x / w) * 100}%`,
        top: `${((h - p.y) / h) * 100}%`,
      };
    },
    [preview],
  );

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Drawing underlays">
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <MapIcon className="size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 text-xs font-semibold leading-tight">Drawing underlays</div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          onClick={() => fileInputRef.current?.click()}
          title="Add a PDF drawing from a local file"
        >
          <FilePlus2 className="mr-1 size-3.5" aria-hidden /> Add PDF
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={onFilePicked}
        />
        <Button variant="ghost" size="icon" className="size-6" onClick={onClose} aria-label="Close panel">
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>

      {/* Storey picker */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <label className="text-[11px] text-muted-foreground" htmlFor="underlay-storey">
          Storey
        </label>
        <select
          id="underlay-storey"
          className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-[11px]"
          value={selectedStorey?.key ?? ''}
          onChange={(e) => setStoreyKey(e.target.value)}
        >
          {storeyOptions.length === 0 && <option value="">No storeys loaded</option>}
          {storeyOptions.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name} ({s.elevation.toFixed(2)} m)
            </option>
          ))}
        </select>
        <Button
          variant={viewLocked ? 'default' : 'outline'}
          size="sm"
          className="h-6 shrink-0 px-2 text-[11px]"
          disabled={!selectedStorey && !viewLocked}
          onClick={() => {
            if (viewLocked) {
              exitDrawingView();
              return;
            }
            const storey = availableStoreys.find(
              (s) => `${s.modelId}:${s.expressId}` === selectedStorey?.key,
            );
            if (storey) enterDrawingView(storey);
          }}
          title="Level-locked top-down view with the storey cut (Ctrl+scroll moves the cut)"
        >
          {viewLocked ? 'Exit view' : 'Drawing view'}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {/* Calibration flow */}
        {calibration && calibratingDrawing && (
          <div className="border-b p-3">
            <div className="mb-1 flex items-center gap-2">
              <Crosshair className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                Calibrating: {calibratingDrawing.name}
              </span>
            </div>
            <p className="mb-2 text-[11px] text-muted-foreground">
              {awaiting === 'page' &&
                `Click point ${calibration.pagePoints.length + 1} of 2 on the drawing below.`}
              {awaiting === 'model' &&
                `Now click the matching point ${calibration.modelPoints.length + 1} in the 3D model.`}
              {awaiting === 'done' && 'Both point pairs picked — save to place the drawing.'}
            </p>
            {previewError && <p className="mb-2 text-[11px] text-destructive">{previewError}</p>}
            <div className="relative">
              <div
                ref={previewHostRef}
                onClick={onPreviewClick}
                className={`relative overflow-hidden rounded border ${awaiting === 'page' ? 'cursor-crosshair ring-1 ring-primary/50' : ''}`}
              />
              {preview &&
                calibration.pagePoints.map((p, i) => {
                  const style = markerStyle(p);
                  return style ? (
                    <span
                      key={i}
                      className="pointer-events-none absolute z-10 flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground ring-2 ring-background"
                      style={style}
                    >
                      {i + 1}
                    </span>
                  ) : null;
                })}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="flex-1 text-[10px] text-muted-foreground">
                PDF {calibration.pagePoints.length}/2 · model {calibration.modelPoints.length}/2
              </span>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={cancelCalibration}>
                Cancel
              </Button>
              <Button size="sm" className="h-6 px-2 text-[11px]" disabled={!canSave} onClick={onSave}>
                Save placement
              </Button>
            </div>
          </div>
        )}

        {/* Drawing list */}
        <div className="flex flex-col gap-1 p-2">
          {drawingList.length === 0 && (
            <div className="flex flex-col items-center gap-1 p-6 text-center">
              <MapIcon className="size-5 text-muted-foreground" aria-hidden />
              <p className="text-xs font-medium">No drawings yet</p>
              <p className="text-[11px] text-muted-foreground">
                Add a PDF floor plan and calibrate it to a storey with two reference points.
              </p>
            </div>
          )}
          {drawingList.map((d) => (
            <DrawingRow
              key={d.id}
              drawing={d}
              calibrating={calibration?.drawingId === d.id}
              onCalibrate={() => startCalibration(d.id, d.placement?.page ?? 1)}
              onOpacity={(v) => setOpacity(d.id, v)}
              onToggleVisible={() => setVisible(d.id, !(d.placement?.visible ?? true))}
              onRemove={() => removeDrawing(d.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function DrawingRow({
  drawing,
  calibrating,
  onCalibrate,
  onOpacity,
  onToggleVisible,
  onRemove,
}: {
  drawing: UnderlayDrawing;
  calibrating: boolean;
  onCalibrate: () => void;
  onOpacity: (value: number) => void;
  onToggleVisible: () => void;
  onRemove: () => void;
}) {
  const p = drawing.placement;
  return (
    <div className={`rounded border p-2 ${calibrating ? 'ring-1 ring-primary/50' : ''}`}>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={drawing.name}>
          {drawing.name}
        </span>
        {p ? (
          <span className="shrink-0 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium leading-none text-emerald-600 dark:text-emerald-300">
            placed
          </span>
        ) : (
          <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium leading-none text-muted-foreground">
            not calibrated
          </span>
        )}
        {p && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={onToggleVisible}
            aria-label={p.visible ? 'Hide drawing' : 'Show drawing'}
            title={p.visible ? 'Hide drawing' : 'Show drawing'}
          >
            {p.visible ? <Eye className="size-3.5" aria-hidden /> : <EyeOff className="size-3.5" aria-hidden />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onRemove}
          aria-label="Remove drawing"
          title="Remove drawing"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={onCalibrate}
          disabled={calibrating}
        >
          <Crosshair className="mr-1 size-3" aria-hidden />
          {p ? 'Recalibrate' : 'Calibrate'}
        </Button>
        {p && (
          <>
            <span className="text-[10px] text-muted-foreground">Opacity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={p.opacity}
              onChange={(e) => onOpacity(Number(e.target.value))}
              className="h-1 min-w-0 flex-1"
              aria-label="Drawing opacity"
            />
          </>
        )}
      </div>
    </div>
  );
}
