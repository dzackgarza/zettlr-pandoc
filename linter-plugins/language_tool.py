#!/usr/bin/env python3
"""LanguageTool external-linter plugin.

Wire protocol: read one JSON object from stdin with ``text`` and ``context``;
write one JSON object with neutral source-offset diagnostics.  Mathematical
projection and LanguageTool invocation are entirely owned here, so an editor is
only a transport/presentation client.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from flowmark.lint_rules import pandoc_math_regions
from flowmark.pandoc_lint import parse_pandoc_for_lint, walk_pandoc

TRAILING_PUNCT = re.compile(r"([,.;:!?])\s*$")


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    display: bool
    punctuation: str


@dataclass(frozen=True)
class Projection:
    text: str
    source_map: tuple[int, ...]
    placeholders: tuple[tuple[int, int], ...]


def _expand_math(text: str, start: int, end: int) -> tuple[int, int, bool]:
    if start >= 2 and text[start - 2 : start] == "$$" and text[end : end + 2] == "$$":
        return start - 2, end + 2, True
    if start >= 2 and text[start - 2 : start] == r"\[" and text[end : end + 2] == r"\]":
        return start - 2, end + 2, True
    if start >= 2 and text[start - 2 : start] == r"\(" and text[end : end + 2] == r"\)":
        return start - 2, end + 2, False
    if start >= 1 and text[start - 1 : start] == "$" and text[end : end + 1] == "$":
        return start - 1, end + 1, False
    return start, end, False


def _punctuation(content: str) -> str:
    match = TRAILING_PUNCT.search(content)
    return "" if match is None else match.group(1)


def _math_spans(text: str) -> list[Span]:
    parsed = parse_pandoc_for_lint(text)
    if parsed.document is None:
        return []

    spans: list[Span] = []
    for start, end in pandoc_math_regions(text, parsed.document):
        full_start, full_end, display = _expand_math(text, start, end)
        spans.append(Span(full_start, full_end, display, _punctuation(text[start:end])))

    cursor = 0
    for node in walk_pandoc(parsed.document):
        if node.get("t") not in {"RawInline", "RawBlock"}:
            continue
        content = node.get("c")
        if not isinstance(content, list) or len(content) != 2:
            continue
        fmt, raw = content
        if fmt not in {"tex", "latex"} or not isinstance(raw, str):
            continue
        found = text.find(raw, cursor)
        if found < 0:
            found = text.find(raw)
        if found < 0:
            continue
        inner = re.sub(r"\\end\{[^}]+\}\s*$", "", raw.strip())
        display = node.get("t") == "RawBlock" or "\n" in raw
        spans.append(Span(found, found + len(raw), display, _punctuation(inner)))
        cursor = found + len(raw)

    spans.sort(key=lambda span: (span.start, span.end))
    deduped: list[Span] = []
    for span in spans:
        if deduped and span.start < deduped[-1].end:
            if span.end <= deduped[-1].end:
                continue
            continue
        deduped.append(span)
    return deduped


def project_math(text: str) -> Projection:
    spans = _math_spans(text)
    if not spans:
        return Projection(text, tuple(range(len(text))), ())

    out: list[str] = []
    source_map: list[int] = []
    placeholders: list[tuple[int, int]] = []
    cursor = 0

    for span in spans:
        start, end = span.start, span.end
        if span.display:
            while start > cursor and text[start - 1].isspace():
                start -= 1
            while end < len(text) and text[end].isspace():
                end += 1

        for index in range(cursor, start):
            out.append(text[index])
            source_map.append(index)

        if span.display and out and not out[-1].isspace():
            out.append(" ")
            source_map.append(span.start)
        placeholder_start = len(out)
        replacement = "X" + span.punctuation
        for char in replacement:
            out.append(char)
            source_map.append(span.start)
        placeholder_end = len(out)
        placeholders.append((placeholder_start, placeholder_end))
        if span.display and end < len(text) and not text[end].isspace():
            out.append(" ")
            source_map.append(max(span.start, span.end - 1))
        cursor = end

    for index in range(cursor, len(text)):
        out.append(text[index])
        source_map.append(index)
    return Projection("".join(out), tuple(source_map), tuple(placeholders))


def _overlaps_placeholder(start: int, end: int, placeholders: tuple[tuple[int, int], ...]) -> bool:
    return any(start < right and end > left for left, right in placeholders)


def _mapped_range(projection: Projection, offset: int, length: int, source_length: int) -> tuple[int, int]:
    if not projection.source_map:
        return 0, 0
    start_index = max(0, min(offset, len(projection.source_map) - 1))
    if length <= 0:
        source = projection.source_map[start_index]
        return source, source
    end_index = max(start_index, min(offset + length - 1, len(projection.source_map) - 1))
    start = projection.source_map[start_index]
    end = min(source_length, projection.source_map[end_index] + 1)
    return min(start, end), max(start, end)


def _cli_check(text: str, context: dict[str, Any]) -> dict[str, Any]:
    language = str(context.get("language") or "auto")
    args = ["languagetool", "--json"]
    if language == "auto":
        args.append("--autoDetect")
    else:
        args.extend(["-l", language])
    disabled = [str(item) for item in context.get("disabledRules", []) if str(item)]
    if disabled:
        args.extend(["-d", ",".join(disabled)])
    if context.get("level") == "picky":
        args.extend(["--level", "PICKY"])
    mother_tongue = str(context.get("motherTongue") or "").strip()
    if mother_tongue:
        args.extend(["-m", mother_tongue])
    args.append("-")
    completed = subprocess.run(args, input=text, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"LanguageTool exited with {completed.returncode}")
    return json.loads(completed.stdout)


def _remote_check(text: str, context: dict[str, Any]) -> dict[str, Any]:
    backend = str(context.get("backend") or "official")
    server = str(context.get("customServer") or "").strip() if backend == "custom" else "https://api.languagetool.org"
    username = str(context.get("username") or "").strip()
    api_key = str(context.get("apiKey") or "").strip()
    if username and api_key:
        server = "https://api.languagetoolplus.com"
    server = server.rstrip("/")
    language = str(context.get("language") or "auto")
    params: dict[str, str] = {
        "language": language,
        "text": text,
        "level": str(context.get("level") or "default"),
    }
    disabled = [str(item) for item in context.get("disabledRules", []) if str(item)]
    if disabled:
        params["disabledRules"] = ",".join(disabled)
    mother = str(context.get("motherTongue") or "").strip()
    if mother:
        params["motherTongue"] = mother
    if username and api_key:
        params["username"] = username
        params["apiKey"] = api_key
    variants = context.get("variants")
    if language == "auto" and isinstance(variants, dict):
        params["preferredVariants"] = ",".join(str(value) for value in variants.values())
    request = urllib.request.Request(
        server + "/v2/check",
        data=urllib.parse.urlencode(params).encode(),
        method="POST",
        headers={"User-Agent": "external-linter/language-tool"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def _supported_languages(context: dict[str, Any]) -> list[str]:
    cached = context.get("supportedLanguages")
    if isinstance(cached, list) and cached:
        return [str(item) for item in cached]
    if str(context.get("backend") or "cli") != "cli":
        return []
    completed = subprocess.run(["languagetool", "--list"], text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        return []
    return [line.split(maxsplit=1)[0] for line in completed.stdout.splitlines() if line.strip()]


def run(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("text") or "")
    context = payload.get("context")
    if not isinstance(context, dict):
        context = {}
    if context.get("active") is False:
        return {"diagnostics": []}

    projection = project_math(text)
    backend = str(context.get("backend") or "cli")
    response = _cli_check(projection.text, context) if backend == "cli" else _remote_check(projection.text, context)
    user_dictionary = {str(item) for item in context.get("userDictionary", [])}
    diagnostics: list[dict[str, Any]] = []

    for match in response.get("matches", []):
        if not isinstance(match, dict):
            continue
        offset = int(match.get("offset", 0))
        length = int(match.get("length", 0))
        end = offset + max(length, 0)
        rule = match.get("rule") if isinstance(match.get("rule"), dict) else {}
        issue_type = str(rule.get("issueType") or "grammar")
        if length > 0 and any(
            left <= offset and end <= right for left, right in projection.placeholders
        ):
            continue
        source_from, source_to = _mapped_range(projection, offset, length, len(text))
        authored = text[source_from:source_to]
        if issue_type == "misspelling" and authored in user_dictionary:
            continue

        actions: list[dict[str, Any]] = []
        safe_replacement = not _overlaps_placeholder(offset, end, projection.placeholders)
        if safe_replacement:
            for replacement in match.get("replacements", [])[:10]:
                if isinstance(replacement, dict) and isinstance(replacement.get("value"), str):
                    actions.append(
                        {
                            "kind": "replace",
                            "name": replacement["value"],
                            "replacement": replacement["value"],
                            "markClass": "cm-ltSuggestAction",
                        }
                    )
        actions.append(
            {
                "kind": "command",
                "name": "Disable Rule",
                "command": "language-tool:disable-rule",
                "markClass": "cm-ltDisableAction",
                "payload": {
                    "rule": {
                        "description": str(rule.get("description") or rule.get("id") or "LanguageTool rule"),
                        "id": str(rule.get("id") or ""),
                        "category": str((rule.get("category") or {}).get("name") if isinstance(rule.get("category"), dict) else ""),
                    },
                    "ruleId": str(rule.get("id") or ""),
                },
            }
        )
        severity = "info" if issue_type == "style" else "error" if issue_type == "misspelling" else "warning"
        diagnostics.append(
            {
                "from": source_from,
                "to": source_to,
                "severity": severity,
                "message": str(match.get("message") or "LanguageTool diagnostic"),
                "source": f"language-tool({issue_type})",
                "data": {
                    "ruleId": str(rule.get("id") or ""),
                    "issueType": issue_type,
                },
                "actions": actions,
            }
        )

    language = response.get("language") if isinstance(response.get("language"), dict) else {}
    detected = language.get("detectedLanguage") if isinstance(language.get("detectedLanguage"), dict) else {}
    return {
        "diagnostics": diagnostics,
        "metadata": {
            "lastDetectedLanguage": str(detected.get("code") or language.get("code") or context.get("language") or "auto"),
            "supportedLanguages": _supported_languages(context),
        },
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        result = run(payload if isinstance(payload, dict) else {})
        json.dump(result, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    except Exception as error:
        json.dump({"diagnostics": [], "metadata": {"lastError": str(error)}}, sys.stdout)
        sys.stdout.write("\n")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
