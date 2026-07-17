/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Documents panel (D-075) — the project document library, registered as the
 * `documents` workspace panel (docks / floats / pops out like the rest).
 *
 * Lists documents pushed by the embedding host over the AIM bridge
 * (DOCUMENTS_LOAD) or added locally via drag & drop / file picker (PDFs and
 * images, `local:` ids). Rows open as tabs in the center document pane;
 * calibrated drawings additionally jump straight into the 2D/Split view of
 * their storey.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { FilePlus2, FileText, Image as ImageIcon, Map as MapIcon, X } from 'lucide-react';
import type { StoreyOption } from '@/hooks/useViewMode';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { IdentifierLinkSettings } from '@/components/viewer/IdentifierLinkSettings';
import { useViewerStore, type ViewerDocument } from '@/store';
import { useViewMode } from '@/hooks/useViewMode';

interface DocumentsPanelProps {
  onClose: () => void;
}

/** Group key: host-defined folder path, or a catch-all bucket. */
function groupLabel(doc: ViewerDocument): string {
  return doc.folder && doc.folder.length > 0 ? doc.folder.join(' / ') : '';
}

function kindOfFile(file: File): ViewerDocument['kind'] {
  // Extension fallback: some platforms hand over files with an empty type.
  if (file.type.startsWith('image/')) return 'image';
  if (!file.type && /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name)) return 'image';
  return 'document';
}

export function DocumentsPanel({ onClose }: DocumentsPanelProps) {
  const docs = useViewerStore((s) => s.viewerDocuments);
  const openDocument = useViewerStore((s) => s.openDocument);
  const upsertDocument = useViewerStore((s) => s.upsertViewerDocument);
  const removeDocument = useViewerStore((s) => s.removeViewerDocument);
  const { setMode, storeys, storeyHasDrawing } = useViewMode();

  const [filter, setFilter] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const byGroup = new Map<string, ViewerDocument[]>();
    for (const doc of docs.values()) {
      if (needle && !doc.name.toLowerCase().includes(needle)) continue;
      const key = groupLabel(doc);
      const list = byGroup.get(key);
      if (list) list.push(doc);
      else byGroup.set(key, [doc]);
    }
    for (const list of byGroup.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    // Named folders first (alphabetical), the catch-all bucket last.
    return [...byGroup.entries()].sort(([a], [b]) =>
      a === '' ? 1 : b === '' ? -1 : a.localeCompare(b),
    );
  }, [docs, filter]);

  // ── Local files (standalone use + testing without a host) ───────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addFiles = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        if (!/\.pdf$/i.test(file.name) && !file.type.startsWith('image/')) continue;
        upsertDocument({
          id: `local:${file.name}:${file.size}`,
          name: file.name,
          kind: kindOfFile(file),
          url: URL.createObjectURL(file),
          mime: file.type || undefined,
        });
      }
    },
    [upsertDocument],
  );

  const storeyOf = useCallback(
    (doc: ViewerDocument): StoreyOption | undefined =>
      doc.storeyGuid ? storeys.find((s) => s.guid === doc.storeyGuid) : undefined,
    [storeys],
  );

  const openInPlan = useCallback(
    (doc: ViewerDocument) => {
      const storey = storeyOf(doc);
      if (storey) setMode('split', storey);
    },
    [storeyOf, setMode],
  );

  /**
   * Primary click, Dalux-style: a CALIBRATED drawing jumps straight to the
   * Split view of its storey (plan synced with the model); everything else —
   * text PDFs, images, drawings not calibrated yet — opens as a document tab.
   */
  const openPrimary = useCallback(
    (doc: ViewerDocument) => {
      if (doc.kind === 'drawing') {
        const storey = storeyOf(doc);
        if (storey && storeyHasDrawing(storey.guid)) {
          setMode('split', storey);
          return;
        }
      }
      openDocument(doc.id);
    },
    [storeyOf, storeyHasDrawing, setMode, openDocument],
  );

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        <span className="flex-1 text-xs font-semibold">Documents</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Add PDF or image files"
          title="Add PDF or image files"
        >
          <FilePlus2 className="size-3.5" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onClose}
          aria-label="Close documents panel"
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      <div className="border-b px-3 py-1.5">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter documents…"
          aria-label="Filter documents"
          className="h-6 w-full rounded border bg-background px-2 text-[11px]"
        />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {groups.length === 0 ? (
          <div className="p-6 text-center text-[11px] text-muted-foreground">
            {docs.size === 0
              ? 'No documents yet. Drop PDF or image files here, or use the add button above.'
              : 'No documents match the filter.'}
          </div>
        ) : (
          <div className="px-1.5 py-1">
            {groups.map(([label, list]) => (
              <div key={label || '(root)'} className="mb-1">
                {label && (
                  <div className="px-1.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                  </div>
                )}
                {list.map((doc) => {
                  const storey = storeyOf(doc);
                  const planPrimary =
                    doc.kind === 'drawing' && !!storey && storeyHasDrawing(storey.guid);
                  return (
                    <DocumentRow
                      key={doc.id}
                      doc={doc}
                      planPrimary={planPrimary}
                      canPlan={!!storey}
                      onOpen={() => openPrimary(doc)}
                      onOpenTab={() => openDocument(doc.id)}
                      onPlan={() => openInPlan(doc)}
                      onRemove={doc.id.startsWith('local:') ? () => removeDocument(doc.id) : undefined}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* Identifier hyperlinks (D-076): code source + pattern per project. */}
        <IdentifierLinkSettings />
      </ScrollArea>
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-primary/60 bg-primary/5 text-xs font-medium text-primary">
          Drop PDF / image files
        </div>
      )}
    </div>
  );
}

interface DocumentRowProps {
  doc: ViewerDocument;
  /** Calibrated drawing: the row's primary click opens the Split plan view. */
  planPrimary: boolean;
  canPlan: boolean;
  onOpen: () => void;
  /** Open as a plain document tab (secondary action for planPrimary rows). */
  onOpenTab: () => void;
  onPlan: () => void;
  onRemove?: () => void;
}

function DocumentRow({ doc, planPrimary, canPlan, onOpen, onOpenTab, onPlan, onRemove }: DocumentRowProps) {
  const Icon = doc.kind === 'image' ? ImageIcon : doc.kind === 'drawing' ? MapIcon : FileText;
  const revision = doc.meta?.revision;
  return (
    <div className="group flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-muted/60">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <button
        type="button"
        onClick={onOpen}
        title={planPrimary ? `${doc.name} — opens the 2D/Split plan of its storey` : doc.name}
        className="min-w-0 flex-1 truncate text-left text-[11px]"
      >
        {doc.name}
        {revision && <span className="ml-1.5 text-[10px] text-muted-foreground">rev {revision}</span>}
      </button>
      {planPrimary ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-5 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={onOpenTab}
          aria-label="Open as a document tab"
          title="Open as a document tab (plain PDF)"
        >
          <FileText className="size-3" aria-hidden />
        </Button>
      ) : canPlan ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-5 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={onPlan}
          aria-label="Show on the 2D plan beside 3D"
          title="Show on the 2D plan beside 3D"
        >
          <MapIcon className="size-3" aria-hidden />
        </Button>
      ) : null}
      {onRemove && (
        <Button
          variant="ghost"
          size="icon"
          className="size-5 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={onRemove}
          aria-label={`Remove ${doc.name}`}
          title="Remove (session-local file)"
        >
          <X className="size-3" aria-hidden />
        </Button>
      )}
    </div>
  );
}
