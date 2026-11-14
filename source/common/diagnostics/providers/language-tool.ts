import type { ExternalLinter } from "@common/diagnostics/external-linter";
import { ipcExternalLinter } from "@common/diagnostics/providers/ipc";
import { reportError } from "@common/util/error-reporting";
import type { LanguageToolIgnoredRuleEntry } from "@providers/config/get-config-template";

const userDictionary = new Set<string>();

export interface LanguageToolDiagnosticContext extends Record<string, unknown> {
  active: boolean;
  language: string;
  disabledRules: string[];
  supportedLanguages: string[];
  userDictionary: string[];
}

export interface LanguageToolDiagnosticMetadata {
  lastDetectedLanguage?: string;
  supportedLanguages?: string[];
  lastError?: string;
}

export interface DisableLanguageToolRulePayload {
  rule: LanguageToolIgnoredRuleEntry;
  ruleId: string;
}

export function languageToolUserDictionary(): string[] {
  return [...userDictionary];
}

// The window has the listener from the load of the module, so the set of its
// IPC listeners does not change when the first check runs (#70).
if (window.ipc !== undefined) {
  window.ipc.on("dictionary-provider", (_event, message) => {
    if (message.command === "invalidate-dict") {
      refreshLanguageToolUserDictionary();
    }
  });
}

export function refreshLanguageToolUserDictionary(): void {
  if (window.ipc === undefined) {
    return;
  }
  userDictionary.clear();
  window.ipc
    .invoke("dictionary-provider", { command: "get-user-dictionary" })
    .then((dictionary: string[]) => {
      for (const word of dictionary) {
        userDictionary.add(word);
      }
    })
    .catch((err) => reportError("Could not load the user dictionary for LanguageTool", err));
}

export const languageToolDiagnosticProvider: ExternalLinter<
  LanguageToolDiagnosticContext,
  LanguageToolDiagnosticMetadata
> = ipcExternalLinter<LanguageToolDiagnosticContext, LanguageToolDiagnosticMetadata>(
  "language-tool",
);
