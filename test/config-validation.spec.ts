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
 *                  getConfigTemplate under the headless Electron harness,
 *                  because it reads the version and the theme from Electron.
 *
 * END HEADER
 */

// The harness must load before the configuration modules import Electron.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import {
  type ConfigJsonValue,
  validationRules,
} from "source/app/service-providers/config/config-validation";
import {
  type ConfigOptions,
  getConfigTemplate,
} from "source/app/service-providers/config/get-config-template";

/** Webpack's DefinePlugin supplies __BUILD_DATE__ to the bundle. */
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
  const rules = validationRules();
  let template: ConfigOptions;

  before(function () {
    buildGlobals.__BUILD_DATE__ = 0;
    template = getConfigTemplate("en-US");
  });

  after(function () {
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
