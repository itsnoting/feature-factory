---
name: build-feature
description: Build a feature from a fleshed-out PRD via a gated multi-agent factory loop. Use when the user hands over a PRD/spec markdown file and wants it implemented end-to-end with the project's real quality gates (build, tests, snapshots, E2E) enforced until green. Stack-agnostic — it auto-detects the codebase type and picks the matching gate profile. Triggers on "build this PRD", "run the factory", "build-feature <path>", "implement this spec".
---

# build-feature — PRD → gated feature factory (stack-agnostic)

Turns a fleshed-out PRD into a working, gate-verified feature by resolving the
project's build profile and running the `feature-factory` Workflow.

- **Engine (generic):** `<PLUGIN_ROOT>/workflows/feature-factory.js`
- **Resolver (deterministic):** `<PLUGIN_ROOT>/factory-profiles/resolve.py`
- **Profiles (data):** `<PLUGIN_ROOT>/factory-profiles/<stack>.json`; user
  overrides in `~/.claude/factory-profiles/<stack>.json` (user dir wins)
- **Repo overlay (optional):** `<repo>/.claude/factory.json`

**Resolving `<PLUGIN_ROOT>`:** these files travel with the plugin, so pin the
root once, up front. Use the `CLAUDE_PLUGIN_ROOT` env var when set; otherwise
this skill's own base directory (announced when the skill loads, e.g.
`…/skills/build-feature`) sits two levels below the plugin root:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "<this skill's base dir>/../.." && pwd)}"
```

(Legacy loose install: if neither location has `workflows/feature-factory.js`,
fall back to `~/.claude/workflows/feature-factory.js` and
`~/.claude/factory-profiles/`.)

## The loop
decompose PRD → critique the plan (before coding) → implement slice-by-slice
(each self-fixing until the fast gate is green) → run the full gates →
adversarial review, every finding verified by a skeptic → fix → repeat until
**all gates green AND every acceptance criterion met**, up to `maxRounds`.

## Steps

1. **Confirm the PRD path.** If the user didn't name one, ask which markdown file
   is the spec. The factory reads it directly — no need to paste contents.

1b. **Inventory the whole spec directory — the PRD is rarely the only artifact.**
   `build-prd` emits a *bundle* (`docs/prd/<slug>/` holding `prd.md`, `tdd.md`,
   `assets/`), and specs accumulate companions over time: design mockups,
   research exports, golden fixtures, diagrams, API samples. **The engine reads
   ONLY the file you name.** Everything else is invisible unless you surface it.

   List the PRD's directory recursively, then build a **companion-artifact
   manifest** and inject it into `conventions` (see step 4). For each artifact
   give the path, one line on what it contains, and — critically — **when an
   implementer must open it**:

   ```
   COMPANION ARTIFACTS — open these, do not work from the PRD prose alone.
   - ./tdd.md — the technical design. Read before the first slice.
   - ./assets/mockups/NN-host.png — host flow layout, hierarchy and copy.
     Open before building any host surface.
   - ../../research/foo.md — prior art; read before choosing an approach.
   ```

   Two rules that make the difference between this working and not:
   - **Name the trigger, not just the file.** "Mockups exist" gets ignored;
     "open `NN-guest.png` before building the guest surface" does not.
   - **Follow references OUT of the bundle.** A PRD that points at
     `docs/<feature>/assets/` (canonical, shared, deliberately not duplicated
     into the bundle) still needs those paths in the manifest. Resolve every
     relative link in the PRD and include the targets.

   Say which artifact types you found so the user can spot a missing one before
   hours of building start. Prose-only builds of a surface that HAS a mockup are
   the single most common source of "that's not what I meant" rework.

2. **Resolve the build profile.** Run:
   ```
   python3 "$PLUGIN_ROOT/factory-profiles/resolve.py"
   ```
   from the repo root. It sniffs marker files, loads the matching profile
   (user `~/.claude/factory-profiles/` beats the bundled set), and merges any
   repo-local `.claude/factory.json` overlay. Capture the JSON.
   - If it returns an `error` — unknown stack, or a detected stack with no
     profile file yet — do NOT stop, and do NOT quietly hand-assemble args for
     just this run: run **First-run profile setup** (below). It builds the
     missing profile WITH the user and persists it, so this cost is paid once
     per stack, not once per repo. Then re-run the resolver and continue.

3. **Preflight.** Read the resolved `gates`, `procedures`, and `acceptance`:
   - If an `e2e` gate exists, it usually needs an emulator/simulator — run
     `adb devices` (or equivalent) and warn that E2E will be skipped-with-flag
     if none is attached.
   - If an `acceptance` block exists, the factory drives the running app via
     **mobile-mcp**. It needs: the mobile-mcp server connected (project `.mcp.json`
     → requires a Claude Code restart to activate), Node 22+, and a booted
     emulator/simulator per configured platform. If mobile-mcp isn't connected or
     no device is up, the Acceptance phase degrades to `blocked` (not a failure) —
     tell the user so they know acceptance wasn't actually verified.
   - Confirm you're on a feature branch, not the main branch; if not, create one:
     `git switch -c feat/<slug>`.

4. **Launch the factory.** Call the Workflow tool with the resolved config as args:
   ```
   Workflow({
     scriptPath: '<PLUGIN_ROOT>/workflows/feature-factory.js',  // absolute, resolved above
     args: { prd: '<path>', maxRounds: 3, ...resolvedProfileJSON }
   })
   ```
   (Spread the resolver's JSON into args so `gates`, `conventions`,
   `reviewDimensions`, `gateNotes`, `procedures` flow through. Drop the
   `_resolved` key or leave it — the engine ignores it.)

   **Append step 1b's companion-artifact manifest to `conventions`.** That
   string is the only channel injected into every implementer, reviewer and
   fixer prompt, so it is the only place an instruction reliably reaches the
   agent writing the code. A manifest that lives solely in the PRD body gets
   read once by the decomposer and forgotten by everyone downstream.

   If any artifact is NORMATIVE — an animation spec with exact durations, an
   approved copy deck, a golden fixture — say so explicitly and say what
   deviation means. "NORMATIVE: do not invent timings; drift from this is a
   defect" binds. "See the animation spec" does not.
   It runs in the background and notifies on completion. Watch with `/workflows`.
   This spawns many agents and is token-heavy — this skill IS the explicit opt-in.

5. **Report honestly.** When it returns, relay `green`, per-slice status, final
   gate results, and any `openFindings` or skipped gates. Do NOT claim success if
   `green` is false — surface what's still red.

6. **Human-in-the-loop close-out.** Follow the resolved `procedures`:
   - Eyeball any newly recorded snapshot baselines.
   - Run any gate the factory can't (e.g. iOS via xcodebuild) before release.
   - Once the feature has actually shipped, run `/finish-feature` — it verifies
     the implementation landed, marks the TDD as-built, archives the PRD/TDD out
     of the active queue, and records the feature in the product-spec registry.

## First-run profile setup (missing or unknown profile)

The factory is only as good as its gates, and gates differ per stack — so when
no profile exists, build one in a short interview instead of guessing or
bailing. The user is the authority on what "checked" means in their project;
your job is to arrive with good candidates so each question is a confirmation,
not a research assignment.

1. **Scout before asking.** Read the repo's own definition of "verified": CI
   workflows (`.github/workflows/*.yml` usually contain the real gate commands),
   `package.json` scripts, Makefile/justfile targets, gradle tasks,
   `pyproject.toml`/tox/nox, `Cargo.toml`, pre-commit hooks. Draft a candidate
   command for each gate from what you find, and note where each came from.

2. **Interview with batched AskUserQuestion** (recommended, scouted option
   first):
   - **fast** (required): the build + unit-test command that must stay green
     after every slice. Offer the CI-derived candidate(s).
   - **snapshot / e2e** (optional): heavier proof commands if the stack has
     them (visual regression, integration, device/browser tests) — and what
     makes a legitimate `skipped` (no device attached, no server running).
   - **workdir**: only ask if build files aren't at the repo root.
   - **conventions**: propose 3–5 sentences drafted from the codebase scan
     (module layout, DI/state patterns, test-id conventions); let the user
     amend rather than compose from scratch.
   - **review dimensions**: offer the engine defaults (correctness,
     conventions, test-coverage) plus one optional domain lens for this repo.

3. **Persist with the layering rule.** Stack-shaped answers go in a NEW profile
   `~/.claude/factory-profiles/<id>.json` — the user-extension dir the resolver
   checks first; never write into the plugin's bundled dir, where an update
   would clobber it. Copy the shape of the bundled `kmp-android-ios.json`;
   nothing in a profile may be true only of this repo or this machine.
   Repo-specific answers (the domain lens, project conventions, machine quirks)
   go in the repo overlay `<repo>/.claude/factory.json`. When in doubt,
   overlay — an over-specific profile silently misconfigures the NEXT repo of
   the same stack, and nobody notices until its gates lie.

4. **Unknown stack?** If detection itself failed (the resolver returned no id),
   name the stack with the user, add a marker-file rule for it to
   `detect_profile()` in `$PLUGIN_ROOT/factory-profiles/resolve.py` plus a case
   in `test_resolve.py`, and run those tests. If the plugin root is a git
   checkout, offer to commit the new rule so it survives plugin updates.
   Detection stays deterministic — file-existence markers only, never model
   judgment.

5. **Prove the config before spending tokens on it.** Re-run `resolve.py` and
   confirm it now returns the merged config cleanly. Then run the `fast` gate
   once, exactly as configured: every slice self-fixes against that command, so
   a wrong or broken gate poisons the whole run. Green — or failures the user
   recognizes as pre-existing — is the launch condition. Then continue from
   step 3 (Preflight).

## Tuning
- `maxRounds` (default 3) caps the gate→review→fix loop.
- Change gates/dimensions for a whole stack by editing its profile JSON
  (bundled in `$PLUGIN_ROOT/factory-profiles/`, or your override in
  `~/.claude/factory-profiles/`).
- Change them for one repo via `<repo>/.claude/factory.json` (overlay — see
  `$PLUGIN_ROOT/factory-profiles/README.md`).
- For a small change that doesn't warrant the fan-out, skip the factory and just
  implement inline with `/code-review` + the profile's gate commands.
