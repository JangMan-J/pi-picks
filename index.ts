/**
 * pi-picks — model picker extension
 *
 * Categorized, keyboard-driven model selector with one global fuzzy query.
 *
 * Tabs are facets over a single list: Favorites, All, then one per
 * provider (A→Z). Typing fuzzy-searches within the current tab; Tab
 * switches tab without touching the query. The picker opens on All.
 * Favorites is this extension's own list, stored as
 * `provider/id` strings under `pi-picks.favorites` in
 * settings.json — independent of pi's native scoped models
 * (`enabledModels`). Ctrl+F toggles the selected model in Favorites
 * from any tab (it stays in its provider tab); Ctrl+X removes the
 * favorites contained in the active tab (every favorite on Favorites).
 * A header row names the columns; Ctrl+S cycles the column sort.
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
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Favorites } from "./favorites.ts";
import { FRAME_ROWS, contentWidth, frameLines, spread } from "./frame.ts";
import type { FrameStyle } from "./frame.ts";
import {
	META_COLS_W, MODALITY_LEGEND, activeColumn, effectiveSort, headerSegments, layoutTable, modalitySlots, nextSortState,
	pinsCurrentFirst, providerLabel, rowParts, sortRows, visibleColumnsOf, windowStart,
} from "./table.ts";
import type { Column, Measure, SortContext, SortMode, TabKind } from "./table.ts";

// ─── settings ───────────────────────────────────────────────────────────────

const DEFAULT_SHORTCUT = "ctrl+\\";

const SETTINGS_KEY = "pi-picks";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The extension's settings block. */
function settingsBlock(raw: unknown): Record<string, unknown> {
	if (!isRecord(raw)) return {};
	const current = raw[SETTINGS_KEY];
	return isRecord(current) ? { ...current } : {};
}

function readSetting(setting: string): unknown {
	try {
		return settingsBlock(JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf-8")))[setting];
	} catch {
		return undefined; // Missing or malformed settings use defaults.
	}
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

const measure: Measure = { width: visibleWidth, truncate: (text, width) => truncateToWidth(text, width) };

// ─── component ──────────────────────────────────────────────────────────────

/** Tab keys for the cross-provider tabs. Sentinels so they cannot collide with a provider id. */
const FAVORITES_TAB = "\0favorites";
const ALL_TAB = "\0all";

const modelRef = (m: Model<Api>): string => `${m.provider}\0${m.id}`;

interface ModelPickerOptions {
	allModels: Model<Api>[];
	favorites: Favorites;
	/** Called with the reason when a favorites change could not be saved. */
	onFavoritesError: (message: string) => void;
	currentModel: Model<Api> | undefined;
	onSelect: (model: Model<Api>) => void;
	onCancel: () => void;
}

class ModelPickerComponent {
	// Focusable — needed so the Input inside gets IME cursor positioning
	focused = false;

	private categories: string[];
	private catIndex: number;
	private rowIndex = 0;
	private matchingProviders = new Set<string>();

	// Stored favorites present in the catalogue, in stored order (a view of opts.favorites)
	private resolvedFavorites: Model<Api>[] = [];

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

	// Ctrl+S column sort; typing a search ranks by fuzzy match until Ctrl+S or query clear
	private sortMode: SortMode = "default";
	private searchRanked = false;
	private lastWidth: number | undefined;
	private topMatchRef: string | undefined;

	// the search Input widget
	private searchInput: Input;

	// filtered models for the current view (recomputed on query/category change)
	private filteredRows: Model<Api>[] = [];

	constructor(private opts: ModelPickerOptions) {
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());
		this.refreshFavorites();

		// Home is always the All tab; Favorites is one Tab away.
		const cur = opts.currentModel;
		this.catIndex = Math.max(0, this.tabs.indexOf(ALL_TAB));

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
		return this.tabs[this.catIndex] ?? ALL_TAB;
	}

	private tabKind(): TabKind {
		const tab = this.currentTab();
		return tab === FAVORITES_TAB ? "favorites" : tab === ALL_TAB ? "all" : "provider";
	}

	private onFavoritesTab(): boolean {
		return this.currentTab() === FAVORITES_TAB;
	}

	private isFavorite(model: Model<Api>): boolean {
		return this.opts.favorites.has(model);
	}

	private refreshFavorites(): void {
		this.resolvedFavorites = this.opts.favorites.resolve(this.opts.allModels);
	}

	updateModels(allModels: Model<Api>[], currentModel?: Model<Api>): void {
		const prevTab = this.currentTab();
		const prevSelected = this.filteredRows[this.rowIndex];
		this.opts.allModels = allModels;
		if (currentModel !== undefined) this.opts.currentModel = currentModel;
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());
		this.refreshFavorites();
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

		// Provider tabs keep a stable A→Z order; the picker opens on the
		// relevant tab directly, so promoting the current provider would
		// only rearrange the bar whenever the model changes.
		const sorted = new Map(
			[...map.entries()].sort(([aKey], [bKey]) => aKey.localeCompare(bKey)),
		);

		// All-tab order: display label, then provider — duplicate models
		// offered by several providers end up adjacent for comparison.
		this.allSorted = sortRows([...map.values()].flat(), "default", "all");
		return sorted;
	}

	// ── filtering ────────────────────────────────────────────────────────

	private tabLabel(key: string): string {
		return key === FAVORITES_TAB ? "Favorites" : key === ALL_TAB ? "All" : providerLabel(key);
	}

	/** Source rows for a tab before the query is applied, unsorted. */
	private tabSource(tabKey: string): Model<Api>[] {
		return tabKey === FAVORITES_TAB ? this.resolvedFavorites
			: tabKey === ALL_TAB ? this.allSorted
			: this.byCategory.get(tabKey) ?? [];
	}

	private visibleColumns(): Column[] | undefined {
		if (this.lastWidth === undefined) return undefined;
		return visibleColumnsOf(layoutTable(this.tabSource(this.currentTab()), this.lastWidth, this.crossProvider, measure));
	}

	private sortCtx(): SortContext {
		const kind = this.tabKind();
		const tabRows = this.tabSource(this.currentTab());
		const hasQuery = this.searchInput.getValue().trim() !== "";
		return {
			kind,
			pinnedCurrent: kind === "provider" && pinsCurrentFirst(tabRows, this.opts.currentModel),
			hasQuery,
			searchRanked: this.searchRanked,
			visibleColumns: this.visibleColumns(),
		};
	}

	private applyFilter(): void {
		const query = this.searchInput.getValue().trim();
		const searchText = (m: Model<Api>) =>
			`${m.name} ${m.id} ${m.provider} ${modalitySlots(m).filter((s) => s.present).map((s) => s.label).join(" ")}`;
		this.globalMatches = fuzzyFilter(this.allSorted, query, searchText);
		const tabRows = this.tabSource(this.currentTab());
		const ctx = this.sortCtx();
		const eff = effectiveSort(this.sortMode, ctx);
		if (query) {
			const matched = fuzzyFilter(tabRows, query, searchText);
			this.topMatchRef = matched[0] ? modelRef(matched[0]) : undefined;
			this.filteredRows = eff === "default" ? matched : sortRows(matched, eff, ctx, this.opts.currentModel);
		} else {
			this.topMatchRef = undefined;
			this.filteredRows = sortRows(tabRows, eff, ctx, this.opts.currentModel);
		}
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
		const result = this.isFavorite(selected)
			? this.opts.favorites.remove(selected)
			: this.opts.favorites.add(selected);
		if (!result.ok) this.opts.onFavoritesError(result.error);
		this.refreshFavorites();
		this.applyFilter();
	}

	/**
	 * Ctrl+X: remove the favorites contained in the active tab, whatever the
	 * query. Favorites and All clear every stored favorite; a provider tab
	 * clears that provider's. Stored refs whose models are temporarily
	 * unavailable are cleared too.
	 */
	private clearFavoritesInTab(): void {
		const tab = this.currentTab();
		const result = this.opts.favorites.clear(tab === FAVORITES_TAB || tab === ALL_TAB ? undefined : tab);
		if (!result.ok) this.opts.onFavoritesError(result.error);
		this.refreshFavorites();
		if (tab === FAVORITES_TAB) this.rowIndex = 0;
		this.applyFilter();
	}

	/** Ctrl+S: next column sort, keeping the selected model selected. */
	private cycleSort(): void {
		const prevSelected = this.filteredRows[this.rowIndex];
		const next = nextSortState(this.sortMode, this.sortCtx());
		this.sortMode = next.mode;
		this.searchRanked = next.searchRanked;
		this.applyFilter();
		const kept = prevSelected
			? this.filteredRows.findIndex((m) => modelRef(m) === modelRef(prevSelected))
			: -1;
		// The list window is derived from rowIndex, so it scrolls to keep the row in view.
		this.rowIndex = kept >= 0 ? kept : 0;
	}

	// ── input handling ───────────────────────────────────────────────────

	handleInput(data: string): void {
		// Favorite toggle works on every tab; the model stays in its provider tab.
		if (matchesKey(data, Key.ctrl("f"))) {
			this.toggleSelectedFavorite();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.cycleSort();
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
			this.searchRanked = after.trim() !== "";
			this.rowIndex = 0;
			this.applyFilter();
		}
	}

	// ── rendering ────────────────────────────────────────────────────────

	render(termWidth: number, theme: any): string[] {
		// On a wide screen the text stops short of the right edge; only the rules span the terminal.
		const width = contentWidth(termWidth, META_COLS_W);
		if (this.lastWidth !== width) {
			const prevSelected = this.filteredRows[this.rowIndex];
			this.lastWidth = width;
			this.applyFilter();
			if (prevSelected) {
				const kept = this.filteredRows.findIndex((m) => modelRef(m) === modelRef(prevSelected));
				if (kept >= 0) this.rowIndex = kept;
			}
		}
		// The lines are the suite's shared frame (frame.ts); this method supplies what goes on each.
		const tabs = this.renderTabs(width, theme);

		// ── search field ─────────────────────────────────────────────────
		const promptText = "  Search: ";
		const prompt = theme.fg("muted", promptText);
		const promptW = visibleWidth(promptText);
		const inputLines = this.searchInput.render(Math.max(0, width - promptW));
		const input = prompt + (inputLines[0] ?? "");

		// ── column header (fixed geometry: every row of the tab) ─────────
		const MAX_VISIBLE = FRAME_ROWS;
		const rows = this.filteredRows;
		const hasQuery = this.searchInput.getValue().trim() !== "";
		const geometry = layoutTable(this.tabSource(this.currentTab()), width, this.crossProvider, measure);
		const active = activeColumn(this.sortMode, this.sortCtx());
		const header = headerSegments(geometry, active, measure)
			.map((seg) =>
				seg.style === "active" ? theme.bold(theme.fg("accent", seg.text))
				: seg.style === "arrow" ? theme.bold(theme.fg("warning", seg.text))
				: seg.style === "header" ? theme.fg("accent", seg.text)
				: seg.text)
			.join("");
		const lines: string[] = [];

		// ── model list ───────────────────────────────────────────────────
		const start = windowStart(this.rowIndex, rows.length, MAX_VISIBLE);
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
			for (let i = 0; i < visible.length; i++) {
				const model = visible[i]!;
				const absIdx = start + i;
				const isSelected = absIdx === this.rowIndex;
				const isCurrent =
					this.opts.currentModel?.id === model.id &&
					this.opts.currentModel?.provider === model.provider;
				const fuzzyHighlight = hasQuery
					? (this.topMatchRef === modelRef(model) ? "top" : "match")
					: undefined;
				lines.push(this.renderRow(model, isSelected, isCurrent, geometry, theme, fuzzyHighlight));
			}
		}
		const position = rows.length ? this.rowIndex + 1 : 0;
		const selected = rows[this.rowIndex];
		// On cross-provider tabs the bare id is ambiguous when several
		// providers offer the same model, so show the full ref.
		const ref = selected ? (this.crossProvider ? `${selected.provider}/${selected.id}` : selected.id) : "";
		const details = `  (${position}/${rows.length})${ref ? ` ${ref}` : ""}`;
		// One line, always: truncate rather than wrap so the height never changes.
		const status = theme.fg("dim", truncateToWidth(details, width));

		// ── help bar + right-justified modality legend ──────────────────
		const leftHelp = "  ↑↓ Enter · Tab · Ctrl+F/X fav · Ctrl+S sort · Esc";
		const legend = MODALITY_LEGEND.map((m) => theme.fg(m.color, `[${m.code}]`) + theme.fg("dim", ` ${m.label}`)).join(" ");
		const legendW = visibleWidth(legend);
		// The legend stays whole and the keys give way, down to 20 columns of them; narrower, the legend goes.
		const keys =
			(width >= legendW + 26
				&& spread(theme.fg("dim", truncateToWidth(leftHelp, width - legendW - 4, "…")), legend, width, measure))
			|| theme.fg("dim", truncateToWidth(leftHelp, width, "…"));

		const style: FrameStyle = {
			accent: (text) => theme.fg("accent", text),
			bold: (text) => theme.bold(text),
			border: (text) => theme.fg("border", text),
		};
		// The frame cuts every line to its width, so a tiny terminal never gets an over-wide prompt, marker, or glyph.
		return frameLines({ title: "Select Model", tabs, input, header, rows: lines, status, keys }, width, termWidth, style, measure);
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
		geometry: ReturnType<typeof layoutTable>,
		theme: any,
		fuzzyHighlight?: "match" | "top",
	): string {
		const prefix = isSelected ? "▶ " : "  ";
		const isFav = this.isFavorite(model);
		// One status dot per row, coloured by meaning:
		//   current model            → green (success)
		//   favorite                 → gold (warning); hidden on the Favorites
		//                              tab, where every row is a favorite
		//   current model + favorite → gold, shown on every tab
		const dotColor = isCurrent ? (isFav ? "warning" : "success")
			: isFav && !this.onFavoritesTab() ? "warning"
			: undefined;
		// Cells sit at the tab's fixed column offsets, shared with the header.
		const { name, dot, tail, right, modality } = rowParts(geometry, model, !!dotColor, measure);
		const modalityStyled = modality
			? modality.map((s) => (s.present ? theme.fg(s.color, isSelected ? theme.bold(`[${s.code}]`) : `[${s.code}]`) : "   ")).join("")
			: "";

		// Row colour: selected → accent, current → green, otherwise default.
		// Favorite state is carried by the dot alone. The dot and modality badges
		// keep their own semantic colours on every row, including the selected one.
		const rowColor = isSelected ? "accent" : isCurrent ? "success" : "text";
		const rightColor = isSelected ? "accent" : isCurrent ? "muted" : "dim";
		const left = theme.fg(rowColor, prefix + name)
			+ (dotColor ? theme.fg(dotColor, theme.bold(dot)) : "")
			+ (tail ? theme.fg(rowColor, tail) : "");
		const line = left + theme.fg(rightColor, isSelected ? theme.bold(right) : right) + modalityStyled;
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
		// to pi's native scoped models; read fresh each time the picker opens.
		const favorites = Favorites.open(join(getAgentDir(), "settings.json"));

		const selected = await ctx.ui.custom<Model<Api> | null>((tui, theme, _kb, done) => {
			let closed = false;
			const close = (model: Model<Api> | null) => {
				closed = true;
				done(model);
			};
			const picker = new ModelPickerComponent({
				allModels,
				favorites,
				onFavoritesError: (message) => ctx.ui.notify(message, "error"),
				currentModel: ctx.model ?? undefined,
				onSelect: close,
				onCancel: () => close(null),
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









