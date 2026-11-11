import type LogProvider from "@providers/log";
import { shell } from "electron";
import { promises as fs } from "fs";

export async function safeDelete(
  absPath: string,
  deleteOnFail: boolean,
  logger: LogProvider,
): Promise<void> {
  try {
    await shell.trashItem(absPath);
  } catch (err) {
    if (deleteOnFail) {
      // If this function throws, there's really something off and we shouldn't recover.
      logger.error(`[FSAL File] Forcing deletion of "${absPath}"!`);
      await fs.rm(absPath, { recursive: true, force: true });
    } else {
      // The window shows this message. It names the setting that changes
      // what the application does next time.
      if (err instanceof Error) {
        err.message = `Could not move ${absPath} to the trash: ${err.message}. To delete such a file, set "Delete items irreversibly if moving them to trash fails" in Preferences, Advanced.`;
      }
      throw err;
    }
  }
}
