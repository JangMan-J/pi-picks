# pi-picks

[![npm](https://img.shields.io/npm/v/@jangmanj/pi-picks)](https://www.npmjs.com/package/@jangmanj/pi-picks)

A keyboard-driven model picker extension for the [pi coding agent](https://github.com/badlogic/pi-mono). It started as a fork of rilham97's original model picker and was renamed to `pi-picks` once it diverged: favorites, one fuzzy query across tabs, token costs, and aligned metadata.

One screen, with tabs as filters over a single list: **Favorites**, **All**, then one tab per provider (A→Z). Typing fuzzy-searches within the current tab. Press `Tab` or `Shift+Tab` to switch tabs without losing your query; the All tab sits beside Favorites when you need to widen. The picker opens on All, so the usual flow is just open, type a character or two, `Enter`.

The first tab, **Favorites**, is the picker's own list, independent of pi's native scoped models. It sits one `Tab` (or `Shift+Tab` from All) away from the All tab the picker opens on. Press `Ctrl+F` on any tab to toggle the selected model in Favorites (it stays in its provider tab too), and `Ctrl+X` to remove the favorites contained in the active tab: every favorite on Favorites or All, or only that provider's favorites on a provider tab. Favorites are marked with a gold `●` outside the Favorites tab. They are stored as `provider/id` strings in `~/.pi/agent/settings.json` under `pi-picks.favorites` (hand-editable), in the order added; a favorite whose model is temporarily unavailable is kept and reappears when the model does. A `settings.json` that is not valid JSON is never overwritten: the picker undoes the change and reports that favorites could not be saved.

## Preview

```
─ Select Model ────────────────────────────────────────────────────
  Favorites │ All │ Anthropic │ Antigravity │ Fireworks │ Xai
───────────────────────────────────────────────────────────────────
  Search: > claude_
  Model            Provider             Price   Ctx  Modality
▶ Claude Sonnet ●  [Anthropic]         $3/$15  200k  [T][V]

  (1/1) anthropic/claude-sonnet
───────────────────────────────────────────────────────────────────
  Enter select · Ctrl+F/X fav · Ctrl+S sort · Tab · Esc    [T] thinking [V] vision [G] generation [S] synthesis
───────────────────────────────────────────────────────────────────
```

- **Active model** highlighted in green with a green `●`; if it is also a favorite, the `●` is gold (on every tab, including Favorites)
- **Context window** shown as `200k`, `1M`, etc.
- **Column headers** in accent color differentiate the header band from data rows and stay put while you scroll, search, or sort; narrow terminals drop Modality, Ctx, then Price, headers included
- **Ctrl+S sort** cycles `▲` then `▼` across every visible column left to right (Model ▲/▼, Provider ▲/▼ on cross-provider tabs, Price ▲/▼, Ctx ▲/▼, Modality ▲/▼, plus tab default when distinct); the active column carries a gold sort arrow. Price and Ctx sorts keep $0/missing values last
- **Modality badges**: fixed-lane color-coded `[T]` thinking, `[V]` vision, `[G]` generation (images), `[S]` synthesis (voice), with a right-justified legend on the bottom bar
- **Search** fuzzy-matches model name, id, and provider within the current tab
- **Ranked search highlights** — matching tabs and rows get a subtle neutral background, while the best-ranked result gets a distinct search-match background separate from the selected tab highlight
- **One query everywhere** — switching tabs keeps your query and, when it survives, your selection
- **Duplicates side by side** — on the All tab the same model from several providers sits adjacently, so cost and context differences are easy to compare
- **Wraparound navigation** — `↑` on the first item jumps to the last, and vice versa

## Install

### Via pi package manager (recommended)

```bash
pi install npm:@jangmanj/pi-picks
```

Restart pi after installation. `pi update --extensions` pulls new releases.

### Migrating from the unscoped `pi-picks`

Versions up to 1.3.1 were published as `pi-picks`. Remove that package first so `/models` is not registered twice: `pi remove npm:pi-picks`. Your settings carry over unchanged.

### From git

```bash
pi install git:github.com/JangMan-J/pi-picks
```

## Usage

| Trigger | Description |
|---------|-------------|
| `/models` | Open the categorized picker |

> **Note:** `/model` is a built-in pi command and cannot be overridden. Use `/models` (with an `s`) for this picker. The built-in `/model` (flat search) continues to work as normal.

### Adding a shortcut

The picker binds no key by default. To open it with one, name the key in `~/.pi/agent/settings.json`:

```json
{
  "pi-picks": {
    "shortcut": "alt+m"
  }
}
```

`shortcut` accepts:

- a single key string, e.g. `"alt+m"`
- an array of key strings to bind multiple keys, e.g. ["alt+m", "ctrl+\\"]

See pi's [keybindings docs](https://github.com/badlogic/pi-mono) for the key identifier format (`ctrl`, `shift`, `alt` modifiers combined with letters, digits, or symbols).

Restart pi (or run `/reload`) after changing `settings.json`.

### Opening tab

The picker always opens on **All**, with the current model pre-selected. No tab or search text is remembered between opens.

### Searching beyond the current tab

Every tab uses the same fuzzy search; tabs only narrow which models it runs over. Move to the All tab when the current tab has no match (the empty state tells you when matches exist elsewhere). With a query active, matching tabs get green text on a subtle violet background, matching rows get a subtle neutral background, and the best-ranked row (first after fuzzy sorting) gets a distinct search-match background; the selected tab keeps its separate selected background. `Tab` skips provider tabs that have no matches; Favorites and All are always stops. Favorites and All stay visible when the provider tabs overflow the bar; the `<<` / `>>` markers show what is hidden on each side.

## Controls

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate models (wraps around) |
| `Shift+↑` / `Shift+↓`, or `PageUp` / `PageDown` | Move up / down 10 models, stopping at the first or last result |
| `Tab` / `Shift+Tab` | Switch tab (Favorites, All, then providers); with a query active, provider tabs with no matches are skipped |
| `Ctrl+F` | Toggle the selected model in Favorites, on any tab |
| `Ctrl+X` | Remove favorites contained in the active tab (every favorite on Favorites; only the relevant provider's favorites on a provider tab) |
| `Ctrl+S` | Cycle the column sort; the selected model stays selected |
| `←` / `→` | Switch tab when the search field is empty; otherwise move the text cursor |
| Type | Fuzzy-filter the current tab |
| `Enter` | Select highlighted model and save it as the default for new sessions |
| `Esc` / `Ctrl+C` | Cancel |

Each successful selection saves the provider and model in Pi's global settings.
It preserves other settings, including the default thinking level.

## How it works

The picker calls `modelRegistry.refresh()` then `modelRegistry.getAvailable()` — the same data source as pi's built-in `/model` command. Only models with auth configured (API key or OAuth) are shown. Models are grouped by their `provider` field into provider tabs in A→Z order, sorted alphabetically within each tab with the active model first. The All tab instead sorts by model name, then provider, so duplicates offered by several providers sit together; Favorites keeps its saved order. Ctrl+S picks another sort for every tab.

## Uninstall

```bash
pi remove npm:@jangmanj/pi-picks
```

## Releasing

Every push to `main` and every pull request runs `npm run check`. A release is a version tag:

1. Add a `## <version> — <date>` section to `CHANGELOG.md` and commit it.
2. Run `npm version <patch|minor|major>` (it bumps `package.json`, commits, and tags `v<version>`), then `git push --follow-tags`.

The tag runs `.github/workflows/publish.yml`. It reruns the check, refuses a tag that does not match `package.json`, publishes with npm trusted publishing (OIDC, with provenance), and creates the GitHub release. A tag whose version is already on npm skips the publish, so rerunning a release is safe. The one-time npm setup for a new package name is `npm run bootstrap:npm` (see the header of `scripts/npm-bootstrap.sh`).

## License

MIT — see [LICENSE](LICENSE).
