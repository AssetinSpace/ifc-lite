/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Čisté výpočty pre bridge správy pohľadu (AIM D-083) - bez Reactu a store,
 * aby sa dali testovať. Vykonanie je v `useAimViewCommands.ts`.
 */

import type { SectionPlaneAxis } from '@/store/types';
import { worldToPercent, type AxisRange } from '@/lib/section/section-distance';
import type { CameraPreset, SectionAxis } from './view-protocol.js';

/** SDK / host os -> os rezu viewera (Y hore): x = side, y = down, z = front. */
export const VIEWER_AXIS: Record<SectionAxis, SectionPlaneAxis> = { x: 'side', y: 'down', z: 'front' };

/**
 * Poloha vodorovného rezu (0..100 % rozsahu osi `down`) pre rez `offsetM`
 * metrov nad úrovňou podlažia. Elevácia podlažia je v metroch v rámci IFC
 * (Z hore), rez pracuje v posunutom rámci renderera - preto `- offsetY`,
 * presne ako `worldCutY` v `useFloorplanView`. Bez rozsahu (nič nenačítané) null.
 */
export function storeyCutPercent(
  elevation: number,
  offsetM: number,
  offsetY: number,
  range: AxisRange | null,
): number | null {
  if (!range) return null;
  return worldToPercent(elevation + offsetM - offsetY, range);
}

export type CameraStep =
  | { kind: 'preset'; view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' }
  | { kind: 'home' }
  | { kind: 'fit' };

/** Preset hosta -> volanie `cameraCallbacks` (iso = home, adaptívna JV izometria). */
export function cameraStep(preset: CameraPreset): CameraStep {
  if (preset === 'iso') return { kind: 'home' };
  if (preset === 'fit_all') return { kind: 'fit' };
  return { kind: 'preset', view: preset };
}

/**
 * Podlažie z bridge správy: bez GUID = `undefined` (useViewMode si vyberie
 * aktívne/posledné), známy GUID = podlažie, neznámy GUID = `null` - správa sa
 * nevykoná, aby viewer potichu neprepol na iné podlažie, než host žiadal.
 */
export function pickStorey<T extends { guid: string }>(storeys: readonly T[], guid?: string): T | undefined | null {
  if (!guid) return undefined;
  return storeys.find((s) => s.guid === guid) ?? null;
}
