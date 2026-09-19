#!/usr/bin/env python3
"""Build observability for zettlr-pandoc.

The production ``electron-forge package`` build can silently produce NO fresh
app.asar: a swallowed webpack failure still exits 0, so the launcher believed the
build was current and shipped 03:33 bytes for hours. Nothing caught it. This is
that missing check.

It proves the packaged app.asar was actually (re)built from the CURRENT commit,
using the ``__GIT_COMMIT_HASH__`` value webpack's DefinePlugin bakes into the
bundle (a string literal that survives minification, referenced by
win-about/Debug-Tab.vue). If the asar does not carry the current commit hash, the
build is stale/broken -- and this exits non-zero, loudly.

Usage:
    verify-build.py                # run the production build, then verify output
    verify-build.py --verify-only  # verify the existing out/ artifact, no build
"""

from __future__ import annotations

import argparse
from collections import deque
import json
import os
import pathlib
import signal
import subprocess
import sys
import threading
import time
import zipfile

REPO = pathlib.Path(__file__).resolve().parent.parent
ASAR = REPO / "out" / "Zettlr-Pandoc-linux-x64" / "resources" / "app.asar"
BUILD_TIMEOUT_S = 600
MIN_PLAUSIBLE_ASAR_MB = 10  # a real build is ~100 MB; anything tiny is broken
STAMP = REPO / "out" / "Zettlr-Pandoc-linux-x64" / ".source-fingerprint"
ELECTRON_PACKAGE = REPO / "node_modules" / "electron" / "package.json"
ELECTRON_DIST = REPO / "node_modules" / "electron" / "dist"


def head_short_hash() -> str:
    return subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def source_fingerprint() -> str:
    return subprocess.run(
        [str(REPO / "scripts" / "desktop" / "zettlr-pandoc-source-fingerprint"), str(REPO)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def electron_packager_zip_dir() -> pathlib.Path:
    """Return a local Electron ZIP directory suitable for electronZipDir.

    `electron`'s npm install has already downloaded and extracted the exact
    platform runtime under node_modules/electron/dist. Electron Packager would
    otherwise download the same release again through @electron/get on every
    machine whose Packager cache is cold. On this workstation that download can
    take longer than the entire build timeout.

    Packager officially accepts `electronZipDir`, so reconstruct the release
    ZIP once from that installed runtime and cache it outside the repository.
    The archive name is Packager's documented release filename; a version bump
    naturally selects a new cache file.
    """
    if not ELECTRON_PACKAGE.is_file() or not ELECTRON_DIST.is_dir():
        fail("the installed Electron runtime is missing; run the dependency install first")

    package = json.loads(ELECTRON_PACKAGE.read_text())
    version = package.get("version")
    if not isinstance(version, str) or not version:
        fail(f"could not read an Electron version from {ELECTRON_PACKAGE}")

    dist_version_path = ELECTRON_DIST / "version"
    binary = ELECTRON_DIST / "electron"
    if not dist_version_path.is_file() or not binary.is_file():
        fail(f"the installed Electron {version} runtime is incomplete at {ELECTRON_DIST}")
    dist_version = dist_version_path.read_text().strip().removeprefix("v")
    if dist_version != version:
        fail(
            f"Electron package/runtime version mismatch: package={version}, dist={dist_version}"
        )

    cache_home = pathlib.Path(
        os.environ.get("XDG_CACHE_HOME", pathlib.Path.home() / ".cache")
    )
    zip_dir = cache_home / "zettlr-pandoc" / "electron-packager"
    zip_path = zip_dir / f"electron-v{version}-linux-x64.zip"

    def valid_cached_zip() -> bool:
        if not zip_path.is_file():
            return False
        try:
            with zipfile.ZipFile(zip_path) as archive:
                return (
                    archive.read("version").decode().strip().removeprefix("v") == version
                    and archive.getinfo("electron").file_size == binary.stat().st_size
                )
        except (OSError, KeyError, zipfile.BadZipFile, UnicodeDecodeError):
            return False

    if valid_cached_zip():
        print(f"[verify-build] using cached local Electron {version} runtime: {zip_path}", flush=True)
        return zip_dir

    zip_dir.mkdir(parents=True, exist_ok=True)
    staged = zip_path.with_suffix(zip_path.suffix + ".new")
    staged.unlink(missing_ok=True)
    print(
        f"[verify-build] caching installed Electron {version} runtime for Packager (one-time local step)...",
        flush=True,
    )
    try:
        with zipfile.ZipFile(
            staged,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
            allowZip64=True,
        ) as archive:
            for source in sorted(ELECTRON_DIST.rglob("*")):
                if source.is_file():
                    archive.write(source, source.relative_to(ELECTRON_DIST).as_posix())

            # Electron's npm installer moves this declaration out of dist after
            # extracting the upstream release ZIP. It is not needed at runtime,
            # but restoring it makes the reconstructed archive match the release
            # layout closely and costs little.
            declaration = ELECTRON_PACKAGE.parent / "electron.d.ts"
            if declaration.is_file():
                archive.write(declaration, "electron.d.ts")
        staged.replace(zip_path)
    except Exception:
        staged.unlink(missing_ok=True)
        raise

    if not valid_cached_zip():
        zip_path.unlink(missing_ok=True)
        fail(f"failed to construct a valid local Electron archive at {zip_path}")
    print(f"[verify-build] cached local Electron runtime: {zip_path}", flush=True)
    return zip_dir


def descendant_pids(root_pid: int) -> list[int]:
    """Return descendants of root_pid, deepest children first."""
    parents: dict[int, int] = {}
    for stat_path in pathlib.Path("/proc").glob("[0-9]*/stat"):
        try:
            # /proc/PID/stat's second field is `(comm)` and may contain spaces;
            # parent pid is the second token after the final `)`.
            text = stat_path.read_text()
            after_comm = text[text.rfind(")") + 2:].split()
            pid = int(stat_path.parent.name)
            ppid = int(after_comm[1])
            parents[pid] = ppid
        except (OSError, ValueError, IndexError):
            continue

    descendants: list[int] = []
    frontier = [root_pid]
    while frontier:
        parent = frontier.pop()
        children = [pid for pid, ppid in parents.items() if ppid == parent]
        frontier.extend(children)
        descendants.extend(children)
    return list(reversed(descendants))


def terminate_process_tree(root_pid: int) -> None:
    """Terminate a timed-out build without leaving Forge/download orphans."""
    pids = descendant_pids(root_pid) + [root_pid]
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        alive = []
        for pid in pids:
            try:
                os.kill(pid, 0)
                alive.append(pid)
            except ProcessLookupError:
                pass
        if not alive:
            return
        time.sleep(0.05)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run_build_streaming(env: dict[str, str]) -> tuple[int, str]:
    """Run Forge with live output while retaining a bounded failure tail."""
    process = subprocess.Popen(
        ["bun", "run", "package:linux-x64"],
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )
    assert process.stdout is not None
    tail: deque[str] = deque(maxlen=160)

    def pump() -> None:
        for line in process.stdout:
            print(line, end="", flush=True)
            tail.append(line)

    reader = threading.Thread(target=pump, name="zettlr-package-output", daemon=True)
    reader.start()
    try:
        returncode = process.wait(timeout=BUILD_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        terminate_process_tree(process.pid)
        reader.join(timeout=2)
        fail(
            f"build TIMED OUT after {BUILD_TIMEOUT_S}s; the complete build process tree was terminated",
            "".join(tail),
        )
    reader.join(timeout=2)
    return returncode, "".join(tail)


def fail(msg: str, out: str = "", err: str = "") -> "typing.NoReturn":  # noqa: F821
    print(f"\n[verify-build] BUILD BROKEN: {msg}\n", file=sys.stderr)
    if out.strip():
        print("--- build stdout (tail) ---\n" + out[-3000:], file=sys.stderr)
    if err.strip():
        print("--- build stderr (tail) ---\n" + err[-3000:], file=sys.stderr)
    sys.exit(1)


def asar_contains(needle: str) -> bool:
    # `grep -a` scans the binary asar as text; the injected commit hash is a
    # plain string literal in the bundle.
    return subprocess.run(["grep", "-a", "-q", needle, str(ASAR)]).returncode == 0


def verify_artifact(build_out: str = "", build_err: str = "") -> None:
    head = head_short_hash()

    if not ASAR.exists():
        fail(f"app.asar does not exist at {ASAR}", build_out, build_err)

    size_mb = ASAR.stat().st_size // 1024 // 1024
    if size_mb < MIN_PLAUSIBLE_ASAR_MB:
        fail(f"app.asar is implausibly small ({size_mb} MB) -- partial/broken build",
             build_out, build_err)

    if not asar_contains(head):
        fail(
            f"app.asar does NOT contain the current commit {head} -- it was built "
            f"from a different (stale) commit. THIS is the silent-stale-build "
            f"failure that shipped old code.",
            build_out, build_err,
        )

    print(f"[verify-build] OK: app.asar is built from HEAD ({head}) and is {size_mb} MB")


def build_and_verify() -> None:
    local_package = os.environ.get("ZETTLR_LOCAL_PACKAGE") == "1"
    profile = "local unminified package" if local_package else "production build"
    print(f"[verify-build] running {profile} (timeout {BUILD_TIMEOUT_S}s)...")
    fingerprint = source_fingerprint()
    electron_zip_dir = electron_packager_zip_dir()
    start = time.time_ns()
    # CI=1 selects listr's verbose renderer so the launcher log carries real
    # stage output instead of spinner frames. ZETTLR_ELECTRON_ZIP_DIR invokes
    # Packager's supported local-runtime path above instead of @electron/get.
    returncode, build_tail = run_build_streaming({
        **os.environ,
        "CI": "1",
        "ZETTLR_ELECTRON_ZIP_DIR": str(electron_zip_dir),
    })

    if returncode != 0:
        fail(f"build exited {returncode}", build_tail)

    # Exit 0 is NOT proof: the whole point is that a swallowed failure exits 0.
    if not ASAR.exists() or ASAR.stat().st_mtime_ns < start:
        fail(
            "build exited 0 but app.asar was NOT (re)written during this build -- "
            "the swallowed-webpack-failure mode",
            build_tail,
        )

    verify_artifact(build_tail)
    STAMP.write_text(fingerprint + "\n")
    print(f"[verify-build] wrote source fingerprint to {STAMP}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true",
                        help="only verify the existing artifact; do not run a build")
    args = parser.parse_args()

    if args.verify_only:
        verify_artifact()
    else:
        build_and_verify()


if __name__ == "__main__":
    main()
