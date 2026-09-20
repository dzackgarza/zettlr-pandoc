import { strict as assert } from "node:assert";
import "./provision-renderer-window-seams";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TexResourceProbeRequest } from "source/app/util/tex-resource-resolver";
import { __resetTikzTemplateCompletionCacheForTests } from "source/common/modules/markdown-editor/autocomplete/tex-commands";
import { scholarlyLintSource } from "source/common/modules/markdown-editor/linters/scholarly-lint";
import { workspaceReferencesField } from "source/common/modules/markdown-editor/plugins/workspace-references-field";
import {
  configField,
  configUpdateEffect,
  getDefaultConfig,
} from "source/common/modules/markdown-editor/util/configuration";

function viewFor(doc: string, sourcePath = ""): EditorView {
  let state = EditorState.create({ doc, extensions: sourcePath === "" ? [] : [configField] });
  if (sourcePath !== "") {
    state = state.update({
      effects: configUpdateEffect.of({
        metadata: { ...getDefaultConfig().metadata, path: sourcePath },
      }),
    }).state;
  }
  return { state } as EditorView;
}

function installFakeInvoke(
  handler: (channel: string, request?: unknown) => Promise<unknown>,
): void {
  window.ipc.invoke = handler as typeof window.ipc.invoke;
}

function isResourceProbeRequest(value: unknown): value is TexResourceProbeRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "resources" in value &&
    Array.isArray(value.resources)
  );
}

describe("scholarly mathematical document diagnostics", function () {
  let originalInvoke: typeof window.ipc.invoke;
  let resourceProbeCalls = 0;

  beforeEach(function () {
    originalInvoke = window.ipc.invoke;
    resourceProbeCalls = 0;
    __resetTikzTemplateCompletionCacheForTests();
    installFakeInvoke(async (channel: string, request?: unknown) => {
      if (channel === "mathjax-macros") {
        return {
          Spec: "\\operatorname{Spec}",
          Hom: "\\operatorname{Hom}",
          ZZ: "\\mathbb{Z}",
        };
      }
      if (channel === "tex-macro-commands") {
        return ["\\CompilerOnly"];
      }
      if (channel === "tex-resource-probe") {
        if (!isResourceProbeRequest(request)) {
          throw new Error("tex-resource-probe test request has the wrong shape");
        }
        resourceProbeCalls += 1;
        return request.resources.map((resource: { id: number; path: string }) =>
          resource.path.includes("missing")
            ? { id: resource.id, checkable: true }
            : { id: resource.id, checkable: true, resolvedPath: `/resolved/${resource.path}` },
        );
      }
      if (channel === "tikz-completion-commands") {
        return [];
      }
      throw new Error(`unexpected IPC ${channel}`);
    });
  });

  afterEach(function () {
    window.ipc.invoke = originalInvoke;
    __resetTikzTemplateCompletionCacheForTests();
  });

  it("accepts standard, configured, and locally declared macros but reports an unknown math macro", async function () {
    const doc = [
      "\\newcommand{\\localop}{\\operatorname{localop}}",
      "\\DeclarePairedDelimiter\\localpair{[}{]}",
      "% \\newcommand{\\commentedMacro}{wrong}",
      "",
      "Use $\\frac{1}{2} + \\Spec R + \\CompilerOnly X + \\localop(x) + \\localpair{x} + \\commentedMacro + \\typoMacro(y)$.",
    ].join("\n");
    const diagnostics = await scholarlyLintSource(viewFor(doc));

    const unknown = diagnostics.filter((diagnostic) =>
      /(?:typoMacro|commentedMacro)/u.test(diagnostic.message),
    );
    // Pandoc parses `%` as ordinary Markdown text here and the following
    // `\newcommand{\commentedMacro}{wrong}` as real RawInline(tex); its macro
    // expansion therefore makes `\commentedMacro` an actual declaration.
    assert.equal(unknown.length, 1);
    assert.match(unknown[0].message, /\\typoMacro/u);
    assert.ok(unknown.every((diagnostic) => diagnostic.severity === "warning"));
    for (const command of ["\\frac", "\\Spec", "\\CompilerOnly", "\\localop", "\\localpair"]) {
      assert.equal(
        diagnostics.some((diagnostic) => diagnostic.message.includes(`${command} is not defined`)),
        false,
        `${command} is defined in the configured or local macros`,
      );
    }
  });

  it("reports a minority notation variant only after the document establishes a convention", async function () {
    const doc =
      "Write $\\epsilon_x + \\epsilon_y + \\varepsilon_z$, but $\\phi$ and $\\varphi$ each occur once.\n";
    const diagnostics = await scholarlyLintSource(viewFor(doc));

    const epsilon = diagnostics.filter((diagnostic) => /Use one form consistently/u.test(diagnostic.message));
    assert.equal(epsilon.length, 1);
    assert.match(epsilon[0].message, /\\epsilon/u);
    assert.match(epsilon[0].message, /\\varepsilon/u);
    assert.equal(
      diagnostics.some(
        (diagnostic) =>
          /\\phi/u.test(diagnostic.message) && /Use one form consistently/u.test(diagnostic.message),
      ),
      false,
      "one use of each variant establishes no dominant convention",
    );
  });

  it("prefers unique configured semantic macros over their hand-spelled expansions", async function () {
    const doc =
      "Let $X = \\operatorname{Spec} R$, $n \\in \\mathbb{Z}$, $Y = \\Spec S$, and $m \\in \\ZZ$.\n";
    const diagnostics = await scholarlyLintSource(viewFor(doc));
    for (const macro of ["\\Spec", "\\ZZ"]) {
      const convention = diagnostics.find((diagnostic) =>
        diagnostic.message.startsWith(`${macro} expands to `),
      );
      assert.ok(convention !== undefined, `${macro} should own its exact configured expansion`);
      assert.equal(convention.severity, "info");
    }
  });

  it("surfaces authorial residue but leaves literal code examples alone", async function () {
    const doc = [
      "TODO: replace this argument. [citation needed] ???",
      "",
      "```text",
      "TODO FIXME ??? [citation needed]",
      "```",
    ].join("\n");
    const diagnostics = await scholarlyLintSource(viewFor(doc));
    const residue = diagnostics.filter((diagnostic) => /remains in the document\.$/u.test(diagnostic.message));
    assert.equal(residue.length, 3);
    assert.ok(residue.every((diagnostic) => diagnostic.from < doc.indexOf("```text")));
  });

  it("reports only TeX resources the compiler-aware resolver says are missing", async function () {
    const doc = [
      "\\input{sections/existing}",
      "\\input{sections/missing}",
      "\\graphicspath{{figures/}{../shared/}}",
      "\\includegraphics{diagram.pdf}",
      "\\includegraphics{missing-diagram.pdf}",
      "[link](assets/\\input{missing-link-target}.md)",
      "",
      "<!-- \\input{comment/missing} -->",
      "```tex",
      "\\input{example/missing}",
      "```",
    ].join("\n");
    const diagnostics = await scholarlyLintSource(viewFor(doc, "/workspace/paper.md"));
    const missing = diagnostics.filter((diagnostic) => /^Can't find TeX/u.test(diagnostic.message));
    assert.equal(missing.length, 2);
    assert.ok(missing.some((diagnostic) => diagnostic.message.includes("sections/missing")));
    assert.ok(missing.some((diagnostic) => diagnostic.message.includes("missing-diagram.pdf")));
    assert.equal(
      missing.some((diagnostic) => diagnostic.message.includes("comment/missing")),
      false,
    );
    assert.equal(
      missing.some((diagnostic) => diagnostic.message.includes("example/missing")),
      false,
    );
    assert.equal(
      missing.some((diagnostic) => diagnostic.message.includes("missing-link-target")),
      false,
      "TeX-looking text owned by a Markdown link destination is not a TeX resource",
    );
  });

  it("waits for workspace/Project authority before diagnosing project-root resources", async function () {
    const doc = "\\input{project/only/missing}\n";
    let state = EditorState.create({ doc, extensions: [configField, workspaceReferencesField] });
    state = state.update({
      effects: configUpdateEffect.of({
        metadata: { ...getDefaultConfig().metadata, path: "/workspace/chapter/paper.md" },
      }),
    }).state;

    const diagnostics = await scholarlyLintSource({ state } as EditorView);
    assert.equal(
      resourceProbeCalls,
      0,
      "resource lookup must not run against an incomplete Project-root set",
    );
    assert.equal(
      diagnostics.some((diagnostic) => /not resolvable/u.test(diagnostic.message)),
      false,
    );
  });
});
