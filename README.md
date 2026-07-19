# Feature Factory

A gated, multi-agent feature pipeline for [Claude Code](https://claude.com/claude-code):
spec a feature by interrogation, build it in a self-verifying agent loop against the
repo's real quality gates, then archive the spec as as-built truth and fold what was
learned back into the pipeline.

```
/build-prd  ──►  docs/prd/<slug>/             (grill → factory-ready PRD bundle:
                                               prd.md + tdd.md + assets/)
/build-feature ─►  feature-factory.js         (decompose → critique → implement:
                                               serial chain + parallel worktree
                                               slices → merge → gates → audit →
                                               acceptance → adversarial review
                                               → fix … until green)
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
| `workflows/feature-factory.js` | `~/.claude/workflows/` | The engine: plan → critique (degenerate-plan guard) → implement (dependent slices serialized in the main tree; file-disjoint slices concurrent in isolated git worktrees, merged back fast-gated) → gate/audit/acceptance/review/verify/fix loop. The audit judges against the gate output it is handed; minor review findings ride the result instead of being silently dropped. Supports `cfg.model` (verification-loop model override, resume-cache-safe), mobile-mcp per-platform acceptance, gate-agent retry. |
| `factory-profiles/resolve.py` | `~/.claude/factory-profiles/` | Deterministic profile resolver: sniffs the repo's stack from marker files (Flutter / React Native lookalikes ruled out before the KMP rule — they carry both native trees), merges the matching profile with the repo overlay `<repo>/.claude/factory.json`. Tested: `test_resolve.py`. |
| `factory-profiles/kmp-android-ios.json` | `~/.claude/factory-profiles/` | Stack profile: Kotlin Multiplatform Android+iOS (gradle gates, Roborazzi snapshot **verify**, connected E2E). A clean stack template — nothing repo- or machine-specific belongs in a profile; that content goes in the repo overlay. |
| `skills/build-prd/SKILL.md` | `~/.claude/skills/build-prd/` | Interrogation → PRD bundle. 16-area coverage checklist (surface inventory, justified IA, content completeness, interaction & motion, golden copy samples, reuse contract, device-feel pass), standing-conventions preflight. |
| `skills/build-feature/SKILL.md` | `~/.claude/skills/build-feature/` | Resolves the profile — or, on a stack with none, runs the **first-run profile setup** interview (see below) — surfaces the spec bundle's companion artifacts to every downstream agent, launches the factory Workflow, reports honestly (never claims success on a red run). |
| `skills/finish-feature/SKILL.md` | `~/.claude/skills/finish-feature/` | Verifies shipped-at-HEAD, as-built TDD pass (deviations + **plan alterations** — the mid-build pivots that otherwise vanish), archive move, product-registry entry, optional convention hardening. Ships runnable evals (`evals/` + `fixtures.tar.gz`). |

## Install

This repo is a Claude Code **plugin marketplace** — install with two commands
inside Claude Code:

```
/plugin marketplace add itsnoting/feature-factory
/plugin install feature-factory@itsnoting-plugins
```

Skills arrive namespaced: `/feature-factory:build-prd`,
`/feature-factory:build-feature`, `/feature-factory:finish-feature`. Profiles
resolve from the plugin's bundled `factory-profiles/`, with
`~/.claude/factory-profiles/` as a user-override dir that wins on conflict.

<details>
<summary>Manual (loose) install — no plugin system</summary>

```bash
git clone https://github.com/itsnoting/feature-factory.git
cd feature-factory
mkdir -p ~/.claude/workflows ~/.claude/factory-profiles ~/.claude/skills
cp workflows/feature-factory.js        ~/.claude/workflows/
cp factory-profiles/*                  ~/.claude/factory-profiles/
cp -R skills/build-prd skills/build-feature skills/finish-feature ~/.claude/skills/
```

Do NOT combine both installs — duplicate skills will collide.
</details>

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

## First run on a new stack

No profile for your stack? `/build-feature` notices and builds one **with you**
instead of guessing or bailing:

1. Scouts the repo's own definition of "checked" — CI workflows, `package.json`
   scripts, Makefile targets — so every question arrives with a recommended
   answer.
2. Confirms the gate commands (fast / snapshot / e2e), conventions, and review
   dimensions in a short batched interview.
3. Persists the result with the layering rule: stack-shaped answers become a new
   global profile, repo-specific answers go in the overlay.
4. For a stack the resolver can't even detect, adds a deterministic marker-file
   rule (plus a test) so the next repo of that stack auto-resolves.
5. Runs the fast gate once before launching — every slice self-fixes against
   that command, so a wrong gate would poison the whole run.

One-time cost per stack; every later repo of the same stack resolves automatically.

## How generic is this, honestly?

- The **engine and skills are stack-agnostic**: everything project-shaped
  arrives via profile + overlay args. `finish-feature` is fully
  project-agnostic (auto-detects spec dirs, adapts to existing layouts).
- **One stack profile ships today** (KMP Android+iOS). Others are created on
  first run by the setup interview above.
- The **Acceptance phase is mobile-only today** (mobile-mcp + emulator or
  simulator). Omit the `acceptance` block for web/CLI stacks and the phase
  skips cleanly; the coded gates still run.

## Hard-won invariants baked into the engine

- **Degenerate-plan guard** — the plan-hardening agent occasionally emits a stub
  plan; the engine detects and falls back to the decompose plan.
- **Never touch what you didn't create** — audit/fix agents are forbidden from
  reverting or deleting pre-existing user work (`git checkout`/`rm` on files the
  factory didn't author caused real data loss once; never again).
- **Audit closes the "false done" hole** — a green gate does not prove the
  planned tests actually executed (NO-SOURCE) or that the change stayed in
  scope; the audit phase does, with the round's gate output in hand.
- **No silent drops** — minor review findings skip per-finding verification but
  are carried into the final result for the human close-out.
- **Gate-agent retry** — a gate agent that backgrounds a long command and yields
  its turn dies silently; the engine retries once with a foreground-only
  instruction, cache-safely.
- **Resume cache** — `resumeFromRunId` replays completed agents byte-identically;
  prompts/opts are the cache key, so config additions are designed to keep
  planning/impl opts stable.

## License

[MIT](LICENSE)
