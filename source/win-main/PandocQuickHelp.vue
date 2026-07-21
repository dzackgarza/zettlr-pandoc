<template>
  <Teleport to="body">
    <div
      class="pandoc-quick-help-backdrop"
      v-on:mousedown.self="emit('close')"
    >
      <section
        ref="dialog"
        class="pandoc-quick-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pandoc-quick-help-title"
        tabindex="-1"
      >
        <header>
          <div>
            <p class="eyebrow">
              {{ trans('Markdown syntax') }}
            </p>
            <h1 id="pandoc-quick-help-title">
              {{ trans('Pandoc quick reference') }}
            </h1>
            <p class="intro">
              {{ trans('Citation, cross-reference, and attribute syntax supported by the editor.') }}
            </p>
          </div>
          <button
            class="close"
            type="button"
            v-bind:aria-label="trans('Close')"
            v-on:click="emit('close')"
          >
            ×
          </button>
        </header>

        <div class="convention-note">
          <strong>{{ trans('Use pandoc-crossref labels.') }}</strong>
          <span>
            {{ trans('The editor currently recognizes the lower-case prefixes fig:, tbl:, eq:, and sec:. Use tbl:, not tab:.') }}
          </span>
        </div>

        <div class="help-grid">
          <section class="help-card citations">
            <div class="section-heading">
              <span class="section-number">01</span>
              <div>
                <h2>{{ trans('Cite sources') }}</h2>
                <p>{{ trans('Type @ to autocomplete citekeys from the configured bibliography.') }}</p>
              </div>
            </div>
            <dl class="example-list">
              <template v-for="example in citationExamples" v-bind:key="example.kind">
                <dt>{{ citationLabel(example.kind) }}</dt>
                <dd><code>{{ example.syntax }}</code></dd>
              </template>
            </dl>
            <p class="fine-print">
              {{ trans('Common locator terms include p., pp., chap., sec., fig., and §. Text after a citekey that is not a recognized locator remains a suffix.') }}
            </p>
          </section>

          <section class="help-card crossrefs">
            <div class="section-heading">
              <span class="section-number">02</span>
              <div>
                <h2>{{ trans('Label and reference') }}</h2>
                <p>{{ trans('Give each object a unique prefixed identifier, then cite that identifier with @.') }}</p>
              </div>
            </div>
            <div class="crossref-table" role="table" v-bind:aria-label="trans('Cross-reference syntax')">
              <div class="crossref-row crossref-header" role="row">
                <span role="columnheader">{{ trans('Object') }}</span>
                <span role="columnheader">{{ trans('Label') }}</span>
                <span role="columnheader">{{ trans('Reference') }}</span>
              </div>
              <div
                v-for="example in crossReferenceExamples"
                v-bind:key="example.kind"
                class="crossref-row"
                role="row"
              >
                <span role="cell">{{ crossrefLabel(example.kind) }}</span>
                <code role="cell">{{ example.label }}</code>
                <code role="cell">{{ example.reference }}</code>
              </div>
            </div>
          </section>

          <section class="help-card modifiers">
            <div class="section-heading">
              <span class="section-number">03</span>
              <div>
                <h2>{{ trans('Shape references') }}</h2>
                <p>{{ trans('Cross-references use Pandoc citation syntax, so they can be grouped or have their prefix changed.') }}</p>
              </div>
            </div>
            <dl class="example-list compact">
              <template v-for="example in referenceModifiers" v-bind:key="example.kind">
                <dt>{{ modifierLabel(example.kind) }}</dt>
                <dd><code>{{ example.syntax }}</code></dd>
              </template>
            </dl>
          </section>

          <section class="help-card attributes">
            <div class="section-heading">
              <span class="section-number">04</span>
              <div>
                <h2>{{ trans('Add Pandoc attributes') }}</h2>
                <p>{{ trans('Identifiers begin with #, classes with ., and key-value attributes use quotes.') }}</p>
              </div>
            </div>
            <dl class="example-list compact">
              <template v-for="example in attributeExamples" v-bind:key="example.kind">
                <dt>{{ attributeLabel(example.kind) }}</dt>
                <dd><code>{{ example.syntax }}</code></dd>
              </template>
            </dl>
          </section>
        </div>

        <footer>
          <strong>{{ trans('Editor behavior') }}</strong>
          <span>
            {{ trans('Rendered citations and cross-references reveal their source while the cursor is inside them. Cross-reference autocomplete and target previews are not currently available.') }}
          </span>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { trans } from '@common/i18n-renderer'
import {
  PANDOC_ATTRIBUTE_EXAMPLES,
  PANDOC_CITATION_EXAMPLES,
  PANDOC_CROSS_REFERENCE_EXAMPLES,
  PANDOC_REFERENCE_MODIFIERS,
} from '@common/util/pandoc-quick-reference'

const emit = defineEmits<(event: 'close') => void>()
const dialog = ref<HTMLElement|null>(null)

const citationExamples = PANDOC_CITATION_EXAMPLES
const crossReferenceExamples = PANDOC_CROSS_REFERENCE_EXAMPLES
const referenceModifiers = PANDOC_REFERENCE_MODIFIERS
const attributeExamples = PANDOC_ATTRIBUTE_EXAMPLES

function citationLabel (kind: typeof citationExamples[number]['kind']): string {
  const labels = {
    parenthetical: trans('Parenthetical'),
    narrative: trans('In text'),
    locator: trans('With locator'),
    'prefix-and-suffix': trans('Prefix and suffix'),
    multiple: trans('Multiple sources'),
    'suppress-author': trans('Suppress author'),
  }
  return labels[kind]
}

function crossrefLabel (kind: typeof crossReferenceExamples[number]['kind']): string {
  const labels = {
    figure: trans('Figure'),
    table: trans('Table'),
    equation: trans('Equation'),
    section: trans('Section'),
  }
  return labels[kind]
}

function modifierLabel (kind: typeof referenceModifiers[number]['kind']): string {
  const labels = {
    group: trans('Group references'),
    'custom-prefix': trans('Custom prefix'),
    'suppress-prefix': trans('Suppress prefix'),
  }
  return labels[kind]
}

function attributeLabel (kind: typeof attributeExamples[number]['kind']): string {
  const labels = {
    attributes: trans('Attribute list'),
    'fenced-div': trans('Fenced div'),
    'bracketed-span': trans('Bracketed span'),
  }
  return labels[kind]
}

function handleKeydown (event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  dialog.value?.focus()
})

onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown))
</script>

<style lang="less">
.pandoc-quick-help-backdrop {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  padding: clamp(16px, 4vw, 48px);
  background: rgba(14, 18, 24, .48);
  backdrop-filter: blur(4px);
}

.pandoc-quick-help {
  --help-bg: #f7f6f2;
  --help-panel: #ffffff;
  --help-text: #24272b;
  --help-muted: #686d73;
  --help-border: #dedcd5;
  --help-accent: #315e86;
  --help-accent-soft: #e7eef5;
  width: min(980px, 100%);
  max-height: min(820px, 100%);
  overflow: auto;
  box-sizing: border-box;
  color: var(--help-text);
  background: var(--help-bg);
  border: 1px solid rgba(255, 255, 255, .35);
  border-radius: 14px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, .32);
  font: 13px/1.45 system-ui, sans-serif;
  outline: none;

  > header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    padding: 26px 30px 20px;
    background: color-mix(in srgb, var(--help-bg) 92%, transparent);
    border-bottom: 1px solid var(--help-border);
    backdrop-filter: blur(12px);
  }

  h1, h2, p { margin: 0; }

  h1 {
    margin-top: 1px;
    font-size: 25px;
    font-weight: 650;
    letter-spacing: -.025em;
  }

  h2 {
    font-size: 15px;
    font-weight: 650;
  }

  .eyebrow {
    color: var(--help-accent);
    font-size: 10px;
    font-weight: 750;
    letter-spacing: .14em;
    text-transform: uppercase;
  }

  .intro, .section-heading p, .fine-print, footer span {
    color: var(--help-muted);
  }

  .intro { margin-top: 5px; }

  button.close {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    padding: 0;
    color: var(--help-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 50%;
    font-size: 24px;
    line-height: 1;

    &:hover, &:focus-visible {
      color: var(--help-text);
      background: var(--help-panel);
      border-color: var(--help-border);
      outline: none;
    }
  }

  .convention-note {
    display: flex;
    gap: 8px;
    margin: 20px 30px 0;
    padding: 11px 13px;
    color: #284a68;
    background: var(--help-accent-soft);
    border-left: 3px solid var(--help-accent);
    border-radius: 4px 8px 8px 4px;
  }

  .help-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
    gap: 14px;
    padding: 14px 30px 22px;
  }

  .help-card {
    min-width: 0;
    padding: 18px;
    background: var(--help-panel);
    border: 1px solid var(--help-border);
    border-radius: 10px;
  }

  .citations, .crossrefs { min-height: 295px; }

  .section-heading {
    display: flex;
    gap: 11px;
    margin-bottom: 15px;

    p { margin-top: 3px; }
  }

  .section-number {
    flex: 0 0 auto;
    padding-top: 2px;
    color: var(--help-accent);
    font-size: 10px;
    font-weight: 750;
    letter-spacing: .08em;
  }

  .example-list {
    display: grid;
    grid-template-columns: 118px minmax(0, 1fr);
    gap: 7px 10px;
    margin: 0;

    &.compact { grid-template-columns: 112px minmax(0, 1fr); }

    dt {
      align-self: center;
      color: var(--help-muted);
      font-size: 11px;
    }

    dd { min-width: 0; margin: 0; }
  }

  code {
    display: block;
    box-sizing: border-box;
    max-width: 100%;
    padding: 5px 7px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    color: #223a50;
    background: #f0f3f5;
    border: 1px solid #e0e5e9;
    border-radius: 5px;
    font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
  }

  .fine-print {
    margin-top: 12px;
    font-size: 11px;
  }

  .crossref-table {
    display: grid;
    gap: 5px;
  }

  .crossref-row {
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr) 78px;
    gap: 7px;
    align-items: center;

    > span:first-child {
      color: var(--help-muted);
      font-size: 11px;
    }
  }

  .crossref-header {
    padding: 0 1px 2px;
    color: var(--help-muted);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  > footer {
    display: flex;
    gap: 8px;
    margin: 0 30px 26px;
    padding-top: 15px;
    border-top: 1px solid var(--help-border);
    font-size: 11px;
  }
}

body.dark .pandoc-quick-help {
  --help-bg: #25282c;
  --help-panel: #2d3136;
  --help-text: #eef0f2;
  --help-muted: #aeb4bb;
  --help-border: #42474d;
  --help-accent: #8db9df;
  --help-accent-soft: #293d50;

  .convention-note { color: #c8e3fa; }

  code {
    color: #d4e8f8;
    background: #20252a;
    border-color: #3b4249;
  }
}

@media (max-width: 760px) {
  .pandoc-quick-help-backdrop { padding: 10px; }

  .pandoc-quick-help {
    max-height: 100%;
    border-radius: 10px;

    > header { padding: 20px 18px 16px; }
    .convention-note { flex-direction: column; gap: 3px; margin: 14px 18px 0; }
    .help-grid { grid-template-columns: 1fr; padding: 12px 18px 18px; }
    .citations, .crossrefs { min-height: 0; }
    > footer { margin: 0 18px 20px; }
  }
}

@media (max-width: 460px) {
  .pandoc-quick-help {
    > footer { flex-direction: column; gap: 3px; }
    .example-list, .example-list.compact { grid-template-columns: 1fr; gap: 3px; }
    .example-list dd { margin-bottom: 5px; }
    .crossref-row { grid-template-columns: 50px minmax(0, 1fr); }
    .crossref-row > :last-child { grid-column: 2; }
    .crossref-header { display: none; }
  }
}
</style>
