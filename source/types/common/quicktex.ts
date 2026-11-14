/** A setting of the QuickTeX configuration that the app could not use. */
export interface QuickTexProblem {
  setting: "editor.quickTexFile" | "editor.quickTexPluginDirectory";
  /** The value that the setting had when the app read it. */
  path: string;
  /** Why the app could not use it. The sentence names the file. */
  cause: string;
}

/** Evaluated QuickTeX dictionaries, with Vim keycodes rendered by keytrans(). */
export interface QuickTexCatalogue {
  prose: Record<string, string>;
  math: Record<string, string>;
  excludeChars: string[];
  sourceFile: string;
  /** Why the configuration of the settings gives no expansions. */
  problem: QuickTexProblem | undefined;
}
