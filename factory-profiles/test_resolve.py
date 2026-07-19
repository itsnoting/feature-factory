#!/usr/bin/env python3
"""Tests for resolve.py — detection rules and overlay merge semantics.

Run:  python3 ~/.claude/factory-profiles/test_resolve.py
No dependencies beyond the stdlib; builds fake repo trees in a tempdir.
"""
import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("resolve", os.path.join(HERE, "resolve.py"))
resolve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolve)


def make_tree(root, paths):
    """paths ending in '/' become dirs; others become empty files."""
    for p in paths:
        full = os.path.join(root, p)
        if p.endswith("/"):
            os.makedirs(full, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(full) or full, exist_ok=True) if os.path.dirname(p) else None
            open(full, "w").close()


class DetectTest(unittest.TestCase):
    def detect(self, paths):
        with tempfile.TemporaryDirectory() as tmp:
            make_tree(tmp, paths)
            old = os.getcwd()
            os.chdir(tmp)
            try:
                return resolve.detect_profile()
            finally:
                os.chdir(old)

    def test_kmp_split_layout(self):
        # The layout this suite grew up on: gradle in android/, iosApp/ sibling.
        self.assertEqual(
            self.detect(["android/settings.gradle.kts", "iosApp/"]),
            "kmp-android-ios")

    def test_kmp_root_gradle_with_xcodeproj(self):
        self.assertEqual(
            self.detect(["settings.gradle.kts", "ios/App.xcodeproj/"]),
            "kmp-android-ios")

    def test_flutter_not_mistaken_for_kmp(self):
        # Flutter has android/+gradle AND ios/*.xcodeproj — pubspec must win.
        self.assertEqual(
            self.detect(["pubspec.yaml", "android/settings.gradle",
                         "ios/Runner.xcodeproj/"]),
            "flutter")

    def test_react_native_not_mistaken_for_kmp(self):
        # RN likewise carries both native trees — metro.config.js must win.
        self.assertEqual(
            self.detect(["package.json", "metro.config.js",
                         "android/settings.gradle", "ios/App.xcodeproj/"]),
            "react-native")

    def test_plain_gradle(self):
        self.assertEqual(self.detect(["settings.gradle.kts"]), "android-gradle")

    def test_node(self):
        self.assertEqual(self.detect(["package.json"]), "node-web")

    def test_rust(self):
        self.assertEqual(self.detect(["Cargo.toml"]), "rust")

    def test_go(self):
        self.assertEqual(self.detect(["go.mod"]), "go")

    def test_python(self):
        self.assertEqual(self.detect(["pyproject.toml"]), "python")

    def test_nothing(self):
        self.assertIsNone(self.detect(["README.md"]))


class MergeTest(unittest.TestCase):
    BASE = {
        "gates": {"fast": "make fast", "e2e": "make e2e"},
        "gateNotes": {"e2e": "needs device"},
        "conventions": "stack conventions",
        "reviewDimensions": [{"key": "correctness", "ask": "bugs?"},
                             {"key": "style", "ask": "fits?"}],
        "procedures": {"ios": "by hand"},
    }

    def test_gates_shallow_merge_overlay_wins(self):
        out = resolve.merge(self.BASE, {"gates": {"e2e": "custom-e2e.sh"}})
        self.assertEqual(out["gates"], {"fast": "make fast", "e2e": "custom-e2e.sh"})

    def test_conventions_append(self):
        out = resolve.merge(self.BASE, {"conventions": "repo specifics"})
        self.assertEqual(out["conventions"], "stack conventions\n\nrepo specifics")

    def test_review_dimensions_concat_dedup_overlay_wins(self):
        out = resolve.merge(self.BASE, {"reviewDimensions": [
            {"key": "style", "ask": "OVERRIDDEN"},
            {"key": "domain", "ask": "domain rules"}]})
        dims = {d["key"]: d["ask"] for d in out["reviewDimensions"]}
        self.assertEqual(dims, {"correctness": "bugs?", "style": "OVERRIDDEN",
                                "domain": "domain rules"})

    def test_scalar_replace(self):
        out = resolve.merge(self.BASE, {"workdir": "android"})
        self.assertEqual(out["workdir"], "android")

    def test_base_untouched_keys_survive(self):
        out = resolve.merge(self.BASE, {"gateNotes": {"snapshot": "record first"}})
        self.assertEqual(out["gateNotes"],
                         {"e2e": "needs device", "snapshot": "record first"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
