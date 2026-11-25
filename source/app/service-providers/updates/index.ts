import { trans } from "@common/i18n-main";
import { md2html } from "@common/modules/markdown-utils";
import broadcastIpcMessage from "@common/util/broadcast-ipc-message";
import { initializeMathJax } from "@common/util/mathtex-to-html";
import { showNativeNotification } from "@common/util/show-notification";
import type ConfigProvider from "@providers/config";
import crypto from "crypto";
import { app, net } from "electron";
import { createWriteStream, promises as fs, type WriteStream } from "fs";
import got, { RequestError, type Response } from "got";
import path from "path";
import semver from "semver";
import { openPath } from "source/app/util/open-path";
import { handleInvokeChannel } from "../../util/handle-ipc-channel";
import {
  loadCanonicalMathJaxMacros,
  loadCanonicalMathJaxPairedDelimiters,
} from "../../util/load-mathjax-macros";
import type LogProvider from "../log";
import ProviderContract from "../provider-contract";
import type WindowProvider from "../windows";
import { newestRelease } from "./newest-release";

export interface UpdateAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

export interface ServerAPIResponse {
  id: number;
  tag_name: string;
  name: string;
  prerelease: boolean;
  html_url: string;
  body: string;
  published_at: string;
  assets: UpdateAsset[];
}

export type UpdateState = {
  lastErrorMessage: string | undefined;
  lastErrorCode: string | undefined;
  updateAvailable: boolean;
  lastCheck?: number;
  prerelease: boolean;
  tagName: string;
  releasePage: string;
  changelog: string;
  compatibleAssets: UpdateAsset[];
  checksumFile?: UpdateAsset;
  name: string;
  full_path: string;
  size_total: number;
  size_downloaded: number;
  start_time: number;
  eta_seconds: number;
};

type UpdateErrorCode = "ERR_BODY_PARSE_FAILURE" | "SHA_CHECKSUM_ERR";
class UpdateError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function releaseShapeError(detail: string): UpdateError {
  return new UpdateError(
    "ERR_BODY_PARSE_FAILURE",
    trans("Could not check for updates: The server sent malformed release data (%s)", detail),
  );
}

function parseAsset(value: JsonValue): UpdateAsset {
  if (!isJsonObject(value)) {
    throw releaseShapeError("an asset is not an object");
  }
  const { name, size, browser_download_url } = value;
  if (
    typeof name !== "string" ||
    typeof size !== "number" ||
    typeof browser_download_url !== "string"
  ) {
    throw releaseShapeError("an asset lacks name, size or browser_download_url");
  }
  return { name, size, browser_download_url };
}

function parseRelease(value: JsonValue): ServerAPIResponse {
  if (!isJsonObject(value)) {
    throw releaseShapeError("a release is not an object");
  }
  const { id, tag_name, name, prerelease, html_url, body, published_at, assets } = value;
  if (
    typeof id !== "number" ||
    typeof tag_name !== "string" ||
    typeof name !== "string" ||
    typeof prerelease !== "boolean" ||
    typeof html_url !== "string" ||
    typeof body !== "string" ||
    typeof published_at !== "string" ||
    !Array.isArray(assets)
  ) {
    throw releaseShapeError(`release ${String(tag_name)} does not match the GitHub release schema`);
  }
  return {
    id,
    tag_name,
    name,
    prerelease,
    html_url,
    body,
    published_at,
    assets: assets.map(parseAsset),
  };
}

function parseReleases(value: JsonValue): ServerAPIResponse[] {
  if (!Array.isArray(value)) {
    throw releaseShapeError("the response is not a list of releases");
  }
  return value.map(parseRelease);
}

const CUR_VER = app.getVersion();

export interface ReleaseLocations {
  releasePage: string;
  releasesApi: string;
}

export function releaseLocations(homepage: string): ReleaseLocations {
  const repository = new URL(homepage);
  if (repository.hostname !== "github.com") {
    throw new Error(`package.json homepage ${homepage} is not a GitHub repository.`);
  }
  return {
    releasePage: `${repository.origin}${repository.pathname}/releases`,
    releasesApi: `https://api.github.com/repos${repository.pathname}/releases`,
  };
}

const UPDATE_CHECK_INTERVAL = 1000 * 60 * 60;

function getUpdateState(releasePage: string): UpdateState {
  return {
    lastErrorMessage: undefined,
    lastErrorCode: undefined,
    updateAvailable: false,
    prerelease: false,
    changelog: "",
    releasePage,
    tagName: "",
    compatibleAssets: [],
    name: "",
    full_path: "",
    size_total: 0,
    size_downloaded: 0,
    start_time: 0,
    eta_seconds: 0,
  };
}

export default class UpdateProvider extends ProviderContract {
  private readonly _sha256Data: Map<string, string>;
  private _updateState: UpdateState;
  private _downloadReadStream: undefined | ReturnType<typeof got.stream>;
  private _downloadWriteStream: undefined | WriteStream;
  private _checkInterval: undefined | ReturnType<typeof setInterval>;

  constructor(
    private readonly _logger: LogProvider,
    private readonly _config: ConfigProvider,
    private readonly _windows: Pick<WindowProvider, "showUpdateWindow">,
    private readonly _releases: ReleaseLocations,
  ) {
    super();
    this._logger.verbose("Update provider booting up ...");

    this._sha256Data = new Map();

    this._updateState = getUpdateState(this._releases.releasePage);

    this._downloadReadStream = undefined;
    this._downloadWriteStream = undefined;
  }

  private _registerIpcHandler(): void {
    handleInvokeChannel("update-provider", {
      "check-for-update": async () => {
        await this.check();
      },
      "update-status": () => this._updateState,
      "request-app-update": (_event, { payload }) => {
        this._logger.info("[Update Provider] Requesting update " + payload);
        this._downloadAppUpdate(payload);
      },
      "begin-update": () => {
        this._beginUpdate().catch((e: Error) => {
          this._reportError("EUPDATE", trans("Could not start the update: %s", e.message), true);
        });
        return true;
      },
    });
  }

  applicationUpdateAvailable(): boolean {
    return this._updateState.updateAvailable;
  }

  getUpdateState(): UpdateState {
    return this._updateState;
  }

  private _resetState(): void {
    this._updateState = getUpdateState(this._releases.releasePage);
    broadcastIpcMessage("update-provider", "state-changed", this._updateState);
  }

  private _reportError(code: string, message: string, notify: boolean): void {
    this._logger.error(`[Update Provider] ${code}: ${message}`);
    this._updateState.lastErrorCode = code;
    this._updateState.lastErrorMessage = message;
    broadcastIpcMessage("update-provider", "state-changed", this._updateState);
    if (notify) {
      showNativeNotification(message, trans("Update failed"), () =>
        this._windows.showUpdateWindow(),
      );
    }
  }

  async check(): Promise<void> {
    if (__UPDATES_DISABLED__ === "1") {
      this._reportError(
        "EDISABLED",
        trans("This build of the app does not check for updates."),
        false,
      );
      return;
    }
    if (!net.online) {
      this._reportError(
        "EOFFLINE",
        trans("Could not check for updates: The computer has no network connection."),
        false,
      );
      return;
    }

    this._resetState();

    try {
      this._logger.info(
        `[Update Provider] Checking ${this._releases.releasesApi} for application updates ...`,
      );
      let platformString = "";
      if (process.platform === "win32") {
        platformString = `Windows NT 10.0; ${process.arch}`;
      }
      if (process.platform === "darwin") {
        platformString = `Macintosh; Intel Mac OS X ${process.getSystemVersion()}; ${process.arch}`;
      }
      if (process.platform === "linux") {
        platformString = `Linux ${process.arch === "x64" ? "x86_64" : process.arch}`;
      }

      const response: Response<JsonValue> = await got(this._releases.releasesApi, {
        timeout: { request: 5000 },
        method: "GET",
        responseType: "json",
        headers: {
          "User-Agent": `Zettlr/${CUR_VER} (${platformString})`,
          Accept: "application/vnd.github+json",
        },
        searchParams: new URLSearchParams([["per_page", "100"]]),
      });

      this._updateState = await this._parseResponse(response);
      broadcastIpcMessage("update-provider", "state-changed", this._updateState);

      if (this.applicationUpdateAvailable()) {
        this._logger.info(
          `[Update Provider] New update available! Please update to ${this._updateState.tagName} soon!`,
        );
        await this._retrieveSHA256Sums();

        const { tagName } = this.getUpdateState();
        showNativeNotification(
          trans("An update to version %s is available!", tagName),
          trans("Update available"),
          () => this._windows.showUpdateWindow(),
        );
      } else {
        this._logger.verbose(
          `[Update Provider] No new update available. Current version is ${this._updateState.tagName}.`,
        );
      }
    } catch (err: unknown) {
      if (err instanceof UpdateError) {
        this._reportError(err.code, err.message, true);
        return;
      }

      if (!(err instanceof RequestError)) {
        this._reportError(
          "EUNEXPECTED",
          trans(
            "Could not check for updates: %s",
            err instanceof Error ? err.message : String(err),
          ),
          true,
        );
        return;
      }

      const statusCode = err.response?.statusCode;
      const notFoundError = err.code === "ENOTFOUND";
      const timeoutError = err.code === "ETIMEDOUT";
      const serverError = statusCode !== undefined && statusCode >= 500;
      const clientError = statusCode !== undefined && statusCode >= 400 && statusCode < 500;
      const redirectError = statusCode !== undefined && statusCode >= 300 && statusCode < 400;

      if (serverError) {
        const msg = trans(
          "Could not check for updates: Server Error (Status code: %s)",
          statusCode,
        );
        this._reportError(err.code as string, msg, false);
      } else if (clientError) {
        const msg = trans(
          "Could not check for updates: Client Error (Status code: %s)",
          statusCode,
        );
        this._reportError(err.code as string, msg, false);
      } else if (redirectError) {
        const msg = trans(
          "Could not check for updates: The server tried to redirect (Status code: %s)",
          statusCode,
        );
        this._reportError(err.code as string, msg, true);
      } else if (notFoundError) {
        const msg = trans("Could not check for updates: Could not establish connection");
        this._reportError(err.code as string, msg, false);
      } else if (timeoutError) {
        const msg = trans("Could not check for updates: The connection attempt timed out.");
        this._reportError(err.code as string, msg, false);
      } else {
        const msg = trans("Could not check for updates. %s: %s", err.name, err.message);
        this._reportError(err.code as string, msg, true);
      }
    }
  }

  private async _parseResponse(response: Response<JsonValue>): Promise<UpdateState> {
    const releases = parseReleases(response.body);
    const state = getUpdateState(this._releases.releasePage);
    state.lastCheck = Date.now();
    const parsedResponse = newestRelease(releases, this._config.get("checkForBeta"));
    if (parsedResponse === undefined) {
      this._logger.info(
        `[Update Provider] ${this._releases.releasePage} has no published release.`,
      );
      return state;
    }

    const localVersion = semver.parse(CUR_VER);
    const remoteVersion = semver.parse(parsedResponse.tag_name);

    if (localVersion === null || remoteVersion === null) {
      this._stopDownload();
      const error = new Error(
        "Cannot complete check for new version: Either the local or remote version could not be parsed!",
      );
      this._logger.error(error.message, { localVersion, remoteVersion });
      throw error;
    }

    state.updateAvailable = semver.lt(localVersion, remoteVersion);

    state.tagName = parsedResponse.tag_name;
    state.changelog = await md2html(parsedResponse.body, {
      onCitation: (_c1, _c2) => undefined,
      zknLinkFormat: "link|title",
    });
    state.prerelease = parsedResponse.prerelease;
    state.releasePage = parsedResponse.html_url;

    state.compatibleAssets = parsedResponse.assets.filter((asset) => {
      const assetArch = /arm64|aarch64/.test(asset.name) ? "arm64" : "x64";
      if (process.arch !== assetArch) {
        return false;
      }

      switch (process.platform) {
        case "darwin":
          return /\.dmg$/i.test(asset.name);
        case "win32":
          return /\.exe$/i.test(asset.name);
        case "linux":
          return /\.(?:AppImage|deb|rpm)$/i.test(asset.name);
      }

      return false;
    });

    state.checksumFile = parsedResponse.assets.find((asset) => {
      return asset.name === "SHA256SUMS.txt";
    });

    return state;
  }

  private async _retrieveSHA256Sums(): Promise<void> {
    if (this._updateState.checksumFile === undefined) {
      throw new UpdateError(
        "SHA_CHECKSUM_ERR",
        trans("The SHA256 checksums file seems to be missing for this release."),
      );
    }

    try {
      const response = await got(this._updateState.checksumFile.browser_download_url, {
        method: "GET",
        timeout: { request: 5000 },
      });

      response.body
        .split("\n")
        .map((release) => release.split(/\s+/))
        .filter((release) => release.length === 2)
        .map((release) => {
          this._logger.info(`[Update Provider] Found SHA256 checksum for ${release[1]}`);
          this._sha256Data.set(release[1], release[0]);
        });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new UpdateError(
        "SHA_CHECKSUM_ERR",
        trans("Cannot retrieve SHA256 checksums: %s", message),
        { cause: err },
      );
    }
  }

  private _downloadAppUpdate(url: string): void {
    const updateToPull = this._updateState.compatibleAssets.find((elem) => {
      return elem.browser_download_url === url;
    });

    if (updateToPull === undefined) {
      this._reportError(
        "ENOTFOUND",
        trans("Refused to download file %s: URL is not in the list of server-provided assets", url),
        true,
      );
      return;
    }

    const destination = path.join(app.getPath("downloads"), updateToPull.name);

    this._downloadWriteStream = createWriteStream(destination);
    this._downloadReadStream = got.stream(updateToPull.browser_download_url);

    this._updateState.name = updateToPull.name;
    this._updateState.full_path = destination;
    this._updateState.size_total = updateToPull.size;
    this._updateState.size_downloaded = 0;
    this._updateState.start_time = Date.now();
    this._updateState.eta_seconds = 0;

    broadcastIpcMessage("update-provider", "state-changed", this._updateState);

    this._downloadReadStream.on("data", (chunk) => {
      if (this._downloadWriteStream === undefined) {
        this._abandonDownload(
          "EWRITESTREAM",
          trans("Could not download the update: The file of the download is closed."),
        );
        return;
      }

      const now = Date.now();
      this._updateState.size_downloaded += chunk.length;
      const secondsPassed = (now - this._updateState.start_time) / 1000;
      const bytesPerSecond = this._updateState.size_downloaded / secondsPassed;
      const bytesRemaining = this._updateState.size_total - this._updateState.size_downloaded;
      this._updateState.eta_seconds = Math.round(bytesRemaining / bytesPerSecond);
      broadcastIpcMessage("update-provider", "state-changed", this._updateState);
      this._downloadWriteStream.write(chunk);
    });

    this._downloadReadStream.on("end", () => {
      this._downloadWriteStream?.end(() => {
        this._logger.info(
          `Successfully downloaded ${this._updateState.name}. Transferred ${this._updateState.size_downloaded} bytes overall.`,
        );
        showNativeNotification(
          `Download of ${this._updateState.name} successful!`,
          "Update",
          () => {
            this._windows.showUpdateWindow();
          },
        );
      });
    });

    this._downloadReadStream.on("error", (err) => {
      this._abandonDownload("EREADSTREAM", trans("Could not download the update: %s", err.message));
    });

    this._downloadWriteStream.on("error", (err) => {
      this._abandonDownload(
        "EWRITESTREAM",
        trans("Could not save the update to %s: %s", destination, err.message),
      );
    });
  }

  async _beginUpdate(): Promise<void> {
    showNativeNotification("Verifying update ...");

    const correctSHA = this._sha256Data.get(this._updateState.name);

    if (correctSHA === undefined) {
      await this._abandonDownload(
        "EVERIFY",
        trans(
          "Could not verify the integrity of the downloaded update. Please retry or update manually.",
        ),
      );
      return;
    }

    const download = this._updateState.full_path;
    let fileContents: Buffer;
    try {
      fileContents = await fs.readFile(download);
    } catch (err: unknown) {
      this._stopDownload();
      const message = err instanceof Error ? err.message : String(err);
      this._reportError(
        "EREADFILE",
        trans("Could not read the downloaded update %s: %s", download, message),
        true,
      );
      return;
    }
    const downloadSHA = crypto.createHash("sha256").update(fileContents).digest("hex");

    if (downloadSHA !== correctSHA) {
      await this._abandonDownload(
        "EVERIFY",
        trans(
          "The downloaded file has a different checksum than the server reported. Please retry or update manually.",
        ),
      );
      return;
    }
    this._logger.info(
      `[Update Provider] Successfully verified the checksum of ${this._updateState.name} (${downloadSHA})!`,
    );

    try {
      if (download.endsWith(".AppImage")) {
        await openPath(path.dirname(download));
      } else {
        await openPath(download);
      }
      app.quit();
    } catch (err: unknown) {
      this._stopDownload();
      const message = err instanceof Error ? err.message : String(err);
      this._reportError(
        "EOPEN",
        trans("Could not start update. Please retry or update manually. Error was: %s", message),
        true,
      );
    }
  }

  private _stopDownload(): string {
    if (this._downloadWriteStream !== undefined) {
      this._downloadWriteStream.close();
      this._downloadWriteStream = undefined;
    }
    if (this._downloadReadStream !== undefined) {
      this._downloadReadStream.destroy();
      this._downloadReadStream = undefined;
    }
    const download = this._updateState.full_path;
    this._resetState();
    return download;
  }

  private async _abandonDownload(code: string, message: string): Promise<void> {
    const download = this._stopDownload();
    const removal =
      download === ""
        ? undefined
        : await fs.rm(download, { force: true }).then(
            () => undefined,
            (err: Error) => err,
          );
    this._reportError(
      code,
      removal === undefined
        ? message
        : `${message} ${trans("The download %s stays on disk: %s", download, removal.message)}`,
      true,
    );
  }

  async boot(): Promise<void> {
    const home = app.getPath("home");
    await initializeMathJax(
      await loadCanonicalMathJaxMacros(home),
      await loadCanonicalMathJaxPairedDelimiters(home),
    );
    this._registerIpcHandler();

    this._checkInterval = setInterval(() => {
      const { checkForUpdates } = this._config.get().system;
      if (!checkForUpdates || this.applicationUpdateAvailable()) {
        return;
      }

      this.check().catch((err) => {
        this._logger.error("[Update Provider] Could not check for updates: Unexpected error", err);
      });
    }, UPDATE_CHECK_INTERVAL);

    if (!this._config.get().system.checkForUpdates) {
      return;
    }

    this.check().catch((err) => {
      this._logger.error("[Update Provider] Could not check for updates: Unexpected error", err);
    });
  }

  async shutdown(): Promise<void> {
    this._logger.verbose("Update provider shutting down ...");
    clearInterval(this._checkInterval);
    const downloadUnfinished =
      this._updateState.size_downloaded > 0 &&
      this._updateState.size_downloaded !== this._updateState.size_total;
    const download = this._stopDownload();
    if (downloadUnfinished) {
      await fs.rm(download, { force: true });
    }
  }
}
