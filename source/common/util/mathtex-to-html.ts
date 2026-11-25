import { browserAdaptor } from "@mathjax/src/cjs/adaptors/browserAdaptor.js";
import { liteAdaptor } from "@mathjax/src/cjs/adaptors/liteAdaptor.js";
import { TeX } from "@mathjax/src/cjs/input/tex.js";
import { mathjax } from "@mathjax/src/cjs/mathjax.js";
import { CHTML } from "@mathjax/src/cjs/output/chtml.js";
import "@mathjax/src/cjs/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/cjs/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/cjs/input/tex/configmacros/ConfigMacrosConfiguration.js";
import "@mathjax/src/cjs/input/tex/mathtools/MathtoolsConfiguration.js";
import "@mathjax/src/cjs/input/tex/mhchem/MhchemConfiguration.js";
import "@mathjax/src/cjs/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/cjs/input/tex/noundefined/NoUndefinedConfiguration.js";
import {
  type MathJaxMacro,
  mathJaxPackages,
} from "@dzack/tikz-render/mathjax-config";
import { MathJaxMhchemFontExtension } from "@mathjax/mathjax-mhchem-font-extension/cjs/chtml.js";
import { MathJaxNewcmFont } from "@mathjax/mathjax-newcm-font/cjs/chtml.js";
import { type LiteDocument } from "@mathjax/src/cjs/adaptors/lite/Document.js";
import { LiteElement, type LiteNode } from "@mathjax/src/cjs/adaptors/lite/Element.js";
import { type LiteText } from "@mathjax/src/cjs/adaptors/lite/Text.js";
import { type MathDocument } from "@mathjax/src/cjs/core/MathDocument.js";
import { type MmlNode } from "@mathjax/src/cjs/core/MmlTree/MmlNode.js";
import { HTMLDocument } from "@mathjax/src/cjs/handlers/html/HTMLDocument.js";
import { HandlerType } from "@mathjax/src/cjs/input/tex/HandlerTypes.js";
import { AbstractParseMap } from "@mathjax/src/cjs/input/tex/TokenMap.js";

import "./mathjax-newcm-dynamic";

const documentElement = globalThis.document;

MathJaxNewcmFont.addExtension({
  ...MathJaxMhchemFontExtension,
  fontURL: documentElement === undefined ? "" : new URL("../mathjax", documentElement.baseURI).href,
});

type BrowserDocument = MathDocument<HTMLElement, Text, Document>;
type MainDocument = MathDocument<LiteNode, LiteText, LiteDocument>;

let browserRenderer: BrowserDocument | undefined;
let mainRenderer: MainDocument | undefined;
let browserChtml: CHTML<HTMLElement, Text, Document> | undefined;
let mainChtml: CHTML<LiteElement, LiteText, LiteDocument> | undefined;
let browserAdaptorInstance: ReturnType<typeof browserAdaptor> | undefined;

type MathJaxDisplay = "inline" | "display";

const BROWSER_RENDER_CACHE_LIMIT = 2048;
const browserRenderCache = new Map<string, HTMLElement>();

function browserRenderCacheKey(equation: string, display: MathJaxDisplay): string {
  return `${display}\0${equation}`;
}

function cacheBrowserNode(key: string, node: HTMLElement): void {
  browserRenderCache.delete(key);
  browserRenderCache.set(key, node.cloneNode(true) as HTMLElement);
  if (browserRenderCache.size > BROWSER_RENDER_CACHE_LIMIT) {
    const oldest = browserRenderCache.keys().next().value;
    if (oldest !== undefined) {
      browserRenderCache.delete(oldest);
    }
  }
}

export function __resetMathJaxRenderCacheForTests(): void {
  browserRenderCache.clear();
}

export function __mathJaxRenderCacheSizeForTests(): number {
  return browserRenderCache.size;
}
let mainAdaptorInstance: ReturnType<typeof liteAdaptor> | undefined;

mathjax.asyncLoad = () => Promise.resolve();

let initialized = false;
let initializing: Promise<void> | undefined;

export interface MathJaxCompletionCatalogue {
  commands: readonly string[];
  environments: readonly string[];
}

let completionCatalogue: MathJaxCompletionCatalogue = {
  commands: [],
  environments: [],
};

function mapKeysForHandler<N, T, D>(tex: TeX<N, T, D>, handlerType: HandlerType): string[] {
  const handler = tex.parseOptions.handlers.get(handlerType);
  if (handler === undefined) {
    return [];
  }

  const keys: string[] = [];
  for (const mapName of handler.toString().split(", ").filter(Boolean)) {
    const tokenMap = handler.retrieve(mapName);
    if (!(tokenMap instanceof AbstractParseMap)) {
      continue;
    }
    const enumerableMap: unknown = Reflect.get(tokenMap, "map");
    if (!(enumerableMap instanceof Map)) {
      continue;
    }
    for (const key of enumerableMap.keys()) {
      if (typeof key === "string") {
        keys.push(key);
      }
    }
  }
  return keys;
}

function buildCompletionCatalogue<N, T, D>(tex: TeX<N, T, D>): MathJaxCompletionCatalogue {
  const commands = new Set<string>();
  for (const key of [
    ...mapKeysForHandler(tex, HandlerType.MACRO),
    ...mapKeysForHandler(tex, HandlerType.DELIMITER),
  ]) {
    const bare = key.startsWith("\\") ? key.slice(1) : key;
    if (/^[A-Za-z@]+$/u.test(bare)) {
      commands.add(`\\${bare}`);
    }
  }

  const environments = new Set<string>();
  for (const key of mapKeysForHandler(tex, HandlerType.ENVIRONMENT)) {
    if (/^[A-Za-z@*]+$/u.test(key)) {
      environments.add(key);
    }
  }

  return {
    commands: [...commands].sort((a, b) => a.localeCompare(b)),
    environments: [...environments].sort((a, b) => a.localeCompare(b)),
  };
}

function texInput(
  macros: Record<string, MathJaxMacro>,
) {
  return new TeX({ packages: [...mathJaxPackages], macros });
}

export function buildMathJaxCompletionCatalogue(
  macros: Record<string, MathJaxMacro>,
): MathJaxCompletionCatalogue {
  return buildCompletionCatalogue(texInput(macros));
}

export function mathJaxCompletionCatalogue(): MathJaxCompletionCatalogue {
  return completionCatalogue;
}

export function initializeMathJax(
  macros: Record<string, MathJaxMacro>,
): Promise<void> {
  if (initializing !== undefined) {
    return initializing;
  }

  const tex = texInput(macros);
  completionCatalogue = buildCompletionCatalogue(tex);

  if (documentElement === undefined) {
    mainAdaptorInstance = liteAdaptor();
    mainChtml = new CHTML<LiteElement, LiteText, LiteDocument>({
      fontData: MathJaxNewcmFont,
      dynamicPrefix: "",
      adaptiveCSS: false,
    });
    mainRenderer = new HTMLDocument(mainAdaptorInstance.parse(""), mainAdaptorInstance, {
      InputJax: tex,
      OutputJax: mainChtml,
    });
    initializing = mainChtml.font.loadDynamicFiles().then(() => {
      initialized = true;
    });
  } else {
    browserAdaptorInstance = browserAdaptor();
    browserChtml = new CHTML({
      fontData: MathJaxNewcmFont,
      fontURL: new URL("../mathjax", documentElement.baseURI).href,
      dynamicPrefix: "",
      adaptiveCSS: false,
      displayOverflow: "scroll",
    });
    browserRenderer = new HTMLDocument(documentElement, browserAdaptorInstance, {
      InputJax: tex,
      OutputJax: browserChtml,
    });
    initializing = browserChtml.font.loadDynamicFiles().then(() => {
      browserRenderer?.updateDocument();
      initialized = true;
    });
  }

  return initializing;
}

function isMmlNode(node: LiteNode | HTMLElement | MmlNode): node is MmlNode {
  return "isToken" in node;
}

function mathJaxToBrowserNode(equation: string, display: MathJaxDisplay): HTMLElement {
  if (browserRenderer === undefined) {
    throw new Error("Browser MathJax renderer is unavailable");
  }

  const key = browserRenderCacheKey(equation, display);
  const cached = browserRenderCache.get(key);
  if (cached !== undefined) {
    browserRenderCache.delete(key);
    browserRenderCache.set(key, cached);
    return cached.cloneNode(true) as HTMLElement;
  }

  const node = browserRenderer.convert(equation, { display: display === "display" });
  if (isMmlNode(node)) {
    throw new Error("MathJax did not produce HTML");
  }
  browserRenderer.updateDocument();
  cacheBrowserNode(key, node);
  return node;
}

function mathJaxToMainNode(equation: string, display: MathJaxDisplay): LiteElement {
  if (mainRenderer === undefined) {
    throw new Error("Main-process MathJax renderer is unavailable");
  }

  const node = mainRenderer.convert(equation, { display: display === "display" });
  if (isMmlNode(node) || !(node instanceof LiteElement)) {
    throw new Error("MathJax did not produce HTML");
  }
  mainRenderer.updateDocument();
  return node;
}

export function mathJaxToElem(equation: string, element: HTMLElement, display: MathJaxDisplay) {
  if (!initialized) {
    throw new Error("MathJax must be initialized before rendering");
  }

  element.replaceChildren(mathJaxToBrowserNode(equation, display));
}

export function mathJaxToHTML(equation: string, display: MathJaxDisplay): string {
  if (!initialized) {
    throw new Error("MathJax must be initialized before rendering");
  }

  if (browserRenderer === undefined) {
    if (mainAdaptorInstance === undefined) {
      throw new Error("Main-process MathJax adaptor is unavailable");
    }
    return mainAdaptorInstance.outerHTML(mathJaxToMainNode(equation, display));
  }

  if (browserAdaptorInstance === undefined) {
    throw new Error("Browser MathJax adaptor is unavailable");
  }
  return browserAdaptorInstance.outerHTML(mathJaxToBrowserNode(equation, display));
}
