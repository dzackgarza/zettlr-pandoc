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
import os
import pathlib
import subprocess
import sys
import time

REPO = pathlib.Path(__file__).resolve().parent.parent
ASAR = REPO / "out" / "Zettlr-Pandoc-linux-x64" / "resources" / "app.asar"
BUILD_TIMEOUT_S = 600
MIN_PLAUSIBLE_ASAR_MB = 10  # a real build is ~100 MB; anything tiny is broken
STAMP = REPO / "out" / "Zettlr-Pandoc-linux-x64" / ".source-fingerprint"


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
    print(f"[verify-build] running production build (timeout {BUILD_TIMEOUT_S}s)...")
    fingerprint = source_fingerprint()
    start = time.time_ns()
    try:
        result = subprocess.run(
            ["bun", "run", "package:linux-x64"],
            cwd=REPO, capture_output=True, text=True, timeout=BUILD_TIMEOUT_S,
            # CI=1 selects listr's verbose renderer so piped logs carry real
            # task output instead of spinner frames. It does NOT prevent the
            # swallowed mode: that is forge's commander-spawned `package`
            # subcommand forwarding a child SIGNAL death as process.exit(null)
            # -> exit 0. Diagnosed 2026-08-12: earlyoom SIGTERMed the ~7 GB
            # webpack compile under memory pressure and the build chain
            # reported success with no fresh asar. The freshness check below
            # is what catches it; on BUILD BROKEN, check `journalctl -u
            # earlyoom` before suspecting webpack.
            env={**os.environ, "CI": "1"},
        )
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        fail(
            f"build TIMED OUT after {BUILD_TIMEOUT_S}s -- webpack hung and produced "
            f"no fresh artifact",
            stdout, stderr,
        )

    if result.returncode != 0:
        fail(f"build exited {result.returncode}", result.stdout, result.stderr)

    # Exit 0 is NOT proof: the whole point is that a swallowed failure exits 0.
    if not ASAR.exists() or ASAR.stat().st_mtime_ns < start:
        fail(
            "build exited 0 but app.asar was NOT (re)written during this build -- "
            "the swallowed-webpack-failure mode",
            result.stdout, result.stderr,
        )

    verify_artifact(result.stdout, result.stderr)
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
