/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Shortcuts utilities
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains a bunch of utility functions and types to
 *                  facilitate custom shortcut implementation in both main
 *                  process and renderer.
 *
 * END HEADER
 */

/**
 * Interface that mimicks the configurability of CodeMirror's commands. Can be
 * used in both main process and renderer process to define default shortcuts
 * which can be overridden.
 */
export interface DefaultShortcut {
  mac?: string;
  win?: string;
  linux?: string;
  key?: string;
}

/**
 * A CodeMirror-style shortcut taken apart into its modifiers and its key, the
 * shape ShortcutDisplay.vue renders.
 */
export interface ExplodedShortcut {
  altKey: boolean;
  shiftKey: boolean;
  modKey: boolean;
  ctrlKey: boolean;
  key: string;
}

/**
 * Takes an Electron accelerator (`CmdOrCtrl+Shift+K`) apart into the
 * modifiers and key ShortcutDisplay.vue renders. `CmdOrCtrl` is the key it
 * resolves to on this platform: Cmd on macOS, Ctrl elsewhere.
 *
 * @param   {string}            accelerator  The accelerator
 *
 * @return  {ExplodedShortcut}               The exploded shortcut
 */
export function explodeAccelerator(accelerator: string): ExplodedShortcut {
  const parts = accelerator.split("+");
  const key = parts[parts.length - 1].toLowerCase();
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  const commandOrControl =
    modifiers.includes("cmdorctrl") || modifiers.includes("commandorcontrol");
  const command =
    modifiers.includes("cmd") ||
    modifiers.includes("command") ||
    modifiers.includes("super") ||
    modifiers.includes("meta");
  const control = modifiers.includes("ctrl") || modifiers.includes("control");
  const isMac = process.platform === "darwin";
  return {
    altKey: modifiers.includes("alt") || modifiers.includes("option"),
    shiftKey: modifiers.includes("shift"),
    modKey: command || (isMac && commandOrControl),
    ctrlKey: control || (!isMac && commandOrControl),
    key,
  };
}

/**
 * Takes a CodeMirror-style shortcut (`Mod-Shift-t`) apart into its modifiers
 * and its key.
 *
 * @param   {string}            shortcut  The shortcut
 *
 * @return  {ExplodedShortcut}            The exploded shortcut
 */
export function explodeShortcut(shortcut: string): ExplodedShortcut {
  const keys = shortcut.toLowerCase().split(/-/);
  const altKey = keys.includes("alt") || keys.includes("option");
  const shiftKey = keys.includes("shift");
  const modKey =
    keys.includes("mod") ||
    (process.platform === "darwin" && keys.includes("cmd")) ||
    (process.platform !== "darwin" && keys.includes("mod"));
  const ctrlKey = keys.includes("ctrl");
  return {
    altKey,
    shiftKey,
    modKey,
    ctrlKey,
    key: keys[keys.length - 1],
  };
}

/**
 * Serialises a captured shortcut in CodeMirror's normalized modifier order.
 */
export function implodeShortcut(shortcut: ExplodedShortcut): string {
  let returnVal = shortcut.key;

  if (shortcut.altKey) {
    returnVal = `Alt-${returnVal}`;
  }
  if (shortcut.shiftKey) {
    returnVal = `Shift-${returnVal}`;
  }
  if (shortcut.modKey) {
    returnVal = `Mod-${returnVal}`;
  }
  if (shortcut.ctrlKey) {
    returnVal = `Ctrl-${returnVal}`;
  }

  return returnVal;
}

/**
 * Returns the assigned default keyboard shortcut for the provided action. NOTE
 * that these default keybindings can be custom per platform. The function
 * checks the platform for that.
 *
 * @param   {keyof T}  name  The name of the shortcut
 * @param   {T}        defaults The default map
 *
 * @return  {string|undefined}          The (platform-specific) default
 *                                      keybinding, if available.
 */
export function getDefaultKeybinding<T extends Record<string, DefaultShortcut>>(
  name: keyof T,
  defaults: T,
): string | undefined {
  const candidate = defaults[name];

  if (process.platform === "darwin" && "mac" in candidate) {
    return candidate.mac;
  } else if (process.platform === "win32" && "win" in candidate) {
    return candidate.win;
  } else if (process.platform === "linux" && "linux" in candidate) {
    return candidate.linux;
  } else {
    return candidate.key;
  }
}

/** The parts of a CodeMirror key name: its modifiers and its key. */
interface ParsedKeyName {
  /** The name has `Mod`: Cmd on macOS, Ctrl elsewhere. */
  mod: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  key: string;
}

/**
 * Takes a CodeMirror key name apart as CodeMirror does: the parts are apart
 * by a `-` that is not the last character. Reference: `normalizeKeyName` of
 * @codemirror/view (src/keymap.ts), which throws for an unknown modifier as
 * this function does.
 */
function parseKeyName(name: string): ParsedKeyName {
  const parts = name.trim().split(/-(?!$)/);
  const parsed: ParsedKeyName = {
    mod: false,
    alt: false,
    ctrl: false,
    meta: false,
    shift: false,
    key: parts[parts.length - 1],
  };
  for (const modifier of parts.slice(0, -1)) {
    if (/^(cmd|meta|m)$/i.test(modifier)) {
      parsed.meta = true;
    } else if (/^a(lt)?$/i.test(modifier)) {
      parsed.alt = true;
    } else if (/^(c|ctrl|control)$/i.test(modifier)) {
      parsed.ctrl = true;
    } else if (/^s(hift)?$/i.test(modifier)) {
      parsed.shift = true;
    } else if (/^mod$/i.test(modifier)) {
      parsed.mod = true;
    } else {
      throw new Error(`The shortcut "${name}" has the unknown modifier "${modifier}".`);
    }
  }
  return parsed;
}

/**
 * The one spelling of the key that a CodeMirror key name binds on a
 * platform, in CodeMirror's order (`Shift-Meta-Ctrl-Alt-key`). CodeMirror
 * reads an upper-case letter as the letter with Shift: a press of
 * Ctrl+Shift+C runs both `Mod-C` and `Mod-Shift-c` (`runHandlers` of
 * @codemirror/view tries the name of the key and the name of its base key).
 * So on Linux both have the spelling `Shift-Ctrl-c`.
 */
export function normalizeShortcut(shortcut: string, platform: NodeJS.Platform): string {
  const parsed = parseKeyName(shortcut);
  let key = parsed.key === "Space" ? " " : parsed.key;
  let shift = parsed.shift;
  if (/^[A-Z]$/.test(key)) {
    key = key.toLowerCase();
    shift = true;
  }
  const meta = parsed.meta || (parsed.mod && platform === "darwin");
  const ctrl = parsed.ctrl || (parsed.mod && platform !== "darwin");
  return [
    shift ? "Shift-" : "",
    meta ? "Meta-" : "",
    ctrl ? "Ctrl-" : "",
    parsed.alt ? "Alt-" : "",
    key,
  ].join("");
}

/**
 * Takes a CodeMirror style shortcut and transforms it to conform to Electron
 * accelerator syntax. Example: `Mod-Shift-c` -> `CmdOrCtrl+Shift+C`. An
 * upper-case letter is the letter with Shift, as CodeMirror reads it
 * (`Mod-C` -> `CmdOrCtrl+Shift+C`). Meta is Cmd on macOS and Super
 * elsewhere. The key names are those of the Electron accelerator
 * documentation: `Plus` for `+`, `Space` for a space, `Up` for `ArrowUp`.
 *
 * @param   {string}  cmShortcut  The CM shortcut; the empty string and
 *                                undefined are no shortcut
 *
 * @return  {string}              The Electron accelerator.
 */
export function cmShortcutToElectron(cmShortcut?: string): string | undefined {
  if (cmShortcut === undefined || cmShortcut.trim() === "") {
    return undefined;
  }
  const parsed = parseKeyName(cmShortcut);
  let key = parsed.key;
  let shift = parsed.shift;
  if (/^[A-Z]$/.test(key)) {
    shift = true;
  } else if (key === "+") {
    key = "Plus";
  } else if (key === " ") {
    key = "Space";
  } else if (key.startsWith("Arrow")) {
    key = key.slice(5);
  }
  const modifiers: string[] = [];
  if (parsed.mod) {
    modifiers.push("CmdOrCtrl");
  }
  if (parsed.meta) {
    modifiers.push(process.platform === "darwin" ? "Cmd" : "Super");
  }
  if (parsed.ctrl) {
    modifiers.push("Ctrl");
  }
  if (parsed.alt) {
    modifiers.push("Alt");
  }
  if (shift) {
    modifiers.push("Shift");
  }
  return [...modifiers, key.length === 1 ? key.toUpperCase() : key].join("+");
}
