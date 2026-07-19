#!/usr/bin/env python3
"""Resolve the feature-factory build config for the current repo.

Deterministic profile selection for the `build-feature` skill:
  1. Sniff marker files in $PWD to detect the codebase type.
  2. Load the matching profile <id>.json — the user dir
     (~/.claude/factory-profiles/) wins over the bundled dir (next to this
     script), so users can override or add stacks without touching the plugin.
  3. Merge an optional repo-local overlay ($PWD/.claude/factory.json) on top.
  4. Print the merged config as JSON on stdout.

The skill runs this, then passes the JSON straight into the feature-factory
workflow as `args`. Detection is file-existence based, never model judgment.

Add a new stack: drop <id>.json into ~/.claude/factory-profiles/ (or the
bundled dir) and add a rule to detect_profile() below — or just run the
build-feature skill in the new repo and let its first-run profile setup do
both with you.
"""
import json
import os
import sys

HOME = os.path.expanduser("~")
# Bundled profiles ship beside this script (plugin install or ~/.claude copy);
# ~/.claude/factory-profiles is the user-extension dir and wins on conflict.
BUNDLED_PROFILE_DIR = os.path.dirname(os.path.abspath(__file__))
USER_PROFILE_DIR = os.path.join(HOME, ".claude", "factory-profiles")


def find_profile(pid):
    """Path to <pid>.json, user dir first, else bundled dir, else None."""
    for d in (USER_PROFILE_DIR, BUNDLED_PROFILE_DIR):
        p = os.path.join(d, pid + ".json")
        if os.path.exists(p):
            return p
    return None


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
                    "(it interviews the user, persists a profile to "
                    "~/.claude/factory-profiles/ and adds a detect rule), or "
                    "pass gates explicitly via args.",
        }, indent=2))
        return

    profile_path = find_profile(pid)
    if profile_path is None:
        print(json.dumps({
            "error": f"Detected codebase type '{pid}' but no profile file named "
                     f"{pid}.json exists in {USER_PROFILE_DIR} or "
                     f"{BUNDLED_PROFILE_DIR}.",
            "detected": pid,
            "hint": "Run the build-feature skill's first-run profile setup to "
                    f"create {pid}.json with the user (or copy "
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
