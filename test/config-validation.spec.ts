/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Configuration validation specs (#164)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Every validation rule accepts the value that the shipped
 *                  configuration template gives its option, and refuses a
 *                  value outside its ruleset. The template is the real
 *                  getConfigTemplate, built under an Electron stub because
 *                  it reads the locale, the version and the theme from
 *                  Electron.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import Module from "module";
import type {
  ConfigJsonValue,
  ValidationRule,
} from "source/app/service-providers/config/config-validation";
import type { ConfigOptions } from "source/app/service-providers/config/get-config-template";

/** The parts of Electron that the configuration template reads. */
const electronStub = {
  app: {
    getLocale: () => "",
    getVersion: () => "0.0.0",
    getPath: () => "/home/user",
  },
  nativeTheme: { shouldUseDarkColors: false },
  ipcMain: { handle() {}, on() {} },
};

/** What Module._load returns: the exports of whatever module was requested. */
type ModuleExports = ReturnType<NodeJS.Require>;
type ModuleLoad = (
  this: typeof Module,
  request: string,
  ...rest: ReadonlyArray<string | boolean>
) => ModuleExports;
const moduleWithLoad = Module as typeof Module & { _load: ModuleLoad };
const buildGlobals = globalThis as typeof globalThis & { __BUILD_DATE__?: number };

/** A value of the template that each rule refuses. */
const INVALID: Record<string, ConfigJsonValue> = {
  darkMode: "yes",
  darkModeEditor: "sepia",
  autoDarkMode: "always",
  fileMeta: 1,
  sorting: "random",
  newFileNamePattern: 7,
  appLang: "e",
  fileManagerMode: "wide",
  "fileManager.expandedDirectories": "/a",
  "fileManager.ignoreRules": "*.tmp",
  "fileManager.showIgnored": "no",
  "fileManager.filters.include": "md",
  muteLines: "no",
  "export.dir": "home",
  "export.stripTags": "no",
  "export.stripLinks": "some",
  "export.cslLibrary": 3,
  "zkn.idRE": 3,
  "zkn.idGen": "a",
  attachmentExtensions: ".pdf",
  debug: "no",
  "editor.indentUnit": 25,
  "editor.boldFormatting": "*",
  "editor.italicFormatting": "__",
  "editor.readabilityAlgorithm": "flesch",
  "display.imageWidth": 0,
  "display.imageHeight": 101,
  "watchdog.stabilityThreshold": 100001,
  "ui.recentFilesLimit": 0,
};

function templateValue(template: ConfigOptions, option: string): ConfigJsonValue {
  let value: ConfigJsonValue = template;
  for (const key of option.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)) {
      throw new Error(`The configuration template has no option "${option}".`);
    }
    value = value[key];
  }
  return value;
}

describe("Configuration validation (#164)", function () {
  let template: ConfigOptions;
  let rules: ValidationRule[];
  const originalLoad = moduleWithLoad._load;

  before(async function () {
    moduleWithLoad._load = function (request, ...rest) {
      return request === "electron" ? electronStub : originalLoad.call(this, request, ...rest);
    };
    buildGlobals.__BUILD_DATE__ = 0;
    const { getConfigTemplate } = await import(
      "source/app/service-providers/config/get-config-template"
    );
    const { validationRules } = await import(
      "source/app/service-providers/config/config-validation"
    );
    template = getConfigTemplate();
    rules = validationRules();
  });

  after(function () {
    moduleWithLoad._load = originalLoad;
    delete buildGlobals.__BUILD_DATE__;
  });

  it("accepts the template value of every option that has a rule", function () {
    const refused = rules
      .map((rule) => rule.getKey())
      .filter((option, index) => !rules[index].validate(templateValue(template, option)));
    assert.deepStrictEqual(refused, []);
  });

  it("refuses a value outside the ruleset of every option", function () {
    assert.deepStrictEqual(rules.map((rule) => rule.getKey()).sort(), Object.keys(INVALID).sort());
    const accepted = rules
      .map((rule) => rule.getKey())
      .filter((option, index) => rules[index].validate(INVALID[option]));
    assert.deepStrictEqual(accepted, []);
  });
});
