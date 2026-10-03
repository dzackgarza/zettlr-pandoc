# Task progress handoff

## Current state

- Branch: `feat/shared-task-progress`.
- PR: https://github.com/dzackgarza/zettlr-pandoc/pull/175, open against `develop`.
- Hosted `qc-ci / qc` passed on `56b74deb96f1d857c1f108ec3f893b2b42bd5138`.
- Two hosted `Unit Tests / Lint` jobs remain in progress: runs `37123234228` and `37123230779`. Both reached assembled-app E2E.
- No local test process is running. Use CI for the remaining checks.

## Change

- `source/common/vue/TaskProgressIndicator.vue` shows activity and a native progress element. It shows a percentage when a task reports a fraction.
- `source/win-main/MainStatusbar.vue` and `source/win-main/PopoverLRT.vue` use this shared display.
- `source/common/vue/PopoverWrapper.vue` places the task popover in view at the right edge.
- `e2e/problems-view.spec.ts` checks workspace lint progress, the task popover, count, placement, and screenshots.

## Remaining work

1. Read the latest PR check results. Fix any app test failure from its hosted log.
2. Inspect the hosted `workspace-lint-task.png` artifact. A prior local screenshot showed poor dark-theme contrast; the theme-token change has not had a visual check afterward.
3. After required checks pass and the screenshot is acceptable, merge PR #175 and prune the feature branch.
4. Check the worktree and local `develop` after merge. Preserve unrelated local work.

## QC finding

Editing `e2e/window-statusbar.spec.ts` triggered a file-wide `defensive.async-noise` finding. Replacing its custom polling and combining the new progress assertion with an existing wait did not clear the finding. The status bar test file is absent from the final feature diff. Its existing custom polling remains and has not been remediated. The final five-file feature diff passed hosted QC.
