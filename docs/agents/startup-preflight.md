# 5. Startup preflight

- `source/app/util/preflight.ts`, called from `source/app/util/environment-check.ts`.
  Fails loud (native dialog + `app.exit(1)`) if `pandoc`, `just`, `latexmk`,
  `pdflatex`, `biber`, `pandoc-crossref`, `latexpand` or `~/.pandoc/justfile`
  are missing in the app's runtime environment. The TikZ preview needs
  `~/.pandoc/filters/tikzcd.lua` and `~/.pandoc/templates/standalone-tikz.tex`,
  and a filter whose first line does not state the protocol of the app stops
  the start too ([§7](tikz.md)).
- **One probe of each tool.** The preflight, the pandoc-crossref gate and the
  pandoc version of the environment check read the same `probeTool` answer
  ([§25](external-tools.md)), so each tool starts one time. A tool that does not answer
  `--version` within 10 s stops the start with "did not answer"; a tool
  without the execute bit is "on the PATH but not executable", not absent.
  Proof: `test/start-tool-probes.spec.ts`.
- **The app uses the `PATH` it was started with.** The launcher owns the
  environment; a wrong `PATH` is a preflight failure, not something the app
  repairs. Upstream Zettlr runs the user's login shell at startup (`fix-path`)
  to read another `PATH`; this fork removed that. On this machine that shell
  is the one that starts a second compositor when `WAYLAND_DISPLAY` is unset.
- The command checks and the three gates of the preflight run at the same time.
  The preflight costs the time of the slowest tool, not the sum.
- Proof in the assembled app: `e2e/start-without-required-tool.spec.ts` (a
  PATH without `biber`, a home folder without `~/.pandoc/justfile`: the
  native box, what the output names, and exit code 1).
