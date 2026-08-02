/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ribbon toolbar (issue #1686) — the tabbed, IFCFlux/Office-style
 * alternative to the classic single-strip `MainToolbar`, and the default
 * toolbar since the ribbon shipped. A slim tab strip selects a command
 * context; the band beneath lays the commands out in labeled groups with
 * visible names, trading one strip of vertical space for zero-recall
 * discovery. Selected per user via `uiSlice.toolbarStyle`; both styles
 * drive the same shared command hooks so behaviour can never fork.
 *
 * Office conventions kept: double-click the active tab (or the chevron)
 * to collapse the band to the tab strip; the collapsed state persists.
 * The active tab also follows the working context (see
 * `useRibbonContextualTab`), which the user can turn off in View.
 *
 * Narrow screens (`uiSlice.isMobile`) get the same ribbon, sized for a
 * thumb: a 44px strip with 36px hit targets, a tab strip that scrolls
 * horizontally instead of squeezing its tabs (seven of them do not fit a
 * phone, and squeezing pushed the theme/help/collapse cluster off-screen),
 * and a progress readout stripped to the bar. There it also opens
 * collapsed (`UI_DEFAULTS.RIBBON_COLLAPSED`) and a tab tap expands it only
 * for the session, so the toolbar costs 44px until the chevron pins the
 * band open — less than the mobile strip it replaced.
 */

import React from 'react';
import { ChevronDown, ChevronUp, HelpCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore, type RibbonTabId } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { cn } from '@/lib/utils';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { ThemeSwitch } from '../ThemeSwitch';
import { ExportChangesButton } from '../ExportChangesButton';
import { ExtensionToolbarSlot } from '@/components/extensions/ExtensionToolbarSlot';
import { useFileCommands } from '../toolbar/useFileCommands';
import { FileTab } from './tabs/FileTab';
import { HomeTab } from './tabs/HomeTab';
import { ViewTab } from './tabs/ViewTab';
import { ElementsTab } from './tabs/ElementsTab';
import { AnalyzeTab } from './tabs/AnalyzeTab';
import { AuthorTab } from './tabs/AuthorTab';
import { RibbonSwitchNotice } from './RibbonSwitchNotice';
import { useRibbonContextualTab } from './useRibbonContextualTab';
// >>> AIM-FORK: fork-only Documents tab body (see src/aim/DocumentsRibbonTab.tsx)
import { DocumentsRibbonTab } from '@/aim/DocumentsRibbonTab';
// <<< AIM-FORK

const RIBBON_TABS: { id: RibbonTabId; label: string }[] = [
  { id: 'file', label: 'File' },
  { id: 'home', label: 'Home' },
  { id: 'view', label: 'View' },
  { id: 'elements', label: 'Elements' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'author', label: 'Author' },
  // >>> AIM-FORK: fork-only tab, kept last so upstream keeps appending above us.
  { id: 'documents', label: 'Documents' },
  // <<< AIM-FORK
];

interface RibbonToolbarProps {
  onShowShortcuts?: () => void;
}

export function RibbonToolbar({ onShowShortcuts }: RibbonToolbarProps = {} as RibbonToolbarProps) {
  // The active tab lives in the store so the contextual driver and the
  // walkthrough can open one; it starts on Home and is never persisted.
  const activeTab = useViewerStore((s) => s.ribbonTab);
  const setActiveTab = useViewerStore((s) => s.setRibbonTab);
  const ribbonCollapsed = useViewerStore((s) => s.ribbonCollapsed);
  const setRibbonCollapsed = useViewerStore((s) => s.setRibbonCollapsed);
  // Touch sizing and the stripped-down strip; owned by ViewerLayout's
  // resize listener, so rotating a phone re-sizes the ribbon with it.
  const isMobile = useViewerStore((s) => s.isMobile);

  useRibbonContextualTab();

  // Keep the active tab reachable: the contextual driver (and the command
  // palette) can open a tab that sits outside the scrolled strip on a
  // phone. `nearest` so it never scrolls anything but the strip itself.
  const activeTabRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  // Shared command surface — registers the global load listeners and the
  // hidden file inputs exactly once for this toolbar style.
  const fileCommands = useFileCommands();

  const { loading, progress, geometryProgress, metadataProgress } = useIfc();
  const error = useViewerStore((state) => state.error);
  const activeProgress = geometryProgress ?? metadataProgress ?? progress;

  const handleTabClick = (id: RibbonTabId) => {
    if (id === activeTab && !ribbonCollapsed) return;
    setActiveTab(id);
    if (ribbonCollapsed) {
      // Clicking any tab while collapsed re-opens the band (Office pins on
      // click) — but on a phone that pin is transient, written to the store
      // and not to storage. One tap to reach a command must not cost 88px
      // of every future session; the chevron is how a small screen says
      // "keep it open", the same split Office draws between showing the
      // band and pinning it.
      if (isMobile) useViewerStore.setState({ ribbonCollapsed: false });
      else setRibbonCollapsed(false);
    }
  };

  return (
    <div className="relative z-50 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-black">
      {fileCommands.fileInputs}

      {/* ── Tab strip ── */}
      <div
        className={cn(
          'flex items-center gap-0.5 border-b border-zinc-200/70 px-2 dark:border-zinc-800/70',
          isMobile ? 'h-11' : 'h-10',
        )}
      >
        {/* The strip is the one element allowed to shrink (`min-w-0`) and
            scroll: everything to its right is a command that must stay
            on-screen at every width. */}
        <div
          role="tablist"
          aria-label="Ribbon tabs"
          className="flex h-full min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overscroll-x-contain scrollbar-none"
          {...tourAnchor(TOUR_ANCHORS.ribbonTabs)}
        >
          {RIBBON_TABS.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                ref={isActive ? activeTabRef : undefined}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handleTabClick(tab.id)}
                onDoubleClick={() => {
                  if (isActive) setRibbonCollapsed(!ribbonCollapsed);
                }}
                className={cn(
                  'relative flex shrink-0 select-none items-center rounded-t-md px-3 text-xs font-medium tracking-wide transition-colors',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  isMobile ? 'h-9' : 'h-8',
                  isActive
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                {tab.label}
                {/* Drafting-pen underline for the active tab — reads in
                    every theme without a filled pill. */}
                {isActive && (
                  <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />
                )}
              </button>
            );
          })}
        </div>

        {/* Loading progress — lives in the strip so it survives collapse.
            On a phone only the bar survives: the phase text alone is wider
            than the tabs it would push out of reach. */}
        {loading && activeProgress && (
          <div className="mr-2 flex shrink-0 items-center gap-2">
            {!isMobile && (
              <span className="max-w-56 truncate text-xs text-muted-foreground">
                {activeProgress.phase}
                {geometryProgress && metadataProgress ? ` | ${metadataProgress.phase}` : ''}
              </span>
            )}
            {activeProgress.indeterminate ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : (
              <>
                <Progress value={activeProgress.percent ?? 0} className={cn('h-2', isMobile ? 'w-14' : 'w-28')} />
                {!isMobile && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {Math.round(activeProgress.percent ?? 0)}%
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {/* Error Display */}
        {error && (
          <span className={cn('mr-2 shrink-0 truncate text-xs text-destructive', isMobile ? 'max-w-24' : 'max-w-72')}>
            {error}
          </span>
        )}

        {/* Extension toolbar contributions (right-aligned, same slot as
            the classic toolbar). */}
        <div className="flex shrink-0 items-center">
          <ExtensionToolbarSlot slot="toolbar.right" />
        </div>

        {/* Export Changes — pending-mutation affordance must stay visible
            regardless of the active tab or collapse state. */}
        <div className="flex shrink-0 items-center">
          <ExportChangesButton />
        </div>

        <div className="ml-1 flex shrink-0 items-center gap-1 border-l border-zinc-200 pl-2 dark:border-zinc-700/60">
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <ThemeSwitch size={isMobile ? 48 : 80} />
              </div>
            </TooltipTrigger>
            <TooltipContent>Toggle theme (Shift+click for secret mode)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size={isMobile ? 'icon' : 'icon-sm'}
                aria-label="Info and keyboard shortcuts"
                onClick={() => onShowShortcuts?.()}
              >
                <HelpCircle className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Info (?)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size={isMobile ? 'icon' : 'icon-sm'}
                aria-label={ribbonCollapsed ? 'Expand the ribbon' : 'Collapse the ribbon'}
                aria-expanded={!ribbonCollapsed}
                onClick={() => setRibbonCollapsed(!ribbonCollapsed)}
                {...tourAnchor(TOUR_ANCHORS.ribbonCollapse)}
              >
                {ribbonCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{ribbonCollapsed ? 'Expand the ribbon' : 'Collapse the ribbon'}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* ── Band ── */}
      {!ribbonCollapsed && (
        <div
          role="tabpanel"
          aria-label={`${activeTab} commands`}
          className={cn(
            'flex h-[88px] items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain px-1',
            // 88px is the height a large button needs (32px icon + two label
            // lines); shrinking it on a phone would clip the labels, so the
            // band keeps its size and the ribbon saves space by opening
            // collapsed instead. Hide the scrollbar there — it would eat a
            // sixth of the button and touch scrolling needs no track.
            isMobile && 'scrollbar-none',
          )}
        >
          {activeTab === 'file' && <FileTab fileCommands={fileCommands} />}
          {activeTab === 'home' && <HomeTab />}
          {activeTab === 'view' && <ViewTab />}
          {activeTab === 'elements' && <ElementsTab />}
          {activeTab === 'analyze' && <AnalyzeTab />}
          {activeTab === 'author' && <AuthorTab />}
          {/* >>> AIM-FORK: fork-only Documents tab (D-072 / D-075) */}
          {activeTab === 'documents' && <DocumentsRibbonTab />}
          {/* <<< AIM-FORK */}
        </div>
      )}

      {/* One-time "the toolbar changed" line, with the way back. Sits under
          the band so it never displaces a command the user is reaching for. */}
      <RibbonSwitchNotice />
    </div>
  );
}
