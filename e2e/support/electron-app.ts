// Shared assembled-app harness. A spec starts the packaged build of the run
// against a throwaway data directory and attaches over CDP; keeping that in
// one module stops each spec from copying the start sequence.
import { strict as assert } from "node:assert";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import {
  AGENT_API_DISCOVERY_FILE,
  parseAgentApiDiscovery,
} from "source/app/service-providers/agent-api/discovery-file";
import type { components } from "source/types/generated/agent-api";
import { stringify } from "yaml";

type AgentApiSchemas = components["schemas"];

export const REPO_ROOT = path.resolve(process.cwd());

/**
 * The packaged binary of `just package`. A spec that starts it proves the
 * current source only while the build is current, so this fails when the
 * build is absent or when its stamp differs from the source fingerprint that
 * the desktop launcher compares.
 */
export function currentPackagedBinary(): string {
  return path.join(currentPackagedDirectory(), "zettlr-pandoc");
}

/**
 * The application archive of the packaged build. A spec starts it with the
 * Electron of `node_modules` (`launchElectron`): the code is the code that
 * the package ships, and the app is not packaged for Electron
 * (`app.isPackaged`), so it writes its log to its output too.
 */
export function currentPackagedArchive(): string {
  return path.join(currentPackagedDirectory(), "resources", "app.asar");
}

/**
 * The Electron binary of the installed `electron` package, found as the
 * `index.js` of that package finds it: `dist/` and the name in `path.txt`.
 */
export function electronBinary(): string {
  const packageDirectory = path.join(REPO_ROOT, "node_modules", "electron");
  const name = readFileSync(path.join(packageDirectory, "path.txt"), "utf8");
  return path.join(packageDirectory, "dist", name);
}

/**
 * The source fingerprint of this run. A run tests the source that it
 * started on: a source edit or a commit during the run does not stop its
 * later starts, and a build that replaces the package during the run (a
 * start from the desktop launcher) has another stamp and is refused. The
 * lanes runner reads the fingerprint at its start and gives it to each spec
 * file in `E2E_SOURCE_FINGERPRINT`; a Mocha process that no runner started
 * is a run of its own and reads it at its first start.
 */
let runFingerprint: string | undefined = process.env.E2E_SOURCE_FINGERPRINT;

function sourceFingerprintOfRun(): string {
  if (runFingerprint === undefined) {
    runFingerprint = execFileSync(
      path.join(REPO_ROOT, "scripts", "desktop", "zettlr-pandoc-source-fingerprint"),
      [REPO_ROOT],
      { encoding: "utf8" },
    ).trim();
  }
  return runFingerprint;
}

function currentPackagedDirectory(): string {
  const packagedDirectory = path.join(REPO_ROOT, "out", "Zettlr-Pandoc-linux-x64");
  const binary = path.join(packagedDirectory, "zettlr-pandoc");
  const stamp = path.join(packagedDirectory, ".source-fingerprint");
  assert.ok(
    existsSync(binary) && existsSync(stamp),
    `No packaged build at ${packagedDirectory}. Run \`just package\` first.`,
  );
  assert.equal(
    readFileSync(stamp, "utf8").trim(),
    sourceFingerprintOfRun(),
    `The packaged build at ${packagedDirectory} is older than the source. Run \`just package\` first.`,
  );
  return packagedDirectory;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Makes a watched file unreadable and gives it the modification time
 * `changedAt`, so the app reads a change it cannot load. The watcher of the
 * app (chokidar, `handler.js`) drops each event of a file that comes within
 * 5 ms of the one before it, and it reports a change only when the
 * modification time moved: the change of the mode alone is no change, and a
 * time change 5 ms after it is lost. The two changes are therefore apart.
 * The line of the output gives the time of the change, so a run whose app
 * reports no change shows whether the watch of the app was in place (#62).
 */
export async function makeUnreadableAndNewer(filePath: string, changedAt: Date): Promise<void> {
  console.log(`[${new Date().toISOString()}] makeUnreadableAndNewer: chmod 000 ${filePath}`);
  await chmod(filePath, 0o000);
  await delay(100);
  await utimes(filePath, changedAt, changedAt);
}

export function requireInitialized<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

export function outputTail(output: string): string {
  return output.split("\n").slice(-100).join("\n");
}

export async function waitForDevTools(
  appProcess: ChildProcess,
  getOutput: () => string,
  timeoutMs: number,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Electron did not expose DevTools within ${timeoutMs}ms.\n${outputTail(getOutput())}`,
        ),
      );
    }, timeoutMs);

    const inspectOutput = (): void => {
      const match = getOutput().match(/DevTools listening on (ws:\/\/\S+)/);
      if (match !== null) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };

    appProcess.stdout?.on("data", inspectOutput);
    appProcess.stderr?.on("data", inspectOutput);
    appProcess.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    appProcess.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Electron exited before exposing DevTools (code=${String(code)}, signal=${String(signal)}).\n${outputTail(getOutput())}`,
        ),
      );
    });
  });
}

export async function waitForApplicationBoot(
  appProcess: ChildProcess,
  getOutput: () => string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `The application did not complete boot within ${timeoutMs}ms.\n${outputTail(getOutput())}`,
        ),
      );
    }, timeoutMs);

    const inspectOutput = (): void => {
      if (getOutput().includes("[AppServiceContainer] Boot successful!")) {
        clearTimeout(timeout);
        resolve();
      }
    };

    inspectOutput();
    appProcess.stdout?.on("data", inspectOutput);
    appProcess.stderr?.on("data", inspectOutput);
    appProcess.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    appProcess.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Electron exited before completing boot (code=${String(code)}, signal=${String(signal)}).\n${outputTail(getOutput())}`,
        ),
      );
    });
  });
}

export async function findEditorPage(browser: Browser, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          if ((await page.locator(".cm-content").count()) > 0) {
            // xvfb opens the window at its 640 px screen, where the three
            // panes' minimums leave the editor no room; a working-size
            // window is what every spec assumes, and a spec that wants
            // another size sets it after this returns.
            await page.setViewportSize({ width: 1400, height: 900 });
            return page;
          }
        } catch (error) {
          if (page.isClosed()) {
            continue;
          }
          throw new Error(`Could not inspect editor page ${page.url()}`, {
            cause: error,
          });
        }
      }
    }

    await delay(250);
  }

  const openPages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .map((page) => page.url());
  throw new Error(
    `No editor window appeared within ${timeoutMs}ms. Open pages: ${JSON.stringify(openPages)}`,
  );
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupIsAlive(pid)) {
      return true;
    }
    await delay(100);
  }
  return !processGroupIsAlive(pid);
}

export async function stopProcess(appProcess: ChildProcess | undefined): Promise<void> {
  if (appProcess?.pid === undefined) {
    return;
  }

  if (await waitForProcessGroupExit(appProcess.pid, 10_000)) {
    return;
  }

  process.kill(-appProcess.pid, "SIGTERM");
  if (!(await waitForProcessGroupExit(appProcess.pid, 5_000))) {
    process.kill(-appProcess.pid, "SIGKILL");
    await waitForProcessGroupExit(appProcess.pid, 5_000);
  }
}

export async function readAppLog(fixtureRoot: string): Promise<string> {
  const logDirectory = path.join(fixtureRoot, "config", "logs");
  const filenames = await readdir(logDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [] as string[];
    }
    throw error;
  });
  return (
    await Promise.all(
      filenames
        .filter((filename) => filename.endsWith(".log"))
        .map(async (filename) => await readFile(path.join(logDirectory, filename), "utf8")),
    )
  ).join("\n");
}

export async function preserveArtifacts(
  artifactDirectory: string,
  fixtureRoot: string | undefined,
  processOutput: string,
  rendererEvents: string[],
  screenshots: ReadonlyMap<string, Buffer>,
): Promise<void> {
  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(path.join(artifactDirectory, "process.log"), processOutput, "utf8");
  await writeFile(
    path.join(artifactDirectory, "renderer-events.log"),
    `${rendererEvents.join("\n")}\n`,
    "utf8",
  );
  for (const [filename, screenshot] of screenshots) {
    await writeFile(path.join(artifactDirectory, filename), screenshot);
  }

  if (fixtureRoot !== undefined) {
    const appLogs = path.join(fixtureRoot, "config", "logs");
    await cp(appLogs, path.join(artifactDirectory, "app-logs"), {
      recursive: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

export interface SerializedMenuNode {
  id?: string;
  label?: string;
  type?: string;
  accelerator?: string | null;
  submenu?: SerializedMenuNode[];
}

/** The application menu as the menu provider serialises it for this window. */
export function readApplicationMenu(page: Page): Promise<SerializedMenuNode[]> {
  return page.evaluate(
    () =>
      new Promise<SerializedMenuNode[]>((resolve) => {
        window.ipc.on("menu-provider", (_event, message) => {
          if (message.command === "application-menu") {
            resolve(message.payload);
          }
        });
        window.ipc.send("menu-provider", { command: "get-application-menu" });
      }),
  );
}

export function findMenuNode(
  nodes: SerializedMenuNode[],
  id: string,
): SerializedMenuNode | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const nested = node.submenu === undefined ? undefined : findMenuNode(node.submenu, id);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

/** The Agent API, as the specs drive it: JSON in, parsed JSON out. */
export interface AgentClient {
  get: (route: string) => Promise<unknown>;
  post: (route: string, body: unknown) => Promise<unknown>;
  /** Like `post`, but hands back the status and raw body of a refusal. */
  postExpectingFailure: (
    route: string,
    body: unknown,
  ) => Promise<{ status: number; body: unknown }>;
}

/**
 * The Agent API answers only a caller that sends the token of the app's
 * environment. Each run has a token of its own, so a token of the shell
 * that started the run decides nothing.
 */
export const AGENT_API_TOKEN = randomUUID();
/** What a start of the app adds to its environment. */
export const AGENT_API_ENVIRONMENT = { ZETTLR_AGENT_API_TOKEN: AGENT_API_TOKEN };
/** The header that each request to the Agent API carries. */
export const AGENT_API_AUTHORIZATION = { authorization: `Bearer ${AGENT_API_TOKEN}` };

export function agentClient(port: number): AgentClient {
  const base = `http://127.0.0.1:${port}`;
  const post = async (route: string, body: unknown): Promise<Response> =>
    await fetch(`${base}${route}`, {
      method: "POST",
      headers: { ...AGENT_API_AUTHORIZATION, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const parse = async (response: Response): Promise<unknown> => {
    const text = await response.text();
    return text === "" ? undefined : JSON.parse(text);
  };
  const require = async (response: Response): Promise<unknown> => {
    const parsed = await parse(response);
    if (!response.ok) {
      throw new Error(
        `Agent API ${response.status} for ${response.url}: ${JSON.stringify(parsed)}`,
      );
    }
    return parsed;
  };
  return {
    get: async (route) =>
      await require(await fetch(`${base}${route}`, { headers: AGENT_API_AUTHORIZATION })),
    post: async (route, body) => await require(await post(route, body)),
    postExpectingFailure: async (route, body) => {
      const response = await post(route, body);
      return { status: response.status, body: await parse(response) };
    },
  };
}

/**
 * Classifies a fetch failure while polling a loopback endpoint. A refused or
 * reset connection is the one expected transient — nothing is listening yet,
 * or a stale port file names a dead listener. Every other failure is a real
 * defect and propagates.
 */
function transientConnectionFailure(error: unknown): undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  if (code === "ECONNREFUSED" || code === "ECONNRESET") {
    return undefined;
  }
  throw error;
}

/**
 * Reads the port the running instance actually bound, from the discovery
 * file the Agent API publishes into its user-data directory. The port is
 * handed out only when its `/v1/ping` names the instance of the file: a
 * killed process leaves its file behind, and another instance can bind its
 * port. A stale file reads as "not published yet", not as the endpoint of
 * the instance currently booting.
 */
export async function readAgentApiPort(
  configDirectory: string,
  timeoutMs: number,
): Promise<number> {
  const portFile = path.join(configDirectory, AGENT_API_DISCOVERY_FILE);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // ENOENT is the one legal read failure: the instance has not published
    // yet. Anything else (permissions, a directory at that path) is a real
    // defect and propagates instead of looping into the timeout error.
    const contents = await readFile(portFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (contents !== undefined) {
      const discovery = parseAgentApiDiscovery(contents);
      const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/ping`, {
        headers: AGENT_API_AUTHORIZATION,
      }).catch(transientConnectionFailure);
      if (response?.ok === true) {
        const ping = (await response.json()) as AgentApiSchemas["PingResponse"];
        if (ping.instanceId === discovery.instanceId) {
          return discovery.port;
        }
      }
    }
    await delay(250);
  }
  throw new Error(`The Agent API never published a live port in ${portFile}`);
}

export interface Fixture {
  root: string;
  configDirectory: string;
  documentPath: string;
}

export interface FixtureOptions {
  /** Basename of the single document opened in the active leaf. */
  documentName: string;
  /** Exact bytes written to that document. */
  documentContents: string;
  /**
   * Extra config.json keys merged over the defaults — the Agent API spec uses
   * this to pin `agentApi.port` to a port it owns for the run.
   */
  config?: Record<string, unknown>;
}

export interface WorkspaceFixtureOptions {
  /** Directory copied verbatim to become the single open workspace root. */
  workspaceSource: string;
  /** Path of the document opened in the active leaf, relative to the root. */
  activeDocument: string;
  /** Extra config.json keys merged over the defaults. */
  config?: Record<string, unknown>;
}

/**
 * A fixture whose workspace root is a copy of an existing directory, such as
 * a Quarto project.
 */
export async function createWorkspaceFixture(
  prefix: string,
  options: WorkspaceFixtureOptions,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const configDirectory = path.join(root, "config");
  const workspaceDirectory = path.join(root, "workspace");
  const documentPath = path.join(workspaceDirectory, options.activeDocument);

  await mkdir(configDirectory);
  // A fixture may assemble a book out of symlinks. Copying them verbatim keeps
  // the relative links pointing inside the copy; resolving them would aim the
  // workspace back at the repository's own fixture directory.
  await cp(options.workspaceSource, workspaceDirectory, {
    recursive: true,
    verbatimSymlinks: true,
  });
  await writeFixtureState(configDirectory, workspaceDirectory, documentPath, options.config);

  return { root, configDirectory, documentPath };
}

export async function createFixture(prefix: string, options: FixtureOptions): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const configDirectory = path.join(root, "config");
  const workspaceDirectory = path.join(root, "workspace");
  const documentPath = path.join(workspaceDirectory, options.documentName);

  await mkdir(configDirectory);
  await mkdir(workspaceDirectory);
  await writeFile(documentPath, options.documentContents, "utf8");
  await writeFixtureState(configDirectory, workspaceDirectory, documentPath, options.config);

  return { root, configDirectory, documentPath };
}

/** Writes the throwaway config.json and documents.yaml both fixture shapes share. */
async function writeFixtureState(
  configDirectory: string,
  workspaceDirectory: string,
  documentPath: string,
  config: Record<string, unknown> | undefined,
): Promise<void> {
  const packageMetadata: unknown = JSON.parse(
    await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  assert.ok(
    packageMetadata !== null &&
      typeof packageMetadata === "object" &&
      "version" in packageMetadata &&
      typeof packageMetadata.version === "string",
    "package.json must declare the application version",
  );
  await writeFile(
    path.join(configDirectory, "config.json"),
    `${JSON.stringify(
      {
        version: packageMetadata.version,
        app: {
          openFiles: [],
          openWorkspaces: [workspaceDirectory],
        },
        system: { checkForUpdates: false },
        // The shipped default takes the theme of the host, so `darkMode`
        // would decide nothing and a spec would see another theme on each
        // machine. A fixture states its theme: light, or the `darkMode` of
        // its own config.
        autoDarkMode: "off",
        darkMode: false,
        // The shipped default binds the Agent API to a fixed port, which a
        // fixture would take from whatever Zettlr the developer is running.
        // A spec that needs the API asks for it and gets a kernel-assigned
        // port; every other fixture leaves the port alone.
        agentApi: { enabled: false, port: 0 },
        ...config,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const documents = {
    "56b44854-b144-4a6f-8061-dcfeb6e512e8": {
      type: "leaf",
      id: "7b4dd4f2-48a2-4279-b6c9-577132e64480",
      openFiles: [{ path: documentPath, pinned: false }],
      activeFile: { path: documentPath, pinned: false },
    },
  };
  await writeFile(path.join(configDirectory, "documents.yaml"), stringify(documents), "utf8");
}

/**
 * A version of `org.freedesktop.portal.FileChooser` that no portal has; the
 * interface is at version 4.
 */
const NO_PORTAL_FILE_CHOOSER_VERSION = 1000;

export interface LaunchOptions {
  /** Files delivered as literal application arguments on a cold start. */
  files?: string[];
  /** Options of the application on its command line (`cli-provider.ts`). */
  flags?: string[];
  /** Variables set over the inherited environment of the app process. */
  environment?: NodeJS.ProcessEnv;
  /**
   * Variables that webpack reads when it compiles the app, such as
   * `ZETTLR_DISABLE_UPDATE_CHECK` (`__UPDATES_DISABLED__` of
   * `webpack.main.config.js`). A start with them compiles a development
   * build of its own through `electron-forge start`; a start without them
   * runs the packaged build of the run.
   */
  buildEnvironment?: NodeJS.ProcessEnv;
}

export async function launchElectron(
  configDirectory: string,
  options: LaunchOptions = {},
): Promise<ChildProcess> {
  const appArguments = [
    `--data-dir=${configDirectory}`,
    "--remote-debugging-port=0",
    "--disable-hardware-acceleration",
    // The run owns the X display (`just test-e2e`, `just test-e2e-file`):
    // DISPLAY names the desktop's server or the virtual one of the run.
    // Chromium prefers a Wayland compositor whenever WAYLAND_DISPLAY is
    // set, and then the window opens on the developer's desktop. X11 is
    // where the harness looks, the same switch the capture scenes pass.
    "--ozone-platform=x11",
    // A file dialog goes to the desktop portal of the session when the
    // portal has this version of the file chooser interface, and the
    // portal draws it on the desktop of the author. No portal has the
    // version below, so the app draws its own dialog on the display of
    // the run, where a spec finds it (`native-dialog.ts`).
    `--xdg-portal-required-version=${NO_PORTAL_FILE_CHOOSER_VERSION}`,
  ];
  if (options.flags !== undefined) {
    appArguments.push(...options.flags);
  }
  if (options.files !== undefined) {
    appArguments.push(...options.files);
  }
  const environment = { ...process.env, ...AGENT_API_ENVIRONMENT, ...options.environment };

  if (options.buildEnvironment === undefined) {
    // The archive of the packaged build that the run made one time
    // (`just test-e2e`): the start compiles nothing.
    return spawn(electronBinary(), [currentPackagedArchive(), ...appArguments], {
      cwd: REPO_ROOT,
      detached: true,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  const { rendererPort, loggerPort } = forgePortsOfLane();
  const forgeExecutable = path.join(REPO_ROOT, "node_modules", ".bin", "electron-forge");
  return spawn(forgeExecutable, ["start", "--", ...appArguments], {
    cwd: REPO_ROOT,
    detached: true,
    env: {
      ...environment,
      ...options.buildEnvironment,
      NODE_ENV: "develop",
      ZETTLR_FORGE_RENDERER_PORT: String(rendererPort),
      ZETTLR_FORGE_LOGGER_PORT: String(loggerPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The ports of Forge's webpack dev server and logger for a start in this
 * lane. Forge bakes the entry URLs from the configured port before the
 * server binds it, so the port cannot be 0. A port that a probe binds and
 * releases is free for any other process until Forge binds it, and three
 * lanes start at the same time (#70). Each lane has two ports of its own,
 * below the ephemeral range of Linux (`net.ipv4.ip_local_port_range`, 32768
 * to 60999): the kernel gives no port of that range to a bind of port 0 or
 * to an outgoing connection. The run has a network namespace of its own
 * (`_e2e-run`), so no process of the host binds them, and a lane starts one
 * app at a time.
 */
function forgePortsOfLane(): { rendererPort: number; loggerPort: number } {
  const lane = process.env.E2E_LANE;
  if (lane === undefined || !/^[1-9][0-9]*$/.test(lane)) {
    throw new Error(
      `A start that compiles the app runs in a lane of e2e/support/run-lanes.ts (E2E_LANE is ${JSON.stringify(lane)})`,
    );
  }
  const rendererPort = 20_000 + 2 * Number(lane);
  return { rendererPort, loggerPort: rendererPort + 1 };
}

export function observeRenderer(page: Page, rendererEvents: string[]): void {
  page.on("console", (message) => {
    if (message.type() === "error") {
      rendererEvents.push(`console-error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    rendererEvents.push(`pageerror: ${error.stack ?? error.message}`);
  });
  page.on("dialog", (dialog) => {
    rendererEvents.push(`dialog.${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss().catch((error) => {
      rendererEvents.push(`dialog-dismiss-error: ${String(error)}`);
    });
  });
}

/**
 * A launched app plus the CDP connection to it. `attach` performs the whole
 * before-hook sequence so specs do not each re-derive the ordering.
 */
export interface RunningApp {
  appProcess: ChildProcess;
  browser: Browser;
  getOutput: () => string;
  /** Where a spec connects again after it left the connection of `browser`. */
  devToolsUrl: string;
}

/**
 * The time a start has to expose DevTools and to boot (#70). A start of the
 * packaged build compiles nothing, so a start that takes longer hangs. The
 * deadline is shorter than the hook timeout of mocha, so the error of the
 * start names the hang with the output of the app; the hook timeout would
 * end the hook without it. A start with a build environment compiles
 * webpack first.
 */
const PACKAGED_START_DEADLINE_MS = 60_000;
const BUILD_START_DEADLINE_MS = 240_000;

export function startDeadline(options: LaunchOptions): number {
  return options.buildEnvironment === undefined
    ? PACKAGED_START_DEADLINE_MS
    : BUILD_START_DEADLINE_MS;
}

export async function attach(
  configDirectory: string,
  rendererEvents: string[],
  options: LaunchOptions = {},
): Promise<RunningApp> {
  const timeoutMs = startDeadline(options);
  const appProcess = await launchElectron(configDirectory, options);
  let attached = false;
  let browser: Browser | undefined;
  const running = (async (): Promise<RunningApp> => {
    let processOutput = "";
    const appendOutput = (chunk: Buffer): void => {
      processOutput = `${processOutput}${chunk.toString()}`.slice(-200_000);
    };
    appProcess.stdout?.on("data", appendOutput);
    appProcess.stderr?.on("data", appendOutput);

    const devToolsUrl = await waitForDevTools(appProcess, () => processOutput, timeoutMs);
    await waitForApplicationBoot(appProcess, () => processOutput, timeoutMs);
    const connectedBrowser = await chromium.connectOverCDP(devToolsUrl);
    browser = connectedBrowser;
    for (const context of connectedBrowser.contexts()) {
      context.pages().forEach((page) => observeRenderer(page, rendererEvents));
      context.on("page", (page) => observeRenderer(page, rendererEvents));
    }

    attached = true;
    return {
      appProcess,
      browser: connectedBrowser,
      getOutput: () => processOutput,
      devToolsUrl,
    };
  })();

  return await running.finally(async () => {
    if (!attached) {
      await browser?.close();
      await stopProcess(appProcess);
    }
  });
}

/**
 * Asks the app to quit, as File → Quit does. The page sends the request in a
 * later task. A quit can close the page, and an evaluation whose page closes
 * before its answer arrives rejects; this evaluation has answered by then.
 */
export async function requestQuit(page: Page): Promise<void> {
  await page.evaluate(() => {
    setTimeout(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu-quit" });
    }, 100);
  });
}

/**
 * Asks the window of the page to close, as its close control does. The
 * request goes in a later task of the page, for the reason of `requestQuit`.
 * The window manager can refuse the close; the caller waits for what it
 * expects.
 */
export async function requestWindowClose(page: Page): Promise<void> {
  await page.evaluate(() => {
    setTimeout(() => {
      window.ipc.send("window-controls", { command: "win-close" });
    }, 100);
  });
}

/**
 * Clicks a control whose action can close its page. Playwright stops each
 * action of a page that closes before the action ends, so a click whose
 * handler closes the page races that close. The page clicks the control in a
 * later task, after the evaluation has answered. The caller waits for what it
 * expects.
 */
export async function clickBeforeClose(control: Locator): Promise<void> {
  await control.waitFor({ state: "visible", timeout: 10_000 });
  assert.ok(await control.isEnabled(), "the control that closes the page is enabled");
  await control.evaluate((element: HTMLElement) => {
    setTimeout(() => {
      element.click();
    }, 100);
  });
}

/** Clicks a control whose action closes its page, and waits for the close. */
export async function clickToClose(page: Page, control: Locator): Promise<void> {
  const closed = page.waitForEvent("close", { timeout: 10_000 });
  await clickBeforeClose(control);
  await closed;
}

export async function shutdown(
  browser: Browser | undefined,
  appProcess: ChildProcess | undefined,
): Promise<void> {
  const mainWindow = browser
    ?.contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().includes("/main_window/"));
  await mainWindow?.close({ runBeforeUnload: true });
  await stopProcess(appProcess);
  await browser?.close();
}

export function assertCleanExit(processOutput: string): void {
  assert.doesNotMatch(
    processOutput,
    /(?:^|\n).*FATAL:|Uncaught exception/,
    `The application terminated with a fatal runtime error.\n${outputTail(processOutput)}`,
  );
  if (processOutput.includes("DevTools listening on")) {
    assert.match(
      processOutput,
      /Shutting down at/,
      `The application did not complete a graceful shutdown.\n${outputTail(processOutput)}`,
    );
  }
}
