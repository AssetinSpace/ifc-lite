/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * View-mode switcher (D-075): segmented 3D | 2D | Split control with a storey
 * picker, Dalux-style. Self-contained — MainToolbar mounts it with a single
 * line so the (upstream-churny) toolbar diff stays minimal.
 *
 * 2D opens the storey's calibrated drawing full-width (plan pane); without a
 * calibrated drawing it falls back to the locked ortho top-down model view.
 * Split shows the resizable 2D plan | free 3D pair. The control is disabled
 * while a calibration is in flight — the flow owns the view then.
 */

import { useMemo } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useViewerStore } from '@/store';
import { useViewMode, type ViewMode } from '@/hooks/useViewMode';

const MODES: ReadonlyArray<{ id: ViewMode; label: string; title: string }> = [
  { id: '3d', label: '3D', title: 'Free 3D workspace' },
  { id: '2d', label: '2D', title: 'Storey plan (calibrated drawing, or top-down model)' },
  { id: 'split', label: 'Split', title: '2D plan beside a free 3D view' },
];

export function ViewModeSwitcher() {
  const { mode, setMode, setStorey, storeys, activeStorey } = useViewMode();
  const calibrating = useViewerStore((s) => s.underlayCalibration !== null);
  const disabled = storeys.length === 0 || calibrating;

  const disabledReason = useMemo(() => {
    if (calibrating) return 'Finish or cancel the calibration first';
    if (storeys.length === 0) return 'Load a model with storeys first';
    return null;
  }, [calibrating, storeys.length]);

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="radiogroup"
            aria-label="View mode"
            className={cn(
              'flex items-center rounded-md border bg-background p-0.5',
              disabled && 'opacity-50',
            )}
          >
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                title={m.title}
                disabled={disabled}
                onClick={() => setMode(m.id)}
                className={cn(
                  'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                  mode === m.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  disabled && 'cursor-not-allowed',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </TooltipTrigger>
        <TooltipContent>{disabledReason ?? 'View mode (3D / 2D / Split)'}</TooltipContent>
      </Tooltip>
      {mode !== '3d' && (
        <select
          aria-label="Storey"
          className="h-6 max-w-36 rounded border bg-background px-1 text-[11px]"
          value={activeStorey?.key ?? ''}
          onChange={(e) => {
            const storey = storeys.find((s) => s.key === e.target.value);
            if (storey) setStorey(storey);
          }}
        >
          {!activeStorey && <option value="" />}
          {storeys.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
