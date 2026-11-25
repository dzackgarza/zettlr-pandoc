import { strict as assert } from "node:assert";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  AGENT_API_TOKEN,
  type AgentClient,
  agentClient,
  currentPackagedBinary,
  delay,
  readAgentApiPort,
  startDeadline,
} from "../support/electron-app";

const execFile = promisify(execFileCallback);

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_WINDOW_CLASS = "zettlr-pandoc";
const SPLASH_WINDOW_CLASS = "zpandoc-boot";

const COLD_MARKER = "INSTALLED_LAUNCHER_COLD_DELIVERY_MARKER_7C40D1B2";
const RUNNING_MARKER = "INSTALLED_LAUNCHER_RUNNING_DELIVERY_MARKER_9A81E6F4";

interface HyprlandClient {
  class: string;
  pid: number;
}

async function hyprlandClients(): Promise<HyprlandClient[]> {
  const { stdout } = await execFile("hyprctl", ["clients", "-j"]);
  const parsed: unknown = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed), "hyprctl clients -j must return an array");
  return parsed.filter(
    (client): client is HyprlandClient =>
      typeof client === "object" &&
      client !== null &&
      "class" in client &&
      typeof client.class === "string" &&
      "pid" in client &&
      typeof client.pid === "number",
  );
}

async function windowsOfClass(windowClass: string): Promise<HyprlandClient[]> {
  return (await hyprlandClients()).filter((client) => client.class === windowClass);
}

class PollTimeoutError extends Error {}

async function pollUntil<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) {
      return result;
    }
    await delay(500);
  }
  throw new PollTimeoutError(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function signalGroup(pid: number, signal: NodeJS.Signals): "delivered" | "gone" {
  try {
    process.kill(-pid, signal);
    return "delivered";
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") {
      return "gone";
    }
    throw error;
  }
}

async function launcherLogTail(home: string): Promise<string> {
  const logFile = path.join(home, ".cache", "zettlr-pandoc-dev.log");
  const contents = await readFile(logFile, "utf8").catch(
    (error: NodeJS.ErrnoException) => `<no launcher log at ${logFile}: ${error.message}>`,
  );
  return contents.split("\n").slice(-40).join("\n");
}

async function openDocumentPaths(api: AgentClient): Promise<string[]> {
  const context = await api.get("/v1/context");
  assert.ok(isRecord(context) && Array.isArray(context.openDocuments));
  return context.openDocuments.map((document: unknown) => {
    assert.ok(isRecord(document) && typeof document.path === "string");
    return document.path;
  });
}

describe("file delivery through the installed desktop launcher (#52)", function () {
  this.timeout(startDeadline({}) + 60_000);

  let testHome: string | undefined;
  let appPid: number | undefined;

  const environment = (): NodeJS.ProcessEnv => {
    const child: NodeJS.ProcessEnv = { ...process.env, HOME: testHome };
    delete child.XDG_CONFIG_HOME;
    delete child.XDG_DATA_HOME;
    delete child.XDG_CACHE_HOME;
    delete child.XDG_STATE_HOME;
    delete child.ZETTLR_AGENT_API_TOKEN;
    return child;
  };

  before(async function () {
    await execFile("hyprctl", ["clients", "-j"]).catch((error: Error) => {
      assert.fail(
        `A live Hyprland compositor is required for the installed-launcher proof: ${error.message}`,
      );
    });
    for (const requiredCommand of ["kitty", "gio", "jq", "just", "direnv"]) {
      await execFile("sh", ["-c", `command -v ${requiredCommand}`]).catch(() => {
        assert.fail(`Required command is unavailable: ${requiredCommand}`);
      });
    }
    const preexisting = await windowsOfClass(APP_WINDOW_CLASS);
    assert.equal(
      preexisting.length,
      0,
      "Another Zettlr-Pandoc instance is running. The launcher chain is " +
        "single-instance per desktop, so this proof needs the session to itself: " +
        "close the running app and re-run.",
    );
    currentPackagedBinary();

    const pandocJustfile = path.join(homedir(), ".pandoc", "justfile");
    await readFile(pandocJustfile).catch((error: NodeJS.ErrnoException) => {
      assert.fail(
        `The boot script refreshes the MathJax macros through the justfile of ~/.pandoc at ${pandocJustfile}: ${error.message}`,
      );
    });

    testHome = await mkdtemp(path.join(tmpdir(), "zettlr-launcher-home-"));
    await symlink(path.join(homedir(), ".pandoc"), path.join(testHome, ".pandoc"));
    const profileDirectory = path.join(testHome, ".config", "Zettlr-Pandoc");
    const workspaceDirectory = path.join(testHome, "workspace");
    await mkdir(profileDirectory, { recursive: true });
    await mkdir(workspaceDirectory, { recursive: true });

    const packageMetadata: unknown = JSON.parse(
      await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    assert.ok(
      isRecord(packageMetadata) && typeof packageMetadata.version === "string",
      "package.json must declare the application version",
    );
    await writeFile(
      path.join(profileDirectory, "config.json"),
      `${JSON.stringify(
        {
          version: packageMetadata.version,
          app: { openFiles: [], openWorkspaces: [workspaceDirectory] },
          system: { checkForUpdates: false },
          agentApi: { enabled: true, port: 0 },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const alreadyOpenDocument = path.join(workspaceDirectory, "already-open.md");
    await writeFile(alreadyOpenDocument, "# Already open\n\nSeed document.\n", "utf8");
    await writeFile(
      path.join(profileDirectory, "documents.yaml"),
      [
        "56b44854-b144-4a6f-8061-dcfeb6e512e8:",
        "  type: leaf",
        "  id: 7b4dd4f2-48a2-4279-b6c9-577132e64480",
        "  openFiles:",
        `    - path: ${alreadyOpenDocument}`,
        "      pinned: false",
        `  activeFile:`,
        `    path: ${alreadyOpenDocument}`,
        "    pinned: false",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      path.join(testHome, ".envrc"),
      `export ZETTLR_AGENT_API_TOKEN=${AGENT_API_TOKEN}\n`,
      "utf8",
    );
    await execFile("direnv", ["allow", testHome], { env: environment() });

    const installation = await execFile(
      path.join(REPO_ROOT, "scripts", "install-desktop-launcher.sh"),
      [],
      { env: environment() },
    );
    assert.match(installation.stdout, /Installed Zettlr-Pandoc desktop launcher/);
  });

  after(async function () {
    if (appPid !== undefined) {
      const windowGone = async (): Promise<true | undefined> =>
        (await windowsOfClass(APP_WINDOW_CLASS)).length === 0 ? true : undefined;
      if (signalGroup(appPid, "SIGTERM") === "delivered") {
        try {
          await pollUntil(windowGone, 30_000, "the app group to exit on SIGTERM");
        } catch (error) {
          if (!(error instanceof PollTimeoutError)) {
            throw error;
          }
          signalGroup(appPid, "SIGKILL");
          await pollUntil(windowGone, 10_000, "the app group to exit on SIGKILL");
        }
      }
    }
    if (testHome !== undefined) {
      await rm(testHome, { recursive: true, force: true });
    }
  });

  it("cold start opens the file argument as the focused editor document", async function () {
    assert.ok(testHome !== undefined);
    const home = testHome;
    const profileDirectory = path.join(home, ".config", "Zettlr-Pandoc");
    const coldDocument = path.join(home, "workspace", "delivered-cold.md");
    await writeFile(coldDocument, `# Cold delivery\n\n${COLD_MARKER}\n`, "utf8");

    const desktopFile = path.join(home, ".local", "share", "applications", "zettlr-pandoc.desktop");
    const launch = await execFile("gio", ["launch", desktopFile, coldDocument], {
      env: environment(),
    });

    const [appWindow] = await windowsOfClass(APP_WINDOW_CLASS);
    if (appWindow === undefined) {
      assert.fail(
        "The installed launcher chain exited without starting the app.\n" +
          `chain stderr: ${launch.stderr.trim()}\n` +
          `launcher log:\n${await launcherLogTail(home)}`,
      );
    }
    assert.ok(appWindow.pid > 0);

    const port = await readAgentApiPort(profileDirectory, 60_000);
    const api = agentClient(port);
    const ping = await api.get("/v1/ping");
    assert.ok(isRecord(ping) && typeof ping.pid === "number");
    appPid = ping.pid;

    const focused = await pollUntil(
      async () => {
        const context = await api.get("/v1/context");
        if (
          isRecord(context) &&
          isRecord(context.focusedDocument) &&
          context.focusedDocument.path === coldDocument
        ) {
          return context.focusedDocument;
        }
        return undefined;
      },
      60_000,
      "the cold-delivered file to become the focused document",
    );
    assert.ok(isRecord(focused) && typeof focused.documentId === "string");
    const content = await api.get(
      `/v1/documents/${encodeURIComponent(focused.documentId)}?includeContent=true`,
    );
    assert.ok(isRecord(content) && typeof content.content === "string");
    assert.ok(
      content.content.includes(COLD_MARKER),
      "the editor must hold the authored contents of the delivered file",
    );
  });

  it("a second activation delivers its file into the running instance", async function () {
    assert.ok(testHome !== undefined && appPid !== undefined);
    const profileDirectory = path.join(testHome, ".config", "Zettlr-Pandoc");
    const runningDocument = path.join(testHome, "workspace", "delivered-running.md");
    await writeFile(runningDocument, `# Running delivery\n\n${RUNNING_MARKER}\n`, "utf8");

    const desktopFile = path.join(
      testHome,
      ".local",
      "share",
      "applications",
      "zettlr-pandoc.desktop",
    );
    await execFile("gio", ["launch", desktopFile, runningDocument], { env: environment() });

    const port = await readAgentApiPort(profileDirectory, 60_000);
    const api = agentClient(port);
    await pollUntil(
      async () => ((await openDocumentPaths(api)).includes(runningDocument) ? true : undefined),
      120_000,
      "the running instance to open the delivered file",
    );

    const ping = await api.get("/v1/ping");
    assert.ok(isRecord(ping) && typeof ping.pid === "number");
    assert.equal(ping.pid, appPid, "delivery must reach the original instance");
    assert.equal((await windowsOfClass(APP_WINDOW_CLASS)).length, 1);
    assert.equal(
      (await windowsOfClass(SPLASH_WINDOW_CLASS)).length,
      0,
      "the boot splash must have closed after the handoff",
    );
  });
});
