"""Build a deterministic release from an explicit, audited source manifest."""
import hashlib
import json
import os
import re
import time
import zipfile
from pathlib import Path
from publication_audit import ROOT, audit_source, private_terms, report, scan_content, source_manifest


def collect_files(root=ROOT):
    terms = private_terms(root)
    findings = audit_source(root, terms)
    if findings:
        report(findings)
        raise ValueError("Refusing to package source with publication findings.")
    files = {name: (root / name).read_bytes() for name in source_manifest(root)}
    # Source is never discovered with a recursive glob. Only freshly built browser
    # assets and dependency license notices have separate, narrow inclusion rules.
    build = root / "dist/web"
    if not (build / "index.html").is_file():
        raise ValueError("Build browser assets before packaging.")
    for path in build.rglob("*"):
        if path.is_dir():
            continue
        name = path.relative_to(build).as_posix()
        allowed = name in {"index.html", "downloads/task_pool.py", "downloads/minimal_worker.py"} or re.fullmatch(r"assets/(?:index|import\.worker)-[A-Za-z0-9_-]+\.(?:js|css)", name)
        if not allowed or path.is_symlink() or not path.resolve().is_relative_to(build.resolve()):
            raise ValueError("Unexpected browser build file: " + name)
        files["dist/web/" + name] = path.read_bytes()
    lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    for location in lock["packages"]:
        if not location:
            continue
        directory = root / location
        if not directory.exists():
            continue
        if not location.startswith("node_modules/") or not directory.resolve().is_relative_to((root / "node_modules").resolve()):
            raise ValueError("Dependency license path escapes node_modules.")
        for path in directory.iterdir():
            if path.is_file() and not path.is_symlink() and path.name.lower().startswith(("license", "licence", "notice", "copying")):
                files["notices/" + location.replace("node_modules/", "") + "/" + path.name] = path.read_bytes()
    findings = []
    for name, data in files.items():
        findings.extend(scan_content(name, data, terms))
    if findings:
        report(findings)
        raise ValueError("Refusing to package assets with publication findings.")
    return files


def main():
    files = collect_files()
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    output = ROOT / "release"
    output.mkdir(exist_ok=True)
    text_suffixes = {".ts", ".py", ".mjs", ".md", ".json", ".jsonc", ".sql", ".css", ".html", ".yml", ".yaml", ".sh"}
    for name, data in list(files.items()):
        if Path(name).suffix in text_suffixes or name in {".gitignore", ".gitattributes", ".dev.vars.example", "LICENSE"}:
            files[name] = data.replace(b"\r\n", b"\n")
    manifest = {"version": version, "format": 1, "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
    files["SHA256SUMS.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    stamp = time.gmtime(max(315532800, int(os.environ.get("SOURCE_DATE_EPOCH", "1788523200"))))[:6]
    archive = output / f"cloudflare-task-broker-{version}.zip"
    temporary = archive.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as handle:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            handle.writestr(info, data)
    temporary.replace(archive)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(".zip.sha256").write_bytes(f"{digest}  {archive.name}\n".encode())
    print(f"Created {archive.name}: {len(files)} files, {archive.stat().st_size} bytes; SHA-256 {digest}")


if __name__ == "__main__":
    main()
