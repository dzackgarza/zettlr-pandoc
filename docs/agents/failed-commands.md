# 15. Failed application commands

- **A command that cannot do its work throws.** A command
  (`service-providers/commands/`) throws an `Error` whose message names the
  file or folder and the cause. It does not write the cause to the log and
  answer `false`: `false` is a value of the contract of some commands, and a
  caller cannot tell it from a failure. The one exception is a command that
  showed the cause itself, in a native dialog or in the error window ("A
  command that prompts answers its contract", below): `dir-new`,
  `dir-rename`, `file-duplicate`, `file-rename`, `request-move` and the
  Project export return after their prompt.
- **The dispatcher shows each failure once, in the window that started the
  command.** `CommandProvider.run` (`commands/index.ts`) logs the error,
  sends it on `command-failed` (`types/common/command-failure.ts`) to the
  window whose renderer started the command, and rejects to the caller. The
  main window gets the failure of a command that the application started (a
  menu item, a second instance) and of a command whose window is gone. Each
  window shows the message as an error (`window-register`). A command that
  runs a command (`force-open`, `tutorial-open`) passes the same error on;
  the dispatcher shows it one time.
- **A caller does not show a rejection of a command.** It logs the rejection
  (`reportError`) and stops its own work: no success message, no further
  step. A second message in the caller repeats the first.
- **`CALLER_SHOWS_FAILURE`** names the commands that a window runs on its
  own (a lint pass, a figure render, a hover preview). Their callers show the
  failure in their own place, and the dispatcher broadcasts nothing for them.
  A new command of that kind goes into the set; a command that an action of
  the author starts does not.
- **A refused open of a document or a link is shown in the window that
  asked.** The `open-file` request of the documents provider and the
  navigation handler (`attach-app-navigation-handlers.ts`) send the refusal
  on `command-failed` to that window (`showRefusalInWindow`,
  `app/util/show-refusal-in-window.ts`); each caller in the window logs the
  rejection and stops. Proof: `e2e/follow-link-refused.spec.ts`.
- **A command that prompts answers its contract.** A command that showed the
  cause itself in a native dialog or in the error window (`dir-rename`, the
  Project export) returns its value and does not throw as well.
- **A Project export gives one message for all its profiles.** One profile
  that does not export does not stop the other profiles. When a profile did
  not export, `dir-project-export` opens one error window that names each
  such profile with its cause, shows no success notification and answers
  `false`. A new error window closes the one before it, so a command that
  can fail in more than one part collects the causes and opens one window.
- **Proof:** `e2e/command-refusal.spec.ts`,
  `e2e/project-settings-refusal.spec.ts`, `test/project-export.spec.ts`,
  `e2e/project-export-failure.spec.ts`.
