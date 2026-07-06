---
name: build-prd
description: Interrogate the user (via a /grilling session) and turn the answers into a fleshed-out, factory-ready PRD markdown file for /build-feature to implement. Use whenever the user wants to spec a new feature, "write a PRD" or requirements doc, "prep a spec for build-feature", "grill me for a PRD", wants to plan/pin down/flesh out a feature idea before building it, or asks "what should we decide before building X" — even if they never say the word PRD. Produces the PRD file; it does NOT build the feature (hand off to build-feature for that).
---

# build-prd — grill the user, emit a factory-ready PRD

Turn a fuzzy feature idea into a **precise, testable PRD** that the
`build-feature` factory can decompose cleanly. The single most important
property of the output: **every requirement is concrete and checkable**, so the
factory's Decompose phase can tie each one to a slice + acceptance criterion.

This skill does two things and nothing else:
1. **Interrogate** — run a `/grilling` session with a PRD-targeted agenda until
   every coverage area below is answered (no hand-waving).
2. **Assemble** — write the answers into the PRD template as a markdown file,
   then offer to hand it to `build-feature`.

It does **not** implement the feature. Stop at the PRD.

> **Interview engine.** The interrogation is a `/grilling` session (from the
> mattpocock/skills pack). Note: the `/grill-me` alias sets
> `disable-model-invocation: true`, so this skill CANNOT trigger it
> programmatically — it invokes `/grilling` directly (model-invocable), which is
> exactly what `/grill-me` runs anyway. `/grilling` interviews **one question at
> a time** by design and offers a recommended answer per question; don't try to
> batch it. This skill's own batched `AskUserQuestion` is reserved for the
> final gap-fill/confirmation pass (step 2), not the main interview.
>
> Related sibling skill: mattpocock's `/to-prd` also emits a PRD, but it does
> *no* interview and publishes user-stories to an issue tracker. `build-prd` is
> the `build-feature`-targeted variant: it grills first and writes a local
> markdown *file* with numbered, gate-checkable requirements.

## Why the bar is high

`build-feature` runs `feature-factory`, whose first move is: *read the PRD +
code, produce an ordered set of slices, each with checkable acceptance criteria
tied to a specific PRD requirement, plus tests.* A vague PRD produces vague
slices and untestable criteria. So this skill's job is to eliminate vagueness
**before** a single line is built. Optimize the PRD for that Decompose step, not
for human prose.

## Procedure

### 1. Preflight
- Confirm `/grilling` is available (it is this skill's interrogation engine — the
  same session `/grill-me` runs). If it is not installed, stop and tell the user
  to install the mattpocock/skills pack (`npx skills add mattpocock/skills`);
  this skill delegates the interview by design and will not fake it with a
  shallow Q&A.
- Get the one-line feature idea from the user if they haven't given one.
- Do a **fast codebase scan** for anything the feature touches (existing
  modules, similar screens/endpoints, conventions, data models). Bring concrete
  file paths into the grilling so questions are grounded ("you already have
  `UserRepository` — does this reuse it or need a new store?") rather than
  generic. This grounding is what makes the resulting acceptance criteria
  testable against real code. `/grilling` will also explore the codebase itself
  rather than ask when it can — so a good scan makes it sharper.
- **Load the standing conventions** before grilling: read
  `<repo>/.claude/factory.json` (`conventions`, `reviewDimensions`), the project
  memory's `feedback`/`user` entries, and the product registry's contracts if
  the repo keeps one (`docs/PRODUCT.md`). Do NOT re-ask preferences already
  settled there — echo the ones this feature touches into the PRD's Constraints
  verbatim (that is what makes the factory enforce them), and grill only where
  the feature would *violate* or *extend* one. Uncaptured standing preferences
  are the #1 source of mid-build "actually I always want X" churn (observed: an
  unwritten motion rule and a glyph-color convention each cost multiple rework
  rounds before someone wrote them down).

### 2. Grill — run a /grilling session with a PRD agenda
Invoke `/grilling`. Frame the session with the **PRD Coverage Checklist** below
as its agenda, and instruct it to keep pressing until each area is answered
concretely enough to write a *testable* requirement. `/grilling` asks one
question at a time (with a recommended answer each) — let it; do not batch it.
Feed in the file paths from your scan so it grills against reality.

The checklist IS the completeness gate. Do not exit grilling with any area still
vague. If the session ends and an area is thin, that's an unmet requirement —
go back in, or close the specific gap with a **batched `AskUserQuestion`** (2–4
concrete options per gap; this is the skill's own gap-fill mechanism, distinct
from the one-at-a-time grilling).

#### PRD Coverage Checklist (the agenda for /grilling)
Grill until each has a concrete, testable answer:

**Frame it —**

1. **Problem & goal** — What user/product problem does this solve? What's the
   single sentence of success? (If they can't state it, the feature isn't ready.)
2. **Users & trigger** — Who does this, and what action/state kicks it off?

**Pin the behavior —**

3. **Surface inventory** — Enumerate EVERY screen, state, or mode the feature
   is reachable from; for each, name the affordance (icon, FAB, row, gesture)
   and one line on why it fits the action's frequency and urgency there. If the
   feature has modes (edition, filter, variant), state how each surface selects
   the mode. A missing surface is a whole rework pass after "done", not a
   touch-up (observed: a rules reference specced only for in-game reach later
   needed a main-screen entry — and a mode selector, because outside a game
   nothing pinned the mode).
4. **In-scope requirements** — The concrete behaviors to build. Push every one
   from adjective to assertion: "fast" → "renders in <200ms on the squad list";
   "handles errors" → "shows a retry banner when the sync call 4xxs".
5. **Out-of-scope / non-goals** — Explicit. This bounds the slices and stops
   scope creep in the factory. Validate each exclusion against
   item 3 (Surface inventory) and item 10 (Content completeness) instead of guessing — a non-goal users will immediately hunt for is a
   requirement wearing a disguise (observed: "devices/bombs out of scope" for a
   rules reference; the first mid-game question was "where are the bomb rules?").
6. **Acceptance criteria** — For each requirement, "how do we *observe* it's
   done?" Prefer Given/When/Then. These become the factory's acceptance criteria
   verbatim, so they must be checkable by a build/test/E2E gate.

**Shape the internals —**

7. **Data & state** — New models, persisted state, migrations, data sources.
8. **UX, interaction & motion** — States (empty/loading/error/success), edge
   cases, inputs, validation, copy that matters. Then, for EVERY interactive,
   floating, or collapsible surface: how it opens, closes, dismisses, and
   restores — and how each of those *animates*, citing the standing motion
   conventions loaded in preflight. "Instant" is a valid answer only when
   stated explicitly; an unstated transition ships as a pop and comes back as a
   defect report.
9. **Information architecture, justified** — Applies whenever the feature
   organizes non-trivial content (roughly >10 items, or any parent/child
   structure). State the content's measured shape (item count, per-item size),
   name at least two navigation models considered (e.g. inline accordion vs
   drill-down pages vs flat list with headers), and give a one-line reason for
   the pick tied to that shape. If the shape is unknowable at spec time, record
   an Open Question plus a research/prototype step — never let a default IA
   slide through silently (observed: an asserted tree→article model was
   replaced wholesale by an accordion once someone measured the content — 36
   sections, median half a screen — the costliest rework of that build).
10. **Content completeness** — Applies to content/reference/catalog features.
    Write the coverage rule as its own Rn ("every action visible on a ship's
    action bar has an entry here"), enumerate the item inventory at spec time
    when it is enumerable, and check the non-goals list against it. Users judge
    a reference by what's missing (observed: cloak, SLAM, and payload rules
    each surfaced as a "where is…?" report after "done").

**Fit the system —**

11. **Integration & reuse** — Which existing modules/APIs/components it must reuse
    or must not break. (Names from the codebase scan.) Answers feed the PRD's
    **Reuse contract** section — symbol + file path, grep-verified at assembly.
12. **Constraints** — Platform, performance, offline, accessibility,
    design-system rules. Start from the standing conventions loaded in
    preflight and echo the applicable ones here verbatim — the factory enforces
    what the PRD carries, not what the repo implies.
13. **Test strategy** — How each acceptance criterion gets verified (unit,
    snapshot, E2E). Flag any criterion that no gate can prove — either make it
    testable or move it to non-goals. For multi-platform repos, name the
    acceptance flows to drive **per platform** (these feed the factory's
    device-driving acceptance phase, not just the primary platform's gates).

**Name the residue —**

14. **User control & lifecycle** — For any new always-on behavior, gesture, or
    ambient surface: can the user turn it off? Where does the toggle live, what
    is its default, and what EXACTLY does "off" degrade to (ideally an
    already-tested absent-data path, not a new code path)? Also: discoverability
    (one-time hint?), per-install vs per-user persistence. If the user says "no
    toggle," record that as an explicit non-goal — the point is that the
    question was asked at spec time, not after shipping.
15. **The hand-check list** — Ask directly: "when this ships, what are the
    first three things you will personally check on a real device?" Each answer
    becomes either a gate-checkable acceptance criterion or a **Device feel
    pass** item (below). This converts tacit expectations — the things users
    otherwise catch only after 'done' — into spec.
16. **Risks & open questions** — Unknowns, dependencies, decisions still owed.
    (Always last: the interview closes by naming what remains genuinely
    unresolved, after every resolvable area above has been forced to an answer.)

### 3. Assemble the PRD
Write to `<repo>/docs/prd/<slug>.md` (create the dir if needed; confirm the path
with the user if ambiguous). Use the template below verbatim in structure.
Rules for a factory-clean PRD:
- **Number requirements** `R1, R2, …` and give each its own acceptance
  criteria. One-to-one requirement↔criteria mapping is what lets Decompose slice
  cleanly.
- Every acceptance criterion must be **observable and gate-checkable**. No
  "works well", "is intuitive", "is performant" without a number or observable.
- Keep it **information-dense**: the reader is an agent, not an exec. Cut
  narrative fluff; keep the assertions.
- Reference **real file paths** from the scan under Context so the factory
  starts in the right place.
- Put genuine unknowns in **Open Questions**, don't invent answers. But don't
  leave a *requirement* as an open question — resolve those with the user first.
- **Criteria pin user-visible truths, never artifact internals.** "The baseline
  file contains the string X verbatim" is an artifact criterion — authors will
  contort the product to satisfy the artifact (observed: a spec-mandated
  verbatim phrase crammed into a parenthetical produced copy the user later
  rejected). State the truth the user must see ("a small ship's card shows its
  own threshold, 1"); let the TDD derive test anchors from it. Corollary: any
  test that renders sample output MUST fill it exactly as the live code path
  does — an unfaithful sample means the shipped rendering never appears in any
  reviewable artifact.
- **Golden copy samples.** If the feature renders authored or generated text,
  the PRD includes 3–5 fully-rendered final outputs — worst-case fills (longest
  name, zero/edge counts, the fallback path) — **approved by the user during
  grilling**. Mark every string in the PRD `NORMATIVE` (ship byte-exact) or
  `ILLUSTRATIVE` (voice/shape guide only) so the factory knows which drift is a
  defect. Copy taste is the #1 thing gates cannot judge; approve it at spec
  time, not after shipping.
- **Reuse contract, verified.** From the codebase scan (and the product
  registry, e.g. `docs/PRODUCT.md`, if the repo keeps one): list the exact
  existing symbols the feature must reuse rather than recreate — name, file
  path, and confirm each exists with a grep **at PRD time**. Also list which
  registry contracts the feature touches. This section gets injected into the
  factory's conventions verbatim; symbol-level precision here is what prevents
  agents from rebuilding what already exists.

### 4. Self-check before handing off
Run this rubric; fix anything that fails, then show the user the PRD:
- [ ] Every requirement Rn has ≥1 acceptance criterion.
- [ ] Every acceptance criterion is observable by a build/test/E2E gate.
- [ ] Standing conventions loaded (factory.json + project memory) and the
      applicable ones echoed into Constraints — none re-asked, none violated
      without an explicit callout.
- [ ] Surface inventory lists every surface the feature is reachable from, each
      affordance justified; any mode has a selection story per surface.
- [ ] If the feature organizes content: IA justified against measured shape
      with ≥2 models considered, or an explicit Open Question + research step.
- [ ] If content/reference: a coverage Rn exists and non-goals were checked
      against it.
- [ ] Every interactive/floating/collapsible surface has open/close/dismiss/
      restore motion specified (or an explicit "instant").
- [ ] Every criterion states a user-visible truth, not an artifact internal
      (no "file/baseline contains string X" — say what the user sees instead).
- [ ] Non-goals section is non-empty.
- [ ] User control & lifecycle answered (toggle + degrade path, or explicit "no").
- [ ] Rendered-text features have user-approved golden samples, each marked
      NORMATIVE or ILLUSTRATIVE, including worst-case fills.
- [ ] Reuse-contract symbols each verified to exist (grep, not memory).
- [ ] Device feel pass populated from the user's hand-check answers.
- [ ] No requirement contains an unresolved open question.
- [ ] Context names real modules/files the feature touches.
- [ ] A stranger agent could build this without asking you a question.

### 5. Hand off
Offer: "Ready to build? Run `/build-feature docs/prd/<slug>.md`." Do not launch
the factory yourself unless the user says go — building is a separate, explicit,
token-heavy opt-in owned by `build-feature`.

## PRD Template

```markdown
# PRD: <Feature name>

**One-line goal:** <the single sentence of success>
**Status:** Draft · **Author:** <user> · **Date:** <YYYY-MM-DD>

## Problem
<Who has what problem, why it matters. 2–4 sentences.>

## Goal & success signal
<What "done and working" looks like, observably.>

## Users & trigger
<Who does this and what starts it.>

## Surface inventory
| Surface | Affordance | Why it fits here | Mode selection (if any) |
|---|---|---|---|
| <screen/state> | <icon/FAB/row/gesture> | <frequency/urgency fit> | <how this surface picks the mode, or —> |

## Context (existing code this touches)
- `<path>` — <role / why relevant>
- <conventions or patterns to follow>

## Requirements
### R1 — <short title>
<Concrete behavior, stated as an assertion.>
**Acceptance:**
- Given <state>, when <action>, then <observable result>.
- <edge case / error state criterion>

### R2 — <short title>
...

## Non-goals (out of scope)
- <explicitly excluded behavior>

## User control & lifecycle
<Toggle: where it lives, default, and the exact degrade path when off (prefer an
already-tested absent-data path). Discoverability. Or: "deliberately no toggle" + why.>

## Golden samples (user-approved)
<3–5 fully-rendered final outputs incl. worst-case fills. Each marked NORMATIVE
or ILLUSTRATIVE. Approved by the user during grilling — copy drift from a
NORMATIVE sample is a defect.>

## Reuse contract (verified at PRD time)
- `<Symbol>` — `<file path>` — <what it provides; reuse, never recreate>
- Registry contracts touched: <from docs/PRODUCT.md or equivalent, if kept>

## Data & state
<New models, persistence, migrations, sources. "None" if none.>

## UX, interaction & motion
<States: empty/loading/error/success. Validation. Copy that matters. Then per
interactive/floating/collapsible surface: open/close/dismiss/restore and how
each animates (cite the standing motion conventions); "instant" only if stated.>

## Information architecture (only if the feature organizes content)
<Measured content shape (item count, per-item size) · ≥2 nav models considered ·
the pick + one-line why tied to the shape. Unknown shape ⇒ Open Question + a
research/prototype step, never a silent default.>

## Constraints
<Platform, perf targets, offline, a11y, design-system rules, conventions.>

## Test strategy
<How each Rn's acceptance is verified: unit / snapshot / E2E. Note any gate gaps.
Per-platform acceptance flows for the factory's device-driving phase.>

## Device feel pass (post-gate human checklist)
<The subjective checks only a human on real hardware can judge — gesture timing,
haptic strength, optical alignment, edge clamping, animation feel. Green gates do
NOT close these; the factory report should surface them as the remaining human
step. Sourced from the "hand-check list" grilling answers.>

## Risks & open questions
- <unknown or decision still owed — NOT requirements>
```

## Notes
- This skill and `build-feature` are companions: build-prd produces the input,
  build-feature consumes it. Keep the PRD's acceptance criteria in the exact
  shape the factory rewards (checkable, gate-verifiable) — that's the whole game.
- **Expectation-setting: a PRD cannot drive user involvement to zero.** Churn
  comes in two regimes. *Foreseeable-structural* — missing surfaces, unjustified
  IA, content gaps, unloaded conventions — is what this checklist front-loads
  into one decision pass at spec time. *Device-feel* — animation feel, gesture
  semantics like "don't auto-reopen on scroll-up" — is only discoverable by
  using the build; that loop is BOUNDED by the Device feel pass, not eliminated
  by prose. Judge a PRD by how much of the first regime it converts; the second
  showing up in the factory report as the remaining human step is the system
  working, not the spec failing.
- For a tiny change that doesn't need a formal PRD, skip this and just describe
  the change to `build-feature` inline or implement it directly.
