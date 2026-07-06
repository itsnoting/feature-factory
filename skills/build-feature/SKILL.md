---
name: build-feature
description: Build a feature from a fleshed-out PRD via a gated multi-agent factory loop. Use when the user hands over a PRD/spec markdown file and wants it implemented end-to-end with the project's real quality gates (build, tests, snapshots, E2E) enforced until green. Stack-agnostic — it auto-detects the codebase type and picks the matching gate profile. Triggers on "build this PRD", "run the factory", "build-feature <path>", "implement this spec".
---

# build-feature — PRD → gated feature factory (stack-agnostic)

Turns a fleshed-out PRD into a working, gate-verified feature by resolving the
project's build profile and running the `feature-factory` Workflow.

- **Engine (generic):** `~/.claude/workflows/feature-factory.js`
- **Resolver (deterministic):** `~/.claude/factory-profiles/resolve.py`
- **Profiles (data):** `~/.claude/factory-profiles/<stack>.json`
- **Repo overlay (optional):** `<repo>/.claude/factory.json`

## The loop
decompose PRD → critique the plan (before coding) → implement slice-by-slice
(each self-fixing until the fast gate is green) → run the full gates →
adversarial review, every finding verified by a skeptic → fix → repeat until
**all gates green AND every acceptance criterion met**, up to `maxRounds`.

## Steps

1. **Confirm the PRD path.** If the user didn't name one, ask which markdown file
   is the spec. The factory reads it directly — no need to paste contents.

2. **Resolve the build profile.** Run:
   ```
   python3 ~/.claude/factory-profiles/resolve.py
   ```
   from the repo root. It sniffs marker files, loads the matching global profile,
   and merges any repo-local `.claude/factory.json` overlay. Capture the JSON.
   - If it returns an `error` (unknown stack / missing profile), tell the user
     what's missing. Either add a profile (copy `kmp-android-ios.json` as a
     template) or gather the gate commands from the user and pass them via `args`.

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
     scriptPath: '~/.claude/workflows/feature-factory.js',
     args: { prd: '<path>', maxRounds: 3, ...resolvedProfileJSON }
   })
   ```
   (Spread the resolver's JSON into args so `gates`, `conventions`,
   `reviewDimensions`, `gateNotes`, `procedures` flow through. Drop the
   `_resolved` key or leave it — the engine ignores it.)
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

## Tuning
- `maxRounds` (default 3) caps the gate→review→fix loop.
- Change gates/dimensions for a whole stack by editing its profile JSON.
- Change them for one repo via `<repo>/.claude/factory.json` (overlay — see
  `~/.claude/factory-profiles/README.md`).
- For a small change that doesn't warrant the fan-out, skip the factory and just
  implement inline with `/code-review` + the profile's gate commands.
