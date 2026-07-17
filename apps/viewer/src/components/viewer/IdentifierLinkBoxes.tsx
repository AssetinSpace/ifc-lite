/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared identifier-link box rendering (D-076 in the AIM repo) — used by both
 * the 2D plan pane overlay (`IdentifierLinkLayer`) and the PDF document
 * reader (`PageIdentifierLinks`), so the visual language and the click
 * behaviour stay identical everywhere a drawing is shown.
 *
 * Matched codes get a subtle pale-green highlight with an underline (a quiet
 * "this is a hyperlink" cue that doesn't fight the drawing linework); debug
 * mode outlines recognized-but-unmatched codes with a dashed amber border.
 */

import { useState } from 'react';
import { useViewerStore, toGlobalIdFromModels } from '@/store';
import type { ResolvedPageLink } from '@/lib/identifier-links/page-links';
import type { IdentifierTarget } from '@/lib/identifier-links/identifier-index';

/**
 * Select the element behind an identifier link — the single source of truth
 * for "open the element preview", shared with direct scene picks: the same
 * selection actions the Viewport pick handler calls, plus revealing the
 * Information (properties) panel that renders the preview.
 */
export function selectIdentifierTarget(target: IdentifierTarget): void {
  const store = useViewerStore.getState();
  const globalId = toGlobalIdFromModels(store.models, target.modelId, target.expressId);
  store.setSelectedEntityId(globalId);
  store.setSelectedEntity({ modelId: target.modelId, expressId: target.expressId });
  store.showWorkspacePanel('properties');
}

interface IdentifierLinkBoxesProps {
  links: ResolvedPageLink[];
  /** Page size in PDF points — the frame the link boxes are expressed in. */
  pageW: number;
  pageH: number;
  /** Show dashed outlines for codes not found in the model. */
  debug: boolean;
  /** Inverse-scale for the candidate picker (plan pane zoom); default 1. */
  pickerScale?: number;
}

export function IdentifierLinkBoxes({
  links,
  pageW,
  pageH,
  debug,
  pickerScale = 1,
}: IdentifierLinkBoxesProps) {
  const [picker, setPicker] = useState<ResolvedPageLink | null>(null);

  if (!(pageW > 0) || !(pageH > 0) || links.length === 0) return null;

  /** PDF points (bottom-left, y-up) → percent CSS box (top-left origin). */
  const toCss = (box: ResolvedPageLink): React.CSSProperties => ({
    left: `${(box.x / pageW) * 100}%`,
    // box.y is the text baseline; the box extends up by box.h.
    top: `${((pageH - box.y - box.h) / pageH) * 100}%`,
    width: `${(box.w / pageW) * 100}%`,
    height: `${((box.h * 1.25) / pageH) * 100}%`,
  });

  const activate = (link: ResolvedPageLink) => {
    if (link.targets.length === 0) return;
    if (link.targets.length === 1) {
      setPicker(null);
      selectIdentifierTarget(link.targets[0]);
    } else {
      setPicker((prev) => (prev === link ? null : link));
    }
  };

  return (
    <div className="pointer-events-none absolute inset-0" data-testid="identifier-link-layer">
      {links.map((link, i) => {
        const matched = link.targets.length > 0;
        if (!matched && !debug) return null;
        return (
          <div
            key={`${link.code}:${i}`}
            role={matched ? 'button' : undefined}
            tabIndex={matched ? 0 : undefined}
            title={
              matched
                ? link.targets.length === 1
                  ? `${link.code} → ${link.targets[0].name || link.targets[0].typeName}`
                  : `${link.code} — ${link.targets.length} elements`
                : `${link.code} — not found in model`
            }
            className={
              matched
                ? 'pointer-events-auto absolute cursor-pointer rounded-[2px] bg-emerald-300/20 shadow-[inset_0_-2px_0_0_rgb(16_185_129/0.55)] hover:bg-emerald-300/40'
                : 'absolute rounded-[1px] border border-dashed border-amber-500/70'
            }
            style={toCss(link)}
            onPointerDown={matched ? (e) => e.stopPropagation() : undefined}
            onPointerUp={matched ? (e) => e.stopPropagation() : undefined}
            onClick={matched ? () => activate(link) : undefined}
            onKeyDown={
              matched
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      activate(link);
                    }
                  }
                : undefined
            }
          />
        );
      })}
      {picker && (
        <div
          className="pointer-events-auto absolute z-20"
          style={{
            left: `${(picker.x / pageW) * 100}%`,
            top: `${((pageH - picker.y) / pageH) * 100}%`,
            transform: `scale(${pickerScale})`,
            transformOrigin: '0 0',
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          <div className="min-w-44 max-w-64 rounded border bg-background p-1 text-[11px] shadow-md">
            <div className="px-1.5 py-0.5 font-medium text-muted-foreground">
              {picker.code} — {picker.targets.length} elements
            </div>
            {picker.targets.slice(0, 8).map((t) => (
              <button
                key={`${t.modelId}:${t.expressId}`}
                type="button"
                className="block w-full truncate rounded px-1.5 py-0.5 text-left hover:bg-accent"
                onClick={() => {
                  setPicker(null);
                  selectIdentifierTarget(t);
                }}
              >
                {t.name || t.typeName || t.guid}
                <span className="ml-1 text-muted-foreground">{t.typeName}</span>
              </button>
            ))}
            {picker.targets.length > 8 && (
              <div className="px-1.5 py-0.5 text-muted-foreground">
                +{picker.targets.length - 8} more…
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
