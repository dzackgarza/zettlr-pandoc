# Handoff

## Task

The user asked the maintainer to fix every outstanding issue of zettlr-pandoc
and every defect found on the way. The user is the end user: they report the
functions they need and the problems they meet.

The user chose to merge PR #209 (`feat/visual-tikz-desktop` into `develop`)
when its required checks are green, and to review the fixes on `develop`
after the merge. The user said that many red tests of the branch are made to
fail in a way that a later fix turns green, and that they do not reproduce
the reported failure. That review is the next task after the merge.

## Completion condition

| Item | Acceptance | Status |
| --- | --- | --- |
| PR #209 merged | Required checks green on the head, no open review thread | Open until the merge |
| Review of the fixes of #209 | Each red test reproduces the reported failure through the real path; a test that does not is replaced by one that does | Review done, dispositions on #217 |
| Each open issue that #209 does not close | Fixed with a red proof, or found not reproducible with evidence on the issue | Open |

Open issues that #209 does not close (read `gh issue list --state open` and
the `closes` line of the PR body; this list is from 2026-11-13):

| Kind | Issues |
| --- | --- |
| Backlogs and ledgers | #16, #18, #19, #20, #21, #57, #66, #69, #96, #115, #132, #197 |
| Architecture | #6, #8, #13, #203 |
| Defects | #94, #118, #123, #210 (four updater defects) |
| Quarto | #83 |
| Test and CI | #38, #47, #62, #70, #82, #91, #108, #112, #131, #160 |

## Next work

1. If #209 is not merged, read `gh pr checks 209` and merge when the
   required checks pass. Then watch the push run of `develop`.
2. Close the backlogs and ledgers whose children are closed; read each
   for a child that is still open.
3. Work the defects by root cause, then #203 (one parser of each Markdown
   element) and #132 (responsiveness).

Before you believe a claim of this file, check it against the issue, the
code and the CI run of the branch head.

## State outside the repository

- `cloudflared-zettlr.service` (systemd user unit) publishes
  `127.0.0.1:27412` at a public hostname. The Agent API now requires the
  bearer token on each route (AGENTS.md §6), but the unit is still running.
  The user decides whether it stays.
- `~/.config/Zettlr-Pandoc/config.json` holds the removed key
  `agentApi.claimDescriptionSimilarityThreshold`.
- The ChatGPT app needs Refresh on its settings page after the merge: the
  tool contract changed.
- A running app must quit and start again to read `ZETTLR_AGENT_API_TOKEN`
  and the setting `zotero.localServer`.
- `/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf` has an owner or
  permissions that ssh refuses, so the Flowmark update at the start of the
  app fails its git fetch and keeps the installed Flowmark.
