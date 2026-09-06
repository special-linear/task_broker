"""Publication boundary regressions, without using real secrets or user identities."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from publication_audit import audit_archive, audit_history, git, private_path, scan_content, source_manifest
from package_release import collect_files


class PublicationTests(unittest.TestCase):
    def test_sensitive_content_is_reported_without_echoing_values(self):
        values = [
            "tb_" + "0" * 8 + "-" + "0" * 4 + "-" + "0" * 4 + "-" + "0" * 4 + "-" + "0" * 12 + "_" + "a" * 64,
            "eyJ" + "a" * 24 + "." + "b" * 24 + "." + "c" * 24,
            "person" + "@" + "mail.invalid",
            "https://private-team." + "cloudflareaccess.com",
            "C:" + chr(92) + "Users" + chr(92) + "private-person" + chr(92) + "project",
        ]
        for value in values:
            with self.subTest(kind=value[:2]):
                findings = scan_content("file.txt", value.encode())
                self.assertTrue(findings)
                self.assertNotIn(value, repr(findings))

    def test_private_deny_list_catches_unstructured_secret(self):
        value = "arbitrary" + "-private-value-12345"
        self.assertTrue(scan_content("source.txt", value.encode(), [value]))

    def test_templates_and_license_attribution_are_allowed(self):
        self.assertFalse(scan_content("template.txt", b"owner@example.com https://YOUR-TEAM.cloudflareaccess.com"))
        self.assertFalse(scan_content("notices/library/LICENSE", ("Copyright Author <author" + "@" + "mail.invalid>").encode()))

    def test_deployment_ids_are_detected_without_private_deny_lists(self):
        identifier = "f" * 32
        self.assertTrue(scan_content("config.json", json.dumps({"account_id": identifier}).encode()))
        self.assertFalse(scan_content("config.json", json.dumps({"account_id": "YOUR_ACCOUNT_ID"}).encode()))

    def test_history_checks_old_blobs_and_tag_annotations(self):
        email = ("private-person" + "@" + "mail.invalid").encode()
        def fake_git(*args):
            if args[0] == "rev-list":
                return b"current\nprevious\n"
            if args[0] == "show":
                return b"Update deployment template"
            if args[0] == "ls-tree":
                return b"100644 blob " + args[-1].encode() + b"\tconfig.txt\0"
            if args == ("cat-file", "blob", "current"):
                return b"generic template"
            if args == ("cat-file", "blob", "previous"):
                return email
            if args[0] == "for-each-ref":
                return b"tag-id tag\n"
            if args == ("cat-file", "tag", "tag-id"):
                return b"object current\ntype commit\ntag release\ntagger Project <contributors@example.invalid> 0 +0000\n\n" + email
            raise AssertionError(args)
        with patch("publication_audit.git", side_effect=fake_git):
            findings = audit_history()
        self.assertTrue(any("previous" in name for name, _, _ in findings))
        self.assertTrue(any("tag-id" in name for name, _, _ in findings))

    def test_private_paths_and_traversal_are_rejected(self):
        for path in ["wrangler.staging.local.jsonc", ".env.production", "artifacts/private/report.json", "artifacts/verification/result.json", "a/../../secret", ".git/config", "key.pem", "output.js.map"]:
            self.assertTrue(private_path(path), path)
        self.assertFalse(private_path(".dev.vars.example"))
        self.assertFalse(private_path("migrations/0001_initial.sql"))

    def test_ignored_root_files_do_not_enter_archive_without_git(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "release-files.json").write_text(json.dumps(["release-files.json", "package-lock.json"]))
            (root / "package-lock.json").write_text('{"packages": {}}')
            (root / "dist/web").mkdir(parents=True)
            (root / "dist/web/index.html").write_text("<html></html>")
            (root / "wrangler.staging.local.jsonc").write_text('{"secret":"should stay local"}')
            (root / "unreviewed.json").write_text('{"value":"should stay local"}')
            files = collect_files(root)
            self.assertNotIn("wrangler.staging.local.jsonc", files)
            self.assertNotIn("unreviewed.json", files)
            (root / "dist/web/debug.log").write_text("private")
            with self.assertRaises(ValueError):
                collect_files(root)

    def test_manifest_cannot_override_private_exclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "release-files.json").write_text('["wrangler.staging.local.jsonc"]')
            (root / "wrangler.staging.local.jsonc").write_text("{}")
            with self.assertRaises(ValueError):
                source_manifest(root)

    def test_zip_scan_rejects_hidden_private_file_and_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr(".env", "secret=value")
                archive.writestr("screenshot.png", b"\x89PNG\x00")
            self.assertEqual({hit[2] for hit in audit_archive(path)}, {"private-file", "unreviewed-binary"})


class HistoryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.contributor = "Example Contributor"
        self.email = "contributor" + "@" + "mail.invalid"
        self.identifier = "f" * 32
        self.git("init", "-q")
        self.git("config", "user.name", self.contributor)
        self.git("config", "user.email", self.email)
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "tag.gpgsign", "false")
        self.git("config", "core.hooksPath", str(self.root / "no-hooks"))
        self.git("commit", "--allow-empty", "-qm", "Initial public source")

    def git(self, *args):
        return git(*args, root=self.root)

    def audit(self, terms=()):
        with patch("publication_audit.git", side_effect=self.git):
            return audit_history(terms)

    def test_contributor_identities_are_allowed_even_in_private_deny_lists(self):
        self.git("tag", "-a", "release", "-m", "Public release")
        self.assertEqual(self.audit([self.contributor, self.email]), [])

    def test_commit_messages_and_tag_annotations_still_reject_sensitive_data(self):
        cases = [
            ("provider-token", "ghp_" + "a" * 36, []),
            ("installation-host", "https://private-team." + "cloudflareaccess.com", []),
            ("installation-id", json.dumps({"database_id": self.identifier}), []),
            ("personal-email", json.dumps({"OWNER_EMAILS": self.email}), [self.email]),
            ("private-deny-list", "deployment-secret-12345", ["deployment-secret-12345"]),
        ]
        for category, value, terms in cases:
            with self.subTest(category=category):
                self.git("commit", "--allow-empty", "-qm", value)
                commit = self.git("rev-parse", "HEAD").decode().strip()
                # A line resembling a tagger header inside the annotation is still data.
                self.git("tag", "-a", category, "-m", "Release notes\n\ntagger " + value)
                tag = self.git("rev-parse", "refs/tags/" + category).decode().strip()
                findings = self.audit(terms)
                self.assertIn(("history/" + commit[:12] + "/message", 1, category), findings)
                self.assertIn(("history/tag/" + tag[:12], 8, category), findings)
                self.assertNotIn(value, repr(findings))

    def test_detached_head_files_are_checked(self):
        self.git("checkout", "--detach", "-q")
        (self.root / "deployment.json").write_text(json.dumps({"account_id": self.identifier}), encoding="utf-8")
        self.git("add", "deployment.json")
        self.git("commit", "-qm", "Detached CI change")
        commit = self.git("rev-parse", "HEAD").decode().strip()
        self.assertIn(("history/" + commit[:12] + "/deployment.json", 1, "installation-id"), self.audit())


if __name__ == "__main__":
    unittest.main()
