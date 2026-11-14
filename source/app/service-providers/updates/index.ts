/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        UpdateProvider
 * CVM-Role:        Service Provider
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Takes care of downloading any updates to the app.
 *
 * END HEADER
 */

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
import { loadCanonicalMathJaxMacros } from "../../util/load-mathjax-macros";
import type LogProvider from "../log";
import ProviderContract from "../provider-contract";
import type WindowProvider from "../windows";
import { newestRelease } from "./newest-release";

/**
 * Struct which represents a single asset provided for by the updater
 */
export interface UpdateAsset {
  /**
   * The filename of the asset
   */
  name: string;
  /**
   * The total file size in bytes
   */
  size: number;
  /**
   * The URL to download this asset
   */
  browser_download_url: string;
}

/**
 * This struct contains the information returned by the Update API
 */
export interface ServerAPIResponse {
  /**
   * GitHub's internal ID
   */
  id: number;
  /**
   * The tag name of the new version
   */
  tag_name: string;
  /**
   * The name of the new version
   */
  name: string;
  /**
   * Whether the new version is a beta
   */
  prerelease: boolean;
  /**
   * A link to the release page (currently unused)
   */
  html_url: string;
  /**
   * The changelog (raw Markdown string)
   */
  body: string;
  /**
   * The publication date (currently unused)
   */
  published_at: string;
  /**
   * All assets available in this update
   */
  assets: UpdateAsset[];
}

/**
 * This struct holds all information necessary to guide a user through the
 * complete update process
 */
export type UpdateState = {
  /**
   * If lastErrorMessage is not undefined, an error occurred. The error
   * corresponds to the got error classes
   */
  lastErrorMessage: string | undefined;
  /**
   * Contains the last error code
   */
  lastErrorCode: string | undefined;
  /**
   * Whether or not an update is available
   */
  updateAvailable: boolean;
  /**
   * When the last update check happened (in Milliseconds as returned from Date.now())
   */
  lastCheck?: number;
  /**
   * Is this release a beta version?
   */
  prerelease: boolean;
  /**
   * The tag name of the new version
   */
  tagName: string;
  /**
   * Contains a link to the GitHub release page, used if there is no compatible asset
   */
  releasePage: string;
  /**
   * The changelog of this update
   */
  changelog: string;
  /**
   * A list of assets available for this specific computer
   */
  compatibleAssets: UpdateAsset[];
  /**
   * The file containing the SHA256 checksums
   */
  checksumFile?: UpdateAsset;
  /**
   * The release's name
   */
  name: string;
  /**
   * The full path to the downloaded file
   */
  full_path: string;
  /**
   * The total size in bytes
   */
  size_total: number;
  /**
   * The size of the already downloaded chunk
   */
  size_downloaded: number;
  /**
   * When the download has started
   */
  start_time: number;
  /**
   * How long the update will approximately still need
   */
  eta_seconds: number;
};

type UpdateErrorCode = "ERR_BODY_PARSE_FAILURE" | "SHA_CHECKSUM_ERR";
/**
 * Custom updater error that supports an error code
 */
class UpdateError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * A value that JSON.parse can return (RFC 8259).
 */
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

/**
 * Validates the GitHub releases response against ServerAPIResponse.
 */
function parseReleases(value: JsonValue): ServerAPIResponse[] {
  if (!Array.isArray(value)) {
    throw releaseShapeError("the response is not a list of releases");
  }
  return value.map(parseRelease);
}

const CUR_VER = app.getVersion();

/** Where the releases of the app are: the page for a person, the list for the provider. */
export interface ReleaseLocations {
  releasePage: string;
  releasesApi: string;
}

/**
 * The releases of the GitHub repository that package.json names as the
 * homepage are this app's updates. The GitHub REST API serves them under
 * /repos/{owner}/{repo}/releases.
 */
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

const UPDATE_CHECK_INTERVAL = 1000 * 60 * 60; // 1 hour

/**
 * Returns a clean update state with default values
 *
 * @return  {UpdateState}  The clean state
 */
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

    // Initialize the update state
    this._updateState = getUpdateState(this._releases.releasePage);

    // Initialize the write/read streams used during downloads
    this._downloadReadStream = undefined;
    this._downloadWriteStream = undefined;
  }

  private _registerIpcHandler(): void {
    handleInvokeChannel("update-provider", {
      "check-for-update": async () => {
        await this.check();
      },
      "update-status": () => this._updateState,
      // The payload is the URL of the update to download
      "request-app-update": (_event, { payload }) => {
        this._logger.info("[Update Provider] Requesting update " + payload);
        this._downloadAppUpdate(payload);
      },
      "begin-update": () => {
        // Begin the actual update process NOTE We're not blocking the handler
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

  /**
   * Resets the update state, and emits an update message.
   */
  private _resetState(): void {
    this._updateState = getUpdateState(this._releases.releasePage);
    broadcastIpcMessage("update-provider", "state-changed", this._updateState);
  }

  /**
   * Utility function to report an error both to the logs and to the update window
   *
   * @param   {string}   code          The error code
   * @param   {string}   message       The error message
   * @param   {boolean}  notify        Whether to show a desktop notification,
   *                                   which opens the update window on click
   */
  private _reportError(code: string, message: string, notify: boolean): void {
    this._logger.error(`[Update Provider] ${code}: ${message}`);
    this._updateState.lastErrorCode = code;
    this._updateState.lastErrorMessage = message;
    broadcastIpcMessage("update-provider", "state-changed", this._updateState);
    if (notify) {
      // The message names the step that failed: the check, the download,
      // the verify or the start of the update.
      showNativeNotification(message, trans("Update failed"), () =>
        this._windows.showUpdateWindow(),
      );
    }
  }

  /**
   * Runs a query to the API for new versions
   *
   * @return {Promise} Resolves only when there is an update available.
   */
  async check(): Promise<void> {
    // A check that does not run keeps the result of the last check and says
    // why it did not run.
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

    // First, reset the update state
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

      // got parses the body; a body that is not JSON is a ParseError
      // (a RequestError), which the handler below reports with its message.
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

      // Next: Parse the result
      this._updateState = await this._parseResponse(response);
      broadcastIpcMessage("update-provider", "state-changed", this._updateState);

      // At this point, notify the user if applicable
      if (this.applicationUpdateAvailable()) {
        this._logger.info(
          `[Update Provider] New update available! Please update to ${this._updateState.tagName} soon!`,
        );
        // Immediately retrieve the SHA checksum file so we have it available.
        await this._retrieveSHA256Sums();

        // Then notify the user; a click opens the updater
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
        // Report this error
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

      // See for all errors https://github.com/sindresorhus/got/blob/main/documentation/8-errors.md
      // A connection error (ENOTFOUND, ETIMEDOUT) has no response and so no
      // status code.
      const statusCode = err.response?.statusCode;
      const notFoundError = err.code === "ENOTFOUND";
      const timeoutError = err.code === "ETIMEDOUT";
      const serverError = statusCode !== undefined && statusCode >= 500;
      const clientError = statusCode !== undefined && statusCode >= 400 && statusCode < 500;
      const redirectError = statusCode !== undefined && statusCode >= 300 && statusCode < 400;

      // Give a more detailed error message.
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
        this._reportError(err.code as string, msg, true); // This is odd and should be reported
      } else if (notFoundError) {
        // getaddrinfo has reported that the host has not been found.
        // This normally only happens if the networking interface is
        // offline. In this case, no need to inform the user every hour.
        const msg = trans("Could not check for updates: Could not establish connection");
        this._reportError(err.code as string, msg, false);
      } else if (timeoutError) {
        // This can happen if the internet is either really bad or drops during the
        // connection attempt. In any case, this can happen often with, e.g.,
        // company VPNs and other firewalls, and would be distracting to see every
        // hour or so. See #5944 for context.
        const msg = trans("Could not check for updates: The connection attempt timed out.");
        this._reportError(err.code as string, msg, false);
      } else {
        // Something else has occurred. GotError objects have a name property.
        const msg = trans("Could not check for updates. %s: %s", err.name, err.message);
        this._reportError(err.code as string, msg, true); // This is odd and should be reported
      }
    }
  }

  /**
   * Parses the response body from the update query and
   * if applicable.
   *
   * @param {Response} response The response from the server
   */
  private async _parseResponse(response: Response<JsonValue>): Promise<UpdateState> {
    // got returns an empty string for an empty body, which parseReleases refuses.
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

    const localVersion = semver.parse(CUR_VER); // localVersion
    const remoteVersion = semver.parse(parsedResponse.tag_name); // remoteVersion

    if (localVersion === null || remoteVersion === null) {
      this._stopDownload();
      const error = new Error(
        "Cannot complete check for new version: Either the local or remote version could not be parsed!",
      );
      this._logger.error(error.message, { localVersion, remoteVersion });
      throw error;
    }

    // We have one issue (#5429), namely that Zettlr follows the convention to
    // declare nightlies using the SAME major/minor/patch as the current stable
    // release with "-nightly" appended to it. However, under strict SemVer
    // rules, this makes the nightlies a *prerelease* (and not a ...
    // "postrelease"...? I don't think this term exists). Here we have to do a
    // bit of manual engineering to account for this edge case.

    // NOTE: Zettlr makes use of major, minor, and patch versions, plus "betas"
    // (beta, beta.1, beta.2, etc.), and as build-identifiers "nightly".
    // This ensures that `semver.lt` will always work properly, indicating that
    // nightlies will never attempt to update to the same-but-older version:
    // semver.lt('4.0.0-beta+nightly', '4.0.0-beta' returns false).
    state.updateAvailable = semver.lt(localVersion, remoteVersion);

    // Adapt the rest of the state
    state.tagName = parsedResponse.tag_name;
    // NOTE: We do not sanitize the HTML here. Instead we sanitize it in the
    // update window directly.
    state.changelog = await md2html(parsedResponse.body, {
      onCitation: (_c1, _c2) => undefined,
      zknLinkFormat: "link|title",
    });
    state.prerelease = parsedResponse.prerelease;
    state.releasePage = parsedResponse.html_url;

    state.compatibleAssets = parsedResponse.assets.filter((asset) => {
      // Filter out the assets unusable on the current platform.
      const assetArch = /arm64|aarch64/.test(asset.name) ? "arm64" : "x64";
      if (process.arch !== assetArch) {
        return false;
      }

      // Determine compatibility based on the file extensions
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

  /**
   * Attempts to download and parse the SHA 256 sums for the releases
   *
   * @return {boolean} The success or failure of the operation
   */
  private async _retrieveSHA256Sums(): Promise<void> {
    if (this._updateState.checksumFile === undefined) {
      throw new UpdateError(
        "SHA_CHECKSUM_ERR",
        trans("The SHA256 checksums file seems to be missing for this release."),
      );
    }

    // Let's download the SHA256 data as well
    try {
      const response = await got(this._updateState.checksumFile.browser_download_url, {
        method: "GET",
        timeout: { request: 5000 },
      });

      // Now we need to parse the data. It looks like this:
      // [sha256 sum]  [binary name]
      // So we first need to split on newlines and then on spaces
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

  /**
   * Download the given application update
   *
   * @param {string} url The URL to download
   */
  private _downloadAppUpdate(url: string): void {
    // First, let's find the update
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

    // Save to downloads folder
    const destination = path.join(app.getPath("downloads"), updateToPull.name);

    // The read stream reads the remote binary file, the write stream pipes that
    // data through to the local file.
    this._downloadWriteStream = createWriteStream(destination);
    this._downloadReadStream = got.stream(updateToPull.browser_download_url);

    // Preset the appropriate values on the internal state
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
      // Close the write stream. This will free the file handle, which is
      // important on Windows for the next step, because if this is not done,
      // Windows will refuse to open the file and emit an error that the file is
      // still in use. The download is complete when the file has each byte.
      this._downloadWriteStream?.end(() => {
        this._logger.info(
          `Successfully downloaded ${this._updateState.name}. Transferred ${this._updateState.size_downloaded} bytes overall.`,
        );
        showNativeNotification(
          `Download of ${this._updateState.name} successful!`,
          "Update",
          () => {
            // The user has clicked the notification, so we can show the update window here
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

  /**
   * Verify the downloaded binary file and then commence the update process
   * by launching the installer and closing the app.
   */
  async _beginUpdate(): Promise<void> {
    // What this function does:
    // 1. Download the SHA checksums
    // 2. Check that the file is correct
    // 3. Launch the file
    // 4. Quit the app
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

    // Then launch the file and immediately quit the app.
    try {
      if (download.endsWith(".AppImage")) {
        // AppImages need to be manually moved by the user
        await openPath(path.dirname(download));
      } else {
        // Everything else can be opened as is
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

  /**
   * Stops the streams of the download and resets the provider state, so
   * that another download can begin.
   *
   * @return  {string}  The path of the download; empty when none was started
   */
  private _stopDownload(): string {
    // First, clean out the download write stream
    if (this._downloadWriteStream !== undefined) {
      this._downloadWriteStream.close();
      this._downloadWriteStream = undefined;
    }
    // Second the read stream
    if (this._downloadReadStream !== undefined) {
      this._downloadReadStream.destroy();
      this._downloadReadStream = undefined;
    }
    const download = this._updateState.full_path;
    this._resetState();
    return download;
  }

  /**
   * Gives up the download: stops it, removes its file and reports the cause.
   * A file that cannot be removed is named in the report.
   *
   * @param   {string}  code     The error code
   * @param   {string}  message  The cause, which names the step that failed
   */
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
    await initializeMathJax(await loadCanonicalMathJaxMacros(app.getPath("home")));
    // A check renders the changelog through md2html, which needs MathJax.
    this._registerIpcHandler();

    // Initiate the update check
    this._checkInterval = setInterval(() => {
      // Only check if the user wants to, and if there is not yet a new version.
      const { checkForUpdates } = this._config.get().system;
      if (!checkForUpdates || this.applicationUpdateAvailable()) {
        return;
      }

      this.check().catch((err) => {
        this._logger.error("[Update Provider] Could not check for updates: Unexpected error", err);
      });
    }, UPDATE_CHECK_INTERVAL);

    // One initial check (if applicable)
    if (!this._config.get().system.checkForUpdates) {
      return;
    }

    this.check().catch((err) => {
      this._logger.error("[Update Provider] Could not check for updates: Unexpected error", err);
    });
  }

  /**
   * Shuts down the provider
   * @return {Boolean} Whether or not the shutdown was successful
   */
  async shutdown(): Promise<void> {
    this._logger.verbose("Update provider shutting down ...");
    clearInterval(this._checkInterval);
    // We'll be removing the file IF and only IF the download was not finished.
    const downloadUnfinished =
      this._updateState.size_downloaded > 0 &&
      this._updateState.size_downloaded !== this._updateState.size_total;
    const download = this._stopDownload();
    if (downloadUnfinished) {
      await fs.rm(download, { force: true });
    }
  }
}
