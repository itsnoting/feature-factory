# Feature Factory

A gated, multi-agent feature pipeline for [Claude Code](https://claude.com/claude-code):
spec a feature by interrogation, build it in a self-verifying agent loop against the
repo's real quality gates, then archive the spec as as-built truth and fold what was
learned back into the pipeline.

```
/build-prd  ──►  docs/prd/<slug>.md          (grill → factory-ready PRD)
/build-feature ─►  feature-factory.js         (decompose → critique → implement
                                               slice-by-slice → gates → adversarial
                                               review → fix … until green)
/finish-feature ─► docs/prd/archive/ + docs/PRODUCT.md
                                              (as-built TDD incl. plan alterations,
                                               registry contracts, convention hardening)
```

The loop compounds: conventions settled mid-build get committed to the repo's
`.claude/factory.json` and project memory by `/finish-feature`; `/build-prd`'s
preflight loads them back, so every feature makes the next PRD sharper.

## Layout (mirrors install paths under `~/.claude/`)

| Repo path | Installs to | Role |
|---|---|---|
| `workflows/feature-factory.js` | `~/.claude/workflows/` | The engine: plan → critique (degenerate-plan guard) → serial slices (fast-gated) → gate/audit/acceptance/review/verify/fix loop. Supports `cfg.model` (verification-loop model override, resume-cache-safe), mobile-mcp per-platform acceptance, gate-agent retry. |
| `factory-profiles/resolve.py` | `~/.claude/factory-profiles/` | Deterministic profile resolver: sniffs the repo's stack, merges the matching profile with the repo overlay `<repo>/.claude/factory.json`. |
| `factory-profiles/kmp-android-ios.json` | `~/.claude/factory-profiles/` | Profile: Kotlin Multiplatform Android+iOS (gradle gates from `android/`, Roborazzi snapshots, connected E2E). Copy as a template for new stacks. |
| `skills/build-prd/SKILL.md` | `~/.claude/skills/build-prd/` | Interrogation → PRD. 16-area coverage checklist (surface inventory, justified IA, content completeness, interaction & motion, golden copy samples, reuse contract, device-feel pass), standing-conventions preflight. |
| `skills/build-feature/SKILL.md` | `~/.claude/skills/build-feature/` | Resolves the profile, preflights devices/emulators, launches the factory Workflow, reports honestly (never claims success on a red run). |
| `skills/finish-feature/SKILL.md` | `~/.claude/skills/finish-feature/` | Verifies shipped-at-HEAD, as-built TDD pass (deviations + **plan alterations** — the mid-build pivots that otherwise vanish), archive move, product-registry entry, optional convention hardening. |

## Install

```bash
git clone git@github.com:itsnoting/feature-factory.git
cd feature-factory
mkdir -p ~/.claude/workflows ~/.claude/factory-profiles ~/.claude/skills
cp workflows/feature-factory.js        ~/.claude/workflows/
cp factory-profiles/*                  ~/.claude/factory-profiles/
cp -R skills/build-prd skills/build-feature skills/finish-feature ~/.claude/skills/
```

Requirements:
- Claude Code with the Workflow tool (the factory is a background multi-agent
  workflow — token-heavy by design; `/build-feature` is the explicit opt-in).
- `/grilling` from the mattpocock/skills pack (`npx skills add mattpocock/skills`)
  — `build-prd`'s interview engine.
- Optional but recommended: **mobile-mcp** connected + a booted emulator/simulator
  per platform, for the factory's device-driving acceptance phase (degrades to
  `blocked`, never deadlocks, when absent).

Per-repo setup: add a `<repo>/.claude/factory.json` overlay for repo-specific
conventions, review dimensions, and per-platform `acceptance` install commands —
see `factory-profiles/README.md`.

## Hard-won invariants baked into the engine

- **Degenerate-plan guard** — the plan-hardening agent occasionally emits a stub
  plan; the engine detects and falls back to the decompose plan.
- **Never touch what you didn't create** — audit/fix agents are forbidden from
  reverting or deleting pre-existing user work (`git checkout`/`rm` on files the
  factory didn't author caused real data loss once; never again).
- **Gate-agent retry** — a gate agent that backgrounds a long command and yields
  its turn dies silently; the engine retries once with a foreground-only
  instruction, cache-safely.
- **Resume cache** — `resumeFromRunId` replays completed agents byte-identically;
  prompts/opts are the cache key, so config additions are designed to keep
  planning/impl opts stable.
