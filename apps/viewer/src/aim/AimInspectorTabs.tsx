/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM | IFC inspector switch (D-077) — the tab bar shown at the top of the
 * PropertiesPanel when the viewer is embedded in the AIM host and an element
 * is selected. "AIM" shows the host-fed AimCard (platform data), "IFC" shows
 * the panel's native file-derived content; PropertiesPanel hides its native
 * subtree via `useAimNativeHidden` (a `hidden`/`contents` wrapper, so the
 * upstream layout is untouched when the tab bar is inactive). Standalone
 * (non-embedded) mode renders nothing — zero upstream impact.
 */

import { create } from 'zustand';
import { Database, FileBox } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAimPanelStore } from './aimPanelStore';
import { AimCard } from './AimCard';

type InspectorTab = 'aim' | 'ifc';

interface AimInspectorState {
  tab: InspectorTab;
  setTab: (tab: InspectorTab) => void;
}

const useAimInspectorStore = create<AimInspectorState>((set) => ({
  tab: 'aim',
  setTab: (tab) => set({ tab }),
}));

/** True while the tab bar is active AND the AIM tab is selected — the
 *  PropertiesPanel hides its native content subtree for that state. */
export function useAimNativeHidden(): boolean {
  const embedded = useAimPanelStore((s) => s.embedded);
  const panel = useAimPanelStore((s) => s.panel);
  const tab = useAimInspectorStore((s) => s.tab);
  return embedded && panel.status !== 'idle' && tab === 'aim';
}

export function AimInspectorTabs() {
  const embedded = useAimPanelStore((s) => s.embedded);
  const panel = useAimPanelStore((s) => s.panel);
  const tab = useAimInspectorStore((s) => s.tab);
  const setTab = useAimInspectorStore((s) => s.setTab);

  // No host / no selection: no tab bar, PropertiesPanel shows native content.
  if (!embedded || panel.status === 'idle') return null;

  return (
    <>
      <Tabs value={tab} onValueChange={(v) => setTab(v as InspectorTab)} className="shrink-0">
        <TabsList className="properties-tabs-list w-full shrink-0">
          <TabsTrigger
            value="aim"
            title="AIM platforma"
            className="properties-tab-trigger flex-1 min-w-0 uppercase text-[11px] tracking-wide"
          >
            <Database className="h-3 w-3 shrink-0 panel-compact-icon" />
            <span className="panel-compact-text">AIM</span>
          </TabsTrigger>
          <TabsTrigger
            value="ifc"
            title="Natívne IFC dáta"
            className="properties-tab-trigger flex-1 min-w-0 uppercase text-[11px] tracking-wide"
          >
            <FileBox className="h-3 w-3 shrink-0 panel-compact-icon" />
            <span className="panel-compact-text">IFC</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'aim' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <AimCard />
        </div>
      )}
    </>
  );
}
