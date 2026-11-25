# 27. Application updates

- **The releases of the fork are the updates.** `releaseLocations`
  (`service-providers/updates`) takes the GitHub repository of the
  `homepage` of `package.json`; the service container gives the
  `UpdateProvider` those locations. A spec gives it a release server on
  loopback.
- **A step that fails sets the error of the state.** A check that does not
  run (no network: `EOFFLINE`; a build without updates: `EDISABLED`) keeps
  the result of the last check and says why. A download, a verify and the
  start of the update each report their own cause; the notification shows
  that message. The update window offers the start again after a failure.
- **A download that the provider gives up is removed.** A failed verify, a
  failed stream and a quit before the end of the download remove the file
  from the downloads folder (`_abandonDownload`, `shutdown`). A file that
  cannot be removed is named in the message. A download is complete when
  its file has each byte (the `end` of the write stream).
- **A check that reaches no server is no failure to show.** A host that is
  not found (`ENOTFOUND`) and a check that gets no answer in its time limit
  (`ETIMEDOUT`) set the error of the state without a notification: the check
  runs each hour.
- **A nightly is not older than its release.** A nightly of Zettlr has
  the version of the stable release with `-nightly` (#5429), which SemVer
  reads as a prerelease. The comparison treats `nightly` as a build
  identifier, so `semver.lt` never offers a nightly the release of the same
  number.
- **The changelog is HTML that the update window sanitizes.** The provider
  renders it through `md2html`, so the boot of the provider initializes
  MathJax with the projections of `~/.pandoc` before it registers its IPC.
- **The checksum file has one line for each asset:** the SHA256 sum, two
  spaces, the file name.
- **The provider closes the write stream before it opens the download**:
  Windows refuses to open a file with an open handle.
- **Proof:** `test/updater-failures.spec.ts`,
  `test/updater-check-timeout.spec.ts`.
