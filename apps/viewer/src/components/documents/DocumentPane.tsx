/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Center document pane (D-075): the tab strip + active document body,
 * mounted as a collapsible Panel beside the 3D viewport (ViewerLayout).
 *
 * Only the ACTIVE tab's viewer is mounted — switching tabs unmounts the
 * previous viewer and thereby drops its rasters/canvases (the memory
 * contract from D-075); the lightweight view state (page/zoom) lives in the
 * store and is restored on return. Middle-click closes a tab, like a
 * browser.
 */

import { useMemo } from 'react';
import { X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';
import { PdfDocumentView } from './PdfDocumentView';
import { ImageDocumentView } from './ImageDocumentView';

/** Extension fallback when the host didn't provide a mime type. */
function isImageDoc(name: string, mime?: string): boolean {
  if (mime) return mime.startsWith('image/');
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(name);
}

export function DocumentPane() {
  const docs = useViewerStore((s) => s.viewerDocuments);
  const tabs = useViewerStore((s) => s.docTabs);
  const activeId = useViewerStore((s) => s.activeDocTabId);
  const setActive = useViewerStore((s) => s.setActiveDocTab);
  const closeTab = useViewerStore((s) => s.closeDocTab);

  const activeDoc = useMemo(
    () => (activeId ? (docs.get(activeId) ?? null) : null),
    [docs, activeId],
  );

  if (tabs.length === 0) return null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden border-l bg-background">
      <div role="tablist" aria-label="Open documents" className="flex items-stretch overflow-x-auto border-b">
        {tabs.map((tab) => {
          const doc = docs.get(tab.docId);
          const active = tab.docId === activeId;
          return (
            <div
              key={tab.docId}
              className={cn(
                'flex max-w-44 shrink-0 items-center border-r',
                active ? 'bg-background' : 'bg-muted/40 hover:bg-muted/70',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={doc?.name}
                onClick={() => setActive(tab.docId)}
                onAuxClick={(e) => {
                  if (e.button === 1) closeTab(tab.docId);
                }}
                className={cn(
                  'min-w-0 truncate py-1 pl-2 pr-1 text-[11px]',
                  active ? 'font-medium' : 'text-muted-foreground',
                )}
              >
                {doc?.name ?? tab.docId}
              </button>
              <button
                type="button"
                aria-label={`Close ${doc?.name ?? 'document'}`}
                onClick={() => closeTab(tab.docId)}
                className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <div className="min-h-0 flex-1">
        {activeDoc &&
          (isImageDoc(activeDoc.name, activeDoc.mime) || activeDoc.kind === 'image' ? (
            <ImageDocumentView key={activeDoc.id} url={activeDoc.url} name={activeDoc.name} />
          ) : (
            <PdfDocumentView key={activeDoc.id} docId={activeDoc.id} url={activeDoc.url} />
          ))}
      </div>
    </div>
  );
}
