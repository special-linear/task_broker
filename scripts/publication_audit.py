"""Local publication guard. Report locations/categories, never matched values.

Heuristic scanning supplements review; it cannot prove arbitrary data is secret-free.
The optional private deny lists never enter the source manifest or archive.
"""
import argparse
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
RULES = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "jwt": re.compile(r"\beyJ[\w-]{20,}\.[\w-]{10,}\.[\w-]{10,}\b"),
    "compute-key": re.compile(r"\btb_[0-9a-f-]{36}_[0-9a-f]{64}\b", re.I),
    "provider-token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b"),
    "machine-path": re.compile(r"(?i)(?:\b[A-Z]:[\\/]+(?:Users|Pr|Projects|Workspaces)[\\/]+[^\s\"'<>`]+|/(?:Users|home)/[A-Za-z0-9_.-]+/[^\s\"'<>`]+)"),
    "authenticated-url": re.compile(r"https?://[^\s/:]+:[^\s/@]+@[^\s/]+", re.I),
}
EMAIL = re.compile(r"\b[A-Za-z0-9_.+%-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b")
HOST = re.compile(r"\b(?:[A-Za-z0-9-]+\.)+(?:workers\.dev|cloudflareaccess\.com)\b", re.I)
SAFE_HOSTS = {"preview.workers.dev"}  # Deliberately rejected hostname in auth.test.ts.
ASSIGNMENT = re.compile(r'''["']?(APP_SIGNING_SECRET|oauth_token|refresh_token|CLOUDFLARE_API_TOKEN)["']?\s*[:=]\s*["']([^"'\r\n]{20,})["']''', re.I)
INSTALLATION_ID = re.compile(r'''["'](?:account_id|database_id|ACCESS_AUDIENCE)["']\s*:\s*["']([^"'\r\n]*)["']''')
SAFE_LITERALS = {
    "local-only-non-production-signing-secret",
    "test-only-signing-secret-at-least-32-bytes",
    "replace-with-at-least-32-random-bytes",
}


def private_path(name):
    path = PurePosixPath(name.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts or ":" in name:
        return True
    denied = {".git", ".wrangler", ".cloudflared", ".cache", ".npm-cache", "node_modules", "artifacts", "release", "__pycache__", "test-results", "playwright-report", "coverage", ".vscode", ".idea"}
    if any(part in denied for part in path.parts):
        return True
    for part in path.parts:
        if part in {".env.example", ".dev.vars.example"}:
            continue
        if part in {".env", ".dev.vars"} or part.startswith((".env.", ".dev.vars.")) or ".local." in part:
            return True
    return path.suffix.lower() in {".token", ".pem", ".key", ".p12", ".pfx", ".log", ".db", ".sqlite", ".sqlite3", ".pyc", ".map", ".zip", ".bundle"}


def private_terms(root=ROOT):
    terms = []
    for name in ("private-terms.json", "secret-needles.json"):
        path = root / "artifacts/private/publication-audit" / name
        if path.exists():
            values = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(values, list) or any(not isinstance(v, str) or len(v) < 8 for v in values):
                raise ValueError("Private audit list must contain strings of at least eight characters.")
            terms.extend(values)
    return terms


def scan_content(name, data, terms=()):
    if private_path(name):
        return [(name, 0, "private-file")]
    # Public source/assets are text. Images, databases and other binary additions need review.
    try:
        content = data.decode("utf-8-sig")
        if "\x00" in content:
            raise UnicodeError()
    except UnicodeError:
        return [(name, 0, "unreviewed-binary")]
    findings = []
    for line, text in enumerate(content.splitlines(), 1):
        for category, pattern in RULES.items():
            if pattern.search(text):
                findings.append((name, line, category))
        # Third-party license attribution is deliberately retained.
        if not name.startswith("notices/"):
            if any(not re.search(r"@(?:(?:[\w-]+\.)*example\.(?:com|test|invalid|org|net)|users\.noreply\.github\.com)$", m.group(), re.I) and m.group() != "noreply@github.com" for m in EMAIL.finditer(text)):
                findings.append((name, line, "personal-email"))
        if any(m.group().lower() not in SAFE_HOSTS and "YOUR-" not in m.group().upper() and "EXAMPLE" not in m.group().upper() for m in HOST.finditer(text)):
            findings.append((name, line, "installation-host"))
        if any(m.group(2) not in SAFE_LITERALS for m in ASSIGNMENT.finditer(text)):
            findings.append((name, line, "secret-assignment"))
        if any(m.group(1) not in {"", "local", "REPLACE-ME"} and not m.group(1).startswith("YOUR_") for m in INSTALLATION_ID.finditer(text)):
            findings.append((name, line, "installation-id"))
        if any(term.casefold() in text.casefold() for term in terms):
            findings.append((name, line, "private-deny-list"))
    return findings


def git(*args, root=ROOT):
    return subprocess.check_output(["git", *args], cwd=root)


def source_manifest(root=ROOT):
    names = json.loads((root / "release-files.json").read_text(encoding="utf-8"))
    if not isinstance(names, list) or not names or any(not isinstance(n, str) for n in names) or len(names) != len(set(names)):
        raise ValueError("Source manifest must contain unique filenames.")
    for name in names:
        path = root / name
        if private_path(name) or path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("Source manifest contains a missing or forbidden file: " + name)
    return names


def audit_source(root=ROOT, terms=()):
    names = source_manifest(root)
    findings = []
    if (root / ".git").exists():
        candidates = set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z", root=root).decode().split("\0")) - {""}
        for name in sorted(candidates - set(names)):
            findings.append((name, 0, "not-in-source-manifest"))
        for name in names:
            if subprocess.run(["git", "check-ignore", "--no-index", "-q", "--", name], cwd=root).returncode == 0:
                findings.append((name, 0, "ignored-source-file"))
    for name in names:
        findings.extend(scan_content(name, (root / name).read_bytes(), terms))
    return findings


def audit_history(terms=()):
    findings, seen = [], set()
    # Tool-internal refs and reflogs are local recovery state, not publication refs.
    # Inspect all branches (including remote tracking refs) and tags, not only HEAD.
    for commit in git("rev-list", "--branches", "--tags", "--remotes").decode().splitlines():
        metadata = git("show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%B", commit)
        findings.extend(scan_content("history/" + commit[:12] + "/metadata", metadata, terms))
        for entry in git("ls-tree", "-rz", commit).split(b"\0"):
            if not entry:
                continue
            meta, raw_name = entry.split(b"\t", 1)
            mode, kind, blob = meta.decode().split()
            name = raw_name.decode()
            if (blob, name) in seen:
                continue
            seen.add((blob, name))
            if kind != "blob" or mode == "120000":
                hits = [(name, 0, "unreviewed-link")]
            else:
                hits = scan_content(name, git("cat-file", "blob", blob), terms)
            findings.extend(("history/" + commit[:12] + "/" + p, line, category) for p, line, category in hits)
    # Tag annotations may carry a separate identity even when commits are clean.
    for tag in git("for-each-ref", "--format=%(objectname) %(objecttype)", "refs/tags").decode().splitlines():
        oid, kind = tag.split()
        if kind == "tag":
            findings.extend(scan_content("history/tag/" + oid[:12], git("cat-file", "tag", oid), terms))
    return findings


def audit_archive(path, terms=()):
    findings = []
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            findings.append(("archive", 0, "duplicate-entry"))
        for name in names:
            findings.extend(scan_content(name, archive.read(name), terms))
    return findings


def report(findings):
    for name, line, category in sorted(set(findings)):
        print(f"{name}:{line}: {category}")
    if findings:
        print(f"Publication audit failed: {len(set(findings))} findings. Matched values are withheld.")
    else:
        print("Publication audit passed for the selected scope (heuristic checks plus local deny lists).")
    return 1 if findings else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", action="store_true", help="Also scan all reachable local branches and tags.")
    parser.add_argument("--archive", type=Path, help="Scan ZIP contents instead of working files.")
    args = parser.parse_args()
    terms = private_terms()
    findings = audit_archive(args.archive, terms) if args.archive else audit_source(terms=terms)
    if args.history:
        findings.extend(audit_history(terms))
    return report(findings)


if __name__ == "__main__":
    sys.exit(main())
