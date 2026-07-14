/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Large calibration PDF surface (D-072) — an over-the-viewport overlay so the
 * drawing can be worked on a big screen while picking reference points.
 * Shown when the user expands the calibration surface AND it is the
 * drawing-pick turn; when it's the model-pick turn it shrinks to a small
 * banner so the 3D viewport underneath is fully clickable.
 */

import { Minimize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { CalibrationPdfSurface } from './CalibrationPdfSurface';

export function CalibrationPdfOverlay() {
  const calibration = useViewerStore((s) => s.underlayCalibration);
  const expanded = useViewerStore((s) => s.underlayCalibrationExpanded);
  const setExpanded = useViewerStore((s) => s.setUnderlayCalibrationExpanded);
  const drawings = useViewerStore((s) => s.underlayDrawings);

  if (!calibration || !expanded) return null;
  const drawing = drawings.get(calibration.drawingId);
  const awaiting =
    calibration.pagePoints.length > calibration.modelPoints.length
      ? 'model'
      : calibration.pagePoints.length < 2
        ? 'page'
        : 'done';

  // Model-pick turn: get out of the way so the 3D viewport is clickable.
  if (awaiting === 'model') {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 text-[11px] shadow-lg backdrop-blur">
          <span className="font-medium">
            Click matching point {calibration.modelPoints.length + 1} in the 3D model
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-4 z-40 flex flex-col overflow-hidden rounded-lg border bg-background/95 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={drawing?.name}>
          Calibrate: {drawing?.name ?? ''}
        </span>
        <span className="text-[11px] text-muted-foreground">
          Click point {calibration.pagePoints.length + 1} of 2 on the drawing
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => setExpanded(false)}
          aria-label="Shrink calibration drawing"
          title="Back to panel"
        >
          <Minimize2 className="size-3.5" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => setExpanded(false)}
          aria-label="Close"
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      <CalibrationPdfSurface className="flex-1 p-3" />
    </div>
  );
}
