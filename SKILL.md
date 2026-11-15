---
name: pi-picks
description: Categorized model selector for pi. Use /models or Ctrl+\ to open a single-screen TUI picker with tabs as filters — Favorites first (the picker's own stored list), then All (the opening screen), then one tab per provider. Type to fuzzy-search within the current tab, Tab or ← → to switch tabs keeping the query, ↑↓ to navigate, Ctrl+F to toggle the selected model in Favorites, Ctrl+X to remove favorites contained in the active tab, Enter to select and save the startup default.
license: MIT
compatibility: Requires pi coding agent with auth configured for at least one model provider.
metadata:
  author: JangMan-J
---

# pi-picks

Open the categorized model picker with `/models` or `Ctrl+\`.

## Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate models (wraps around) |
| `Shift+↑` / `Shift+↓`, or `PageUp` / `PageDown` | Move ten results, stopping at either end |
| `Ctrl+F` | Toggle the selected model in Favorites, on any tab (keeps it in its provider tab) |
| `Ctrl+X` | Remove favorites contained in the active tab |
| `Ctrl+S` | Cycle `▲` then `▼` across visible columns left to right (Model, Provider, Price, Ctx, Modality, plus tab default when distinct) |
| `Tab` / `Shift+Tab` | Switch tab; with a query active, provider tabs with no matches are skipped |
| `←` / `→` | Switch tab when the search field is empty; otherwise move the text cursor |
| Type | Fuzzy-filter the current tab |
| `Enter` | Select highlighted model and save it as the startup default |
| `Esc` | Cancel |
