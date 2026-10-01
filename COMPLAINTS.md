# Complaints

## YAML front matter widget: the Properties card looks bad

User said: the YAML front matter widget (the Properties card) looks bad.

Diagnosis: the card is a nested CodeMirror editor inside the outer editor. Rules written for the outer editor as descendant selectors also match the inner editor, and they win over the widget's own theme.

| Symptom | Winning rule | Widget rule that loses |
|---|---|---|
| 50 px of empty space on all four sides | `source/win-main/MainEditor.vue:1879`: `.cm-scroller { padding: 50px 50px }` under `.cm-editor` | none |
| Prose font at the prose size, not the code font at 0.9 em | `source/common/modules/markdown-editor/theme/editor.ts:379`: the `font` shorthand on `.cm-scroller`, later in the sheet at equal specificity | `render-yaml-frontmatter.ts:191` and `:198` |
| Opaque grey header bar | `source/common/vue/window/assets/generic.css:128`: `body.linux.dark button` (0,2,1) beats `.yaml-frontmatter-header` (0,2,0); the header is a `<button>` | `render-yaml-frontmatter.ts:385-395` |

`nestedEditorExtensions` also calls `EditorView.theme(...)` once for each widget instance (`render-yaml-frontmatter.ts:186`). The style module never removes these sheets, so each new widget adds one more copy.
