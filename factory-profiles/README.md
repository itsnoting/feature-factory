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
| `conventions` | prose the agents get in every phase |
| `reviewDimensions` | `[{key, ask}]` adversarial review lenses |
| `procedures` | pointers to skills/docs for things the loop can't self-certify (snapshot baselines, iOS build) |

## Repo overlay (`<repo>/.claude/factory.json`)
Same shape, partial. Merge rules (`resolve.py:merge`):
- `gates` / `gateNotes` / `procedures` — shallow-merged per key (overlay wins).
- `reviewDimensions` — concatenated, deduped by `key` (overlay wins).
- `conventions` — appended after the profile's, separated by a blank line.
- everything else — overlay replaces.

Use the overlay for project-specific concerns on top of a generic stack profile
(e.g. adding a domain-rules review dimension, or overriding a gate command).

## Add a new stack
1. Create `<id>.json` here (copy `kmp-android-ios.json`).
2. Add a detection rule to `detect_profile()` in `resolve.py`.
3. Test: `cd <repo> && python3 ~/.claude/factory-profiles/resolve.py`.
