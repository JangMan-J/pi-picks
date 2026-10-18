# Changelog

## 1.3.0 — 2026-10-17

- Rename the package to `pi-picks` (npm and GitHub). Settings move to the `"pi-picks"` block in settings.json; an existing `"pi-model-picker"` block is still read and is migrated on the next write
- Publish to npm from GitHub Actions with trusted publishing on every version bump pushed to main
- Change the default picker shortcut from Ctrl+Shift+M to Ctrl+\ (unbound in pi; configurable via pi-picks.shortcut)

- Merge the tabbed and fuzzy screens into one: tabs are facets (Favorites, All, then providers A→Z) over a single global fuzzy query. Tab switches tabs without touching the query (skipping no-match provider tabs while a query is active); selection follows the model across tab switches. Active searches add a subtle violet background to matching tabs and a subtle neutral background to matching rows, with a distinct search-match background for the top-ranked row. Favorites and All stay pinned when provider tabs overflow, with `<<` / `>>` overflow markers. The All tab sorts same-model duplicates adjacently, the details line shows provider/id on cross-provider tabs, and favorites carry a gold ● marker outside the Favorites tab (the active model's ● turns gold when it is also a favorite)
- Add a Favorites tab (first tab, and the opening screen when any favorite is available) with provider-labelled rows; the list is the extension's own, stored under `pi-picks.favorites` in settings.json, independent of pi's native scoped models
- Add Ctrl+F to toggle the selected model in Favorites from any tab (it stays in its provider tab; Ctrl+S was dropped because multiplexers intercept it), and Ctrl+X to remove favorites contained in the active tab (provider-scoped on provider tabs; full clear on Favorites)

- Report an incomplete installation and fail the command if an extension file cannot be copied
- Keep rendered lines within the terminal width during very narrow resizes
- Use Pi's agent-directory resolver so tilde paths and empty overrides follow Pi's settings behavior
- Preserve custom colon-qualified model names unless the prefix identifies the provider or model ID namespace
- Give the selected provider tab a themed background highlight in scoped and fuzzy search
- Align bracketed providers by the longest fuzzy match name and show the selected model's full ID beside the counter
- Remove maker prefixes from model display names while keeping version and variant information
- Add Ctrl+F global fuzzy search with ranked results, provider labels, and matching-tab highlights
- Omit redundant trailing provider annotations such as `(Antigravity)` from model labels
- Always show the selected position and filtered total as `(5/43)`, or `(0/0)` for no results
- Add Shift+Up/Down to move ten models at a time within the filtered list
- Save each selected model as the default for new sessions
- Show compact action and navigation hints on one footer row
- Remove creator grouping and its shortcut; keep provider tabs only
- Restore the Select Model header and Tab/Shift+Tab category navigation
- Restore upstream tab creation and naming: one tab per provider, with no provider-specific exceptions

## 1.2.0 — 2026-09-17

- Show token costs and aligned model metadata in picker rows
- Switch between provider and creator grouping with `Tab`
- Remember the last grouping and tab while pi is running
- Keep a fixed 10-row picker height across tabs and searches

## 1.1.0 — 2026-07-02

- Keyboard shortcut is now configurable via `~/.pi/agent/settings.json` (`pi-model-picker.shortcut`)
  - Accepts a string, an array of strings (binds multiple keys), or `false` to disable
  - Defaults to `Ctrl+Shift+M` when unset

## 1.0.0 — 2026-02-25

Initial release.

- Categorized model picker grouped by provider
- Tab / ← → to switch categories
- Per-category search field (preserves query when switching categories)
- ↑ / ↓ navigation with wraparound
- Active model highlighted with ● marker
- Model metadata: context window size, `thinking` and `vision` tags
- `/models` command and `Ctrl+Shift+M` shortcut
- Uses same data source as built-in `/model` (`modelRegistry.refresh()` + `getAvailable()`)
