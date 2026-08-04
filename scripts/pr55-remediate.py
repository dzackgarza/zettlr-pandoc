#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*args: str) -> None:
    subprocess.run(args, cwd=ROOT, check=True)


# Maintained libraries replace the repository-owned routing, validation,
# locking, hashing, persistence, and IPC infrastructure.
run(
    "bun", "add",
    "openapi-backend",
    "@sinclair/typebox@^0.34",
    "async-mutex",
    "@noble/hashes",
    "write-file-atomic@^7",
    "@electron-toolkit/typed-ipc",
    "@electron-toolkit/preload",
)
run(
    "bun", "add", "--dev",
    "openapi-typescript",
    "@types/write-file-atomic",
)

package_path = ROOT / "package.json"
package = json.loads(package_path.read_text(encoding="utf-8"))
scripts = package.setdefault("scripts", {})
scripts["generate:agent-api-types"] = (
    "openapi-typescript source/app/service-providers/agent-api/openapi.yaml "
    "-o source/types/generated/agent-api.ts"
)
scripts["check:agent-api-types"] = (
    "bun run generate:agent-api-types && "
    "git diff --exit-code -- source/types/generated/agent-api.ts"
)
package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")

(ROOT / "source/types/generated").mkdir(parents=True, exist_ok=True)
