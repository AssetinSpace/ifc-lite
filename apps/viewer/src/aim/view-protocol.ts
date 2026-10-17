/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge správy pohľadu (AIM D-083 fáza 1): rez, kamera, režim 3D|2D|Split.
 * Host nepozná súradnice scény, preto správy nesú len podlažie (IFC GlobalId),
 * výšku nad jeho úrovňou, preset kamery a GUIDy cieľa - prepočet na rovinu a
 * kameru robí viewer (`viewCommands.ts`). Vlastný súbor, lebo
 * `bridge-protocol.ts` je na rozpočte veľkosti modulu.
 */

import { SOURCE } from './bridge-protocol.js';

export const CAMERA_PRESETS = ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso', 'fit_all'] as const;
export type CameraPreset = (typeof CAMERA_PRESETS)[number];
export const VIEW_MODES = ['3d', '2d', 'split'] as const;
export type BridgeViewMode = (typeof VIEW_MODES)[number];
export type SectionAxis = 'x' | 'y' | 'z';

/** Výška rezu nad úrovňou podlažia v metroch - rovnaký rozsah ako host. */
export const SECTION_OFFSET_RANGE = { min: -5, max: 20 } as const;
const MAX_GUIDS = 600;

export type ViewInboundMessage =
  | {
      source: typeof SOURCE;
      type: 'SET_SECTION';
      action: 'set' | 'clear';
      axis?: SectionAxis;
      storeyGuid?: string;
      offsetM?: number;
      position?: number;
      flipped?: boolean;
    }
  | { source: typeof SOURCE; type: 'SET_CAMERA'; preset: CameraPreset; projection?: 'perspective' | 'orthographic'; guids?: string[] }
  | { source: typeof SOURCE; type: 'SET_VIEW_MODE'; mode: BridgeViewMode; storeyGuid?: string };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const inRange = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const optional = <T>(v: T | undefined, ok: (x: T) => boolean) => v === undefined || ok(v);

function isGuidList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= MAX_GUIDS && v.every(isStr);
}

export function isViewMessage(data: unknown): data is ViewInboundMessage {
  if (!data || typeof data !== 'object') return false;
  const m = data as Record<string, unknown>;
  if (m.source !== SOURCE) return false;
  switch (m.type) {
    case 'SET_SECTION': {
      if (m.action === 'clear') return true;
      if (m.action !== 'set') return false;
      if (!optional(m.flipped, (f) => typeof f === 'boolean')) return false;
      if (isStr(m.storeyGuid)) {
        // Rez nad podlažím je vždy vodorovný.
        return (m.axis === undefined || m.axis === 'y')
          && optional(m.offsetM, (o) => inRange(o, SECTION_OFFSET_RANGE.min, SECTION_OFFSET_RANGE.max));
      }
      return (m.axis === 'x' || m.axis === 'y' || m.axis === 'z') && inRange(m.position, 0, 100);
    }
    case 'SET_CAMERA':
      return (CAMERA_PRESETS as readonly unknown[]).includes(m.preset)
        && optional(m.projection, (p) => p === 'perspective' || p === 'orthographic')
        && optional(m.guids, isGuidList);
    case 'SET_VIEW_MODE':
      return (VIEW_MODES as readonly unknown[]).includes(m.mode) && optional(m.storeyGuid, isStr);
    default:
      return false;
  }
}
