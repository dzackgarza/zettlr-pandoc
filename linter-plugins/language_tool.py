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
from typing import Literal, TypedDict

from flowmark.lint_rules import pandoc_math_regions
from flowmark.pandoc_lint import parse_pandoc_for_lint, walk_pandoc

TRAILING_PUNCT = re.compile(r"([,.;:!?])\s*$")


class Variants(TypedDict):
    en: str
    de: str
    pt: str
    ca: str


class LanguageToolContext(TypedDict):
    """The context the host sends: `runLanguageToolBackend` in
    source/app/util/external-linter-registry.ts merges the renderer's
    `LanguageToolDiagnosticContext` with `editor.lint.languageTool` config."""

    active: bool
    language: str
    disabledRules: list[str]
    supportedLanguages: list[str]
    userDictionary: list[str]
    level: Literal["picky", "default"]
    motherTongue: str
    variants: Variants
    backend: Literal["cli", "official", "custom"]
    customServer: str
    username: str
    apiKey: str


class Payload(TypedDict):
    text: str
    context: LanguageToolContext


class LTReplacement(TypedDict):
    value: str


class LTCategory(TypedDict):
    id: str
    name: str


class LTRule(TypedDict):
    id: str
    description: str
    issueType: str
    category: LTCategory


class LTMatch(TypedDict):
    message: str
    offset: int
    length: int
    replacements: list[LTReplacement]
    rule: LTRule


class LTDetectedLanguage(TypedDict):
    code: str


class LTLanguage(TypedDict):
    code: str
    detectedLanguage: LTDetectedLanguage


class LTResponse(TypedDict):
    """The `/v2/check` response, which `languagetool --json` also prints."""

    language: LTLanguage
    matches: list[LTMatch]


class LTLanguageEntry(TypedDict):
    """One entry of the `/v2/languages` response."""

    longCode: str


class ReplaceAction(TypedDict):
    kind: Literal["replace"]
    name: str
    replacement: str
    markClass: str


class IgnoredRule(TypedDict):
    """`LanguageToolIgnoredRuleEntry` in get-config-template.ts."""

    description: str
    id: str
    category: str


class DisableRulePayload(TypedDict):
    """`DisableLanguageToolRulePayload` in diagnostics/providers/language-tool.ts."""

    rule: IgnoredRule
    ruleId: str


class CommandAction(TypedDict):
    kind: Literal["command"]
    name: str
    command: str
    markClass: str
    payload: DisableRulePayload


class DiagnosticData(TypedDict):
    ruleId: str
    issueType: str


# `from` is a Python keyword, so this TypedDict uses the functional syntax.
Diagnostic = TypedDict(
    "Diagnostic",
    {
        "from": int,
        "to": int,
        "severity": Literal["info", "warning", "error"],
        "message": str,
        "source": str,
        "data": DiagnosticData,
        "actions": list[ReplaceAction | CommandAction],
    },
)


class Metadata(TypedDict):
    lastDetectedLanguage: str
    supportedLanguages: list[str]


class Result(TypedDict):
    diagnostics: list[Diagnostic]
    metadata: Metadata


class InactiveResult(TypedDict):
    """The answer while the user has LanguageTool switched off."""

    diagnostics: list[Diagnostic]


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
        # Without Pandoc's parse the math cannot be projected out, and
        # LanguageTool would check TeX as prose.
        raise RuntimeError(f"Pandoc could not parse the document: {parsed.messages}")

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


def _cli_check(text: str, context: LanguageToolContext) -> LTResponse:
    args = ["languagetool", "--json"]
    if context["language"] == "auto":
        args.append("--autoDetect")
    else:
        args.extend(["-l", context["language"]])
    if context["disabledRules"]:
        args.extend(["-d", ",".join(context["disabledRules"])])
    if context["level"] == "picky":
        args.extend(["--level", "PICKY"])
    # An empty mother tongue is the unset state of the preference.
    if context["motherTongue"].strip():
        args.extend(["-m", context["motherTongue"].strip()])
    args.append("-")
    completed = subprocess.run(args, input=text, text=True, capture_output=True, check=True)
    response: LTResponse = json.loads(completed.stdout)
    return response


def _premium(context: LanguageToolContext) -> bool:
    return bool(context["username"].strip() and context["apiKey"].strip())


def _remote_server(context: LanguageToolContext) -> str:
    if _premium(context):
        return "https://api.languagetoolplus.com"
    if context["backend"] == "official":
        return "https://api.languagetool.org"
    server = context["customServer"].strip().rstrip("/")
    if not server:
        raise ValueError("The custom LanguageTool backend is selected but no server URL is configured")
    return server


def _remote_check(text: str, context: LanguageToolContext) -> LTResponse:
    params: dict[str, str] = {
        "language": context["language"],
        "text": text,
        "level": context["level"],
    }
    if context["disabledRules"]:
        params["disabledRules"] = ",".join(context["disabledRules"])
    # An empty mother tongue is the unset state of the preference.
    if context["motherTongue"].strip():
        params["motherTongue"] = context["motherTongue"].strip()
    if _premium(context):
        params["username"] = context["username"].strip()
        params["apiKey"] = context["apiKey"].strip()
    if context["language"] == "auto":
        variants = context["variants"]
        params["preferredVariants"] = ",".join((variants["en"], variants["de"], variants["pt"], variants["ca"]))
    request = urllib.request.Request(
        _remote_server(context) + "/v2/check",
        data=urllib.parse.urlencode(params).encode(),
        method="POST",
        headers={"User-Agent": "external-linter/language-tool"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        checked: LTResponse = json.load(response)
        return checked


def _supported_languages(context: LanguageToolContext) -> list[str]:
    # The renderer echoes back the list from the previous run once it has one.
    if context["supportedLanguages"]:
        return context["supportedLanguages"]
    if context["backend"] == "cli":
        completed = subprocess.run(["languagetool", "--list"], text=True, capture_output=True, check=True)
        return [line.split(maxsplit=1)[0] for line in completed.stdout.splitlines() if line.strip()]
    request = urllib.request.Request(
        _remote_server(context) + "/v2/languages",
        headers={"User-Agent": "external-linter/language-tool"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        languages: list[LTLanguageEntry] = json.load(response)
        return [language["longCode"] for language in languages]


def _severity(issue_type: str) -> Literal["info", "warning", "error"]:
    if issue_type == "style":
        return "info"
    if issue_type == "misspelling":
        return "error"
    return "warning"


def _actions(match: LTMatch, replaceable: bool) -> list[ReplaceAction | CommandAction]:
    actions: list[ReplaceAction | CommandAction] = []
    if replaceable:
        for replacement in match["replacements"][:10]:
            actions.append(
                {
                    "kind": "replace",
                    "name": replacement["value"],
                    "replacement": replacement["value"],
                    "markClass": "cm-ltSuggestAction",
                }
            )
    rule = match["rule"]
    actions.append(
        {
            "kind": "command",
            "name": "Disable Rule",
            "command": "language-tool:disable-rule",
            "markClass": "cm-ltDisableAction",
            "payload": {
                "rule": {
                    "description": rule["description"],
                    "id": rule["id"],
                    "category": rule["category"]["name"],
                },
                "ruleId": rule["id"],
            },
        }
    )
    return actions


def run(payload: Payload) -> Result | InactiveResult:
    text = payload["text"]
    context = payload["context"]
    if not context["active"]:
        return {"diagnostics": []}

    projection = project_math(text)
    if context["backend"] == "cli":
        response = _cli_check(projection.text, context)
    else:
        response = _remote_check(projection.text, context)
    user_dictionary = set(context["userDictionary"])
    diagnostics: list[Diagnostic] = []

    for match in response["matches"]:
        offset = match["offset"]
        length = match["length"]
        end = offset + length
        issue_type = match["rule"]["issueType"]
        if length > 0 and any(left <= offset and end <= right for left, right in projection.placeholders):
            continue
        source_from, source_to = _mapped_range(projection, offset, length, len(text))
        authored = text[source_from:source_to]
        if issue_type == "misspelling" and authored in user_dictionary:
            continue

        diagnostics.append(
            {
                "from": source_from,
                "to": source_to,
                "severity": _severity(issue_type),
                "message": match["message"],
                "source": f"language-tool({issue_type})",
                "data": {
                    "ruleId": match["rule"]["id"],
                    "issueType": issue_type,
                },
                "actions": _actions(match, not _overlaps_placeholder(offset, end, projection.placeholders)),
            }
        )

    return {
        "diagnostics": diagnostics,
        "metadata": {
            "lastDetectedLanguage": response["language"]["detectedLanguage"]["code"],
            "supportedLanguages": _supported_languages(context),
        },
    }


def main() -> int:
    # A failure propagates as a traceback on stderr and a nonzero exit; the
    # host reports that stderr as the run's lastError.
    payload: Payload = json.load(sys.stdin)
    print(json.dumps(run(payload), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
