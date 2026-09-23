# Mathematical phrase dictionaries

Each UTF-8 `.txt` file contains **one complete phrase per line**. Blank lines and lines beginning with `#` are ignored.
There is no JSON, YAML, snippet escaping, required abbreviation, or generation step.

```text
# Add entries by typing another line and saving the file.
Smith-Minkowski-Siegel
Smith normal form
Grothendieck-Riemann-Roch
minimal model program
Alexander Grothendieck
```

The text on the line is the text to insert, including its spaces, accents, apostrophes and hyphens.
It is not a snippet template.
Capitalization-distinct entries are allowed.
Exact and canonically equivalent Unicode duplicates are merged.
Use spaces rather than tabs inside a phrase.

The files here are a hand-selected starter vocabulary, not a claim of exhaustive coverage and not an imported upstream database.
Add, remove or reorganize entries freely.
An author can have both a surname entry and a full-name entry.

## Runtime behavior

On first application boot, when `~/.pandoc/completions/` does not yet exist, the starter `.txt` files in this directory are copied there.
After that the user directory is authoritative: its files are never restored or overwritten on boot.
The Assets provider watches that directory and reloads the editor database after a save, file creation, rename or deletion.

`source/app/util/load-phrase-dictionaries.ts` reads all top-level `.txt` files in an explicitly supplied directory.
Every call sees saved edits, added files and deleted files.
A missing directory, unreadable file, invalid UTF-8 or malformed line rejects the call rather than silently hiding a broken dictionary.

`source/common/modules/markdown-editor/autocomplete/phrases.ts` exports a native CodeMirror `CompletionSource`, backed by its own editor state field.
It provides literal text options such as `Sm` → `Smith-Minkowski-Siegel`; native CodeMirror owns fuzzy filtering, ranking, insertion and the menu.
Multiword prefixes replace the whole matching prefix, and a completion can remain active across spaces and hyphens.
No automatic Space expansion or QuickTeX changes are introduced.
Prose dictionary entries do not declare TeX commands or macros.

The phrase source is appended beside the existing first-match completion source, so it does not become another branch inside the TeX/snippet/tag/citation dispatcher.
Preferences → Snippets contains **Open phrase completion dictionary**, which opens `~/.pandoc/completions/` in the system file manager for ordinary text-editor editing.

The native API used here is documented by CodeMirror: https://codemirror.net/docs/ref/#autocomplete.CompletionSource https://codemirror.net/docs/ref/#autocomplete.Completion https://codemirror.net/docs/ref/#autocomplete.ifNotIn
