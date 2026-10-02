<template>
  <div id="problems-view">
    <div class="problems-controls">
      <select v-model="scope" aria-label="Problem scope">
        <option value="workspace">This workspace</option>
        <option value="all">All workspaces</option>
      </select>
      <select v-model="minimumSeverity" aria-label="Minimum severity">
        <option value="info">All severities</option>
        <option value="warning">Warnings and errors</option>
        <option value="error">Errors</option>
      </select>
      <select v-model="grouping" aria-label="Group problems">
        <option value="document">By document</option>
        <option value="rule">By rule</option>
      </select>
      <button type="button" aria-label="Refresh problems" @click="refresh">Refresh</button>
    </div>
    <p v-if="error" class="problems-state">{{ error }}</p>
    <p v-else-if="answer === null" class="problems-state">Loading problems…</p>
    <template v-else>
      <p v-if="visibleFindings.length === 0 && answer.pendingPaths.length === 0" class="problems-state">No problems</p>
      <div v-if="grouping === 'document'">
        <details v-for="document in visibleDocuments" :key="document.path" :open="visibleDocuments.length <= 30" class="problems-group">
          <summary>{{ document.name }} <span>{{ document.counts.error }} errors · {{ document.counts.warning }} warnings · {{ document.counts.info }} info</span><span v-if="document.state === 'stale'"> · Stale</span></summary>
          <div v-for="finding in filtered(document.diagnostics)" :key="`${finding.rule}:${finding.from}:${finding.to}:${finding.message}`" class="problems-finding" :data-severity="finding.severity">
            <button type="button" class="problems-jump" @click="emit('navigate', { path: document.path, from: finding.from, to: finding.to })">
              <strong>{{ finding.severity }}</strong> {{ finding.message }}
              <small>{{ finding.rule }} · {{ finding.line }}:{{ finding.column }}</small>
            </button>
            <button v-if="finding.fix !== null && document.state === 'current'" type="button" class="problems-fix" :title="finding.fix.title" @click="applyFix(document, finding)">Fix</button>
          </div>
        </details>
      </div>
      <div v-else>
        <details v-for="group in ruleGroups" :key="group.rule" open class="problems-group">
          <summary>{{ group.rule }} <span>{{ group.findings.length }}</span></summary>
          <div v-for="entry in group.findings" :key="`${entry.document.path}:${entry.finding.from}:${entry.finding.message}`" class="problems-finding" :data-severity="entry.finding.severity">
            <button type="button" class="problems-jump" @click="emit('navigate', { path: entry.document.path, from: entry.finding.from, to: entry.finding.to })">
              <strong>{{ entry.finding.severity }}</strong> {{ entry.finding.message }}
              <small>{{ entry.document.name }} · {{ entry.finding.line }}:{{ entry.finding.column }}<span v-if="entry.document.state === 'stale'"> · Stale</span></small>
            </button>
            <button v-if="entry.finding.fix !== null && entry.document.state === 'current'" type="button" class="problems-fix" :title="entry.finding.fix.title" @click="applyFix(entry.document, entry.finding)">Fix</button>
          </div>
        </details>
      </div>
      <details v-if="answer.pendingPaths.length" open class="problems-group" data-problems-pending>
        <summary>{{ answer.pendingPaths.length }} pending</summary>
        <div v-for="path in answer.pendingPaths" :key="path" class="problems-state" :title="path">{{ pathBasename(path) }}</div>
      </details>
    </template>
  </div>
</template>

<script setup lang="ts">
import { pathBasename } from "@common/util/renderer-path-polyfill";
import type { ProblemDocument, ProblemFinding, ProblemScope, ProblemSeverity, WorkspaceProblems } from "@dts/common/problems";
import { useDocumentTreeStore, useWorkspaceStore } from "source/pinia";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

const emit = defineEmits<{
  (event: "navigate", target: { path: string; from: number; to: number }): void;
  (event: "count", count: number): void;
}>();
const ipcRenderer = window.ipc;
const workspaceStore = useWorkspaceStore();
const documentTreeStore = useDocumentTreeStore();
const scope = ref<ProblemScope>("workspace");
const minimumSeverity = ref<ProblemSeverity>("info");
const grouping = ref<"document" | "rule">("document");
const answer = ref<WorkspaceProblems | null>(null);
const error = ref("");

const workspacePath = computed(() => {
  const activePath = documentTreeStore.lastLeafActiveFile?.path;
  const roots = workspaceStore.rootDescriptors.filter((descriptor) => descriptor.type === "directory");
  return roots
    .filter((descriptor) => activePath !== undefined && (activePath === descriptor.path || activePath.startsWith(`${descriptor.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? roots[0]?.path;
});

const weight: Record<ProblemSeverity, number> = { info: 0, warning: 1, error: 2 };
function filtered(findings: ProblemFinding[]): ProblemFinding[] {
  return findings.filter((finding) => weight[finding.severity] >= weight[minimumSeverity.value]);
}
const visibleDocuments = computed(() => (answer.value?.documents ?? []).filter((document) => filtered(document.diagnostics).length > 0));
const visibleFindings = computed(() => visibleDocuments.value.flatMap((document) => filtered(document.diagnostics)));
const ruleGroups = computed(() => {
  const groups = new Map<string, { document: ProblemDocument; finding: ProblemFinding }[]>();
  for (const document of visibleDocuments.value) {
    for (const finding of filtered(document.diagnostics)) {
      const list = groups.get(finding.rule) ?? [];
      list.push({ document, finding });
      groups.set(finding.rule, list);
    }
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([rule, findings]) => ({ rule, findings }));
});

async function refresh(): Promise<void> {
  try {
    error.value = "";
    const result: WorkspaceProblems = await ipcRenderer.invoke("application", {
      command: "list-workspace-lint",
      payload: { scope: scope.value, workspacePath: workspacePath.value },
    });
    answer.value = result;
    emit("count", result.documents.reduce((total, document) => total + document.diagnostics.length, 0));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function applyFix(document: ProblemDocument, finding: ProblemFinding): Promise<void> {
  if (finding.fix === null || document.state !== "current") return;
  try {
    const result = await ipcRenderer.invoke("application", {
      command: "apply-lint-fix",
      payload: {
        documentPath: document.path,
        sourceHash: document.sourceHash,
        from: finding.from,
        to: finding.to,
        replacement: finding.fix.replacement,
      },
    });
    if (result.status === "conflict") error.value = "Document changed. Refresh problems before fixing it.";
    else await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

watch([scope, workspacePath], () => { void refresh(); });
function onLintChanged(): void { void refresh(); }
let stopLintChanged: (() => void) | undefined;
onMounted(() => {
  stopLintChanged = ipcRenderer.on("document-lint-changed", onLintChanged);
  void refresh();
});
onUnmounted(() => stopLintChanged?.());
</script>

<style lang="less" scoped>
#problems-view { height: 100%; overflow: auto; color: var(--chrome-text); }
.problems-controls { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px; }
.problems-controls select, .problems-controls button { max-width: 100%; font: inherit; }
.problems-state { padding: 8px; color: var(--chrome-text-muted); }
.problems-group { border-top: 1px solid var(--chrome-border); }
.problems-group summary { padding: 7px 8px; cursor: pointer; overflow-wrap: anywhere; }
.problems-group summary span { color: var(--chrome-text-muted); }
.problems-finding { display: flex; align-items: start; gap: 4px; padding: 3px 8px 3px 16px; }
.problems-jump { flex: 1; min-width: 0; text-align: left; border: 0; background: none; color: inherit; cursor: pointer; overflow-wrap: anywhere; }
.problems-jump small { display: block; color: var(--chrome-text-muted); }
.problems-fix { flex: none; }
.problems-finding[data-severity="error"] strong { color: var(--fg-error); }
.problems-finding[data-severity="warning"] strong { color: var(--orange-2); }
:global(body.dark) .problems-finding[data-severity="error"] strong { color: var(--bg-error); }
:global(body.dark) .problems-finding[data-severity="warning"] strong { color: var(--orange-0); }
</style>
