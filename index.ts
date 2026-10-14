/**
 * Model Picker Extension
 *
 * Categorized, keyboard-driven model selector with per-category search.
 *
 * Tab/Shift+Tab switch provider categories.
 *
 * Usage:
 *   /models          — open the categorized picker
 *   Ctrl+Shift+M     — keyboard shortcut (default; configurable, see below)
 *
 * Note: /model is a built-in pi command and cannot be overridden.
 *
 * Configuring the shortcut:
 *   Add to ~/.pi/agent/settings.json:
 *     { "pi-model-picker": { "shortcut": "ctrl+l" } }
 *   Accepts a string, an array of strings (binds multiple keys), or `false`
 *   to disable the shortcut entirely (the /models command still works).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Input, Key, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { KeyId } from "@mariozechner/pi-tui";
import type { Api, Model } from "@mariozechner/pi-ai";

// ─── settings ───────────────────────────────────────────────────────────────

const DEFAULT_SHORTCUT = "ctrl+shift+m";

function readSetting(setting: string): unknown {
	try {
		const raw = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf-8"));
		return raw?.["pi-model-picker"]?.[setting];
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

interface ModelPickerOptions {
	allModels: Model<Api>[];
	currentModel: Model<Api> | undefined;
	lastTab?: string;
	onSelect: (model: Model<Api>) => void;
	onCancel: () => void;
}

class ModelPickerComponent {
	// Focusable — needed so the Input inside gets IME cursor positioning
	focused = false;

	private categories: string[];
	private catIndex: number;
	private rowIndex = 0;
	private fuzzy = false;
	private matchingProviders = new Set<string>();

	// per-category source models (sorted, never mutated)
	private byCategory: Map<string, Model<Api>[]>;

	// per-category search terms (reset when category changes, preserved when returning)
	private searchTerms: Map<string, string> = new Map();

	// the search Input widget
	private searchInput: Input;

	// filtered models for the current view (recomputed on query/category change)
	private filteredRows: Model<Api>[] = [];

	constructor(private opts: ModelPickerOptions) {
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());

		// Restore the saved tab if available, otherwise follow the current model.
		const cur = opts.currentModel;
		const startCat = opts.lastTab && this.byCategory.has(opts.lastTab)
			? opts.lastTab : cur?.provider ?? this.categories[0];
		this.catIndex = Math.max(0, this.categories.indexOf(startCat ?? ""));

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

	getLastTab() {
		return this.categories[this.catIndex] ?? "";
	}

	updateModels(allModels: Model<Api>[], currentModel?: Model<Api>): void {
		const prevCat = this.categories[this.catIndex];
		const prevSelected = this.filteredRows[this.rowIndex];
		this.opts.allModels = allModels;
		if (currentModel !== undefined) this.opts.currentModel = currentModel;
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());
		const nextCatIdx = prevCat ? this.categories.indexOf(prevCat) : -1;
		this.catIndex = nextCatIdx >= 0 ? nextCatIdx : Math.min(this.catIndex, Math.max(0, this.categories.length - 1));
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

		// Sort categories: active provider first, then alphabetical
		return new Map(
			[...map.entries()].sort(([aKey], [bKey]) => {
				const aCur = cur && aKey === cur.provider ? -1 : 0;
				const bCur = cur && bKey === cur.provider ? -1 : 0;
				if (aCur !== bCur) return aCur - bCur;
				return aKey.localeCompare(bKey);
			}),
		);
	}

	// ── filtering ────────────────────────────────────────────────────────

	private searchKey(): string {
		return this.categories[this.catIndex] ?? "";
	}

	private applyFilter(): void {
		const catKey = this.categories[this.catIndex] ?? "";
		const source = this.fuzzy ? [...this.byCategory.values()].flat() : this.byCategory.get(catKey) ?? [];
		const query = this.searchInput.getValue().toLowerCase().trim();

		if (this.fuzzy) {
			this.filteredRows = fuzzyFilter(source, query, (m) => `${m.name} ${m.id} ${m.provider}`);
		} else if (!query) {
			this.filteredRows = source;
		} else {
			this.filteredRows = source.filter(
				(m) =>
					m.name.toLowerCase().includes(query) ||
					m.id.toLowerCase().includes(query) ||
					m.provider.toLowerCase().includes(query),
			);
		}
		this.matchingProviders = new Set(this.filteredRows.map((m) => m.provider));
		// Clamp row selection
		this.rowIndex = Math.max(0, Math.min(this.rowIndex, this.filteredRows.length - 1));
	}

	private switchCategory(delta: number): void {
		if (!this.categories.length) return;
		if (this.fuzzy) {
			const providers = this.categories.filter((p) => this.matchingProviders.has(p));
			if (!providers.length) return;
			const current = providers.indexOf(this.filteredRows[this.rowIndex]!.provider);
			const next = providers[(current + delta + providers.length) % providers.length];
			this.rowIndex = this.filteredRows.findIndex((m) => m.provider === next);
			return;
		}
		// Save current search term for this category before leaving
		this.searchTerms.set(this.searchKey(), this.searchInput.getValue());

		this.catIndex =
			(this.catIndex + delta + this.categories.length) % this.categories.length;

		// Restore search term for new category
		const saved = this.searchTerms.get(this.searchKey()) ?? "";
		this.searchInput.setValue(saved);

		this.rowIndex = 0;
		this.applyFilter();
	}

	// ── input handling ───────────────────────────────────────────────────

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("f"))) {
			this.fuzzy = !this.fuzzy;
			if (!this.fuzzy) this.searchTerms.set(this.searchKey(), this.searchInput.getValue());
			this.rowIndex = 0;
			this.applyFilter();
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

		// ← at start of empty field — switch category left
		if (!this.fuzzy && matchesKey(data, Key.left) && this.searchInput.getValue() === "") {
			this.switchCategory(-1);
			return;
		}
		// → at end of empty field — switch category right
		if (!this.fuzzy && matchesKey(data, Key.right) && this.searchInput.getValue() === "") {
			this.switchCategory(1);
			return;
		}

		// Everything else (including ← / → when field has text) → Input
		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const after = this.searchInput.getValue();

		if (before !== after) {
			// Global typing must not overwrite saved queries on other tabs.
			if (!this.fuzzy) this.searchTerms.set(this.searchKey(), after);
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
		const promptText = this.fuzzy ? "  Fuzzy: " : "  Search: ";
		const prompt = theme.fg(this.fuzzy ? "accent" : "muted", promptText);
		const promptW = visibleWidth(promptText);
		const inputLines = this.searchInput.render(Math.max(0, width - promptW));
		lines.push(prompt + (inputLines[0] ?? ""));

		lines.push("");

		// ── model list ───────────────────────────────────────────────────
		const MAX_VISIBLE = 10;
		const half = Math.floor(MAX_VISIBLE / 2);
		const rows = this.filteredRows;
		const start = Math.max(0, Math.min(this.rowIndex - half, rows.length - MAX_VISIBLE));
		const visible = rows.slice(start, start + MAX_VISIBLE);

		if (rows.length === 0) {
			const query = this.searchInput.getValue();
			const msg = query
				? `  No models match "${query}"`
				: this.fuzzy ? "  No models available" : "  No models in this category";
			lines.push(theme.fg("muted", truncateToWidth(msg, width)));
		} else {
			// Use every fuzzy match so columns do not move when the list scrolls.
			const measured = this.fuzzy ? rows : visible;
			const colW = {
				name: this.fuzzy ? Math.max(...rows.map((m) => visibleWidth(modelLabel(m)))) : 0,
				provider: this.fuzzy ? Math.max(...rows.map((m) => visibleWidth(`[${providerLabel(m.provider)}]`))) : 0,
				cost: Math.max(0, ...measured.map((m) => visibleWidth(fmtCost(m.cost)))),
				ctx: Math.max(0, ...measured.map((m) => visibleWidth(m.contextWindow ? fmtCtx(m.contextWindow) : ""))),
				thinking: measured.some((m) => m.reasoning) ? "thinking".length : 0,
				vision: measured.some((m) => m.input.includes("image")) ? "vision".length : 0,
			};
			// Keep the model and provider identifiable before showing optional metadata.
			for (const column of ["cost", "vision", "thinking", "ctx"] as const) {
				const infoWidth = Math.max(0, [colW.cost, colW.ctx, colW.thinking, colW.vision].filter(Boolean).reduce((sum, n) => sum + n + 2, -2));
				const labelWidth = this.fuzzy ? colW.name + colW.provider + 8 : 16;
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
				lines.push(this.renderRow(model, isSelected, isCurrent, width, theme, colW));
			}
		}
		// The empty-state message occupies one row; keep the count slot too.
		for (let i = Math.max(1, visible.length); i < MAX_VISIBLE; i++) lines.push("");
		const position = rows.length ? this.rowIndex + 1 : 0;
		const selected = rows[this.rowIndex];
		const details = `  (${position}/${rows.length})${selected ? ` ${selected.id}` : ""}`;
		lines.push(...wrapTextWithAnsi(theme.fg("dim", details), width));

		// ── help bar ─────────────────────────────────────────────────────
		lines.push(theme.fg("border", "─".repeat(width)));
		const help = `↑↓ / Enter select · Tab provider · Ctrl+F ${this.fuzzy ? "search" : "fuzzy"} · Esc/Ctrl+C cancel`;
		lines.push(theme.fg("dim", truncateToWidth("  " + help, width)));
		lines.push(theme.fg("accent", "─".repeat(width)));

		// Tiny terminal resizes must not emit over-wide prompts, markers, or wide glyphs.
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderTabs(width: number, theme: any): string {
		const total = this.categories.length;
		if (!total) return "";
		const selectedProvider = this.fuzzy ? this.filteredRows[this.rowIndex]?.provider : this.categories[this.catIndex];
		const active = Math.max(0, this.categories.indexOf(selectedProvider ?? this.categories[this.catIndex]!));
		const ARROW_W = 4; // "◀ " + " ▶"
		const SEP_W = 1;   // "│"
		const availForTabs = width - ARROW_W;

		let lo = active;
		let hi = active;
		let used = visibleWidth(` ${providerLabel(this.categories[active]!)} `);

		while (true) {
			let expanded = false;
			if (hi + 1 < total) {
				const w = SEP_W + visibleWidth(` ${providerLabel(this.categories[hi + 1]!)} `);
				if (used + w <= availForTabs) { hi++; used += w; expanded = true; }
			}
			if (lo - 1 >= 0) {
				const w = SEP_W + visibleWidth(` ${providerLabel(this.categories[lo - 1]!)} `);
				if (used + w <= availForTabs) { lo--; used += w; expanded = true; }
			}
			if (!expanded) break;
		}

		const segments: string[] = [];
		for (let i = lo; i <= hi; i++) {
			const label = ` ${providerLabel(this.categories[i]!)} `;
			const selected = this.categories[i] === selectedProvider;
			const color = selected ? "accent" : this.fuzzy
				? this.matchingProviders.has(this.categories[i]!) ? "success" : "dim"
				: "muted";
			const styled = theme.fg(color, selected ? theme.bold(label) : label);
			segments.push(selected ? theme.bg("selectedBg", styled) : styled);
		}

		const tabPart = segments.join(theme.fg("dim", "│"));
		const leftPart = lo > 0 ? theme.fg("dim", "◀ ") : "  ";
		const rightPart = hi < total - 1 ? theme.fg("dim", " ▶") : "  ";

		return truncateToWidth(leftPart + tabPart + rightPart, width);
	}

	private renderRow(
		model: Model<Api>,
		isSelected: boolean,
		isCurrent: boolean,
		width: number,
		theme: any,
		colW: { name: number; provider: number; cost: number; ctx: number; thinking: number; vision: number },
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

		const curMark = isCurrent ? " ●" : "";
		const nameAvail = Math.max(0, width - visibleWidth(prefix) - visibleWidth(right) - (this.fuzzy ? 2 : visibleWidth(curMark)) - 2);
		const providerWidth = this.fuzzy ? Math.min(colW.provider, Math.max(0, nameAvail - 12)) : 0;
		const nameWidth = this.fuzzy ? Math.min(colW.name, Math.max(0, nameAvail - providerWidth - 2)) : nameAvail;
		const name = truncateToWidth(modelLabel(model), nameWidth);
		const provider = this.fuzzy && providerWidth >= 2 ? `[${truncateToWidth(providerLabel(model.provider), providerWidth - 2)}]` : "";
		const nameTrunc = this.fuzzy
			? name + curMark + " ".repeat(Math.max(0, nameWidth + 2 - visibleWidth(name + curMark))) + "  " + provider
			: name + curMark;
		const gap = " ".repeat(
			Math.max(0, width - visibleWidth(prefix + nameTrunc) - visibleWidth(right)),
		);

		if (isSelected) {
			return (
				theme.fg("accent", prefix + nameTrunc) +
				gap +
				theme.fg("accent", theme.bold(right))
			);
		} else if (isCurrent) {
			return (
				theme.fg("success", prefix + nameTrunc) +
				gap +
				theme.fg("muted", right)
			);
		} else {
			return (
				theme.fg("text", prefix + nameTrunc) +
				gap +
				theme.fg("dim", right)
			);
		}
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

		const selected = await ctx.ui.custom<Model<Api> | null>((tui, theme, _kb, done) => {
			let closed = false;
			const close = (model: Model<Api> | null) => {
				closed = true;
				if (rememberLastTab) lastTab = model?.provider ?? picker.getLastTab();
				done(model);
			};
			const picker = new ModelPickerComponent({
				allModels,
				currentModel: ctx.model ?? undefined,
				lastTab,
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

	// Keyboard shortcut(s) — configurable via settings.json ("pi-model-picker": { "shortcut": ... })
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
