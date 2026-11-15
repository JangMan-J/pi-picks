/**
 * Table: pure sort, label, modality, and column-geometry helpers for the picker list.
 *
 * No runtime imports, so Node's type stripping runs it (and its tests)
 * directly. Column geometry depends only on every row of the active tab and
 * the width — never on the sort mode, scroll window, or query — so headers
 * and cells keep their x-offsets while the user scrolls, filters, or sorts.
 */

export interface TableModel {
	provider: string;
	id: string;
	name: string;
	cost?: { input: number; output: number };
	contextWindow?: number;
	reasoning?: boolean;
	input: readonly string[];
	output?: readonly string[];
}

export type SortMode =
	| "default"
	| "model-asc"
	| "model-desc"
	| "provider-asc"
	| "provider-desc"
	| "price-asc"
	| "price-desc"
	| "ctx-asc"
	| "ctx-desc"
	| "modality-asc"
	| "modality-desc";
/** favorites and all span providers; provider is a single-provider tab. */
export type TabKind = "favorites" | "all" | "provider";
export type MetaColumn = "cost" | "ctx" | "modality";
export type Column = "model" | "provider" | MetaColumn;

export type ModalityCode = "T" | "V" | "G" | "S";
export type ModalityColor = "syntaxVariable" | "success" | "warning" | "thinkingXhigh";

export interface ModalitySlot {
	code: ModalityCode;
	label: string;
	color: ModalityColor;
	present: boolean;
}

/** Four fixed modality slots: Thinking, Vision, Generation (images), Synthesis (voice). */
export const MODALITY_LEGEND: readonly Omit<ModalitySlot, "present">[] = [
	{ code: "T", label: "thinking", color: "syntaxVariable" },
	{ code: "V", label: "vision", color: "success" },
	{ code: "G", label: "generation", color: "warning" },
	{ code: "S", label: "synthesis", color: "thinkingXhigh" },
];

/** Ctrl+S cycle order: tab default (when distinct), then ▲ and ▼ on every column left to right. */
export const SORT_MODES: readonly SortMode[] = [
	"default",
	"model-asc",
	"model-desc",
	"provider-asc",
	"provider-desc",
	"price-asc",
	"price-desc",
	"ctx-asc",
	"ctx-desc",
	"modality-asc",
	"modality-desc",
];

const SORT_INFO: Record<Exclude<SortMode, "default">, { column: Column; arrow: "▲" | "▼" }> = {
	"model-asc": { column: "model", arrow: "▲" },
	"model-desc": { column: "model", arrow: "▼" },
	"provider-asc": { column: "provider", arrow: "▲" },
	"provider-desc": { column: "provider", arrow: "▼" },
	"price-asc": { column: "cost", arrow: "▲" },
	"price-desc": { column: "cost", arrow: "▼" },
	"ctx-asc": { column: "ctx", arrow: "▲" },
	"ctx-desc": { column: "ctx", arrow: "▼" },
	"modality-asc": { column: "modality", arrow: "▲" },
	"modality-desc": { column: "modality", arrow: "▼" },
};
/** Metadata columns, left to right. */
export const META_COLUMNS: readonly MetaColumn[] = ["cost", "ctx", "modality"];
/** Narrow widths drop metadata columns in this order. */
export const DROP_ORDER: readonly MetaColumn[] = ["modality", "ctx", "cost"];

export const LABELS: Record<Column, string> = {
	model: "Model",
	provider: "Provider",
	cost: "Price",
	ctx: "Ctx",
	modality: "Modality",
};

const MODALITY_WIDTH = MODALITY_LEGEND.length * 3; // "[T][V][G][S]" = 12 columns

/** Header width reserved per column: the label plus its widest sort arrow (or fixed slot width). */
const HEADER_RESERVE: Record<Column, number> = {
	model: "Model ▲".length,
	provider: "Provider ▲".length,
	cost: "Price ▲".length,
	ctx: "Ctx ▲".length,
	modality: Math.max("Modality ▼".length, MODALITY_WIDTH),
};

const PREFIX = 2; // cursor prefix "▶ " / "  "
const DOT = 2; // " ●" status dot after the name
const GAP = 2;
/** Name and provider widths kept before metadata columns are dropped. */
const MIN_NAME = 24;
const MIN_PROVIDER = 14;

// ─── labels & modalities ────────────────────────────────────────────────────

/** Friendly display name for a provider id, derived from the id itself. */
export function providerLabel(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** Omit identified maker prefixes and redundant provider suffixes, not custom name qualifiers. */
export function modelLabel(model: Pick<TableModel, "name" | "id" | "provider">): string {
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
	const provider = suffix?.[1]!.trim().toLowerCase();
	return suffix && (provider === model.provider.toLowerCase() || provider === providerLabel(model.provider).toLowerCase())
		? name.slice(0, suffix.index).trimEnd() || name : name;
}

/** Format per-million-token cost as "$in/$out"; omit invalid or all-zero rates. */
export function fmtCost(cost: { input: number; output: number } | undefined): string {
	const rates = [cost?.input, cost?.output] as number[];
	if (!rates.every((n) => Number.isFinite(n) && n >= 0) || !rates.some((n) => n > 0)) return "";
	const fmt = (n: number) =>
		n === 0 ? "0"
		: n < 0.01 ? String(Number(n.toPrecision(2))) // keep sub-cent rates non-zero
		: n < 1 ? n.toFixed(2)
		: n.toFixed(2).replace(/\.?0+$/, "");
	return rates.map((n) => `$${fmt(n)}`).join("/");
}

/** Format context window as human-readable ("200k", "1M"); omit invalid or non-positive values. */
export function fmtCtx(tokens: number | undefined): string {
	if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return "";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
	return String(tokens);
}

const IMAGE_GEN_ID = /\b(imagen|flux|dall-e|gpt-image|recraft|ideogram|seedream|stable-diffusion)\b|-image(?:-|$)/i;
const VOICE_SYNTH_ID = /\b(tts|audio-preview|realtime|voice|speech|elevenlabs|kokoro|orpheus)\b/i;

export function hasModality(model: TableModel, code: ModalityCode): boolean {
	switch (code) {
		case "T": return Boolean(model.reasoning);
		case "V": return model.input.includes("image");
		case "G": return Boolean(model.output?.includes("image")) || IMAGE_GEN_ID.test(model.id);
		case "S": return Boolean(model.output?.includes("audio")) || VOICE_SYNTH_ID.test(model.id);
	}
}

export function modalitySlots(model: TableModel): ModalitySlot[] {
	return MODALITY_LEGEND.map((entry) => ({ ...entry, present: hasModality(model, entry.code) }));
}

/** Plain 12-column fixed-slot modality string (`"[T][V]      "`, `"[T][V][G][S]"`). */
export function fmtModality(model: TableModel): string {
	return modalitySlots(model).map((s) => (s.present ? `[${s.code}]` : "   ")).join("");
}

const modalityCount = (m: TableModel) => MODALITY_LEGEND.reduce((n, e) => n + Number(hasModality(m, e.code)), 0);
const modalityRank = (m: TableModel) =>
	(hasModality(m, "V") ? 8 : 0)
	+ (hasModality(m, "T") ? 4 : 0)
	+ (hasModality(m, "G") ? 2 : 0)
	+ (hasModality(m, "S") ? 1 : 0);

// ─── sorting ────────────────────────────────────────────────────────────────

export interface SortContext {
	kind: TabKind;
	/** True when `kind === "provider"` and `currentModel` sits ahead of alphabetical index 0. */
	pinnedCurrent?: boolean;
	/** Non-empty search query is present. */
	hasQuery?: boolean;
	/** True while search query ranks rows by fuzzy match (before Ctrl+S overrides it). */
	searchRanked?: boolean;
	/** Visible columns at current terminal width (defaults to all columns for `kind`). */
	visibleColumns?: readonly Column[];
}

const normCtx = (ctx: SortContext | TabKind): SortContext => (typeof ctx === "string" ? { kind: ctx } : ctx);
const defaultColumns = (kind: TabKind): Column[] =>
	kind === "provider" ? ["model", ...META_COLUMNS] : ["model", "provider", ...META_COLUMNS];

export function visibleColumnsOf(g: Geometry): Column[] {
	return ["model", ...(g.showProvider ? ["provider" as const] : []), ...g.meta.map((m) => m.column)];
}

const rate = (n: number | undefined) => (Number.isFinite(n) && n! > 0 ? n! : 0);
const isPaid = (m: TableModel) => rate(m.cost?.output) > 0 || rate(m.cost?.input) > 0;
const ctxTokens = (m: TableModel) =>
	m.contextWindow && Number.isFinite(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : 0;
const byModelAsc = (a: TableModel, b: TableModel) =>
	modelLabel(a).localeCompare(modelLabel(b))
	|| providerLabel(a.provider).localeCompare(providerLabel(b.provider))
	|| a.id.localeCompare(b.id);
const byModelDesc = (a: TableModel, b: TableModel) =>
	modelLabel(b).localeCompare(modelLabel(a))
	|| providerLabel(a.provider).localeCompare(providerLabel(b.provider))
	|| a.id.localeCompare(b.id);
const byProvider = (dir: 1 | -1) => (a: TableModel, b: TableModel) =>
	dir * providerLabel(a.provider).localeCompare(providerLabel(b.provider)) || byModelAsc(a, b);
/** Paid models by `dir` price, then $0 / unpriced models A→Z, never mixed. */
const byPrice = (dir: 1 | -1) => (a: TableModel, b: TableModel) =>
	Number(isPaid(b)) - Number(isPaid(a))
	|| (isPaid(a)
		? dir * (rate(a.cost?.output) - rate(b.cost?.output))
			|| dir * (rate(a.cost?.input) - rate(b.cost?.input))
			|| byModelAsc(a, b)
		: byModelAsc(a, b));
/** Known context windows by `dir`, then missing/0 context windows A→Z. */
const byCtx = (dir: 1 | -1) => (a: TableModel, b: TableModel) =>
	Number(ctxTokens(b) > 0) - Number(ctxTokens(a) > 0)
	|| (ctxTokens(a) > 0 ? dir * (ctxTokens(a) - ctxTokens(b)) || byModelAsc(a, b) : byModelAsc(a, b));
/** Modality badge count by `dir`, tie-breaking by capability weight (`V > T > G > S`), then Model ▲. */
const byModality = (dir: 1 | -1) => (a: TableModel, b: TableModel) =>
	dir * (modalityCount(a) - modalityCount(b))
	|| dir * (modalityRank(a) - modalityRank(b))
	|| byModelAsc(a, b);

/** True when `current` exists in `rows` and would move ahead of the first `Model ▲` row in default mode. */
export function pinsCurrentFirst(rows: readonly TableModel[], current?: { provider: string; id: string }): boolean {
	if (!current || rows.length <= 1) return false;
	if (!rows.some((m) => m.provider === current.provider && m.id === current.id)) return false;
	const first = rows.reduce((best, m) => (byModelAsc(m, best) < 0 ? m : best), rows[0]!);
	return !(first.provider === current.provider && first.id === current.id);
}

function hasDistinctDefault(c: SortContext): boolean {
	if (c.hasQuery) return true;
	if (c.kind === "favorites") return true;
	if (c.kind === "provider") return Boolean(c.pinnedCurrent);
	return false;
}

/** Effective sort mode for the active tab, query state, and visible columns. */
export function effectiveSort(mode: SortMode, ctx: SortContext | TabKind): SortMode {
	const c = normCtx(ctx);
	if (c.hasQuery && c.searchRanked) return "default";
	const cols = new Set(c.visibleColumns ?? defaultColumns(c.kind));
	if (mode === "default") return hasDistinctDefault(c) ? "default" : "model-asc";
	if (!cols.has(SORT_INFO[mode].column)) return hasDistinctDefault(c) ? "default" : "model-asc";
	return mode;
}

function sortCycle(c: SortContext): SortMode[] {
	const cols = new Set(c.visibleColumns ?? defaultColumns(c.kind));
	const colModes = (Object.keys(SORT_INFO) as Exclude<SortMode, "default">[]).filter((m) => cols.has(SORT_INFO[m].column));
	return hasDistinctDefault(c) ? ["default", ...colModes] : colModes;
}

/** Next sort mode and search-ranking flag after one Ctrl+S press. */
export function nextSortState(mode: SortMode, ctx: SortContext | TabKind): { mode: SortMode; searchRanked: boolean } {
	const c = normCtx(ctx);
	const cycle = sortCycle(c);
	const cur = effectiveSort(mode, c);
	const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length]!;
	return { mode: next, searchRanked: Boolean(c.hasQuery && next === "default") };
}

/** Next sort mode after one Ctrl+S press. */
export function nextSort(mode: SortMode, ctx: SortContext | TabKind): SortMode {
	return nextSortState(mode, ctx).mode;
}

/**
 * The sorted column and its arrow, or null when no single column governs order:
 * fuzzy-ranked searches, saved Favorites order, and provider tabs pinning the active model out of order.
 */
export function activeColumn(mode: SortMode, ctx: SortContext | TabKind): { column: Column; arrow: "▲" | "▼" } | null {
	const eff = effectiveSort(mode, ctx);
	return eff === "default" ? null : SORT_INFO[eff];
}

/**
 * Rows of a tab in `mode` order; never mutates `rows`. Default keeps the
 * stored Favorites order, sorts All by model then provider, and puts the
 * current model first on a provider tab.
 */
export function sortRows<T extends TableModel>(
	rows: readonly T[],
	mode: SortMode,
	ctx: SortContext | TabKind,
	current?: { provider: string; id: string },
): T[] {
	const out = [...rows];
	const c = typeof ctx === "string"
		? { kind: ctx, pinnedCurrent: ctx === "provider" && pinsCurrentFirst(rows, current) }
		: ctx;
	switch (effectiveSort(mode, c)) {
		case "default":
			if (c.kind === "favorites" || c.hasQuery) return out;
			if (c.kind === "all") return out.sort(byModelAsc);
			{
				const isCur = (m: T) => (current && m.provider === current.provider && m.id === current.id ? 0 : 1);
				return out.sort((a, b) => isCur(a) - isCur(b) || byModelAsc(a, b));
			}
		case "model-asc": return out.sort(byModelAsc);
		case "model-desc": return out.sort(byModelDesc);
		case "provider-asc": return out.sort(byProvider(1));
		case "provider-desc": return out.sort(byProvider(-1));
		case "price-asc": return out.sort(byPrice(1));
		case "price-desc": return out.sort(byPrice(-1));
		case "ctx-asc": return out.sort(byCtx(1));
		case "ctx-desc": return out.sort(byCtx(-1));
		case "modality-asc": return out.sort(byModality(1));
		case "modality-desc": return out.sort(byModality(-1));
	}
}

/** First row of a `size`-row window keeping `selected` in view (roughly centred). */
export function windowStart(selected: number, total: number, size: number): number {
	return Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
}

// ─── geometry ───────────────────────────────────────────────────────────────

export interface Measure {
	width(text: string): number;
	truncate(text: string, width: number): string;
}

/** Code-point measure; the picker passes pi-tui's visibleWidth/truncateToWidth. */
export const plainMeasure: Measure = {
	width: (text) => [...text].length,
	truncate: (text, width) => [...text].slice(0, Math.max(0, width)).join(""),
};

export interface Geometry {
	width: number;
	showProvider: boolean;
	/** Name field width, including room for the status dot. Starts at x = 2. */
	nameW: number;
	/** Provider field width (0 when hidden). Starts at x = 2 + nameW + 2. */
	providerW: number;
	/** Visible metadata columns, left to right. */
	meta: { column: MetaColumn; x: number; w: number }[];
}

/**
 * Price, Ctx and Modality at their header widths, a gap apart: the columns the frame keeps on the terminal's
 * midline on a wide screen (`contentWidth` in frame.ts).
 */
export const META_COLS_W = HEADER_RESERVE.cost + GAP + HEADER_RESERVE.ctx + GAP + HEADER_RESERVE.modality;

/**
 * Column geometry for a tab. Pass every row of the tab (not the visible
 * window, not the filtered rows) so offsets never move. Metadata columns
 * drop in DROP_ORDER while the name and provider would not fit.
 */
export function layoutTable(rows: readonly TableModel[], width: number, showProvider: boolean, measure: Measure = plainMeasure): Geometry {
	const max = (values: number[], floor: number) => values.reduce((a, b) => Math.max(a, b), floor);
	const fullName = max(rows.map((m) => measure.width(modelLabel(m)) + DOT), HEADER_RESERVE.model);
	const fullProvider = showProvider
		? max(rows.map((m) => measure.width(`[${providerLabel(m.provider)}]`)), HEADER_RESERVE.provider) : 0;
	const metaW: Record<MetaColumn, number> = {
		cost: max(rows.map((m) => measure.width(fmtCost(m.cost))), HEADER_RESERVE.cost),
		ctx: max(rows.map((m) => measure.width(fmtCtx(m.contextWindow))), HEADER_RESERVE.ctx),
		modality: HEADER_RESERVE.modality,
	};
	const visible = new Set<MetaColumn>(META_COLUMNS);
	const metaWidth = () => META_COLUMNS.filter((c) => visible.has(c)).reduce((sum, c) => sum + metaW[c] + GAP, 0);
	const minLeft = PREFIX + Math.min(fullName, MIN_NAME) + (showProvider ? GAP + Math.min(fullProvider, MIN_PROVIDER) : 0);
	for (const column of DROP_ORDER) {
		if (minLeft + metaWidth() <= width) break;
		visible.delete(column);
	}
	const right = metaWidth(); // includes the gap before the block
	const avail = Math.max(0, width - PREFIX - right);
	const providerW = showProvider
		? Math.min(fullProvider, Math.max(0, avail - GAP - Math.min(fullName, MIN_NAME))) : 0;
	const nameW = Math.min(fullName, Math.max(0, avail - (showProvider ? GAP + providerW : 0)));
	const meta: Geometry["meta"] = [];
	let x = width;
	for (const column of [...META_COLUMNS].reverse()) {
		if (!visible.has(column)) continue;
		x -= metaW[column];
		meta.unshift({ column, x, w: metaW[column] });
		x -= GAP;
	}
	return { width, showProvider, nameW, providerW, meta };
}

export interface Segment {
	text: string;
	/** "active" (sorted label), "arrow" (▲/▼), "header" (unsorted column header), "space" (padding). */
	style: "active" | "arrow" | "header" | "space";
}

/** Header row segments; every column header carries "header"/"active" so all headers stand out in accent color. */
export function headerSegments(g: Geometry, active: { column: Column; arrow: string } | null, measure: Measure = plainMeasure): Segment[] {
	const segments: Segment[] = [];
	let x = 0;
	const space = (n: number) => {
		if (n > 0) segments.push({ text: " ".repeat(n), style: "space" });
		x += Math.max(0, n);
	};
	const label = (column: Column, w: number, align: "left" | "right") => {
		const on = active?.column === column;
		if (!on) {
			const text = measure.truncate(LABELS[column], w);
			const pad = Math.max(0, w - measure.width(text));
			if (align === "right") space(pad);
			segments.push({ text, style: "header" });
			x += measure.width(text);
			if (align === "left") space(pad);
			return;
		}
		const arrowPart = w >= 3 ? ` ${active!.arrow}` : "";
		const labelPart = measure.truncate(LABELS[column], Math.max(0, w - measure.width(arrowPart)));
		const totalW = measure.width(labelPart + arrowPart);
		const pad = Math.max(0, w - totalW);
		if (align === "right") space(pad);
		segments.push({ text: labelPart, style: "active" });
		if (arrowPart) segments.push({ text: arrowPart, style: "arrow" });
		x += totalW;
		if (align === "left") space(pad);
	};
	space(PREFIX);
	label("model", g.nameW, "left");
	if (g.showProvider) {
		space(GAP);
		label("provider", g.providerW, "left");
	}
	for (const m of g.meta) {
		space(m.x - x);
		label(m.column, m.w, m.column === "modality" ? "left" : "right");
	}
	return segments;
}

/**
 * Parts of one row after the 2-column cursor prefix:
 * name + dot + tail (padding, provider) + right (Price, Ctx, and gap before Modality) + modality (4 fixed slots when shown).
 */
export function rowParts(
	g: Geometry,
	model: TableModel,
	dot: boolean,
	measure: Measure = plainMeasure,
): { name: string; dot: string; tail: string; right: string; modality: ModalitySlot[] | null } {
	const dotText = dot ? " ●" : "";
	const name = measure.truncate(modelLabel(model), Math.max(0, g.nameW - DOT));
	let tail = " ".repeat(Math.max(0, g.nameW - measure.width(name + dotText)));
	if (g.showProvider) {
		const provider = g.providerW >= 2 ? `[${measure.truncate(providerLabel(model.provider), g.providerW - 2)}]` : "";
		tail += " ".repeat(GAP) + provider + " ".repeat(Math.max(0, g.providerW - measure.width(provider)));
	}
	const leftW = PREFIX + measure.width(name + dotText + tail);
	let right = "";
	let modality: ModalitySlot[] | null = null;
	let x = leftW;
	for (const m of g.meta) {
		if (m.column === "modality") {
			right += " ".repeat(Math.max(0, m.x - x));
			modality = modalitySlots(model);
			x = Math.max(x, m.x) + m.w;
			continue;
		}
		const text = m.column === "cost" ? fmtCost(model.cost) : fmtCtx(model.contextWindow);
		right += " ".repeat(Math.max(0, m.x - x)) + text.padStart(m.w);
		x = Math.max(x, m.x) + m.w;
	}
	return { name, dot: dotText, tail, right, modality };
}
