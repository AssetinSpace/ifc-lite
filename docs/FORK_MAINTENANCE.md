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
| **Isolated layer** (new files, upstream has none) | `apps/viewer/src/aim/` (`AimBridge.tsx`, `AimCard.tsx`, `aimPanelStore.ts`, `bridge-protocol.ts`, `bridge-protocol.test.ts`) | none |
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

| File | What we add |
|---|---|
| `apps/viewer/src/App.tsx` | `import { AimBridge }` + `<AimBridge />` mount |
| `apps/viewer/src/components/viewer/ViewerLayout.tsx` | `?models=` federated autoload (extends upstream's `?model=`) |
| `apps/viewer/src/components/viewer/PropertiesPanel.tsx` | `import { AimCard }` + `<AimCard />` render |

If you resolve a conflict here, grep for `AIM-FORK` to confirm you kept all our
brackets, and note in the sync PR which extension point in upstream would have
let us avoid the edit entirely (input for future upstreaming / npm-package move).

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

`.github/workflows/upstream-sync.yml` runs on a schedule (and on manual
`workflow_dispatch`). It fetches upstream, merges into a dated branch, and opens
a **PR in this repo**. On merge conflicts it still opens the PR (with the
conflict markers committed) and labels it so a human finishes the merge. It never
touches `LTplus-AG/ifc-lite`.

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
Worth a calendar reminder a week before expiry.

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

Upstream runs the heavy CI jobs on **Depot** managed runners (`depot-ubuntu-24.04-4`), which
don't exist on the fork — so those jobs sit **queued forever** (`runner_id 0`). The affected
jobs in `.github/workflows/test.yml` (`Build packages + WASM`, `Rust tests`) select their
runner by repository:

```
runs-on: ${{ github.repository == 'LTplus-AG/ifc-lite' && 'depot-ubuntu-24.04-4' || 'ubuntu-latest' }}
```

The from-source wasm compile additionally forces **thin LTO** on the fork
(`CARGO_PROFILE_RELEASE_LTO`) so FAT-LTO doesn't OOM the smaller `ubuntu-latest` runner —
same fix as `scripts/vercel-build.sh`. Upstream keeps Depot + FAT LTO unchanged.

## Conventions (don't drift)

- **New custom code → `apps/viewer/src/aim/`**, not scattered into upstream files.
- **Every edit inside an upstream file → wrap in `// >>> AIM-FORK … // <<< AIM-FORK`.**
- **Merge, never rebase** the deployed `main`.
- Keep this doc and the wiring table above in sync with reality.
