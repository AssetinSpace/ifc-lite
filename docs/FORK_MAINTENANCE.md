# Fork Maintenance — syncing `AssetinSpace/ifc-lite` with upstream

This repository is a **fork** of the upstream project
[`LTplus-AG/ifc-lite`](https://github.com/LTplus-AG/ifc-lite) (MPL-2.0). We track
upstream releases and periodically merge them in, while keeping our own **AIM
integration layer** on top.

> **One-way relationship.** Fetching/merging from upstream is read-only on their
> side — `LTplus-AG/ifc-lite` never sees anything we do. Nothing is ever pushed
> there unless we explicitly open a pull request against their repo (we don't,
> today). All sync work happens inside our own fork.

## How our changes are structured

Our custom code is deliberately kept as a **layer**, so upstream updates collide
with it as little as possible:

| Kind | Where | Conflict risk on sync |
|---|---|---|
| **Isolated layer** (new files, upstream has none) | everything under `apps/viewer/src/aim/` | none |
| **Wiring** (small edits into upstream files) | see table below | low, but real |
| **Generic bug-fixes** we keep local | drag-across-iframe fix in `FloatingPanel.tsx`, `SidebarDock.tsx`, `SidebarPanelHost.tsx`, `useDraggablePanel.ts`, `ViewerLayout.tsx` | occasional |

### Wiring touchpoints (where merge conflicts can appear)

Every custom edit inside an upstream file is bracketed with sentinel comments so
a conflict is obvious and trivially resolvable — **keep our side**:

```
// >>> AIM-FORK: <what & why>
... our code ...
// <<< AIM-FORK
```

**This table is generated from the sentinels — regenerate it, don't hand-patch it:**

```bash
git grep -n ">>> AIM-FORK" -- apps/ packages/
```

| File | Blocks | What we add |
|---|---|---|
| `apps/viewer/index.html` | 4 | branded title, assetin favicons, Inter font, brand colours (D-070) |
| `apps/viewer/src/bootstrap.tsx` | 1 | assetin design-kit import order — tokens first, after `index.css` (D-070; upstream moved the entry imports here from `main.tsx`) |
| `apps/viewer/src/App.tsx` | 2 | `import { AimBridge }` + `<AimBridge />` mount inside `SourceHostProvider` |
| `apps/viewer/src/hooks/useModelUrlAutoload.ts` | 3 | `?models=` federated autoload + origin allowlist (`lib/autoload.ts`), `AUTOLOAD_COMPLETE_EVENT` for AimBridge |
| `apps/viewer/src/components/viewer/ViewerLayout.tsx` | 6 | D-072 2D plan pane + D-075 document pane in the center split (around upstream's `ModelWorkspaceSplit`), view-mode effects |
| `apps/viewer/src/components/viewer/MobileBottomSheet.tsx` | 1 | `z-50` so sheets sit above the full-screen plan/document overlays |
| `apps/viewer/src/components/viewer/MobileToolbar.tsx` | 2 | `<ViewModeSwitcher />` (D-075) |
| `apps/viewer/src/components/viewer/PropertiesPanel.tsx` | 7 | AIM \| IFC inspector tabs + `<AimCard />`, native content wrapped, mobile scroll host (D-077) |
| `apps/viewer/src/components/viewer/HierarchyPanel.tsx` | 2 | AIM tree decorations — row → IFC GlobalId → badge counts (D-077) |
| `apps/viewer/src/components/viewer/hierarchy/HierarchyNode.tsx` | 4 | AIM badge icons + per-GUID counts (D-077) |
| `apps/viewer/src/components/viewer/Viewport.tsx` | 2 | `useDrawingUnderlay` (D-072) |
| `apps/viewer/src/components/viewer/ViewportContainer.tsx` | 4 | Reality Capture pin layer (D-073), calibration / split-view overlays (D-072) |
| `apps/viewer/src/components/viewer/viewport-render-options.ts` | 2 | drawing-view storey cut wins over the Section clip (`aim/underlayCut.ts`, D-072) |
| `apps/viewer/src/components/viewer/selectionHandlers.ts` | 2 | underlay calibration model-point pick (`aim/underlayPick.ts`, D-072) |
| `apps/viewer/src/components/viewer/useMouseControls.ts` | 2 | drawing view: drag pans; Ctrl/Cmd+wheel moves the cut while it is active (D-072) |
| `apps/viewer/src/hooks/useFloorplanView.ts` | 2 | `StoreyInfo` alias + projection/camera selectors for the drawing / split / 2D views (D-072, D-075) |
| `apps/viewer/src/components/viewer/ribbon/RibbonToolbar.tsx` | 3 | fork-only **Documents** ribbon tab — strip entry + band mount (D-072/D-075) |
| `apps/viewer/src/store/constants.ts` | 1 | `'documents'` added to `RibbonTabId` |
| `apps/viewer/src/store/index.ts` | 1 | fork-only store slices (underlays D-072, documents D-075, identifier links D-076) |
| `apps/viewer/src/store/teardown-registry.ts` | 2 | the fork slices' session-reset teardowns (`slices/*Slice.teardown.ts`) |
| `apps/viewer/src/store/store-sync.ts` | 1 | fork panels in `SIDEBAR_PANEL_FLAGS` |
| `apps/viewer/src/store/createViewerActions.ts` | 2 | fork panel flags in `openWorkspacePanel` / properties reveal |
| `apps/viewer/src/lib/panels/registry.ts` | 3 | fork-only workspace panels `drawing-underlay` + `documents`, appended last |
| `apps/viewer/src/lib/panels/renderPanelBody.tsx` | 2 | bodies of the two fork panels |
| `apps/viewer/src/i18n/en.ts` | 2 | fork catalogue `catalogues/aim-fork.en.ts` (panel titles, `ribbon.tab.documents`) |
| `packages/renderer/src/index.ts` | 5 | generic external-overlay hook + registry — **upstream-PR candidate** |
| `packages/collab-server/src/bin.ts` | 3 | fail-closed startup guard (replaces upstream's warn-only block) |

If you resolve a conflict here, grep for `AIM-FORK` to confirm you kept all our
brackets, and note in the sync PR which extension point in upstream would have
let us avoid the edit entirely (input for future upstreaming / npm-package move).
The `packages/renderer` hook is the furthest along that path — it was written as a
generic contract precisely so it can be offered upstream.

## One-time setup (per clone)

```bash
git remote add upstream https://github.com/LTplus-AG/ifc-lite
git fetch --unshallow upstream    # only if this clone is shallow; otherwise: git fetch upstream
```

## Sync recipe (manual)

```bash
# 1. Get the latest upstream main
git fetch upstream main

# 2. Branch off our current main
git switch main && git pull
git switch -c sync/upstream-$(date +%Y-%m-%d)

# 3. Merge upstream (merge, NOT rebase — our main is deployed via Vercel and carries PRs)
git merge upstream/main

# 4. Resolve conflicts. They only appear in the wiring touchpoints above.
#    Look for both git markers (<<<<<<<) and our sentinels (AIM-FORK). Keep our side.
git grep -n "AIM-FORK"

# 5. Verify (see below), then push and open a PR INTO our main
git push -u origin sync/upstream-$(date +%Y-%m-%d)
```

Open the PR against `AssetinSpace/ifc-lite:main`, let CI run, then merge → Vercel
deploys.

## Sync recipe (automated)

`.github/workflows/upstream-sync.yml` runs **every Monday 06:00 UTC** (and on manual
`workflow_dispatch`). It fetches upstream, merges into a dated branch, and opens
a **PR in this repo**. It never touches `LTplus-AG/ifc-lite`.

What happens next depends on the merge:

| Merge | What the workflow does | What you do |
|---|---|---|
| **clean** | opens the PR, waits for CI, merges it (merge commit), deletes the branch | nothing |
| **only `pnpm-lock.yaml` conflicts** | regenerates the lock (`pnpm install --lockfile-only`) and continues as if clean — so it also auto-merges | nothing |
| **anything else conflicts** | commits the markers, opens the PR labelled `needs-manual-merge`, stops | resolve it — keep our `AIM-FORK` blocks |

> **Why the lock is regenerated, not merged.** It conflicts on nearly every sync — upstream
> bumps dependencies constantly and we carry two of our own (`design-kit`, `pdfjs-dist`), so
> the lock diverges even when no source file does. Sending that to a human means a manual
> merge almost every week, which is how the fork once fell three weeks behind. This is the
> same rule D-071 already states. It only applies when the lock is the **only** conflict: if a
> real file conflicts too, `package.json` may be broken and pnpm would resolve against a tree
> nobody has reviewed.

> **Why a conflicted sync commit carries `[skip ci]`.** That tree has conflict markers in it,
> so `apps/viewer/package.json` is invalid JSON and `pnpm install` cannot even start — every
> job in the matrix fails for one reason we already know, and the only output is a wall of red
> notification mail. Red that always means the same thing trains people to ignore red, which
> is the failure mode this whole workflow exists to prevent. CI runs when you push the
> resolution. The `needs-manual-merge` label is the signal that the PR is waiting, not CI.

Every run also rewrites a single issue titled **`Upstream sync status`** with how many
commits we are behind, which upstream commit `main` actually contains, and whether the
last run passed. **That issue is the one thing to check weekly** — pin it once (Issues →
⋯ → Pin issue) and it stays pinned, because the workflow reuses it instead of opening a
new one. Don't close it.

> **Requires Issues to be enabled.** GitHub ships forks with the Issues feature **off**,
> and `gh issue list` then fails with `the '<repo>' repository has disabled issues` — which
> is how we found out (the 2026-08-01 run merged upstream and opened PR #37 fine, then died
> on the status step). Turn them on in **Settings → General → Features → Issues**. Until
> then the step emits a warning and the status goes only to the run's **job summary**; the
> sync itself is unaffected. The same status is written to the job summary either way.

### Repository settings this workflow expects

| Setting | Where | Why |
|---|---|---|
| **Issues enabled** | Settings → General → Features | the `Upstream sync status` issue; off by default on forks |
| Secret `UPSTREAM_SYNC_TOKEN` | Settings → Secrets and variables → Actions → Secrets | pushing `.github/workflows/` changes — see "Sync token" below |
| Variable `UPSTREAM_SYNC_TOKEN_EXPIRES` | same page → Variables | `YYYY-MM-DD`; drives the expiry countdown in the status issue |

> **Why clean syncs merge themselves.** The failure this removes is human, not technical:
> PR #35 sat green and unmerged for five days while the fork drifted 27 further commits
> behind. Automation that opens a PR nobody merges is not automation.
>
> The workflow waits for CI **inside the job** (`gh pr checks --watch`) rather than using
> `gh pr merge --auto`. `--auto` merges the moment the PR is mergeable, so without required
> status checks configured on `main` it would merge *before* CI says anything — and the sync
> PAT has no Administration scope to check whether they are configured. Watching in-job is
> unconditional and cannot merge early. If you later add branch protection with required
> checks, `--auto` becomes the cheaper option and this step can be simplified.

> **Merge commit, never squash or rebase.** This is not style. Squashing an upstream merge
> throws away the merge-base with `upstream/main`, so the *next* sync sees the entire tree as
> divergent and re-conflicts everything. Both the workflow (`gh pr merge --merge`) and the
> conflict-PR body say so explicitly; keep it that way if you touch either.

> **Nothing may fail quietly.** An earlier version wrapped its `gh` calls in `|| true` and
> `|| echo "PR may already exist"`. The 2026-07-13 run hit a 403, swallowed it, and reported
> **success for a run that never opened a PR** — the orphaned `sync/upstream-2026-07-13`
> branch was the only trace. Every `gh` call now either succeeds or fails the run, so a broken
> sync shows up as a red run and a GitHub failure e-mail. Don't reintroduce `|| true`.
>
> Related: GitHub **disables scheduled workflows after 60 days without repository activity**.
> If syncs simply stop arriving, check Actions for the "disabled" banner before debugging.

> **Careful when editing that workflow:** `gh` picks its base repo from the git
> remotes and **prefers one named `upstream`** — which the workflow adds itself,
> pointing at `LTplus-AG/ifc-lite`. Every `gh` call there must therefore stay
> pinned to our fork (the workflow sets `GH_REPO: ${{ github.repository }}` once,
> at the top). Without that pin `gh label create` and `gh pr create` target the
> upstream repo — a 403 if the token is scoped to our fork, and a pull request
> opened against LTplus-AG if it isn't. The relationship is one-way; keep it that way.

### Sync token (`UPSTREAM_SYNC_TOKEN`)

The workflow authenticates with a **PAT**, not the default `GITHUB_TOKEN`. This is
not a preference — it is the only thing that works:

> `! [remote rejected] sync/upstream-2026-07-27 (refusing to allow a GitHub App to`
> `create or update workflow .github/workflows/wide-arithmetic.yml without`
> `` `workflows` permission)``

Upstream regularly adds or edits files under `.github/workflows/`, and a push
carrying such a change is rejected for `GITHUB_TOKEN` **no matter what the
`permissions:` block says** — there is no `workflows` scope to grant it. A sync
week that happens not to touch CI succeeds; the next one that does fails. A PAT
belongs to a user account and carries the scope, so the push goes through. It also
means the sync PR **triggers CI** — PRs opened by `GITHUB_TOKEN` deliberately do not.

Create a **fine-grained PAT** scoped to `AssetinSpace/ifc-lite` only, with:

| Repository permission | Level | Needed for |
|---|---|---|
| Contents | Read and write | pushing the `sync/upstream-*` branch |
| Workflows | Read and write | the upstream `.github/workflows/` changes in that branch |
| Pull requests | Read and write | `gh pr create` |
| Issues | Read and write | creating and applying the sync labels |

Store it as repository secret **`UPSTREAM_SYNC_TOKEN`** (Settings → Secrets and
variables → Actions). The workflow checks for it up front and fails with a pointer
to this section if it is missing, rather than dying later at the push.

Fine-grained PATs expire (max 1 year). When the token lapses the sync fails with a
403 on push — regenerate it and update the secret; nothing in the workflow changes.

So the expiry doesn't ambush us, record it as a **repository variable**
`UPSTREAM_SYNC_TOKEN_EXPIRES` (Settings → Secrets and variables → Actions → Variables),
value `YYYY-MM-DD`. The status issue then counts down and turns the line into a warning
under 30 days. Update the variable whenever you rotate the token. The current token was
issued **2026-07-27**, so it lapses by **2027-07-27** at the latest.

A longer-term fix is a GitHub App installation token, which doesn't expire — worth doing
if rotating a PAT once a year proves to be one chore too many.

## Verify after a sync

```bash
pnpm install
pnpm build                       # turbo build across the tree
pnpm test                        # unit tests incl. apps/viewer aim/bridge-protocol.test.ts
pnpm test:e2e                    # playwright — exercises the App/ViewerLayout/PropertiesPanel wiring
```

Then sanity-check the AIM layer manually (federated `?models=…` load, AIM card,
FOCUS colorize, iframe postMessage bridge). Confirm we didn't overwrite upstream:

```bash
git diff upstream/main..HEAD -- apps/viewer/src/aim   # should show only our layer
```

## Upstream-only workflows (disabled on this fork)

Some upstream CI publishes/deploys to infrastructure the fork doesn't have. These jobs
are guarded with `if: github.repository == 'LTplus-AG/ifc-lite'` (bracketed `AIM-FORK`)
so they **skip** on our fork instead of failing red:

| Workflow | Job(s) | Why it can't run here |
|---|---|---|
| `.github/workflows/release.yml` | `release` | Publishes to npm/crates + opens the changesets version PR; needs `RELEASE_PAT` + OIDC trusted publishers the fork lacks (fails at checkout: "token not supplied"). |
| `.github/workflows/docs.yml` | `build`, `deploy` | Deploys docs to GitHub Pages; the fork has no Pages site (`configure-pages` → 404 "Get Pages site failed"). |
| `.github/workflows/docker.yml` | `docker` | Publishes the server container; the fork embeds the viewer via Vercel and doesn't ship it (also wants a Depot runner). |

If we ever want these on the fork: for docs, enable GitHub Pages (Settings → Pages → build
from Actions) and drop the guard; for releases/docker, set up our own publish targets first.

## Depot runners → ubuntu-latest on the fork

Until the 2026-10 sync upstream ran its heavy CI jobs on **Depot** runners
(`depot-ubuntu-24.04-4`), which don't exist on the fork (jobs sat queued forever), so the fork
guarded each `runs-on` by repository. Upstream has since moved routine CI off Depot: `test.yml`
now picks `ubuntu-latest` unless `vars.SELF_HOSTED_CI == 'true'`, which the fork doesn't set,
so those guards were dropped in that sync. What stays fork-only:

- the from-source wasm compile forces **thin LTO** (`CARGO_PROFILE_RELEASE_LTO`) so FAT LTO
  doesn't OOM `ubuntu-latest` — same fix as `scripts/vercel-build.sh`;
- `docker.yml` keeps its upstream-only `if:` (see the table above).

> **Check this on every sync that touches workflows.** A new upstream job on a runner the fork
> lacks arrives unguarded and hangs the whole PR silently — no failure, just a check that never
> finishes. After a sync, grep for the forms that only exist upstream:
>
> ```bash
> grep -rn "runs-on: depot\|depot-ubuntu" .github/workflows/
> ```
>
> Every hit must either carry a repository-conditional `runs-on`, or sit in a job whose `if:`
> already restricts it to upstream (that is how `docker.yml` is handled).

## Upstream ratchets that carry fork rows

Upstream gates new code with per-file ratchets. The fork-owned UI (D-072 underlays, D-075
documents, D-076 identifier links) predates several of them, so the 2026-10 sync recorded the
fork's current counts as baseline rows instead of rewriting that UI in the same PR:

| Gate | File | Fork rows |
|---|---|---|
| `check-i18n-literals` | `scripts/i18n-literals-baseline.json` | hardcoded English in the underlay / documents / identifier-link panels |
| `check-icon-button-adoption` | `BASELINE` in the script (`AIM-FORK` block) | `<Button size="icon">` in the same panels |
| `check-module-size` | `scripts/module-size-allowlist.txt` | fork files over 400 lines, and upstream files the wiring grew |
| `check-agents-md-size` | `scripts/agents-md-budget.txt` | the fork section in `AGENTS.md` and `packages/collab-server/AGENTS.md` |

They ratchet **down**: moving a panel's copy into `catalogues/aim-fork.en.ts`, switching to
`IconButton`, or splitting a file lowers its row (`--update`). Never raise a row for new fork
code without saying why in the PR.

## Conventions (don't drift)

- **New custom code → `apps/viewer/src/aim/`**, not scattered into upstream files.
- **Every edit inside an upstream file → wrap in `// >>> AIM-FORK … // <<< AIM-FORK`.**
- **Merge, never rebase** the deployed `main`; sync PRs land as **merge commits**, never squashed.
- **No `|| true` around `gh` calls** in the sync workflow — silence there cost us three weeks once.
- Regenerate the wiring table from `git grep ">>> AIM-FORK"` rather than editing it by hand.

## The weekly check (30 seconds)

Open the pinned **`Upstream sync status`** issue. If it says up to date and the last run
passed, you're done. Otherwise:

| What it says | What it means |
|---|---|
| `N commits behind`, last run ✅ | a sync PR is open and waiting — most likely `needs-manual-merge` |
| last run ❌ | the workflow itself is broken; open the linked run |
| token expires in < 30 days | rotate the PAT and update `UPSTREAM_SYNC_TOKEN_EXPIRES` |
| issue not updated for > 1 week | the schedule stopped — check for GitHub's 60-day disabled banner |
