export type MathJaxMacro = string | readonly [string, number] | readonly [string, number, string];


export const mathJaxPackages = [
  "base",
  "ams",
  "boldsymbol",
  "configmacros",
  "mathtools",
  "mhchem",
  "newcommand",
  "noundefined",
] as const;

export function isMathJaxMacro(value: unknown): value is MathJaxMacro {
  if (typeof value === "string") {
    return true;
  }
  if (
    !Array.isArray(value) ||
    typeof value[0] !== "string" ||
    !Number.isInteger(value[1]) ||
    value[1] <= 0
  ) {
    return false;
  }
  if (value.length === 2) {
    return true;
  }
  return value.length === 3 && typeof value[2] === "string";
}

function isJsonObject(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}

export function parseMathJaxMacros(data: unknown): Record<string, MathJaxMacro> {
  if (!isJsonObject(data)) {
    throw new TypeError("MathJax macros must be a JSON object mapping macro names to definitions");
  }

  const macros: Record<string, MathJaxMacro> = {};
  for (const [name, definition] of Object.entries(data)) {
    if (!isMathJaxMacro(definition)) {
      throw new TypeError(`Invalid MathJax macro definition for "${name}"`);
    }
    macros[name] = definition;
  }
  return macros;
}

