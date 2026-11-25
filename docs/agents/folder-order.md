# 23. The order of a folder

- **A control changes the folder that the author names.** Three controls
  change the display, the sort, the direction and the grouping of a folder:
  the context menu of the folder, the Properties of the folder and the
  Workspaces menu. The Workspaces menu changes the selected folder
  (`openDirectory`; a click on a file selects its folder) and names it in
  the item `explorer-target`. It never changes a folder that it does not
  name.
- **One set of choices.** `file-manager/util/explorer-view-menu.ts` owns the
  menu items, the choices and the functions that write them
  (`setSort`, `setDirection`, `setMetadataKey`, through
  `updateExplorerDirectory`). A new control of the order of a folder uses
  them.
- **The direction keeps the sort.** A change of the direction keeps the sort
  and its metadata field; a change of the sort keeps the direction. The
  Properties show each sort of the folder, a metadata field too, and the
  field of a metadata sort.
- **Proof:** `e2e/explorer-metadata-sort.spec.ts`,
  `e2e/folder-metadata-problems.spec.ts`, `e2e/quarto-bound-book.spec.ts`.
