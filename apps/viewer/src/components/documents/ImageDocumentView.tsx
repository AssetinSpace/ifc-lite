/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Image document view (D-075) — the tab body for `kind: 'image'` (photos,
 * scans). Plain <img> with wheel-to-cursor zoom and drag pan, the gesture
 * vocabulary of DrawingPlanPane. No offscreen raster copies — the browser's
 * own image cache is the only memory this view holds.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const ZOOM_MIN = 1;
const ZOOM_MAX = 16;

interface ImageDocumentViewProps {
  url: string;
  name: string;
}

export function ImageDocumentView({ url, name }: ImageDocumentViewProps) {
  const clipRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [url]);

  useEffect(() => {
    const clip = clipRef.current;
    if (!clip) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = clip.getBoundingClientRect();
      setZoom((prev) => {
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * Math.exp(-e.deltaY * 0.0018)));
        if (next === prev) return prev;
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        if (next === 1) {
          setPan({ x: 0, y: 0 });
          return 1;
        }
        setPan((p) => ({
          x: cx - ((cx - p.x) * next) / prev,
          y: cy - ((cy - p.y) * next) / prev,
        }));
        return next;
      });
    };
    clip.addEventListener('wheel', onWheel, { passive: false });
    return () => clip.removeEventListener('wheel', onWheel);
  }, []);

  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        panX: pan.x,
        panY: pan.y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [pan],
  );
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setPan({ x: drag.panX + (e.clientX - drag.startX), y: drag.panY + (e.clientY - drag.startY) });
  }, []);
  const onPointerUp = useCallback(() => (dragRef.current = null), []);

  return (
    <div
      ref={clipRef}
      className="h-full w-full overflow-hidden bg-muted/30"
      style={{ touchAction: 'none', cursor: zoom > 1 ? 'grab' : 'default' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="flex h-full w-full items-center justify-center p-3"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
      >
        <img
          src={url}
          alt={name}
          draggable={false}
          className="max-h-full max-w-full object-contain select-none"
        />
      </div>
    </div>
  );
}
