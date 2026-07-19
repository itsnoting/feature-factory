# factory-profiles

Build/gate configuration for the `build-feature` skill and the `feature-factory`
workflow. Profiles are **data**; selection is **deterministic** (marker-file
sniffing in `resolve.py`); stack-specific *procedures* live in skills, not here.

## How resolution works
```
build-feature skill  →  resolve.py  →  merged config JSON  →  feature-factory workflow (args)
```
`resolve.py`:
1. Detects the codebase type from marker files in the repo root (`detect_profile()`).
2. Loads the matching `<id>.json` from this directory.
3. Merges an optional repo overlay at `<repo>/.claude/factory.json` on top.
4. Prints the merged config.

## Profile file (`<id>.json`)
| key | meaning |
|---|---|
| `id`, `displayName`, `detect` | identity + human-readable detect rule |
| `gates.fast` | **required** — build + unit command, run after every slice |
| `gates.snapshot`, `gates.e2e` | optional heavier gates, run in the Gate phase |
| `gateNotes.<gate>` | guidance injected into the Gate-phase prompt (record baselines, need emulator, etc.) |
| `gatesComment` | doc-only context about the gates (the engine ignores it; humans and setup agents read it) |
| `conventions` | prose injected into the implement/critique/review/fix prompts |
| `reviewDimensions` | `[{key, ask}]` adversarial review lenses |
| `procedures` | pointers to skills/docs for things the loop can't self-certify (snapshot baselines, iOS build) |
| `workdir` | subdir holding the build tool when it isn't the repo root (e.g. `android`) — usually set by the overlay |
| `scopeIgnore` | extra path prefixes the Audit scope-guard ignores (default already covers `.claude/`) |
| `acceptance` | per-platform `{install, appId\|bundleId}` for the device-driving Acceptance phase — **mobile-only today** (mobile-mcp); omit for web/CLI stacks and the phase is skipped |
| `model` | optional model override for the verification-loop agents (gate/audit/acceptance/review/verify/fix); planning + impl agents keep the session model so resume caching stays intact |

Layering rule: nothing in a profile may be true of only one repo or one machine
— that content belongs in the repo overlay. An over-specific profile silently
misconfigures the next repo of the same stack.

## Repo overlay (`<repo>/.claude/factory.json`)
Same shape, partial. Merge rules (`resolve.py:merge`):
- `gates` / `gateNotes` / `procedures` — shallow-merged per key (overlay wins).
- `reviewDimensions` — concatenated, deduped by `key` (overlay wins).
- `conventions` — appended after the profile's, separated by a blank line.
- everything else — overlay replaces.

Use the overlay for project-specific concerns on top of a generic stack profile
(e.g. adding a domain-rules review dimension, or overriding a gate command).

## Add a new stack
The zero-effort path: run `/build-feature` in the new repo — when the resolver
finds no profile it runs a **first-run profile setup** interview (scouts CI
configs and build scripts for gate candidates, confirms with you, persists the
profile + overlay split, and proves the fast gate before launching). See the
build-feature SKILL.md.

By hand:
1. Create `<id>.json` here (copy `kmp-android-ios.json`).
2. Add a detection rule to `detect_profile()` in `resolve.py` **and a case in
   `test_resolve.py`** (beware lookalikes: Flutter/RN repos contain both native
   trees and must be ruled out before broader rules — see the existing guards).
3. Run the tests: `python3 ~/.claude/factory-profiles/test_resolve.py`.
4. Smoke it: `cd <repo> && python3 ~/.claude/factory-profiles/resolve.py`.
