/**
 * pi-picks — model picker extension
 *
 * Categorized, keyboard-driven model selector with one global fuzzy query.
 *
 * Tabs are facets over a single list: Favorites, All, then one per
 * provider (A→Z). Typing fuzzy-searches within the current tab; Tab
 * switches tab without touching the query. The picker opens on Favorites
 * when any favorite is
 * available. Favorites is this extension's own list, stored as
 * `provider/id` strings under `pi-picks.favorites` in
 * settings.json — independent of pi's native scoped models
 * (`enabledModels`). Ctrl+F toggles the selected model in Favorites
 * from any tab (it stays in its provider tab); Ctrl+X removes the
 * favorites contained in the active tab (every favorite on Favorites).
 *
 * Usage:
 *   /models          — open the categorized picker
 *   Ctrl+\           — keyboard shortcut (default; configurable, see below)
 *
 * Note: /model is a built-in pi command and cannot be overridden.
 *
 * Configuring the shortcut:
 *   Add to ~/.pi/agent/settings.json:
 *     { "pi-picks": { "shortcut": "alt+m" } }
 *   Accepts a string, an array of strings (binds multiple keys), or `false`
 *   to disable the shortcut entirely (the /models command still works).
 *   A legacy "pi-model-picker" block is still read and is migrated on the
 *   next settings write.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Input, Key, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { KeyId } from "@mariozechner/pi-tui";
import type { Api, Model } from "@mariozechner/pi-ai";

// ─── settings ───────────────────────────────────────────────────────────────

const DEFAULT_SHORTCUT = "ctrl+\\";

const SETTINGS_KEY = "pi-picks";
/** Settings block name used before the rename; read as a fallback, removed on write. */
const LEGACY_SETTINGS_KEY = "pi-model-picker";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The extension's settings, with the current block overriding the legacy one. */
function settingsBlock(raw: unknown): Record<string, unknown> {
	if (!isRecord(raw)) return {};
	const legacy = raw[LEGACY_SETTINGS_KEY];
	const current = raw[SETTINGS_KEY];
	return { ...(isRecord(legacy) ? legacy : {}), ...(isRecord(current) ? current : {}) };
}

function readSetting(setting: string): unknown {
	try {
		return settingsBlock(JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf-8")))[setting];
	} catch {
		return undefined; // Missing or malformed settings use defaults.
	}
}

/** Stored favorites as `provider/id` refs, in the order they were added. */
function readFavoriteRefs(): string[] {
	const favorites = readSetting("favorites");
	return Array.isArray(favorites)
		? favorites.filter((f): f is string => typeof f === "string" && f.length > 0)
		: [];
}

/** Write one pi-picks setting, preserving everything else in settings.json. */
function writeSetting(setting: string, value: unknown): void {
	const path = join(getAgentDir(), "settings.json");
	let raw: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		if (isRecord(parsed)) raw = parsed;
	} catch {
		// Missing or malformed settings start from an empty object.
	}
	raw[SETTINGS_KEY] = { ...settingsBlock(raw), [setting]: value };
	delete raw[LEGACY_SETTINGS_KEY];
	writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf-8");
}

/** Accept a key, multiple keys, or false/[] to disable. */
function resolveShortcuts(setting = "shortcut", fallback = DEFAULT_SHORTCUT): string[] {
	const shortcut = readSetting(setting);
	if (shortcut === false) return [];
	if (typeof shortcut === "string") return shortcut ? [shortcut] : [];
	if (Array.isArray(shortcut)) return shortcut.filter((s): s is string => typeof s === "string" && s.length > 0);
	return [fallback];
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Friendly display name for a provider id — derived from the id itself, no hardcoding */
function providerLabel(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** Omit identified maker prefixes and redundant provider suffixes, not custom name qualifiers. */
function modelLabel(model: Model<Api>): string {
	let name = model.name;
	const prefix = name.match(/^([^():]+):\s+(?=\S)/);
	if (prefix) {
		const maker = prefix[1]!.toLowerCase().replace(/[\s._-]/g, "");
		const namespace = model.id.includes("/") ? model.id.split("/")[0]! : "";
		if (maker && [model.provider, namespace].some((id) => id.toLowerCase().replace(/[\s._-]/g, "") === maker)) {
			name = name.slice(prefix[0].length);
		}
	}
	const suffix = name.match(/\s+\(([^()]*)\)\s*$/);
	const provider = suffix?.[1].trim().toLowerCase();
	return suffix && (provider === model.provider.toLowerCase() || provider === providerLabel(model.provider).toLowerCase())
		? name.slice(0, suffix.index).trimEnd() || name : name;
}

/** Format context window as human-readable */
function fmtCtx(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
	return String(tokens);
}

/** Format per-million-token cost as "$in/$out"; omit invalid or all-zero rates. */
function fmtCost(cost: { input: number; output: number }): string {
	const rates = [cost?.input, cost?.output];
	if (!rates.every((n) => Number.isFinite(n) && n >= 0) || !rates.some((n) => n > 0)) return "";
	const fmt = (n: number) =>
		n === 0 ? "0"
		: n < 0.01 ? String(Number(n.toPrecision(2))) // keep sub-cent rates non-zero
		: n < 1 ? n.toFixed(2)
		: n.toFixed(2).replace(/\.?0+$/, "");
	return rates.map((n) => `$${fmt(n)}`).join("/");
}

// ─── component ──────────────────────────────────────────────────────────────

/** Tab keys for the cross-provider tabs. Sentinels so they cannot collide with a provider id. */
const FAVORITES_TAB = "\0favorites";
const ALL_TAB = "\0all";

const modelRef = (m: Model<Api>): string => `${m.provider}\0${m.id}`;

interface ModelPickerOptions {
	allModels: Model<Api>[];
	/** Stored favorites resolved against the catalogue, in stored order. */
	favorites: Model<Api>[];
	currentModel: Model<Api> | undefined;
	lastTab?: string;
	onSelect: (model: Model<Api>) => void;
	onCancel: () => void;
	onAddToFavorite: (model: Model<Api>) => void;
	onRemoveFavorite: (model: Model<Api>) => void;
	onRemoveFavorites: (models: Model<Api>[]) => void;
	onClearFavorites: () => void;
}

class ModelPickerComponent {
	// Focusable — needed so the Input inside gets IME cursor positioning
	focused = false;

	private categories: string[];
	private catIndex: number;
	private rowIndex = 0;
	private matchingProviders = new Set<string>();

	// Favorite models in stored order; mutated locally by Ctrl+F/Ctrl+X
	private favorites: Model<Api>[];

	// Fuzzy matches across every provider for the current query (drives tab
	// highlighting, match-only Tab stops, and widen hints)
	private globalMatches: Model<Api>[] = [];

	// First provider shown in the windowed part of the tab bar (index into
	// categories); adjusted minimally so the active provider stays visible
	private providerLo = 0;


	// per-category source models (sorted, never mutated)
	private byCategory: Map<string, Model<Api>[]>;

	// every model, sorted by display label then provider so the same model
	// offered by several providers sits adjacently on the All tab
	private allSorted: Model<Api>[] = [];

	// the search Input widget
	private searchInput: Input;

	// filtered models for the current view (recomputed on query/category change)
	private filteredRows: Model<Api>[] = [];

	constructor(private opts: ModelPickerOptions) {
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());
		this.favorites = [...opts.favorites];

		// Home is Favorites when any favorite is available; otherwise restore
		// the saved tab if available, otherwise follow the current model.
		const cur = opts.currentModel;
		const startTab = this.favorites.length > 0 ? FAVORITES_TAB
			: opts.lastTab && this.tabs.includes(opts.lastTab) ? opts.lastTab
			: cur?.provider ?? ALL_TAB;
		this.catIndex = Math.max(0, this.tabs.indexOf(startTab));

		// Build the search Input
		this.searchInput = new Input();
		this.searchInput.focused = true;
		this.searchInput.onEscape = () => opts.onCancel();
		this.searchInput.onSubmit = () => {
			const selected = this.filteredRows[this.rowIndex];
			if (selected) opts.onSelect(selected);
		};

		// Initialise filtered rows and pre-select current model
		this.applyFilter();
		if (cur) {
			const idx = this.filteredRows.findIndex(
				(m) => m.id === cur.id && m.provider === cur.provider,
			);
			this.rowIndex = Math.max(0, idx);
		}
	}

	/** All tabs: Favorites, All, then one per provider (A→Z). */
	private get tabs(): string[] {
		return [FAVORITES_TAB, ALL_TAB, ...this.categories];
	}

	/** True for tabs whose rows span providers (they show the provider column). */
	private get crossProvider(): boolean {
		const tab = this.currentTab();
		return tab === FAVORITES_TAB || tab === ALL_TAB;
	}

	private currentTab(): string {
		return this.tabs[this.catIndex] ?? FAVORITES_TAB;
	}

	private onFavoritesTab(): boolean {
		return this.currentTab() === FAVORITES_TAB;
	}

	private isFavorite(model: Model<Api>): boolean {
		return this.favorites.some((m) => modelRef(m) === modelRef(model));
	}

	getLastTab() {
		return this.currentTab();
	}

	updateModels(allModels: Model<Api>[], currentModel?: Model<Api>): void {
		const prevTab = this.currentTab();
		const prevSelected = this.filteredRows[this.rowIndex];
		this.opts.allModels = allModels;
		if (currentModel !== undefined) this.opts.currentModel = currentModel;
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());
		// Remap favorites onto refreshed objects, dropping unavailable ones.
		const refreshed = new Map(allModels.map((m) => [modelRef(m), m]));
		this.favorites = this.favorites.flatMap((m) => {
			const next = refreshed.get(modelRef(m));
			return next ? [next] : [];
		});
		const nextTabIdx = this.tabs.indexOf(prevTab);
		this.catIndex = nextTabIdx >= 0 ? nextTabIdx : Math.min(this.catIndex, Math.max(0, this.tabs.length - 1));
		this.applyFilter();
		if (prevSelected) {
			const idx = this.filteredRows.findIndex(
				(m) => m.id === prevSelected.id && m.provider === prevSelected.provider,
			);
			if (idx >= 0) this.rowIndex = idx;
		}
	}

	// ── public Focusable propagation ─────────────────────────────────────
	set focusedState(v: boolean) {
		this.focused = v;
		this.searchInput.focused = v;
	}

	// ── category building ────────────────────────────────────────────────

	private buildCategories(): Map<string, Model<Api>[]> {
		const map = new Map<string, Model<Api>[]>();
		for (const m of this.opts.allModels) {
			if (!map.has(m.provider)) map.set(m.provider, []);
			map.get(m.provider)!.push(m);
		}

		const cur = this.opts.currentModel;

		// Sort models within each category: active first, then alphabetical
		for (const [, arr] of map) {
			arr.sort((a, b) => {
				const aCur = cur && a.id === cur.id && a.provider === cur.provider ? -1 : 0;
				const bCur = cur && b.id === cur.id && b.provider === cur.provider ? -1 : 0;
				if (aCur !== bCur) return aCur - bCur;
				return a.name.localeCompare(b.name);
			});
		}

		// Provider tabs keep a stable A→Z order; the picker opens on the
		// relevant tab directly, so promoting the current provider would
		// only rearrange the bar whenever the model changes.
		const sorted = new Map(
			[...map.entries()].sort(([aKey], [bKey]) => aKey.localeCompare(bKey)),
		);

		// All-tab order: display label, then provider — duplicate models
		// offered by several providers end up adjacent for comparison.
		this.allSorted = [...map.values()].flat().sort((a, b) =>
			modelLabel(a).localeCompare(modelLabel(b))
			|| a.provider.localeCompare(b.provider)
			|| a.id.localeCompare(b.id));
		return sorted;
	}

	// ── filtering ────────────────────────────────────────────────────────

	private tabLabel(key: string): string {
		return key === FAVORITES_TAB ? "Favorites" : key === ALL_TAB ? "All" : providerLabel(key);
	}

	/** Source rows for a tab before the query is applied. */
	private tabSource(tabKey: string): Model<Api>[] {
		return tabKey === FAVORITES_TAB ? this.favorites
			: tabKey === ALL_TAB ? this.allSorted
			: this.byCategory.get(tabKey) ?? [];
	}

	private applyFilter(): void {
		const query = this.searchInput.getValue().trim();
		const searchText = (m: Model<Api>) => `${m.name} ${m.id} ${m.provider}`;
		// fuzzyFilter returns the source untouched for an empty query, so
		// browsing keeps each tab's source order (favorites: stored order).
		this.globalMatches = fuzzyFilter(this.allSorted, query, searchText);
		this.filteredRows = fuzzyFilter(this.tabSource(this.currentTab()), query, searchText);
		this.matchingProviders = new Set(this.globalMatches.map((m) => m.provider));
		// Clamp row selection
		this.rowIndex = Math.max(0, Math.min(this.rowIndex, this.filteredRows.length - 1));
	}

	/**
	 * Move to another tab, keeping the query and, when it survives the
	 * switch, the selected model. With a query active, provider tabs with
	 * no matches are skipped; Favorites and All are always stops.
	 */
	private switchCategory(delta: number): void {
		const tabs = this.tabs;
		const query = this.searchInput.getValue().trim();
		const visitable = tabs.filter((tab) =>
			!query || tab === FAVORITES_TAB || tab === ALL_TAB || this.matchingProviders.has(tab));
		if (!visitable.length) return;
		const prevSelected = this.filteredRows[this.rowIndex];
		// Walk the full tab order from the current position so a current tab
		// that lost its matches still advances to the next visitable one.
		let idx = this.catIndex;
		for (let step = 0; step < tabs.length; step++) {
			idx = (idx + delta + tabs.length) % tabs.length;
			if (visitable.includes(tabs[idx]!)) break;
		}
		this.catIndex = idx;
		this.applyFilter();
		const kept = prevSelected
			? this.filteredRows.findIndex((m) => modelRef(m) === modelRef(prevSelected))
			: -1;
		this.rowIndex = kept >= 0 ? kept : 0;
	}

	// ── favorites mutations ──────────────────────────────────────────────

	/**
	 * Ctrl+F: toggle the selected model in Favorites. Adding keeps it in its
	 * provider tab; removing on the Favorites tab drops the row and keeps
	 * the cursor at the same position.
	 */
	private toggleSelectedFavorite(): void {
		const selected = this.filteredRows[this.rowIndex];
		if (!selected) return;
		// No status line: the row's colour and dot are the feedback, so the
		// picker keeps a fixed height.
		if (this.isFavorite(selected)) {
			this.favorites = this.favorites.filter((m) => modelRef(m) !== modelRef(selected));
			this.opts.onRemoveFavorite(selected);
		} else {
			this.favorites.push(selected);
			this.opts.onAddToFavorite(selected);
		}
		this.applyFilter();
	}

	/**
	 * Ctrl+X: remove favorites contained in the active tab. Scope is the
	 * tab's unfiltered source list, not just the rows matched by the query:
	 * provider tabs lose only that provider's favorites and All loses every
	 * resolved favorite. The Favorites tab retains its full clear, including
	 * stored refs whose models are temporarily unavailable.
	 */
	private clearFavoritesInTab(): void {
		if (!this.favorites.length) return;
		if (this.onFavoritesTab()) {
			this.favorites = [];
			this.opts.onClearFavorites();
			this.rowIndex = 0;
			this.applyFilter();
			return;
		}
		const contained = new Set(this.tabSource(this.currentTab()).map(modelRef));
		const removed = this.favorites.filter((m) => contained.has(modelRef(m)));
		if (!removed.length) return;
		const removedRefs = new Set(removed.map(modelRef));
		this.favorites = this.favorites.filter((m) => !removedRefs.has(modelRef(m)));
		this.opts.onRemoveFavorites(removed);
		this.applyFilter();
	}

	// ── input handling ───────────────────────────────────────────────────

	handleInput(data: string): void {
		// Favorite toggle works on every tab; the model stays in its provider tab.
		if (matchesKey(data, Key.ctrl("f"))) {
			this.toggleSelectedFavorite();
			return;
		}
		if (matchesKey(data, Key.ctrl("x"))) {
			this.clearFavoritesInTab();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.switchCategory(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.switchCategory(-1);
			return;
		}
		// Shift+↑ / ↓ — skip ten rows without wrapping
		if (matchesKey(data, Key.shift("up"))) {
			this.rowIndex = Math.max(0, this.rowIndex - 10);
			return;
		}
		if (matchesKey(data, Key.shift("down"))) {
			this.rowIndex = Math.max(0, Math.min(this.filteredRows.length - 1, this.rowIndex + 10));
			return;
		}
		// ↑ / ↓ — navigate the list with wraparound
		if (matchesKey(data, Key.up)) {
			if (!this.filteredRows.length) return;
			this.rowIndex =
				this.rowIndex === 0
					? this.filteredRows.length - 1
					: this.rowIndex - 1;
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (!this.filteredRows.length) return;
			this.rowIndex =
				this.rowIndex === this.filteredRows.length - 1
					? 0
					: this.rowIndex + 1;
			return;
		}

		// ← with an empty field — switch tab left
		if (matchesKey(data, Key.left) && this.searchInput.getValue() === "") {
			this.switchCategory(-1);
			return;
		}
		// → with an empty field — switch tab right
		if (matchesKey(data, Key.right) && this.searchInput.getValue() === "") {
			this.switchCategory(1);
			return;
		}

		// Everything else (including ← / → when field has text) → Input
		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const after = this.searchInput.getValue();

		if (before !== after) {
			this.rowIndex = 0;
			this.applyFilter();
		}
	}

	// ── rendering ────────────────────────────────────────────────────────

	render(width: number, theme: any): string[] {
		const lines: string[] = [
			theme.fg("accent", "─".repeat(width)),
			truncateToWidth(theme.fg("accent", theme.bold("  Select Model")), width),
			theme.fg("border", "─".repeat(width)),
		];

		// ── tab bar ──────────────────────────────────────────────────────
		lines.push(this.renderTabs(width, theme));

		// ── search field ─────────────────────────────────────────────────
		lines.push(theme.fg("border", "─".repeat(width)));
		const promptText = "  Search: ";
		const prompt = theme.fg("muted", promptText);
		const promptW = visibleWidth(promptText);
		const inputLines = this.searchInput.render(Math.max(0, width - promptW));
		lines.push(prompt + (inputLines[0] ?? ""));

		lines.push("");

		// ── model list ───────────────────────────────────────────────────
		const MAX_VISIBLE = 10;
		const half = Math.floor(MAX_VISIBLE / 2);
		const rows = this.filteredRows;
		const hasQuery = this.searchInput.getValue().trim() !== "";
		const start = Math.max(0, Math.min(this.rowIndex - half, rows.length - MAX_VISIBLE));
		const visible = rows.slice(start, start + MAX_VISIBLE);

		if (rows.length === 0) {
			const query = this.searchInput.getValue().trim();
			const tab = this.currentTab();
			let msg: string;
			if (query && tab !== ALL_TAB && this.globalMatches.length > 0) {
				// Matches exist outside this tab — point at the way to widen.
				const scope = tab === FAVORITES_TAB ? "favorites" : `${providerLabel(tab)} models`;
				msg = `  No ${scope} match "${query}" — Tab to search all ${this.allSorted.length} models`;
			} else if (query) {
				msg = `  No models match "${query}"`;
			} else if (tab === FAVORITES_TAB) {
				msg = "  No favorites yet — Tab to browse; Ctrl+F favorites the selected model";
			} else if (tab === ALL_TAB) {
				msg = "  No models available";
			} else {
				msg = "  No models in this category";
			}
			lines.push(theme.fg("muted", truncateToWidth(msg, width)));
		} else {
			// Cross-provider tabs (Favorites, All) show the provider column.
			const showProvider = this.crossProvider;
			// Measure over every row so columns do not move when the list scrolls.
			const measured = showProvider ? rows : visible;
			const colW = {
				name: showProvider ? Math.max(...rows.map((m) => visibleWidth(modelLabel(m)))) : 0,
				provider: showProvider ? Math.max(...rows.map((m) => visibleWidth(`[${providerLabel(m.provider)}]`))) : 0,
				cost: Math.max(0, ...measured.map((m) => visibleWidth(fmtCost(m.cost)))),
				ctx: Math.max(0, ...measured.map((m) => visibleWidth(m.contextWindow ? fmtCtx(m.contextWindow) : ""))),
				thinking: measured.some((m) => m.reasoning) ? "thinking".length : 0,
				vision: measured.some((m) => m.input.includes("image")) ? "vision".length : 0,
			};
			// Keep the model and provider identifiable before showing optional metadata.
			for (const column of ["cost", "vision", "thinking", "ctx"] as const) {
				const infoWidth = Math.max(0, [colW.cost, colW.ctx, colW.thinking, colW.vision].filter(Boolean).reduce((sum, n) => sum + n + 2, -2));
				const labelWidth = showProvider ? colW.name + colW.provider + 8 : 16;
				if (infoWidth + labelWidth <= width) break;
				colW[column] = 0;
			}
			for (let i = 0; i < visible.length; i++) {
				const model = visible[i]!;
				const absIdx = start + i;
				const isSelected = absIdx === this.rowIndex;
				const isCurrent =
					this.opts.currentModel?.id === model.id &&
					this.opts.currentModel?.provider === model.provider;
				// fuzzyFilter sorts by score, so visible order is rank order:
				// row 0 is the best match for the active query.
				const fuzzyHighlight = hasQuery ? (absIdx === 0 ? "top" : "match") : undefined;
				lines.push(this.renderRow(model, isSelected, isCurrent, width, theme, colW, fuzzyHighlight));
			}
		}
		// The empty-state message occupies one row; keep the count slot too.
		for (let i = Math.max(1, visible.length); i < MAX_VISIBLE; i++) lines.push("");
		const position = rows.length ? this.rowIndex + 1 : 0;
		const selected = rows[this.rowIndex];
		// On cross-provider tabs the bare id is ambiguous when several
		// providers offer the same model, so show the full ref.
		const ref = selected ? (this.crossProvider ? `${selected.provider}/${selected.id}` : selected.id) : "";
		const details = `  (${position}/${rows.length})${ref ? ` ${ref}` : ""}`;
		// One line, always: truncate rather than wrap so the height never changes.
		lines.push(theme.fg("dim", truncateToWidth(details, width)));

		// ── help bar ─────────────────────────────────────────────────────
		lines.push(theme.fg("border", "─".repeat(width)));
		const help = [
			"↑↓ Enter select model",
			"←→ Tab select menu",
			"Ctrl+F toggle favorite",
			"Ctrl+X clear favorites",
			"Esc cancel",
		].join(" · ");
		lines.push(theme.fg("dim", truncateToWidth("  " + help, width)));
		lines.push(theme.fg("accent", "─".repeat(width)));

		// Tiny terminal resizes must not emit over-wide prompts, markers, or wide glyphs.
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderTabs(width: number, theme: any): string {
		const activeKey = this.currentTab();
		const hasQuery = this.searchInput.getValue().trim() !== "";
		const anyFavoriteMatch = this.globalMatches.some((m) => this.isFavorite(m));
		const SEP = theme.fg("dim", "│");
		const SEP_W = 1;
		const labelOf = (key: string) => ` ${this.tabLabel(key)} `;
		const segment = (key: string): string => {
			const label = labelOf(key);
			const selected = key === activeKey;
			const matches = key === FAVORITES_TAB ? anyFavoriteMatch
				: key === ALL_TAB ? this.globalMatches.length > 0
				: this.matchingProviders.has(key);
			const color = selected ? "accent" : hasQuery
				? matches ? "success" : "dim"
				: "muted";
			const styled = theme.fg(color, selected ? theme.bold(label) : label);
			if (selected) return theme.bg("selectedBg", styled);
			// During search, tabs with matches get a subtle violet panel behind
			// their green text, rather than a green-tinted neutral panel that
			// blends with the label. selectedBg stays reserved for selection.
			return hasQuery && matches ? theme.bg("customMessageBg", styled) : styled;
		};

		// Favorites and All are pinned: always visible. Only the provider
		// segment windows, scrolling just enough to keep the active tab in
		// view, with << / >> marking what is hidden on each side.
		const pinned = [FAVORITES_TAB, ALL_TAB];
		const pinnedPart = pinned.map(segment).join(SEP);
		const pinnedW = pinned.reduce((sum, key) => sum + visibleWidth(labelOf(key)), 0) + SEP_W;
		const providers = this.categories;
		if (!providers.length) return truncateToWidth("  " + pinnedPart, width);

		const segW = providers.map((key) => visibleWidth(labelOf(key)));
		const rangeW = (lo: number, hi: number) =>
			segW.slice(lo, hi + 1).reduce((sum, w) => sum + w, 0) + Math.max(0, hi - lo) * SEP_W;
		const activeIdx = providers.indexOf(activeKey);
		let lo = 0;
		let hi = -1;
		// Two passes: arrow widths depend on the hidden counts the window
		// produces, so recompute the budget once with real counts.
		for (let pass = 0; pass < 2; pass++) {
			const leftHidden = lo;
			const rightHidden = providers.length - 1 - hi;
			const reserve = (pass === 0 ? 3 : leftHidden > 0 ? visibleWidth("<< ") : 0)
				+ (pass === 0 ? 3 : rightHidden > 0 ? visibleWidth(" >>") : 0);
			const avail = Math.max(0, width - 2 - pinnedW - SEP_W - reserve);
			lo = Math.min(Math.max(0, this.providerLo), providers.length - 1);
			if (activeIdx >= 0) {
				if (activeIdx < lo) lo = activeIdx;
				while (lo < activeIdx && rangeW(lo, activeIdx) > avail) lo++;
			}
			hi = lo - 1;
			while (hi + 1 < providers.length && rangeW(lo, hi + 1) <= avail) hi++;
			if (hi < lo) hi = lo; // a single over-wide label still shows, truncated at the end
			while (lo > 0 && rangeW(lo - 1, hi) <= avail) lo--;
		}
		this.providerLo = lo;

		const leftHidden = lo;
		const rightHidden = providers.length - 1 - hi;
		const leftPart = leftHidden > 0 ? theme.fg("dim", "<< ") : "";
		const rightPart = rightHidden > 0 ? theme.fg("dim", " >>") : "";
		const providerPart = providers.slice(lo, hi + 1).map(segment).join(SEP);
		return truncateToWidth("  " + pinnedPart + SEP + leftPart + providerPart + rightPart, width);
	}

	private renderRow(
		model: Model<Api>,
		isSelected: boolean,
		isCurrent: boolean,
		width: number,
		theme: any,
		colW: { name: number; provider: number; cost: number; ctx: number; thinking: number; vision: number },
		fuzzyHighlight?: "match" | "top",
	): string {
		const prefix = isSelected ? "▶ " : "  ";
		const ctxStr = model.contextWindow ? fmtCtx(model.contextWindow) : "";
		const costStr = fmtCost(model.cost);
		// Pad blank cells too, so missing values cannot shift the other columns.
		const right = [
			colW.cost ? costStr.padStart(colW.cost) : "",
			colW.ctx ? ctxStr.padStart(colW.ctx) : "",
			colW.thinking ? (model.reasoning ? "thinking" : "").padEnd(colW.thinking) : "",
			colW.vision ? (model.input.includes("image") ? "vision" : "").padEnd(colW.vision) : "",
		].filter(Boolean).join("  ");

		const showProvider = this.crossProvider;
		const isFav = this.isFavorite(model);
		// One status dot per row, coloured by meaning:
		//   current model            → green (success)
		//   favorite                 → gold (warning); hidden on the Favorites
		//                              tab, where every row is a favorite
		//   current model + favorite → gold, shown on every tab
		const dotColor = isCurrent ? (isFav ? "warning" : "success")
			: isFav && !this.onFavoritesTab() ? "warning"
			: undefined;
		const dot = dotColor ? " ●" : "";
		const nameAvail = Math.max(0, width - visibleWidth(prefix) - visibleWidth(right) - (showProvider ? 2 : visibleWidth(dot)) - 2);
		const providerWidth = showProvider ? Math.min(colW.provider, Math.max(0, nameAvail - 12)) : 0;
		const nameWidth = showProvider ? Math.min(colW.name, Math.max(0, nameAvail - providerWidth - 2)) : nameAvail;
		const name = truncateToWidth(modelLabel(model), nameWidth);
		const provider = showProvider && providerWidth >= 2 ? `[${truncateToWidth(providerLabel(model.provider), providerWidth - 2)}]` : "";
		const tail = showProvider
			? " ".repeat(Math.max(0, nameWidth + 2 - visibleWidth(name + dot))) + "  " + provider
			: "";
		const gap = " ".repeat(
			Math.max(0, width - visibleWidth(prefix + name + dot + tail) - visibleWidth(right)),
		);

		// Row colour: selected → accent, current → green, otherwise default.
		// Favorite state is carried by the dot alone. The dot keeps its own
		// colour on every row, including the selected one, so it is coloured
		// separately from the text around it.
		const rowColor = isSelected ? "accent" : isCurrent ? "success" : "text";
		const rightColor = isSelected ? "accent" : isCurrent ? "muted" : "dim";
		const left = theme.fg(rowColor, prefix + name)
			+ (dotColor ? theme.fg(dotColor, theme.bold(dot)) : "")
			+ (tail ? theme.fg(rowColor, tail) : "");
		const line = left + gap + theme.fg(rightColor, isSelected ? theme.bold(right) : right);
		// Fuzzy matches sit on a subtle neutral panel. The best-ranked row uses
		// the theme's dedicated search-match background instead. Both deliberately
		// differ from selectedBg, which remains the selected tab's highlight.
		const fuzzyBg = fuzzyHighlight === "top" ? "searchMatchBg"
			: fuzzyHighlight === "match" ? "toolPendingBg"
			: undefined;
		return fuzzyBg ? theme.bg(fuzzyBg, line) : line;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}
}

// ─── extension ──────────────────────────────────────────────────────────────

export default function modelPickerExtension(pi: ExtensionAPI) {
	const rememberLastTab = readSetting("rememberLastTab") !== false;
	let lastTab: ModelPickerOptions["lastTab"];
	async function openPicker(ctx: ExtensionContext) {
		// Same logic as /model: render cached snapshot immediately, refresh in the background
		const refreshPromise = Promise.resolve(ctx.modelRegistry.refresh());
		let allModels = ctx.modelRegistry.getAvailable();
		if (allModels.length === 0) {
			await refreshPromise.catch(() => {});
			allModels = ctx.modelRegistry.getAvailable();
		}

		if (allModels.length === 0) {
			ctx.ui.notify("No models available", "warning");
			return;
		}

		// Favorites are this extension's own list in settings.json, unrelated
		// to pi's native scoped models. Refs for models missing from the
		// catalogue are kept, so a favorite survives its provider being
		// temporarily unavailable.
		let favoriteRefs = readFavoriteRefs();
		const persistFavorites = () => {
			try {
				writeSetting("favorites", favoriteRefs);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save favorites: ${message}`, "error");
			}
		};
		const resolveFavorites = (models: Model<Api>[]): Model<Api>[] =>
			favoriteRefs.flatMap((ref) => {
				const match = models.find(
					(m) => `${m.provider}/${m.id}`.toLowerCase() === ref.toLowerCase(),
				);
				return match ? [match] : [];
			});
		const addToFavorite = (model: Model<Api>) => {
			const ref = `${model.provider}/${model.id}`;
			if (favoriteRefs.some((r) => r.toLowerCase() === ref.toLowerCase())) return;
			favoriteRefs = [...favoriteRefs, ref];
			persistFavorites();
		};
		const removeFavorite = (model: Model<Api>) => {
			const ref = `${model.provider}/${model.id}`.toLowerCase();
			favoriteRefs = favoriteRefs.filter((r) => r.toLowerCase() !== ref);
			persistFavorites();
		};
		const removeFavorites = (models: Model<Api>[]) => {
			const refs = new Set(models.map((m) => `${m.provider}/${m.id}`.toLowerCase()));
			favoriteRefs = favoriteRefs.filter((r) => !refs.has(r.toLowerCase()));
			persistFavorites();
		};

		const selected = await ctx.ui.custom<Model<Api> | null>((tui, theme, _kb, done) => {
			let closed = false;
			const close = (model: Model<Api> | null) => {
				closed = true;
				if (rememberLastTab) lastTab = model?.provider ?? picker.getLastTab();
				done(model);
			};
			const picker = new ModelPickerComponent({
				allModels,
				favorites: resolveFavorites(allModels),
				currentModel: ctx.model ?? undefined,
				lastTab,
				onSelect: close,
				onCancel: () => close(null),
				onAddToFavorite: addToFavorite,
				onRemoveFavorite: removeFavorite,
				onRemoveFavorites: removeFavorites,
				onClearFavorites: () => {
					favoriteRefs = [];
					persistFavorites();
				},
			});

			// Give the picker focus so the embedded Input gets IME cursor
			picker.focusedState = true;

			void refreshPromise
				.then(() => {
					if (closed) return;
					const refreshed = ctx.modelRegistry.getAvailable();
					if (refreshed.length > 0) {
						picker.updateModels(refreshed, ctx.model ?? undefined);
						tui.requestRender();
					}
				})
				.catch(() => {});

			return {
				// Implement Focusable so pi propagates focus to the Input's cursor
				get focused() {
					return picker.focused;
				},
				set focused(v: boolean) {
					picker.focusedState = v;
				},

				render(width: number): string[] {
					return picker.render(width, theme);
				},
				invalidate() {
					picker.invalidate();
				},
				handleInput(data: string) {
					picker.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selected) return;

		const success = await pi.setModel(selected);
		if (!success) {
			ctx.ui.notify(`No API key for ${selected.provider}/${selected.id}`, "error");
			return;
		}
		try {
			const settings = SettingsManager.create(ctx.cwd);
			settings.setDefaultModelAndProvider(selected.provider, selected.id);
			// Like /model: startup ignores a default outside a non-empty enabledModels scope, so add it.
			const ref = `${selected.provider}/${selected.id}`;
			const enabled = settings.getEnabledModels();
			const inScope = (ctx.scopedModels ?? []).some(({ model }) => model.provider === selected.provider && model.id === selected.id);
			if (enabled?.length && !inScope && !enabled.some((pattern) => pattern.toLowerCase() === ref.toLowerCase())) {
				settings.setEnabledModels([...enabled, ref]);
			}
			await settings.flush();
			const error = settings.drainErrors().find((entry) => entry.scope === "global");
			if (error) throw error.error;
			ctx.ui.notify(`Model: ${selected.name} (saved as startup default)`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Model changed, but could not save startup default: ${message}`, "error");
		}
	}

	// /model is a reserved built-in — use /models instead
	pi.registerCommand("models", {
		description: "Select model by provider category with search (Tab/← → switch, ↑↓ navigate)",
		handler: async (_args, ctx) => {
			await openPicker(ctx);
		},
	});

	// Keyboard shortcut(s) — configurable via settings.json ("pi-picks": { "shortcut": ... })
	const shortcuts = resolveShortcuts();
	const seen = new Set<string>();
	for (const shortcut of shortcuts) {
		const normalized = shortcut.toLowerCase();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		// User-configured shortcuts come from settings.json as plain strings; pi validates
		// the actual key format at registration time, so an invalid value is a no-op rather
		// than a startup crash.
		pi.registerShortcut(shortcut as KeyId, {
			description: "Open categorized model picker",
			handler: async (ctx) => {
				await openPicker(ctx);
			},
		});
	}
}









