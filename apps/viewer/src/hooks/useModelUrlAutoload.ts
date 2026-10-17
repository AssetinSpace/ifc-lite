/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Auto-load a model from `?model=<URL>` (used by the landing-page iframe to
 * drop a sample IFC into the viewer on first mount). Extracted from
 * `ViewerLayout.tsx` (#5851): a malformed URL, a cross-origin URL and a
 * failed fetch used to end in `console.error` only, so the user saw an empty
 * viewer with no explanation. Each now reports through the shared
 * `showLoadError` helper, so the in-viewport load-error card shows it, with
 * Retry re-running this same attempt.
 *
 * SECURITY: only SAME-ORIGIN model URLs are fetched. `?model=` is fully
 * attacker-controllable (any link can set it), so honouring an arbitrary
 * cross-origin URL is a drive-by model-injection vector. We resolve the
 * param against the current document and require its origin to match
 * `window.location.origin`; a cross-origin URL is refused, never fetched.
 */

import { useEffect, useRef } from 'react';
import { useIfcLoader } from './useIfcLoader.js';
import { useIfcFederation } from './useIfcFederation.js';
import { useWebGpuOpenGuard } from './useWebGpuOpenGuard';
import { showLoadError } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { useTranslation, type TranslationKey } from '@/i18n';
// >>> AIM-FORK: `?models=` federation autoload + cross-origin allowlist (D-049 / AIM host)
import { AUTOLOAD_COMPLETE_EVENT, parseAutoloadUrls } from '@/lib/autoload';
// <<< AIM-FORK

export function useModelUrlAutoload(): void {
  // The loader and federation hooks subscribe to actions only; `useIfc()` also
  // subscribes to `models`, which re-rendered the whole viewer shell (#6232).
  const { addModel } = useIfcFederation(useIfcLoader().loadFile);
  const { webgpu, guard: guardWebGpu } = useWebGpuOpenGuard();
  const { t } = useTranslation();
  const autoloadDoneRef = useRef(false);
  // Navigation may change the query and relative URL base while the adapter
  // probe is pending. Preserve the source requested on this mount.
  // >>> AIM-FORK: `?models=<URL>,…` loads a federation (AIM: ASR + VZT) in one
  // link, and the AIM host serves its models from object storage on another
  // origin, so upstream's strict same-origin rule becomes "same-origin plus an
  // explicit allowlist" (`parseAutoloadUrls`, VITE_AIM_MODEL_ORIGINS), applied
  // to `?model=` and `?models=` alike. Anything refused there is never fetched.
  const sourceRef = useRef<{ urls: string[]; requested: boolean } | null>(null);
  if (sourceRef.current === null) {
    const params = new URLSearchParams(window.location.search);
    // Resolve against the mount-time location (#5851): a navigation during the
    // adapter probe must not move a relative source, nor may a Retry.
    const baseUrl = window.location.href;
    sourceRef.current = {
      urls: parseAutoloadUrls(window.location.search, baseUrl).map((entry) => new URL(entry, baseUrl).href),
      requested: params.has('model') || params.has('models'),
    };
  }
  // <<< AIM-FORK

  useEffect(() => {
    // `useWebGPU`'s adapter probe is async; wait for it to settle so the
    // guard below gets a definitive answer instead of racing it (the effect
    // re-runs once `webgpu.checking` flips).
    if (webgpu.checking) return;
    if (autoloadDoneRef.current) return;
    const source = sourceRef.current;
    if (!source || !source.requested) return;
    autoloadDoneRef.current = true;

    // `retry` is required at every call (#5851 review): a refused URL is the
    // SAME url string on every attempt, so retrying it can never differ —
    // null, no Retry button. A fetch failure may well be transient, so it
    // gets a real retry over this same URL.
    const fail = (key: TranslationKey, code: string, retry: (() => void) | null, values?: Record<string, string>) => {
      const { setError, setLastLoadRetry } = useViewerStore.getState();
      showLoadError(setError, setLastLoadRetry, t(key, values), code, retry);
    };

    // >>> AIM-FORK: sequential multi-URL load; the WASM parser isn't re-entrant,
    // and federated adds must observe the earlier model's RTC/anchor before they
    // finalize. AUTOLOAD_COMPLETE_EVENT always fires — even when some (or all)
    // URLs failed — so AimBridge's MODELS_LOADED can't wait forever.
    if (source.urls.length === 0) {
      fail('viewportLighting.container.modelUrlAutoload.crossOrigin', 'model_url_cross_origin', null);
      window.dispatchEvent(new Event(AUTOLOAD_COMPLETE_EVENT));
      return;
    }
    const loadOne = async (modelUrl: string): Promise<void> => {
      try {
        // Entries were validated and made absolute when the hook mounted.
        const url = new URL(modelUrl);
        const res = await fetch(url.href);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const blob = await res.blob();
        const filename = url.pathname.split('/').pop() || 'model.ifc';
        const file = new File([blob], filename, { type: blob.type || 'application/x-step' });
        await addModel(file);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        fail('viewportLighting.container.modelUrlAutoload.fetchFailed', 'model_url_fetch_failed',
          () => { void loadOne(modelUrl); }, { reason });
      }
    };
    const attempt = async () => {
      if (!guardWebGpu(() => { void attempt(); })) return;
      for (const modelUrl of source.urls) await loadOne(modelUrl);
      window.dispatchEvent(new Event(AUTOLOAD_COMPLETE_EVENT));
    };
    // <<< AIM-FORK

    void attempt();
  }, [addModel, guardWebGpu, t, webgpu.checking]);
}
