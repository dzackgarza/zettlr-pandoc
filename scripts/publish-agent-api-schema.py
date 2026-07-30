#!/usr/bin/env python3
"""Emit a Custom-GPT-ready copy of the agent API schema.

The committed openapi.yaml describes the loopback server: `servers:` names
127.0.0.1, and every operation is present. A GPT Action needs neither of those
things — it builds requests from `servers:`, it cannot consume Server-Sent
Events, and its tool selection degrades as the operation count grows.

This writes a derivative. The committed spec stays the source of truth, because
that is the file the conformance tests and the running server read; nothing here
edits it.

    scripts/publish-agent-api-schema.py https://zettlr.example.com
    scripts/publish-agent-api-schema.py https://zettlr.example.com --minimal

Paste the output into the GPT builder's schema box. It is not fetchable from the
running server: /openapi.yaml requires the bearer token like every other route,
and the builder's "Import from URL" fetches anonymously.
"""

import argparse
import pathlib
import sys

import yaml

REPO = pathlib.Path(__file__).resolve().parent.parent
SPEC = REPO / "source" / "app" / "service-providers" / "agent-api" / "openapi.yaml"

# Server-Sent Events. A GPT Action opening this waits for a response that is
# never going to be complete.
STREAMING_MEDIA_TYPE = "text/event-stream"

# The operations a "read my document and suggest corrections" GPT actually
# needs. Everything else is reachable but makes the model choose worse.
MINIMAL_OPERATIONS = {
    "getContext",
    "getDocument",
    "readDocumentContent",
    "submitProposal",
    "getReview",
    "getReviewChunks",
}


def operation_ids(path_item: dict) -> set[str]:
    return {
        operation["operationId"]
        for operation in path_item.values()
        if isinstance(operation, dict) and "operationId" in operation
    }


def streams(path_item: dict) -> bool:
    for operation in path_item.values():
        if not isinstance(operation, dict):
            continue
        for response in operation.get("responses", {}).values():
            if STREAMING_MEDIA_TYPE in response.get("content", {}):
                return True
    return False


def referenced_schemas(node: object, found: set[str]) -> set[str]:
    """Collect every `#/components/schemas/...` name reachable from `node`."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            found.add(ref.rsplit("/", 1)[1])
        for value in node.values():
            referenced_schemas(value, found)
    elif isinstance(node, list):
        for value in node:
            referenced_schemas(value, found)
    return found


def prune_schemas(spec: dict) -> int:
    """Drop schemas no kept path can reach, following refs transitively.

    A schema left behind is not merely noise: the GPT builder reads the whole
    document, so every unreachable definition is context spent describing calls
    the Action cannot make.
    """
    schemas = spec["components"]["schemas"]
    reachable = referenced_schemas(spec["paths"], set())
    # Schemas reference other schemas; keep walking until the set stops growing.
    while True:
        expanded = set(reachable)
        for name in reachable:
            referenced_schemas(schemas.get(name, {}), expanded)
        if expanded == reachable:
            break
        reachable = expanded

    removed = len(schemas) - len(reachable)
    spec["components"]["schemas"] = {
        name: schema for name, schema in schemas.items() if name in reachable
    }
    # Nothing may dangle: a $ref to a pruned schema is a broken document, and
    # the builder's error for that is not going to name this script.
    remaining = referenced_schemas(spec, set())
    missing = remaining - set(spec["components"]["schemas"])
    if missing:
        raise SystemExit(f"pruning left dangling refs: {sorted(missing)}")
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin", help="Public HTTPS origin, e.g. https://zettlr.example.com")
    parser.add_argument(
        "--minimal",
        action="store_true",
        help="Keep only the operations a corrections-focused GPT needs",
    )
    parser.add_argument(
        "--openapi-version",
        default="3.1.0",
        help=(
            "Version string to declare. Defaults to 3.1.0, which is the version "
            "OpenAI's own Actions example uses; the committed spec says 3.1.1 and "
            "the builder may or may not accept that patch level."
        ),
    )
    parser.add_argument("-o", "--output", help="Write here instead of stdout")
    args = parser.parse_args()

    if not args.origin.startswith("https://"):
        # A GPT Action will not call a plaintext origin, and failing here is
        # cheaper than discovering it in the builder.
        print(f"origin must be https://, got {args.origin}", file=sys.stderr)
        return 1

    spec = yaml.safe_load(SPEC.read_text())
    spec["openapi"] = args.openapi_version
    spec["servers"] = [{"url": args.origin.rstrip("/"), "description": "Tunnelled editor"}]

    kept: dict[str, dict] = {}
    dropped_streaming: list[str] = []
    dropped_surplus: list[str] = []
    for route, path_item in spec["paths"].items():
        if streams(path_item):
            dropped_streaming.append(route)
            continue
        if args.minimal and not (operation_ids(path_item) & MINIMAL_OPERATIONS):
            dropped_surplus.append(route)
            continue
        kept[route] = path_item
    spec["paths"] = kept
    pruned_schemas = prune_schemas(spec)

    rendered = yaml.safe_dump(spec, sort_keys=False, allow_unicode=True, width=100)

    if args.output is not None:
        pathlib.Path(args.output).write_text(rendered)
        print(f"wrote {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(rendered)

    print(f"origin:  {spec['servers'][0]['url']}", file=sys.stderr)
    print(f"openapi: {spec['openapi']}", file=sys.stderr)
    print(f"kept:    {len(kept)} paths, {len(spec['components']['schemas'])} schemas", file=sys.stderr)
    print(f"pruned:  {pruned_schemas} unreachable schemas", file=sys.stderr)
    for route in dropped_streaming:
        print(f"dropped: {route} (Server-Sent Events)", file=sys.stderr)
    if dropped_surplus:
        print(f"dropped: {len(dropped_surplus)} paths outside --minimal", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
