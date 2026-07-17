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

interface Transform {
  zoom: number;
  pan: { x: number; y: number };
}

const IDENTITY: Transform = { zoom: 1, pan: { x: 0, y: 0 } };

export function ImageDocumentView({ url, name }: ImageDocumentViewProps) {
  const clipRef = useRef<HTMLDivElement>(null);
  // One atomic transform: the pan is a projection of the zoom anchor, so a
  // wheel tick must update both in a single (pure) state transition.
  const [{ zoom, pan }, setTransform] = useState<Transform>(IDENTITY);
  useEffect(() => setTransform(IDENTITY), [url]);

  useEffect(() => {
    const clip = clipRef.current;
    if (!clip) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = clip.getBoundingClientRect();
      setTransform((prev) => {
        const next = Math.min(
          ZOOM_MAX,
          Math.max(ZOOM_MIN, prev.zoom * Math.exp(-e.deltaY * 0.0018)),
        );
        if (next === prev.zoom) return prev;
        if (next === 1) return IDENTITY;
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        return {
          zoom: next,
          pan: {
            x: cx - ((cx - prev.pan.x) * next) / prev.zoom,
            y: cy - ((cy - prev.pan.y) * next) / prev.zoom,
          },
        };
      });
    };
    clip.addEventListener('wheel', onWheel, { passive: false });
    return () => clip.removeEventListener('wheel', onWheel);
  }, []);

  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  // Touch pinch: two fingers scale the transform around their midpoint —
  // without this, a mobile pinch falls through to the browser's page zoom.
  const touchesRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; start: Transform; mid: { x: number; y: number } } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'touch') {
        touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touchesRef.current.size === 2) {
          const [a, b] = [...touchesRef.current.values()];
          const rect = e.currentTarget.getBoundingClientRect();
          pinchRef.current = {
            dist: Math.hypot(a.x - b.x, a.y - b.y),
            start: { zoom, pan },
            mid: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
          };
          dragRef.current = null; // a pinch is not a pan
        }
      }
      if (!pinchRef.current) {
        dragRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          panX: pan.x,
          panY: pan.y,
        };
      }
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [zoom, pan],
  );
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' && touchesRef.current.has(e.pointerId)) {
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pinch = pinchRef.current;
      if (pinch && touchesRef.current.size >= 2) {
        const [a, b] = [...touchesRef.current.values()];
        const rect = e.currentTarget.getBoundingClientRect();
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist <= 0 || pinch.dist <= 0) return;
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinch.start.zoom * (dist / pinch.dist)));
        if (next === 1) {
          setTransform(IDENTITY);
          return;
        }
        // Keep the content point under the (moving) midpoint anchored.
        const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
        const r = next / pinch.start.zoom;
        setTransform({
          zoom: next,
          pan: {
            x: mid.x - (pinch.mid.x - pinch.start.pan.x) * r,
            y: mid.y - (pinch.mid.y - pinch.start.pan.y) * r,
          },
        });
        return;
      }
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setTransform((prev) => ({
      zoom: prev.zoom,
      pan: { x: drag.panX + (e.clientX - drag.startX), y: drag.panY + (e.clientY - drag.startY) },
    }));
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') {
      touchesRef.current.delete(e.pointerId);
      if (touchesRef.current.size < 2) pinchRef.current = null;
    }
    dragRef.current = null;
  }, []);

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
