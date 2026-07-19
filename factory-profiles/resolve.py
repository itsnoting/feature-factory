#!/usr/bin/env python3
"""Resolve the feature-factory build config for the current repo.

Deterministic profile selection for the `build-feature` skill:
  1. Sniff marker files in $PWD to detect the codebase type.
  2. Load the matching global profile from ~/.claude/factory-profiles/<id>.json.
  3. Merge an optional repo-local overlay ($PWD/.claude/factory.json) on top.
  4. Print the merged config as JSON on stdout.

The skill runs this, then passes the JSON straight into the feature-factory
workflow as `args`. Detection is file-existence based, never model judgment.

Add a new stack: create ~/.claude/factory-profiles/<id>.json and add a rule
to detect_profile() below.
"""
import json
import os
import sys

HOME = os.path.expanduser("~")
PROFILE_DIR = os.path.join(HOME, ".claude", "factory-profiles")


def exists(*parts):
    return os.path.exists(os.path.join(os.getcwd(), *parts))


def glob_ext(ext):
    """True if any top-level entry in $PWD (or one level down) ends with ext."""
    for root, dirs, files in os.walk(os.getcwd()):
        # only descend one level to stay cheap
        depth = root[len(os.getcwd()):].count(os.sep)
        if depth >= 2:
            dirs[:] = []
        if any(f.endswith(ext) for f in files) or any(d.endswith(ext) for d in dirs):
            return True
    return False


def detect_profile():
    # Flutter and React Native repos ALSO contain android/ with gradle AND an
    # .xcodeproj, so they must be ruled out BEFORE the KMP check or they
    # false-positive as kmp-android-ios and get handed gates (Roborazzi etc.)
    # that don't exist there.
    if exists("pubspec.yaml"):
        return "flutter"                 # profile file may not exist yet
    if exists("metro.config.js") or exists("react-native.config.js"):
        return "react-native"            # profile file may not exist yet
    # Gradle root may be at the repo root OR in an android/ subdir (KMP split
    # layout where iosApp/ is a sibling of the Gradle project).
    gradle = (exists("settings.gradle.kts") or exists("settings.gradle")
              or exists("android", "settings.gradle.kts")
              or exists("android", "settings.gradle"))
    ios = exists("iosApp") or glob_ext(".xcodeproj")
    if gradle and ios:
        return "kmp-android-ios"
    if gradle:
        return "android-gradle"          # profile file may not exist yet
    if exists("package.json"):
        return "node-web"                # profile file may not exist yet
    if exists("Cargo.toml"):
        return "rust"                    # profile file may not exist yet
    if exists("go.mod"):
        return "go"                      # profile file may not exist yet
    if exists("pyproject.toml") or exists("setup.py"):
        return "python"                  # profile file may not exist yet
    return None


def load_json(path):
    with open(path) as f:
        return json.load(f)


def merge(base, overlay):
    """Overlay wins per-key. reviewDimensions concat (overlay appended, dedup by
    key with overlay winning). conventions concat with a blank line. gates/gateNotes
    shallow-merged per key."""
    out = dict(base)
    for k, v in overlay.items():
        if k == "reviewDimensions" and isinstance(v, list):
            seen = {}
            for d in base.get("reviewDimensions", []) + v:
                seen[d.get("key", id(d))] = d  # later (overlay) wins
            out["reviewDimensions"] = list(seen.values())
        elif k == "conventions" and isinstance(v, str) and base.get("conventions"):
            out["conventions"] = base["conventions"].rstrip() + "\n\n" + v
        elif k in ("gates", "gateNotes", "procedures") and isinstance(v, dict):
            merged = dict(base.get(k, {}))
            merged.update(v)
            out[k] = merged
        else:
            out[k] = v
    return out


def main():
    pid = detect_profile()
    if pid is None:
        print(json.dumps({
            "error": "Could not detect a codebase type from marker files in "
                     + os.getcwd(),
            "detected": None,
            "hint": "Run the build-feature skill's first-run profile setup "
                    "(it interviews the user and persists a profile + detect "
                    "rule), or pass gates explicitly via args.",
        }, indent=2))
        return

    profile_path = os.path.join(PROFILE_DIR, pid + ".json")
    if not os.path.exists(profile_path):
        print(json.dumps({
            "error": f"Detected codebase type '{pid}' but no profile file exists "
                     f"at {profile_path}.",
            "detected": pid,
            "hint": f"Run the build-feature skill's first-run profile setup to "
                    f"create {profile_path} with the user (or copy "
                    "kmp-android-ios.json as a template by hand).",
        }, indent=2))
        return

    config = load_json(profile_path)

    overlay_path = os.path.join(os.getcwd(), ".claude", "factory.json")
    overlay_applied = False
    if os.path.exists(overlay_path):
        config = merge(config, load_json(overlay_path))
        overlay_applied = True

    config["_resolved"] = {
        "profileId": pid,
        "profilePath": profile_path,
        "overlayApplied": overlay_applied,
        "overlayPath": overlay_path if overlay_applied else None,
        "cwd": os.getcwd(),
    }
    print(json.dumps(config, indent=2))


if __name__ == "__main__":
    main()
