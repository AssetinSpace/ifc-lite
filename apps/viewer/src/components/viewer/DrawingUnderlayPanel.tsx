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
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  Eye,
  EyeOff,
  FilePlus2,
  Map as MapIcon,
  Maximize2,
  Move,
  RotateCcw,
  RotateCw,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  adjustAffine,
  applyAffine,
  createDrawingPlacement,
  similarityFromAnchor,
  similarityRotation,
  similarityScale,
  solveSimilarityFromCalibration,
  type Affine2x3,
  type CalibrationPair,
  type DrawingPlacement,
} from '@ifc-lite/drawing-underlay';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/toast';
import { useViewerStore, type UnderlayDrawing } from '@/store';
import { useFloorplanView } from '@/hooks/useFloorplanView';
import { CalibrationPdfSurface } from './CalibrationPdfSurface';
import { IdentifierLinkSettings } from './IdentifierLinkSettings';

interface DrawingUnderlayPanelProps {
  onClose: () => void;
}

export function DrawingUnderlayPanel({ onClose }: DrawingUnderlayPanelProps) {
  const drawings = useViewerStore((s) => s.underlayDrawings);
  const calibration = useViewerStore((s) => s.underlayCalibration);
  const startCalibration = useViewerStore((s) => s.startUnderlayCalibration);
  const setCalibrationMode = useViewerStore((s) => s.setUnderlayCalibrationMode);
  const setOneParams = useViewerStore((s) => s.setUnderlayCalibrationOneParams);
  const cancelCalibration = useViewerStore((s) => s.cancelUnderlayCalibration);
  const undoCalibrationPoint = useViewerStore((s) => s.undoUnderlayCalibrationPoint);
  const setCalibrationExpanded = useViewerStore((s) => s.setUnderlayCalibrationExpanded);
  const setPlacement = useViewerStore((s) => s.setUnderlayPlacement);
  const setOpacity = useViewerStore((s) => s.setUnderlayOpacity);
  const commitPlacement = useViewerStore((s) => s.commitUnderlayPlacement);
  const setVisible = useViewerStore((s) => s.setUnderlayVisible);
  const upsertDrawing = useViewerStore((s) => s.upsertUnderlayDrawing);
  const removeDrawing = useViewerStore((s) => s.removeUnderlayDrawing);

  // storeyOptions: shared resolution (useFloorplanView) — placements are
  // keyed to the storey GUID (stable across loads), never the expressId.
  const { storeyOptions, enterDrawingView, enterSplitView, exitSplitView, retargetView } =
    useFloorplanView();
  const retargetCalibrationStorey = useViewerStore((s) => s.retargetUnderlayCalibrationStorey);
  const splitView = useViewerStore((s) => s.underlaySplitView);

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

  /** Pairs the active mode needs: 1 anchor, or 2 for the full solve. */
  const needPairs = calibration?.mode === 'one-point' ? 1 : 2;

  /** Whose turn is it? Alternation: page → model (→ page → model). */
  const awaiting: 'page' | 'model' | 'done' = !calibration
    ? 'done'
    : calibration.pagePoints.length > calibration.modelPoints.length
      ? 'model'
      : calibration.pagePoints.length < needPairs
        ? 'page'
        : 'done';

  const canSave =
    !!calibration &&
    calibration.pagePoints.length === needPairs &&
    calibration.modelPoints.length === needPairs &&
    !!calibration.pageSize &&
    (calibration.mode === 'two-point' || calibration.oneScaleDen > 0);

  // One-point mode inputs (local strings; valid parses stream to the draft so
  // the ghost preview re-fits live). Re-seeded when a calibration starts.
  const [oneScaleInput, setOneScaleInput] = useState('50');
  const [oneAngleInput, setOneAngleInput] = useState('0');
  const calibrationDrawingId = calibration?.drawingId ?? null;
  useEffect(() => {
    if (!calibrationDrawingId) return;
    const c = useViewerStore.getState().underlayCalibration;
    if (!c) return;
    setOneScaleInput(String(c.oneScaleDen));
    setOneAngleInput(String(c.oneRotationDeg));
  }, [calibrationDrawingId]);

  /**
   * Dalux-style precision feedback for the picked A–B span: model distance,
   * distance on paper, the implied drawing scale, and rotation. Null until
   * both pairs are picked (or when the picks are degenerate).
   */
  const metrics = useMemo(() => {
    // Only the 2-point solve MEASURES scale/rotation; in one-point mode both
    // are user inputs, so there is nothing derived to report.
    if (!canSave || !calibration || calibration.mode !== 'two-point') return null;
    const pairs: [CalibrationPair, CalibrationPair] = [
      { page: calibration.pagePoints[0], model: calibration.modelPoints[0] },
      { page: calibration.pagePoints[1], model: calibration.modelPoints[1] },
    ];
    try {
      const affine = solveSimilarityFromCalibration(pairs);
      const modelDistM = Math.hypot(
        pairs[1].model.x - pairs[0].model.x,
        pairs[1].model.y - pairs[0].model.y,
      );
      // PDF points → millimetres on paper (1 pt = 25.4/72 mm).
      const pageDistMm =
        Math.hypot(pairs[1].page.x - pairs[0].page.x, pairs[1].page.y - pairs[0].page.y) *
        (25.4 / 72);
      const scaleDenominator = (modelDistM * 1000) / pageDistMm;
      const rotationDeg = (similarityRotation(affine) * 180) / Math.PI;
      // Short spans amplify pick error into scale/rotation error.
      const weak = modelDistM < 2;
      return { modelDistM, pageDistMm, scaleDenominator, rotationDeg, weak };
    } catch {
      return null; // coincident points
    }
  }, [canSave, calibration]);

  const onSave = useCallback(() => {
    if (!calibration || !calibration.pageSize || !calibratingDrawing) return;
    try {
      const anchor: CalibrationPair = {
        page: calibration.pagePoints[0],
        model: calibration.modelPoints[0],
      };
      let affine: Affine2x3;
      let pairs: CalibrationPair[];
      if (calibration.mode === 'one-point') {
        // 1:N paper→model with 1 pt = 25.4/72 mm ⇒ metres per page point.
        affine = similarityFromAnchor(
          anchor,
          (calibration.oneScaleDen * 25.4) / 72000,
          (calibration.oneRotationDeg * Math.PI) / 180,
        );
        pairs = [anchor];
      } else {
        const two: [CalibrationPair, CalibrationPair] = [
          anchor,
          { page: calibration.pagePoints[1], model: calibration.modelPoints[1] },
        ];
        affine = solveSimilarityFromCalibration(two);
        pairs = two;
      }
      // Storey comes from the draft — bound at start, follows explicit
      // dropdown retargets.
      const placement = createDrawingPlacement({
        storeyGuid: calibration.storeyGuid,
        storeyZ: calibration.storeyZ,
        page: calibration.page,
        pageSize: calibration.pageSize,
        affine,
        calibration: pairs,
        calibratedAt: new Date().toISOString(),
      });
      setPlacement(calibration.drawingId, placement);
      toast.success(`"${calibratingDrawing.name}" placed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Calibration failed');
    }
  }, [calibration, calibratingDrawing, setPlacement]);

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
          onChange={(e) => {
            setStoreyKey(e.target.value);
            // A live drawing/split view follows the dropdown: re-cut the 3D
            // at the new level; mid-calibration also rebind the draft (its
            // model points are cleared — they sat on the old floor).
            const option = storeyOptions.find((s) => s.key === e.target.value);
            if (!option) return;
            retargetView(option.info);
            if (calibration) {
              const hadModelPoints = calibration.modelPoints.length > 0;
              retargetCalibrationStorey({ guid: option.guid, z: option.elevation });
              if (hadModelPoints) {
                toast.info('Storey changed — pick the model points again on the new level');
              }
            }
          }}
        >
          {storeyOptions.length === 0 && <option value="">No storeys loaded</option>}
          {storeyOptions.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name} ({s.elevation.toFixed(2)} m)
            </option>
          ))}
        </select>
        <Button
          variant={splitView ? 'default' : 'outline'}
          size="sm"
          className="h-6 shrink-0 px-2 text-[11px]"
          disabled={!selectedStorey && !splitView}
          onClick={() => {
            if (splitView) {
              exitSplitView();
              return;
            }
            if (selectedStorey) enterSplitView(selectedStorey.info);
          }}
          title="Split view: 2D plan beside a navigable 3D, camera synced (Ctrl+scroll moves the storey cut)"
        >
          {splitView ? 'Exit split' : 'Split view'}
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
            {/* Mode: measure everything from 2 points, or trust the drawing
                (1 anchor + title-block scale + angle — no angular error from
                a short pick span). */}
            <div className="mb-2 flex gap-1" role="group" aria-label="Calibration mode">
              <Button
                variant={calibration.mode === 'two-point' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 flex-1 px-2 text-[11px]"
                onClick={() => setCalibrationMode('two-point')}
                title="Pick two point pairs — scale and rotation are measured from them"
              >
                2 points
              </Button>
              <Button
                variant={calibration.mode === 'one-point' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 flex-1 px-2 text-[11px]"
                onClick={() => setCalibrationMode('one-point')}
                title="Pick one anchor point and type the drawing scale (1:N) and rotation — exact when the title block is trusted"
              >
                1 point + scale
              </Button>
            </div>
            {calibration.mode === 'one-point' && (
              <div className="mb-2 flex items-center gap-1.5">
                <label className="text-[10px] text-muted-foreground" htmlFor="one-point-scale">
                  Scale 1:
                </label>
                <input
                  id="one-point-scale"
                  type="number"
                  min={1}
                  step={1}
                  value={oneScaleInput}
                  onChange={(e) => {
                    setOneScaleInput(e.target.value);
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v > 0) setOneParams({ scaleDen: v });
                  }}
                  className="h-5 w-16 rounded border bg-background px-1 text-[10px]"
                />
                <label className="text-[10px] text-muted-foreground" htmlFor="one-point-angle">
                  Angle
                </label>
                <input
                  id="one-point-angle"
                  type="number"
                  step={0.01}
                  value={oneAngleInput}
                  onChange={(e) => {
                    setOneAngleInput(e.target.value);
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setOneParams({ rotationDeg: v });
                  }}
                  className="h-5 w-14 rounded border bg-background px-1 text-[10px]"
                />
                <span className="text-[10px] text-muted-foreground">°</span>
              </div>
            )}
            <p className="mb-2 text-[11px] text-muted-foreground">
              {awaiting === 'page' &&
                (calibration.mode === 'one-point'
                  ? 'Click the reference point on the drawing below.'
                  : `Click point ${calibration.pagePoints.length + 1} of 2 on the drawing below.`)}
              {awaiting === 'model' &&
                (calibration.mode === 'one-point'
                  ? 'Now click the matching point in the 3D model.'
                  : `Now click the matching point ${calibration.modelPoints.length + 1} in the 3D model.`)}
              {awaiting === 'done' &&
                (calibration.mode === 'one-point'
                  ? 'Anchor placed — adjust scale/angle (live preview) and save.'
                  : 'Both point pairs picked — save to place the drawing.')}
            </p>
            <div className="mb-1.5 flex justify-end">
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => setCalibrationExpanded(true)}
                title="Open the drawing on a big screen for precise picking"
              >
                <Maximize2 className="mr-1 size-3" aria-hidden /> Big screen
              </Button>
            </div>
            {/* Shared pick surface (also rendered big in CalibrationPdfOverlay). */}
            <CalibrationPdfSurface />
            {metrics && (
              <div
                className={`mt-1.5 rounded border px-2 py-1 text-[10px] ${metrics.weak ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}
              >
                A–B: {metrics.modelDistM.toFixed(2)} m in model · {metrics.pageDistMm.toFixed(1)} mm
                on paper · scale ≈ 1:{Math.round(metrics.scaleDenominator)} · rotation{' '}
                {metrics.rotationDeg.toFixed(1)}°
                {metrics.weak && ' — points are close together; pick a longer span for accuracy'}
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={undoCalibrationPoint}
                disabled={calibration.pagePoints.length === 0}
                title="Remove the last picked point"
              >
                <Undo2 className="mr-1 size-3" aria-hidden /> Undo
              </Button>
              <span className="flex-1" />
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
              onCalibrate={() => {
                // Recalibration edits the drawing's OWN storey — preselect it
                // so Save can't silently move the drawing to whatever level
                // happened to be picked in the dropdown.
                const own = d.placement
                  ? storeyOptions.find((s) => s.guid === d.placement!.storeyGuid)
                  : undefined;
                const target = own ?? selectedStorey ?? undefined;
                if (own) setStoreyKey(own.key);
                // Prepare the 3D side automatically: storey cut + locked
                // ortho top-down, so the matching model points can be picked
                // precisely on the exposed floor plan (vertical rays = exact
                // plan XY, no slanted-view raycast error).
                if (!target) {
                  toast.error('Load a model first — calibration needs a storey to bind to');
                  return;
                }
                enterDrawingView(target.info);
                startCalibration(d.id, d.placement?.page ?? 1, {
                  guid: target.guid,
                  z: target.elevation,
                });
                // Recalibrate seeds one-point mode with the CURRENT placement's
                // scale/rotation, so switching modes starts from reality.
                if (d.placement) {
                  const den = (similarityScale(d.placement.affine) * 1000 * 72) / 25.4;
                  const deg = (similarityRotation(d.placement.affine) * 180) / Math.PI;
                  setOneParams({
                    scaleDen: Math.round(den * 10) / 10,
                    rotationDeg: Math.round(deg * 100) / 100,
                  });
                }
              }}
              onOpacity={(v) => setOpacity(d.id, v)}
              onOpacityCommit={() => commitPlacement(d.id)}
              onToggleVisible={() => setVisible(d.id, !(d.placement?.visible ?? true))}
              onRemove={() => removeDrawing(d.id)}
            />
          ))}
        </div>

        {/* Identifier hyperlinks (D-076): code source + pattern per project. */}
        <IdentifierLinkSettings />
      </ScrollArea>
    </div>
  );
}

function DrawingRow({
  drawing,
  calibrating,
  onCalibrate,
  onOpacity,
  onOpacityCommit,
  onToggleVisible,
  onRemove,
}: {
  drawing: UnderlayDrawing;
  calibrating: boolean;
  onCalibrate: () => void;
  /** Live (per-tick) opacity update — store/GPU only, no persistence. */
  onOpacity: (value: number) => void;
  /** Persist once, on gesture end (pointer/key release, blur). */
  onOpacityCommit: () => void;
  onToggleVisible: () => void;
  onRemove: () => void;
}) {
  const p = drawing.placement;
  const [fineTune, setFineTune] = useState(false);
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
          <Button
            variant={fineTune ? 'default' : 'ghost'}
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setFineTune((v) => !v)}
            title="Nudge the placed drawing numerically (move / rotate / scale)"
          >
            <Move className="mr-1 size-3" aria-hidden /> Fine-tune
          </Button>
        )}
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
              onPointerUp={onOpacityCommit}
              onKeyUp={onOpacityCommit}
              onBlur={onOpacityCommit}
              className="h-1 min-w-0 flex-1"
              aria-label="Drawing opacity"
            />
          </>
        )}
      </div>
      {p && fineTune && <FineTuneControls drawingId={drawing.id} placement={p} />}
    </div>
  );
}

/**
 * Numeric fine-tuning of a placed drawing (D-072 live feedback): nudge the
 * placement without re-picking calibration points — move by a chosen step in
 * plan metres, rotate in degrees about the page centre, or type an exact
 * drawing scale (1:N). Updates are live (store + GPU only); the placement is
 * persisted once, debounced, after the last nudge.
 */
function FineTuneControls({
  drawingId,
  placement,
}: {
  drawingId: string;
  placement: DrawingPlacement;
}) {
  const updateLive = useViewerStore((s) => s.updateUnderlayPlacementLive);
  const commitPlacement = useViewerStore((s) => s.commitUnderlayPlacement);

  const [moveStep, setMoveStep] = useState(0.05);
  const [rotStep, setRotStep] = useState(0.1);
  const currentRotDeg = (similarityRotation(placement.affine) * 180) / Math.PI;
  const [rotInput, setRotInput] = useState(currentRotDeg.toFixed(2));
  // Derived drawing scale: model mm per paper mm (1 pt = 25.4/72 mm).
  const currentDen = (similarityScale(placement.affine) * 1000 * 72) / 25.4;
  const [scaleInput, setScaleInput] = useState(String(Math.round(currentDen * 10) / 10));

  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCommit = useCallback(() => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => commitPlacement(drawingId), 1000);
  }, [commitPlacement, drawingId]);
  useEffect(() => () => {
    // Unmount mid-session: persist immediately rather than dropping the edit.
    if (commitTimer.current) {
      clearTimeout(commitTimer.current);
      commitPlacement(drawingId);
    }
  }, [commitPlacement, drawingId]);

  const apply = useCallback(
    (adjust: Parameters<typeof adjustAffine>[1]) => {
      const [w, h] = placement.pageSize;
      const center = applyAffine(placement.affine, { x: w / 2, y: h / 2 });
      const affine = adjustAffine(placement.affine, { ...adjust, center: adjust.center ?? center });
      updateLive(drawingId, { ...placement, affine });
      scheduleCommit();
    },
    [drawingId, placement, updateLive, scheduleCommit],
  );

  /** Absolute rotation: type the degrees, rotate by the delta to reach them. */
  const setRotationTo = useCallback(
    (raw: string) => {
      const target = Number(raw);
      if (!Number.isFinite(target)) return;
      apply({ rotateRad: ((target - currentRotDeg) * Math.PI) / 180 });
    },
    [apply, currentRotDeg],
  );

  /** Absolute drawing scale: type the 1:N denominator. */
  const setScaleTo = useCallback(
    (raw: string) => {
      const target = Number(raw);
      if (!Number.isFinite(target) || target <= 0) return;
      apply({ scaleFactor: target / currentDen });
    },
    [apply, currentDen],
  );

  return (
    <div className="mt-1.5 flex flex-col gap-1.5 rounded border bg-muted/30 p-1.5">
      <div className="flex items-center gap-1">
        <span className="w-10 text-[10px] text-muted-foreground">Move</span>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Move left"
          onClick={() => apply({ translate: { x: -moveStep, y: 0 } })}>
          <ChevronLeft className="size-3.5" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Move right"
          onClick={() => apply({ translate: { x: moveStep, y: 0 } })}>
          <ChevronRight className="size-3.5" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Move up (plan north)"
          onClick={() => apply({ translate: { x: 0, y: moveStep } })}>
          <ChevronUp className="size-3.5" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Move down (plan south)"
          onClick={() => apply({ translate: { x: 0, y: -moveStep } })}>
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
        <select
          className="h-5 rounded border bg-background px-0.5 text-[10px]"
          value={moveStep}
          onChange={(e) => setMoveStep(Number(e.target.value))}
          aria-label="Move step"
        >
          <option value={0.01}>1 cm</option>
          <option value={0.05}>5 cm</option>
          <option value={0.25}>25 cm</option>
          <option value={1}>1 m</option>
        </select>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-10 text-[10px] text-muted-foreground">Rotate</span>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Rotate counter-clockwise"
          onClick={() => apply({ rotateRad: (rotStep * Math.PI) / 180 })}>
          <RotateCcw className="size-3.5" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Rotate clockwise"
          onClick={() => apply({ rotateRad: (-rotStep * Math.PI) / 180 })}>
          <RotateCw className="size-3.5" aria-hidden />
        </Button>
        <select
          className="h-5 rounded border bg-background px-0.5 text-[10px]"
          value={rotStep}
          onChange={(e) => setRotStep(Number(e.target.value))}
          aria-label="Rotate step"
        >
          <option value={0.05}>0.05°</option>
          <option value={0.1}>0.1°</option>
          <option value={0.5}>0.5°</option>
          <option value={5}>5°</option>
          <option value={90}>90°</option>
        </select>
        <input
          type="number"
          step={0.01}
          value={rotInput}
          onChange={(e) => setRotInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setRotationTo(rotInput)}
          className="h-5 w-14 rounded border bg-background px-1 text-[10px]"
          aria-label="Rotation in degrees (absolute)"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-5 px-1.5 text-[10px]"
          onClick={() => setRotationTo(rotInput)}
        >
          Set
        </Button>
        <span className="flex-1 text-right text-[10px] text-muted-foreground">
          now {currentRotDeg.toFixed(2)}°
        </span>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-10 text-[10px] text-muted-foreground">Scale</span>
        <span className="text-[10px] text-muted-foreground">1:</span>
        <input
          type="number"
          min={1}
          step={1}
          value={scaleInput}
          onChange={(e) => setScaleInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setScaleTo(scaleInput)}
          className="h-5 w-16 rounded border bg-background px-1 text-[10px]"
          aria-label="Drawing scale denominator"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-5 px-1.5 text-[10px]"
          onClick={() => setScaleTo(scaleInput)}
        >
          Set
        </Button>
        <span className="flex-1 text-right text-[10px] text-muted-foreground">
          now ≈ 1:{Math.round(currentDen * 10) / 10}
        </span>
      </div>
    </div>
  );
}
