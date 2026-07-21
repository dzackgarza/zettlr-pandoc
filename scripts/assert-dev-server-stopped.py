#!/usr/bin/env python3
"""Refuse test execution while the renderer development server is live."""

from __future__ import annotations

import socket
import sys
from pathlib import Path


DEV_SERVER_HOST = "127.0.0.1"
DEV_SERVER_PORT = 3100
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def dev_server_is_running() -> bool:
    """Return whether a project dev process exists or its port accepts connections."""
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
            return True

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(0.25)
        return connection.connect_ex((DEV_SERVER_HOST, DEV_SERVER_PORT)) == 0


def main() -> int:
    """Hard-fail before tests can trigger reloads in a running development app."""
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
