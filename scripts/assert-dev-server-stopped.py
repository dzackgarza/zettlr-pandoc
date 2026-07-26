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

        is_forge_start = any(token.endswith("electron-forge.js") for token in command) and "start" in command
        is_project_electron = any(token.endswith("node_modules/electron/dist/electron") for token in command) and "." in command
        if working_directory == PROJECT_ROOT and (is_forge_start or is_project_electron):
            pids.append(int(process_dir.name))
    return pids


def dev_server_is_running() -> bool:
    """Return whether a project dev process exists or its port accepts connections."""
    if dev_pids():
        return True

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(0.25)
        return connection.connect_ex((DEV_SERVER_HOST, DEV_SERVER_PORT)) == 0


def kill_dev_processes() -> int:
    """SIGTERM (then SIGKILL) any stale project dev process so a launch can bind."""
    pids = dev_pids()
    if not pids:
        return 0

    print(f"Freeing dev ports: terminating stale dev process(es) {pids}", file=sys.stderr)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    # Give them a moment to exit, then SIGKILL whatever ignored SIGTERM.
    time.sleep(1)
    for pid in dev_pids():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
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
