/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createDocumentsSlice, type DocumentsSlice, type ViewerDocument } from './documentsSlice.js';

function doc(id: string, kind: ViewerDocument['kind'] = 'document'): ViewerDocument {
  return { id, name: `${id}.pdf`, kind, url: `https://example.test/${id}.pdf` };
}

describe('DocumentsSlice — tabs and host re-send contract', () => {
  let state: DocumentsSlice;
  let setState: (
    partial: Partial<DocumentsSlice> | ((state: DocumentsSlice) => Partial<DocumentsSlice>),
  ) => void;

  beforeEach(() => {
    setState = (partial) => {
      const update = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...update };
    };
    state = createDocumentsSlice(setState as never, () => state, {} as never);
  });

  it('openDocument dedupes by id and focuses the existing tab', () => {
    state.setViewerDocuments([doc('a'), doc('b')]);
    state.openDocument('a');
    state.openDocument('b');
    state.openDocument('a', { page: 7 });

    assert.strictEqual(state.docTabs.length, 2);
    assert.strictEqual(state.activeDocTabId, 'a');
    assert.strictEqual(state.docTabs.find((t) => t.docId === 'a')?.view.page, 7);
  });

  it('openDocument ignores unknown ids', () => {
    state.openDocument('ghost');
    assert.deepStrictEqual(state.docTabs, []);
    assert.strictEqual(state.activeDocTabId, null);
  });

  it('closeDocTab activates the neighbour and clears when the last tab goes', () => {
    state.setViewerDocuments([doc('a'), doc('b'), doc('c')]);
    state.openDocument('a');
    state.openDocument('b');
    state.openDocument('c');
    state.setActiveDocTab('b');

    state.closeDocTab('b');
    assert.strictEqual(state.activeDocTabId, 'c');

    state.closeDocTab('c');
    assert.strictEqual(state.activeDocTabId, 'a');
    state.closeDocTab('a');
    assert.strictEqual(state.activeDocTabId, null);
    assert.deepStrictEqual(state.docTabs, []);
  });

  it('a host re-send keeps local documents and closes orphaned tabs', () => {
    state.setViewerDocuments([doc('host1'), doc('host2')]);
    state.upsertViewerDocument({ ...doc('local:x.pdf:123'), name: 'x.pdf' });
    state.openDocument('host2');
    state.openDocument('local:x.pdf:123');

    // Host re-sends without host2 — its tab must close, the local doc stays.
    state.setViewerDocuments([doc('host1')]);

    assert.ok(state.viewerDocuments.has('local:x.pdf:123'));
    assert.ok(!state.viewerDocuments.has('host2'));
    assert.deepStrictEqual(
      state.docTabs.map((t) => t.docId),
      ['local:x.pdf:123'],
    );
    assert.strictEqual(state.activeDocTabId, 'local:x.pdf:123');
  });

  it('removeViewerDocument closes its tab and notifies the host once per event', () => {
    const events: Array<{ docId: string; event: string }> = [];
    state.setDocumentEventHandler((e) => events.push({ docId: e.docId, event: e.event }));
    state.setViewerDocuments([doc('a')]);
    state.openDocument('a');
    state.removeViewerDocument('a');

    assert.ok(!state.viewerDocuments.has('a'));
    assert.deepStrictEqual(state.docTabs, []);
    assert.deepStrictEqual(events, [
      { docId: 'a', event: 'opened' },
      { docId: 'a', event: 'closed' },
    ]);
  });

  it('setDocTabView merges partial view state', () => {
    state.setViewerDocuments([doc('a')]);
    state.openDocument('a');
    state.setDocTabView('a', { zoom: 2 });
    state.setDocTabView('a', { page: 3 });

    assert.deepStrictEqual(state.docTabs[0]?.view, { page: 3, zoom: 2 });
  });
});
