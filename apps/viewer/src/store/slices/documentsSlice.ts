/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Project documents state (D-075 in the AIM repo) — the generic document
 * library (PDF drawings, PDF text documents, images) browsable inside the
 * viewer, plus the tabs open in the center document pane.
 *
 * The slice is host-agnostic, mirroring drawingUnderlaySlice: an embedding
 * host pushes its document list (the AIM bridge), or files arrive locally via
 * drag & drop / file picker with `local:` ids. Only tab METADATA lives here —
 * per-tab rasters/canvases are owned by the viewer components and dropped
 * when a tab deactivates (iframe memory is the #1 design constraint).
 */

import type { StateCreator } from 'zustand';

export type ViewerDocumentKind = 'drawing' | 'document' | 'image';

/** One document known to the viewer (host-pushed or session-local). */
export interface ViewerDocument {
  /** Stable id — the host's document id, or `local:<name>:<size>`. */
  id: string;
  name: string;
  /**
   * `drawing` = calibratable floor plan (cross-links to the 2D/Split view via
   * `storeyGuid`); `document` = paged reading material (PDF); `image` = one
   * bitmap (photo, scan).
   */
  kind: ViewerDocumentKind;
  /** Fetchable source (host URL or a session blob: URL). */
  url: string;
  mime?: string;
  /** Storey GlobalId a `drawing` belongs to (D-072 binding), if known. */
  storeyGuid?: string | null;
  /** Host-defined tree path, e.g. ['Building A', 'Level 2']. */
  folder?: readonly string[];
  /** Free-form metadata shown in the list (revision, status, discipline…). */
  meta?: Readonly<Record<string, string>>;
}

/** Restorable per-tab viewer state (survives tab switches, not rasters). */
export interface DocTabView {
  /** 1-based page the viewport is on (PDFs; images are always 1). */
  page: number;
  zoom: number;
}

/** One open tab. Tabs are keyed by document id — a document opens once. */
export interface DocTab {
  docId: string;
  view: DocTabView;
}

export interface DocumentEvent {
  docId: string;
  event: 'opened' | 'closed';
}

/**
 * One-shot page-jump request for an ALREADY-open tab (deep link while the
 * document is active — a mounted viewer treats the stored view as an initial
 * snapshot, so it needs an explicit signal). Consumed by the viewer.
 */
export interface DocJumpRequest {
  docId: string;
  page: number;
  /** Monotonic marker so repeated jumps to the same page still fire. */
  nonce: number;
}

export interface DocumentsSlice {
  /** Keyed by document id. Replaced immutably on every mutation. */
  viewerDocuments: Map<string, ViewerDocument>;
  documentsPanelVisible: boolean;
  /** Open tabs in the center document pane, in visual order. */
  docTabs: DocTab[];
  /** Active tab's document id, or null when the pane is closed. */
  activeDocTabId: string | null;
  /** Pending page jump for an already-open tab, or null. */
  docJump: DocJumpRequest | null;
  /**
   * Host analytics/recents hook (e.g. the AIM bridge). Called on tab
   * open/close. Null = standalone session.
   */
  documentEventHandler: ((e: DocumentEvent) => void) | null;

  /** Bulk-replace the document list (host load path). */
  setViewerDocuments: (docs: readonly ViewerDocument[]) => void;
  /** Add or replace one document (local file open, host push). */
  upsertViewerDocument: (doc: ViewerDocument) => void;
  removeViewerDocument: (id: string) => void;
  setDocumentsPanelVisible: (visible: boolean) => void;

  /** Open a document in the pane — dedupe by id, focus the existing tab. */
  openDocument: (docId: string, opts?: { page?: number }) => void;
  closeDocTab: (docId: string) => void;
  setActiveDocTab: (docId: string) => void;
  setDocTabView: (docId: string, view: Partial<DocTabView>) => void;
  /** Clear a consumed page-jump request (viewer-side ack). */
  clearDocJump: () => void;

  setDocumentEventHandler: (handler: ((e: DocumentEvent) => void) | null) => void;
}

/**
 * Release a session-local document's object URL. Local files enter the store
 * via `URL.createObjectURL`; without a matching revoke the underlying File
 * blob stays pinned for the whole session (memory is D-075's #1 constraint).
 * Guarded — node test runs have no createObjectURL/revokeObjectURL.
 */
function revokeLocalUrl(doc: ViewerDocument | undefined): void {
  if (doc?.url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(doc.url);
  }
}

export const createDocumentsSlice: StateCreator<
  DocumentsSlice,
  [],
  [],
  DocumentsSlice
> = (set, get) => ({
  viewerDocuments: new Map(),
  documentsPanelVisible: false,
  docTabs: [],
  activeDocTabId: null,
  docJump: null,
  documentEventHandler: null,

  setViewerDocuments: (docs) => {
    const closed: string[] = [];
    set((state) => {
      const map = new Map<string, ViewerDocument>();
      for (const d of docs) map.set(d.id, d);
      // A host re-send must not nuke session-local work (mirrors
      // setUnderlayDrawings): locally-added documents survive, and tabs whose
      // document disappeared are closed.
      for (const [id, d] of state.viewerDocuments) {
        if (id.startsWith('local:') && !map.has(id)) map.set(id, d);
      }
      const docTabs = state.docTabs.filter((t) => {
        if (map.has(t.docId)) return true;
        closed.push(t.docId);
        return false;
      });
      const activeDocTabId =
        state.activeDocTabId && docTabs.some((t) => t.docId === state.activeDocTabId)
          ? state.activeDocTabId
          : (docTabs[docTabs.length - 1]?.docId ?? null);
      return { viewerDocuments: map, docTabs, activeDocTabId };
    });
    // Keep the opened/closed pairing intact for the host even when a tab is
    // closed by a library re-send rather than by the user.
    const handler = get().documentEventHandler;
    if (handler) for (const docId of closed) handler({ docId, event: 'closed' });
  },

  upsertViewerDocument: (doc) => {
    set((state) => {
      const previous = state.viewerDocuments.get(doc.id);
      if (previous && previous.url !== doc.url) revokeLocalUrl(previous);
      const next = new Map(state.viewerDocuments);
      next.set(doc.id, doc);
      return { viewerDocuments: next };
    });
  },

  removeViewerDocument: (id) => {
    const state = get();
    if (!state.viewerDocuments.has(id)) return;
    if (state.docTabs.some((t) => t.docId === id)) state.closeDocTab(id);
    set((s) => {
      revokeLocalUrl(s.viewerDocuments.get(id));
      const next = new Map(s.viewerDocuments);
      next.delete(id);
      return { viewerDocuments: next };
    });
  },

  setDocumentsPanelVisible: (visible) => set({ documentsPanelVisible: visible }),

  openDocument: (docId, opts) => {
    const state = get();
    if (!state.viewerDocuments.has(docId)) return;
    const existing = state.docTabs.find((t) => t.docId === docId);
    if (existing) {
      set({
        activeDocTabId: docId,
        docTabs:
          opts?.page !== undefined
            ? state.docTabs.map((t) =>
                t.docId === docId ? { ...t, view: { ...t.view, page: opts.page! } } : t,
              )
            : state.docTabs,
        // A mounted viewer reads the stored view only at mount — an explicit
        // deep-link page for an open tab needs a one-shot jump signal.
        docJump:
          opts?.page !== undefined
            ? { docId, page: opts.page, nonce: (state.docJump?.nonce ?? 0) + 1 }
            : state.docJump,
      });
      return;
    }
    const tab: DocTab = { docId, view: { page: opts?.page ?? 1, zoom: 1 } };
    set({ docTabs: [...state.docTabs, tab], activeDocTabId: docId });
    state.documentEventHandler?.({ docId, event: 'opened' });
  },

  closeDocTab: (docId) => {
    const state = get();
    const idx = state.docTabs.findIndex((t) => t.docId === docId);
    if (idx === -1) return;
    const docTabs = state.docTabs.filter((t) => t.docId !== docId);
    const activeDocTabId =
      state.activeDocTabId === docId
        ? (docTabs[Math.min(idx, docTabs.length - 1)]?.docId ?? null)
        : state.activeDocTabId;
    set({ docTabs, activeDocTabId });
    state.documentEventHandler?.({ docId, event: 'closed' });
  },

  setActiveDocTab: (docId) => {
    if (get().docTabs.some((t) => t.docId === docId)) set({ activeDocTabId: docId });
  },

  setDocTabView: (docId, view) => {
    set((state) => ({
      docTabs: state.docTabs.map((t) =>
        t.docId === docId ? { ...t, view: { ...t.view, ...view } } : t,
      ),
    }));
  },

  clearDocJump: () => set({ docJump: null }),

  setDocumentEventHandler: (handler) => set({ documentEventHandler: handler }),
});
