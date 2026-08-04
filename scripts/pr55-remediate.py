#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

package_path = ROOT / "package.json"
package = json.loads(package_path.read_text(encoding="utf-8"))

runtime_dependencies = {
    "@electron-toolkit/preload": "3.0.2",
    "@electron-toolkit/typed-ipc": "1.0.2",
    "@noble/hashes": "2.2.0",
    "@sinclair/typebox": "0.34.52",
    "ajv": "8.20.0",
    "async-mutex": "0.5.0",
    "openapi-backend": "5.20.0",
    "write-file-atomic": "7.0.1",
}
development_dependencies = {
    "@types/write-file-atomic": "4.0.3",
    "openapi-typescript": "7.13.0",
}

dependencies = package.setdefault("dependencies", {})
dev_dependencies = package.setdefault("devDependencies", {})
for name, version in runtime_dependencies.items():
    dependencies[name] = version
    dev_dependencies.pop(name, None)
for name, version in development_dependencies.items():
    dev_dependencies[name] = version

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
