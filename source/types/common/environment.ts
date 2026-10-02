/** Whether this desktop can show a tray icon, and why not when it cannot. */
export type TraySupport = { supported: true } | { supported: false; reason: string };

/**
 * What the main process found about the system it runs on. The main process
 * owns it; renderers read it through the synchronous `environment-info`
 * channel. Pandoc is required; an optional program has no version when absent.
 */
export interface EnvironmentInfo {
  programVersions: {
    pandoc: string;
    quarto: string | undefined;
    git: string | undefined;
  };
  tray: TraySupport;
}
