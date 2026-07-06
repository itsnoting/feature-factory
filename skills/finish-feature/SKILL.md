---
name: finish-feature
description: Close out a shipped feature — verify it actually landed, mark its TDD as-built (recording deviations from the spec), archive the PRD+TDD into docs/prd/archive/, and record the feature in the docs/PRODUCT.md product-spec registry. Use after a /build-feature run goes green, and whenever the user says "finish the feature", "close out <feature>", "archive the PRD/TDD", "mark <feature> shipped", "update the product spec/registry", or asks to tidy specs for work that has already shipped. Also use when the user wants a shipped-but-undocumented feature added to the product registry.
---

# finish-feature — archive shipped specs, harden the product spec

The bookend to `/build-feature`: the factory turns a PRD into shipped code; this
skill turns the shipped code back into durable documentation. It is
project-agnostic and needs no factory — any repo that keeps spec docs for work
that has since shipped can use it as-is. Three outcomes:

1. The PRD/TDD stop cluttering the **active queue** (`docs/prd/` should contain
   only specs still awaiting implementation).
2. The TDD becomes **as-built truth** — status flipped, shipping commits,
   spec deviations, and mid-build plan alterations recorded — so it stays
   trustworthy years later.
3. The feature's **durable contracts** land in the product registry
   (`docs/PRODUCT.md`), hardening the spec of the whole product one feature at
   a time.

## Conventions & config

Zero config needed in the common case. Defaults, in resolution order:

1. A `"finish"` block in `<repo>/.claude/factory.json` (the same optional
   overlay `/build-feature` uses), if present:
   ```json
   "finish": {
     "prdDir": "docs/prd",
     "archiveDir": "docs/prd/archive",
     "registry": "docs/PRODUCT.md"
   }
   ```
2. Auto-detection: an existing specs directory (`docs/prd/`, `docs/specs/`,
   `specs/`, `docs/rfcs/` — whichever exists and contains the feature), with
   `<that dir>/archive/` and `docs/PRODUCT.md` as companions.
3. Neither? Ask the user where specs live rather than guessing.

Directory shape: each feature is a directory `<prdDir>/<slug>/` containing the
PRD (`<slug>.md` or `.html`) and `TDD.md`. A loose `<prdDir>/<slug>.md` file is
fine too — it gains its directory on the way into the archive. Adapt to what
the repo actually has (a spec without a TDD, different filenames): the steps
below care about the roles (spec of record, design doc, registry), not the
exact names.

## Steps

### 1. Identify the feature and VERIFY it shipped

Resolve the feature directory from the argument (slug or path); if none given,
list the non-archived feature dirs and ask which one is done.

Then verify against HEAD before touching anything — archiving is how a spec
leaves the active queue, so archiving something unshipped silently loses work.
(Factory runs can also mislabel: a green report is a claim, not evidence.)
Require positive evidence:

- The implementation exists **at HEAD**: pick 3–5 load-bearing artifacts named
  by the TDD (new files, public symbols, test tags, asset paths) and confirm
  each with grep/ls.
- The shipping commits exist: `git log --oneline --reverse -- <feature paths>`
  (paths from the TDD's architecture table). Capture the range — it feeds the
  as-built pass and the registry entry.
- If evidence is partial (spec half-built, or only on a branch), STOP and
  report what's missing instead of archiving. Partial work stays in the queue.

### 2. As-built pass on the TDD

A DRAFT TDD describes intent; the archive should hold truth. Update `TDD.md`:

- Header: `**Status: AS-BUILT**` + today's date + the shipping commit range
  (`abc1234..def5678`, and the release version if the repo tags releases).
- Spot-verify the TDD's central claims at HEAD — key names, signatures,
  constants, test tags, file paths. Anything that no longer holds goes into an
  **"As-built deviations"** section: what the spec said, what shipped, and why
  if the commits reveal it (a merged button, a dropped tag, a vestigial enum).
  Deviations are recorded, never silently rewritten — the delta between plan
  and reality is the valuable part.
- Reconstruct a separate **"Plan alterations"** section — the ways the PRD/TDD
  *themselves* were edited after the spec was first frozen: mid-build pivots
  agreed in session ("move the entry point to a FAB"), review-driven
  corrections, content fixes, contract renames synced from a companion spec.
  Mine them from the spec docs' own history (`git log --follow -p -- <feature
  dir>`, plus any still-uncommitted edits vs HEAD; "as built (revised)"
  markers in the docs are a strong hint). Record each substantive change as
  *what the plan originally said → what it became → what prompted it*. This is
  NOT the deviations list: a deviation is code disagreeing with the doc, while
  an alteration is the doc having been rewritten mid-flight — by close-out the
  doc and code agree again, so without this section ad-hoc changes vanish from
  the record entirely.
- Append a one-paragraph **evolution timeline** from the commit log (initial
  land → fixes → extensions), so future readers see how the design settled.
- **No TDD exists** (pre-convention feature)? Write one as-built from the code
  before archiving — architecture table, key mechanisms, test map, PRD
  deviations. Keep it dense; an existing archived TDD in the repo is the shape
  to match.

### 3. Archive the directory

- `git mv <prdDir>/<slug> <archiveDir>/<slug>` (create `archiveDir` first if
  needed; `git mv` so history follows). A loose PRD file moves into
  `<archiveDir>/<slug>/<slug>.md`.
- Maintain `<archiveDir>/README.md`: a one-line purpose header ("shipped specs;
  active specs live one level up") and a table row per feature —
  `| [<slug>](./<slug>/<PRD file>) | <shipping commits / version> |`.
- Fix any now-broken relative links inside the moved files (PRD↔TDD links are
  usually relative-safe; links out to source files may need one more `../`).

### 4. Registry entry in `docs/PRODUCT.md`

The registry is the product's accumulated spec — compact enough to read whole,
hard enough to build against. The deep spec stays in the archive; the registry
holds what must stay true. Create the file on first use:

```markdown
# <Product> — Product Spec Registry

What the product does, feature by feature, as actually shipped. Each entry is
the durable summary: the capability, its deliberate boundaries, and the
contracts future work must not break. Deep specs live in [prd/archive/](prd/archive/).
Maintained by /finish-feature — append an entry when a feature ships.

## Feature index
| Feature | Area | Since | Spec |
|---|---|---|---|
```

Then append the entry (and its index row, keeping the table sorted by area):

```markdown
## <Feature name>
**Area:** <a product area of THIS repo, e.g. Editor / Sync / Billing> · **Since:** <version> (`<commit range>`)

**What it does:** 2–4 sentences of user-facing behavior — what a player can now
do that they couldn't before.

**Boundaries:** the non-goals that still hold (deliberate exclusions from the
PRD that remain product decisions, e.g. "never mutates game state").

**Contracts:** the things future work must not break — test IDs/tags, data
invariants, module boundaries, persisted formats, URL schemes, platform
behaviors. Write them as checkable statements citing real symbols
("`export()` emits schema v2, pinned by `ExportRoundTripTest`"), not vibes.

**Spec:** [PRD](prd/archive/<slug>/<slug>.md) · [TDD](prd/archive/<slug>/TDD.md)
```

If an entry for the feature already exists (e.g. a backfilled stub), update it
in place rather than appending a duplicate.

### 5. Harden the loop (optional, suggest — don't just do)

Contracts worth enforcing on every future change belong where the repo's
builders will actually see them, not just in the registry. If this feature
produced durable invariants (the kind a reviewer should always check), propose
a diff — to `.claude/factory.json` (`reviewDimensions` / `conventions`) when
the repo uses the `/build-feature` factory, otherwise to `CLAUDE.md`,
`CONTRIBUTING.md`, or wherever this repo keeps its working conventions — and
apply it only if the user agrees. This is how the registry hardens future
builds, not just the docs.

### 6. Commit and report

- One commit containing only these doc changes (archive move + README +
  registry + TDD edits), in the repo's own commit style — e.g.
  `docs(prd): archive <slug> — shipped in <range>` where conventional commits
  are the norm. Don't sweep in unrelated working-tree changes. Push only if
  the user asks or the repo's workflow clearly expects it — say which you did.
- Report: what moved, the TDD deviations found, the plan alterations recorded,
  the registry entry (quoted or linked), any claims you could NOT verify, and
  any proposed factory-overlay hardening awaiting a yes.

## Edge cases

- **Feature was never specced** (shipped without PRD): still registrable — add
  the registry entry with `**Spec:** none (pre-spec feature)` and skip the
  archive steps, or offer to write a retroactive as-built TDD first.
- **Multiple features done at once:** run the steps per feature but batch into
  one commit; the report lists each.
- **Registry drift:** if while verifying you notice the registry contradicts
  HEAD (a contract that no longer holds), flag it in the report — the registry
  is only useful while it's true.
