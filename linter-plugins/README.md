# External linter process plugins

External linter backends are registered in
`source/app/util/external-linter-registry.ts` and communicate through the
editor-neutral diagnostic contract in
`source/common/diagnostics/external-linter.ts`.

The renderer has one execution IPC:

```text
run-external-linter { id, text, context }
```

Adding another external linter therefore requires a backend registration, not
another CodeMirror lint source or another IPC command.

Process-backed plugins read one JSON object from stdin:

```json
{
  "text": "authored source",
  "context": {}
}
```

and write one JSON object to stdout:

```json
{
  "diagnostics": [
    {
      "from": 0,
      "to": 4,
      "severity": "warning",
      "message": "diagnostic text",
      "source": "provider(rule)"
    }
  ],
  "metadata": {}
}
```

Offsets always refer to the original authored source. Any projection required
by a linter belongs inside that linter plugin and must map its results back to
those source offsets before returning.

## LanguageTool

`language_tool.py` is one such plugin. It:

1. parses the document with Flowmark's Pandoc-authoritative lint parser;
2. reconciles Pandoc math and Pandoc-identified raw TeX to source ranges;
3. projects mathematical constituents to opaque `X` tokens while preserving
   equation punctuation and sentence continuity across display math;
4. invokes either the local `languagetool --json` CLI or an explicitly
   configured remote LanguageTool backend;
5. maps LanguageTool offsets back to the authored source;
6. suppresses diagnostics wholly inside projected mathematics and omits unsafe
   replacement actions whose ranges cross a projected formula.

The editor does not perform this transformation.
