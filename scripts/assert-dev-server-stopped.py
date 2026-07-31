#!/usr/bin/env python3
"""Detect (and optionally kill) a live renderer development server.

Default mode refuses test execution while a dev process is live. `--kill`
terminates any stale project dev process so `just launch` can bind its ports
instead of dying on EADDRINUSE from an app a previous launch left running.
"""

from __future__ import annotations

import os
import signal
import socket
import sys
import time
from pathlib import Path


DEV_SERVER_HOST = "127.0.0.1"
DEV_SERVER_PORT = 3100
PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ELECTRON = PROJECT_ROOT / "node_modules" / "electron" / "dist" / "electron"


def dev_pids() -> list[int]:
    """PIDs of this project's forge-start / Electron dev processes."""
    pids: list[int] = []
    for process_dir in Path("/proc").iterdir():
        if not process_dir.name.isdigit():
            continue
        try:
            working_directory = (process_dir / "cwd").resolve(strict=True)
            command = [
                token.decode()
                for token in (process_dir / "cmdline").read_bytes().split(b"\0")
                if token
            ]
        except (FileNotFoundError, PermissionError, ProcessLookupError, UnicodeDecodeError):
            continue

        # Two shapes, because the CLI dispatches `forge start` to its own entry
        # point: `node .../electron-forge.js start` when it is invoked through
        # the multiplexer, and `node .../electron-forge-start.js` with no
        # subcommand argument once it has. Matching only the first is why a
        # stale launch survived --kill and the next one died on EADDRINUSE
        # against :9001 with the reaper reporting nothing to do.
        is_forge_start = any(
            token.endswith("electron-forge-start.js")
            or (token.endswith("electron-forge.js") and "start" in command)
            for token in command
        )
        # Identify Electron by the binary the kernel says it is executing, not
        # by argv. Electron's main process does not present argv as the
        # NUL-separated tokens the node processes do, so the token tests that
        # work above find neither the executable path nor the "." argument, and
        # the app's own process went undetected: --kill reaped the forge node
        # process and reported success while the app kept running, and the
        # guard only still refused because dev_server_is_running() falls
        # through to a port probe that kill_dev_processes() does not share.
        try:
            executable = (process_dir / "exe").resolve(strict=True)
        except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
            executable = None
        is_project_electron = executable == PROJECT_ELECTRON
        if working_directory == PROJECT_ROOT and (is_forge_start or is_project_electron):
            pids.append(int(process_dir.name))
    return pids


def port_is_open() -> bool:
    """Return whether the dev server port accepts connections."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(0.25)
        return connection.connect_ex((DEV_SERVER_HOST, DEV_SERVER_PORT)) == 0


def dev_server_is_running() -> bool:
    """Return whether a project dev process exists or its port accepts connections."""
    return bool(dev_pids()) or port_is_open()


def kill_dev_processes() -> int:
    """SIGTERM (then SIGKILL) any stale project dev process so a launch can bind."""
    pids = dev_pids()
    if not pids:
        # The guard consults the port too, so "no pids" must not be reported as
        # "the tree is clear" while something still holds the port: that is the
        # state the caller cannot get out of, since it is refused by the guard
        # and told there is nothing to kill.
        if port_is_open():
            print(
                f"Nothing to kill, but {DEV_SERVER_HOST}:{DEV_SERVER_PORT} is still "
                "accepting connections. A dev server is running that this script "
                "cannot attribute to a process; find and stop it before retrying.",
                file=sys.stderr,
            )
            return 1
        return 0

    print(f"Freeing dev ports: terminating stale dev process(es) {pids}", file=sys.stderr)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            print(f"Dev process {pid} exited before SIGTERM was delivered.", file=sys.stderr)

    # Give them a moment to exit, then SIGKILL whatever ignored SIGTERM.
    time.sleep(1)
    for pid in dev_pids():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            print(f"Dev process {pid} exited before SIGKILL was delivered.", file=sys.stderr)
    return 0


def main() -> int:
    """Hard-fail before tests can trigger reloads in a running development app."""
    if "--kill" in sys.argv[1:]:
        return kill_dev_processes()

    if not dev_server_is_running():
        return 0

    print(
        "Refusing to run tests: a Zettlr-Pandoc development process or renderer "
        f"server on {DEV_SERVER_HOST}:{DEV_SERVER_PORT} is active. Fully quit the dev app first.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
