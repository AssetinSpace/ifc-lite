/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reality Capture pin billboard (D-073) — DOM markers over the WebGPU canvas,
 * re-projected each frame via the camera callbacks. Same mechanism as
 * AnnotationLayer, but AIM-owned (lives under src/aim, D-071) and driven by the
 * standalone capturePinsStore (pins pushed by the host over CAPTURES_LOAD).
 *
 * A click bounces CAPTURE_PIN_CLICK back to the host (via the store's emitter),
 * which opens the capture's gallery / 360° panorama — the 3D→2D→space direction
 * of the bidirectional link. The layer is pointer-events:none; each pin opts in.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Camera, Orbit } from 'lucide-react';

import { useViewerStore } from '../store/index.js';
import { useCapturePinsStore } from './capturePinsStore.js';

interface ProjectedPin {
  id: string;
  kind: 'photo' | 'pano360';
  name?: string;
  thumbUrl?: string;
  screen: { x: number; y: number } | null;
}

export function CapturePinLayer() {
  const pins = useCapturePinsStore((s) => s.pins);
  const selectedId = useCapturePinsStore((s) => s.selectedId);
  const clickPin = useCapturePinsStore((s) => s.clickPin);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);

  const containerRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<{ width: number; height: number } | null>(null);

  // Mirror the canvas geometry so the overlay sits exactly on top (same
  // ResizeObserver + late-mount MutationObserver dance as AnnotationLayer).
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const parent = container.parentElement;
    if (!parent) return;

    let observer: ResizeObserver | null = null;
    const measure = (canvas: HTMLCanvasElement) => {
      const rect = canvas.getBoundingClientRect();
      setBounds({ width: rect.width, height: rect.height });
    };
    const bind = (canvas: HTMLCanvasElement) => {
      measure(canvas);
      observer = new ResizeObserver(() => measure(canvas));
      observer.observe(canvas);
    };

    const initial = parent.querySelector('canvas') as HTMLCanvasElement | null;
    if (initial) {
      bind(initial);
      return () => observer?.disconnect();
    }
    const mutation = new MutationObserver(() => {
      const canvas = parent.querySelector('canvas') as HTMLCanvasElement | null;
      if (canvas) {
        bind(canvas);
        mutation.disconnect();
      }
    });
    mutation.observe(parent, { childList: true, subtree: true });
    return () => {
      mutation.disconnect();
      observer?.disconnect();
    };
  }, []);

  // Per-frame projection tick (world → screen). Idle-cheap: skips setState when
  // nothing moved. Reads the latest pins via the store getState so the loop need
  // not restart on every pins change.
  const [projected, setProjected] = useState<ProjectedPin[]>([]);
  useEffect(() => {
    const project = cameraCallbacks.projectToScreen;
    if (!project) {
      setProjected([]);
      return;
    }
    let raf: number | null = null;
    let lastSerialized = '';
    const tick = () => {
      const current = useCapturePinsStore.getState().pins;
      const next: ProjectedPin[] = current.map((p) => ({
        id: p.id,
        kind: p.kind,
        name: p.name,
        thumbUrl: p.thumbUrl,
        screen: project(p.world),
      }));
      const serialized = next
        .map((p) => `${p.id}:${p.screen?.x ?? 'x'}:${p.screen?.y ?? 'y'}`)
        .join(',');
      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        setProjected(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
    // Restart the loop when the camera projector changes or pins length changes
    // (new/removed pins need an immediate re-projection).
  }, [cameraCallbacks, pins.length]);

  if (!bounds) {
    return <div ref={containerRef} className="absolute inset-0 pointer-events-none" />;
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none overflow-hidden"
      aria-label="Reality capture pins"
    >
      {projected.map((pin) => {
        if (!pin.screen) return null;
        const isSelected = selectedId === pin.id;
        const Icon = pin.kind === 'pano360' ? Orbit : Camera;
        return (
          <div
            key={pin.id}
            data-capture-pin-id={pin.id}
            className="absolute pointer-events-auto"
            style={{ left: pin.screen.x, top: pin.screen.y, transform: 'translate(-50%, -100%)' }}
          >
            <button
              type="button"
              title={pin.name ?? (pin.kind === 'pano360' ? '360° panoráma' : 'Fotka')}
              onClick={() => clickPin(pin.id)}
              className={`flex size-7 items-center justify-center rounded-full border-2 border-white text-white shadow-md transition-transform hover:scale-110 ${
                isSelected ? 'bg-orange-500 ring-2 ring-orange-300' : 'bg-sky-500'
              }`}
            >
              {pin.thumbUrl ? (
                <img src={pin.thumbUrl} alt="" className="size-full rounded-full object-cover" />
              ) : (
                <Icon className="size-3.5" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
