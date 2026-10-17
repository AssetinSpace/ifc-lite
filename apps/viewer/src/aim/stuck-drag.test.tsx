/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM fork: in the AIM host the viewer runs in an iframe, so a mouseup
 * released over the host page never reaches the viewer and a header drag
 * would chase the cursor forever. A buttonless move after a pressed
 * mousedown ends the drag; a mousedown that reports no button (synthetic
 * events, as in upstream's #5957 clamp test) keeps the plain mouseup path.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, mouseDown } from '@/test/render.js';
import type { FloatingPanelState } from '@/store';
import { FloatingPanel } from '@/components/viewer/dock/FloatingPanel';

afterEach(cleanup);

const PANEL: FloatingPanelState = { id: 'properties', snap: 'free', x: 100, y: 200, w: 360, h: 300 };

function mount(onRect: (r: Partial<FloatingPanelState>) => void): HTMLElement {
  const root = render(
    <FloatingPanel
      panel={PANEL}
      title="Properties"
      zIndex={30}
      bounds={null}
      area={{ width: 1280, height: 800, top: 48 }}
      onRect={onRect}
      onSnap={() => {}}
      onFocus={() => {}}
      onDock={() => {}}
      onClose={() => {}}
    >
      <div />
    </FloatingPanel>,
  );
  const header = root.querySelector('.cursor-move');
  assert.ok(header, 'title bar (drag handle) rendered');
  return header as HTMLElement;
}

function moveTo(clientY: number, buttons: number): void {
  act(() => {
    window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 300, clientY, buttons }));
  });
}

describe('FloatingPanel drag released outside the iframe (AIM fork)', () => {
  it('ends the drag on the first buttonless move after a pressed mousedown', () => {
    const rects: Array<Partial<FloatingPanelState>> = [];
    const header = mount((r) => rects.push(r));
    mouseDown(header, { clientX: 300, clientY: 300, buttons: 1 });
    moveTo(400, 1);
    assert.equal(rects[rects.length - 1].y, 100, 'a held drag follows the pointer');
    const held = rects.length;
    moveTo(500, 0); // the button came up over the host page
    moveTo(600, 0);
    assert.equal(rects.length, held, 'no move after the missed mouseup reaches the panel');
  });
});
