---
type: glossary
created: 2026-10-28T13:35:14Z
created_by: k3.1-pro-highspeed
created_session: 01a182a6-336c-773b-bb3f-897d1e78bab8
updated: 2026-10-28T13:37:58Z
updated_by: k3.1-pro-highspeed
updated_session: 01a182a6-336c-773b-bb3f-897d1e78bab8
---

# pi-picks

Domain language for the model picker and its persisted user choices.

## Language

### Favorites

**Favorites**:
The user's ordered, authoritative collection of Favorite refs. A Favorite remains stored while its model is unavailable; only an explicit removal clears the ref.
_Example_: `anthropic/claude-sonnet` remains in `pi-picks.favorites` when Anthropic is temporarily unavailable.
_Not_: Pi's native scoped models (`enabledModels`); Resolved Favorites.
_Confirmed_: 2026-10-28, user, architecture grilling round 1.

**Favorite ref**:
A `provider/id` string identifying one Favorite. Favorite refs compare case-insensitively during resolution and mutation.
_Example_: `openai/GPT-4o` and `openai/gpt-4o` identify the same Favorite.
_Not_: a model's display label.
_Confirmed_: 2026-10-28, user, architecture grilling round 1.

**Resolved Favorites**:
The derived, ordered view of Favorites whose models exist in the current catalog. Unavailable Favorite refs are omitted from this view without being removed from Favorites.
_Example_: if stored Favorites contain `openai/gpt-4o` and `anthropic/claude-sonnet`, but only the latter is available, Resolved Favorites contains only `anthropic/claude-sonnet` and both refs remain stored.
_Not_: a second authoritative copy of Favorites.
_Confirmed_: 2026-10-28, user, architecture grilling round 1.

**Favorites save**:
The persistence outcome of an explicit Favorites mutation. A malformed `settings.json` prevents the save and is preserved; the user receives an error instead of a replacement file. A failed save rolls back to the last saved Favorite refs and Resolved Favorites, keeps the picker open, and notifies the user.
_Example_: after Ctrl+F with malformed settings JSON, the existing file remains unwritten, the picker removes the attempted unsaved Favorite, and it reports that Favorites could not be saved.
_Not_: treating malformed JSON as an empty settings file; rebuilding after an automatic backup; leaving an unsaved Favorite visible.
_Confirmed_: 2026-10-28, user, architecture grilling rounds 1 and 2.

**Favorites reload**:
The reading of stored Favorite refs when a picker opens. A picker session does not watch `settings.json` for external edits; the next open reads the current file.
_Example_: hand-editing `pi-picks.favorites` while the picker is closed changes the next picker's Favorites.
_Not_: live synchronization with an open picker; a one-time cache for the extension's lifetime.
_Confirmed_: 2026-10-28, user, architecture grilling round 2.

**Favorites clear**:
A scoped removal of stored Favorite refs, including refs whose models are unavailable. On Favorites and All it clears every stored Favorite; on a provider tab it clears every stored Favorite for that provider.
_Example_: Ctrl+X on the Anthropic tab removes both available and temporarily unavailable `anthropic/...` Favorites and leaves other providers.
_Not_: removing only Resolved Favorites; clearing the query-filtered rows.
_Confirmed_: 2026-10-28, user, architecture grilling round 2.

**Favorite identity**:
The case-insensitive `provider/id` equivalence class of a Favorite ref. Duplicate refs in one equivalence class collapse to the first stored position; the deduplicated list is written only by the next successful Favorites mutation, never by opening the picker.
_Example_: `["openai/gpt-4o", "x/y", "OpenAI/GPT-4o"]` has Favorites `openai/gpt-4o`, `x/y`; opening the picker writes nothing.
_Not_: separate case-sensitive picker identity and case-insensitive persistence identity.
_Confirmed_: 2026-10-28, user, architecture grilling round 2.

**Favorites normalization**:
Reading ignores a wrong-shaped `favorites` value and any non-string or empty entries. The next successful Favorites mutation writes a deduplicated list of valid Favorite refs and preserves all unrelated settings. Concurrent pi instances are last-writer-wins: a save writes the session's authoritative refs without merging.
_Example_: `favorites: ["a/b", 7, ""]` reads as `a/b`; after Ctrl+F on `c/d`, the file holds `["a/b", "c/d"]`.
_Not_: failing like malformed JSON; preserving unusable entries; merging with another instance's edits.
_Confirmed_: 2026-10-28, user, architecture grilling round 3.

## Unresolved

None.
