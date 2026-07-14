/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DrawingPlacement — the persistable record of one georeferenced drawing
 * underlay: which drawing page, which storey, and the affine that places it.
 *
 * Serialized as the versioned, snake_case `_georef` JSON (v1) so hosts can
 * store it in a plain JSON column/property (e.g. `documents.properties._georef`
 * in the AIM platform) without a schema migration. Parsing is validating and
 * returns `null` for anything malformed — persisted JSON is untrusted input.
 */

import type { Affine2x3, CalibrationPair } from './similarity.js';

/** One calibration correspondence in placement form (tuples, JSON-friendly). */
export interface PlacementCalibrationPair {
  /** Picked drawing point, PDF page points (bottom-left origin, y up). */
  pdfPt: [number, number];
  /** Matching model coordinate, IFC model metres (plan XY, y up). */
  ifcM: [number, number];
}

/** A georeferenced drawing placement (in-memory, camelCase form). */
export interface DrawingPlacement {
  version: 1;
  /** GlobalId of the IfcBuildingStorey the drawing belongs to. */
  storeyGuid: string;
  /**
   * Storey elevation in metres (IFC Z). Cached at calibration time so the
   * placement stays usable when a host loads the model through a path that
   * cannot recover elevations (e.g. cache-only parses).
   */
  storeyZ: number;
  /** 1-based page number within the source document. */
  page: number;
  /** Page size `[width, height]` in PDF points — the frame the affine maps from. */
  pageSize: [number, number];
  /**
   * 2×3 affine mapping PDF page points (y up) → IFC model metres (y up).
   * See similarity.ts for the layout.
   */
  affine: Affine2x3;
  /** The point pairs that produced `affine` — kept so calibration is re-editable. */
  calibration: PlacementCalibrationPair[];
  /** Underlay opacity, 0..1. */
  opacity: number;
  /** Whether the underlay is currently shown. */
  visible: boolean;
  /** Free discipline tag (e.g. "ARCH", "HVAC"); drives grouping in hosts. */
  discipline: string | null;
  /** ISO timestamp of the last (re)calibration. */
  calibratedAt: string | null;
}

/** Inputs for creating a fresh placement; presentation fields get defaults. */
export interface CreateDrawingPlacementInput {
  storeyGuid: string;
  storeyZ: number;
  page: number;
  pageSize: [number, number];
  affine: Affine2x3;
  calibration: readonly CalibrationPair[];
  opacity?: number;
  visible?: boolean;
  discipline?: string | null;
  /** Injected timestamp (hosts pass `new Date().toISOString()`); kept explicit for testability. */
  calibratedAt?: string | null;
}

export const DEFAULT_UNDERLAY_OPACITY = 0.6;

/** Build a v1 placement from calibration output, applying presentation defaults. */
export function createDrawingPlacement(input: CreateDrawingPlacementInput): DrawingPlacement {
  return {
    version: 1,
    storeyGuid: input.storeyGuid,
    storeyZ: input.storeyZ,
    page: input.page,
    pageSize: [input.pageSize[0], input.pageSize[1]],
    affine: [
      input.affine[0], input.affine[1], input.affine[2],
      input.affine[3], input.affine[4], input.affine[5],
    ],
    calibration: input.calibration.map((c) => ({
      pdfPt: [c.page.x, c.page.y],
      ifcM: [c.model.x, c.model.y],
    })),
    opacity: clamp01(input.opacity ?? DEFAULT_UNDERLAY_OPACITY),
    visible: input.visible ?? true,
    discipline: input.discipline ?? null,
    calibratedAt: input.calibratedAt ?? null,
  };
}

/** Serialized (snake_case) v1 `_georef` shape. */
export interface GeorefJsonV1 {
  version: 1;
  storey_guid: string;
  storey_z: number;
  page: number;
  page_size: [number, number];
  affine: [number, number, number, number, number, number];
  calibration: { pdf_pt: [number, number]; ifc_m: [number, number] }[];
  opacity: number;
  visible: boolean;
  discipline: string | null;
  calibrated_at: string | null;
}

/** DrawingPlacement → snake_case `_georef` JSON (v1). */
export function serializePlacement(p: DrawingPlacement): GeorefJsonV1 {
  return {
    version: 1,
    storey_guid: p.storeyGuid,
    storey_z: p.storeyZ,
    page: p.page,
    page_size: [p.pageSize[0], p.pageSize[1]],
    affine: [...p.affine] as GeorefJsonV1['affine'],
    calibration: p.calibration.map((c) => ({
      pdf_pt: [c.pdfPt[0], c.pdfPt[1]],
      ifc_m: [c.ifcM[0], c.ifcM[1]],
    })),
    opacity: p.opacity,
    visible: p.visible,
    discipline: p.discipline,
    calibrated_at: p.calibratedAt,
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNumberTuple(v: unknown, length: number): v is number[] {
  return Array.isArray(v) && v.length === length && v.every(isFiniteNumber);
}

/**
 * Validate untrusted `_georef` JSON into a DrawingPlacement. Returns `null`
 * for anything that is not a well-formed v1 record (missing fields, wrong
 * types, non-finite numbers, unknown version) — callers treat that as "no
 * placement" rather than throwing on hostile or stale persisted data.
 */
export function parsePlacement(raw: unknown): DrawingPlacement | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;

  if (g.version !== 1) return null;
  if (typeof g.storey_guid !== 'string' || g.storey_guid.length === 0) return null;
  if (!isFiniteNumber(g.storey_z)) return null;
  if (!isFiniteNumber(g.page) || !Number.isInteger(g.page) || g.page < 1) return null;
  if (!isNumberTuple(g.page_size, 2) || g.page_size[0] <= 0 || g.page_size[1] <= 0) return null;
  if (!isNumberTuple(g.affine, 6)) return null;
  if (!Array.isArray(g.calibration)) return null;

  const calibration: PlacementCalibrationPair[] = [];
  for (const entry of g.calibration) {
    const c = entry as { pdf_pt?: unknown; ifc_m?: unknown };
    if (!isNumberTuple(c.pdf_pt, 2) || !isNumberTuple(c.ifc_m, 2)) return null;
    calibration.push({
      pdfPt: [c.pdf_pt[0], c.pdf_pt[1]],
      ifcM: [c.ifc_m[0], c.ifc_m[1]],
    });
  }

  return {
    version: 1,
    storeyGuid: g.storey_guid,
    storeyZ: g.storey_z,
    page: g.page,
    pageSize: [g.page_size[0], g.page_size[1]],
    affine: [
      g.affine[0], g.affine[1], g.affine[2],
      g.affine[3], g.affine[4], g.affine[5],
    ],
    calibration,
    opacity: isFiniteNumber(g.opacity) ? clamp01(g.opacity) : DEFAULT_UNDERLAY_OPACITY,
    visible: typeof g.visible === 'boolean' ? g.visible : true,
    discipline: typeof g.discipline === 'string' ? g.discipline : null,
    calibratedAt: typeof g.calibrated_at === 'string' ? g.calibrated_at : null,
  };
}
