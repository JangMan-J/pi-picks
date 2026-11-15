import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DROP_ORDER, META_COLUMNS, MODALITY_LEGEND, SORT_MODES, activeColumn, contentWidth, effectiveSort, fmtCtx, fmtModality,
	hasModality, headerSegments, layoutTable, modalitySlots, nextSort, nextSortState, pinsCurrentFirst, rowParts,
	sortRows, visibleColumnsOf, windowStart,
} from "./table.ts";
import type { Geometry, SortMode, TabKind, TableModel } from "./table.ts";

const m = (
	provider: string,
	name: string,
	output = 0,
	input = 0,
	vision = false,
	reasoning = false,
	contextWindow = 200_000,
	outModalities: string[] = [],
): TableModel => ({
	provider,
	id: name.toLowerCase().replace(/\s+/g, "-"),
	name,
	cost: { input, output },
	contextWindow,
	reasoning,
	input: vision ? ["text", "image"] : ["text"],
	output: outModalities,
});

const header = (g: Geometry, active: Parameters<typeof headerSegments>[1]) =>
	headerSegments(g, active).map((s) => s.text).join("");
const row = (g: Geometry, model: TableModel, dot = false) => {
	const p = rowParts(g, model, dot);
	const mod = p.modality ? p.modality.map((s) => (s.present ? `[${s.code}]` : "   ")).join("") : "";
	return "  " + p.name + p.dot + p.tail + p.right + mod;
};
const names = (rows: TableModel[]) => rows.map((r) => r.name);

// 25 models on one provider; the longest name, widest price, and full [T][V][G][S] sit below the first window.
const provider: TableModel[] = Array.from({ length: 25 }, (_, i) =>
	m("acme", `Model ${String(i).padStart(2, "0")}`, i % 4, i % 3, i % 2 === 0, i % 3 === 0, i % 5 === 0 ? 1_000_000 : 128_000));
provider.push(m("acme", "Extraordinarily Long Model Name", 123.45, 67.8, true, true, 1_000_000, ["image", "audio"]));
const mixed: TableModel[] = [
	m("zeta-ai", "Alpha", 10, 2, false, true, 1_000_000),
	m("acme", "Bravo", 1, 0.5, true, false, 200_000, ["image"]),
	m("acme", "Alpha", 3, 1, true, true, 128_000),
	m("mid", "Charlie", 0, 0, true, false, 0, ["audio"]),
	m("mid", "Delta"),
	m("zeta-ai", "Echo", 1, 0.25),
];

describe("column geometry & styling", () => {
	it("colors every header segment (never dim) and keeps every header and cell x-offset fixed across scroll & sorts", () => {
		for (const [rows, kind] of [[provider, "provider"], [mixed, "all"], [mixed, "favorites"]] as [TableModel[], TabKind][]) {
			const width = 110;
			const g = layoutTable(rows, width, kind !== "provider");
			const positions = new Set<string>();
			const startMode = effectiveSort("default", kind);
			let mode: SortMode = "default";
			let transitions = 0;
			do {
				transitions++;
				const sorted = sortRows(rows, mode, kind);
				for (const active of [activeColumn(mode, kind), null]) {
					const segs = headerSegments(g, active);
					for (const seg of segs) {
						if (seg.text.trim()) {
							assert.ok(["header", "active", "arrow"].includes(seg.style), `unexpected header style ${seg.style}`);
						}
					}
					const h = segs.map((s) => s.text).join("");
					assert.ok(h.length <= width);
					assert.equal(h.indexOf("Model"), 2);
					if (kind !== "provider") assert.equal(h.indexOf("Provider"), 2 + g.nameW + 2);
					const priceEnd = h.indexOf("Price") + h.slice(h.indexOf("Price")).split(/ {2}|$/)[0]!.length;
					const ctxEnd = h.indexOf("Ctx") + h.slice(h.indexOf("Ctx")).split(/ {2}|$/)[0]!.length;
					const modStart = h.indexOf("Modality");
					positions.add(`${priceEnd},${ctxEnd},${modStart}`);
				}
				for (let start = 0; start + 10 <= sorted.length || start === 0; start++) {
					for (const model of sorted.slice(start, start + 10)) {
						const line = row(g, model, model.name === "Bravo");
						assert.equal(line.length, width, line);
						assert.equal(line.indexOf(model.name), 2);
						if (kind !== "provider") assert.equal(line[2 + g.nameW + 2], "[");
						for (const col of g.meta) {
							const raw = line.slice(col.x, col.x + col.w);
							if (col.column === "modality") {
								assert.equal(raw, fmtModality(model));
							} else {
								const cell = raw.trimStart();
								const expected = col.column === "cost"
									? (model.cost!.output || model.cost!.input ? "$" : "")
									: fmtCtx(model.contextWindow);
								assert.ok(expected === "$" ? cell.startsWith("$") : cell === expected, `${col.column}: ${cell}`);
							}
							assert.equal(line[col.x - 1], " ");
						}
					}
				}
				mode = nextSort(mode, kind);
			} while (mode !== startMode);
			assert.equal(transitions, kind === "favorites" ? 11 : kind === "all" ? 10 : 8);
			assert.equal(positions.size, 1, [...positions].join(" | "));
			const [costEnd, ctxEnd, modStart] = [...positions][0]!.split(",").map(Number);
			assert.deepEqual([costEnd, ctxEnd, modStart], [g.meta[0]!.x + g.meta[0]!.w, g.meta[1]!.x + g.meta[1]!.w, g.meta[2]!.x]);
		}
	});

	it("renders [T][V][G][S] in four fixed 3-char vertical lanes with distinct semantic colors", () => {
		const colors = new Set(MODALITY_LEGEND.map((e) => e.color));
		assert.equal(colors.size, 4, "each modality badge has its own distinct color");
		assert.equal(fmtModality(m("p", "Plain")), "            ");
		assert.equal(fmtModality(m("p", "ThinkOnly", 0, 0, false, true)), "[T]         ");
		assert.equal(fmtModality(m("p", "VisionOnly", 0, 0, true, false)), "   [V]      ");
		assert.equal(fmtModality(m("p", "Omni", 0, 0, true, true, 128_000, ["image", "audio"])), "[T][V][G][S]");
		assert.equal(hasModality({ ...m("p", "Flux"), id: "black-forest/flux-pro" }, "G"), true);
		assert.equal(hasModality({ ...m("p", "Voice"), id: "openai/gpt-4o-audio-preview" }, "S"), true);
		assert.equal(modalitySlots(m("p", "Omni", 0, 0, true, true, 128_000, ["image", "audio"])).length, 4);
	});

	it("fills a window, and on a wide screen stops the text where the metadata columns are centred", () => {
		assert.deepEqual([40, 92, 120, 128].map(contentWidth), [40, 92, 120, 128], "a window is filled edge to edge");
		assert.deepEqual([129, 200, 228].map(contentWidth), [128, 128, 128], "wider, the text stays 128 columns until the midline passes the metadata");
		assert.deepEqual([229, 252, 300].map(contentWidth), [129, 140, 164]);
		// Price, Ctx and Modality (28 columns at header widths) straddle the terminal's midline.
		const g = layoutTable(provider, contentWidth(252), false);
		assert.equal(g.width, 140);
		assert.ok(row(g, provider.at(-1)!).endsWith("[T][V][G][S]") && row(g, provider.at(-1)!).length === 140);
		assert.equal((140 - 28 + 140) / 2, 252 / 2);
	});

	it("measures the whole tab, not the first window", () => {
		const g = layoutTable(provider, 120, false);
		const firstWindow = layoutTable(provider.slice(0, 10), 120, false);
		assert.ok(g.nameW > firstWindow.nameW);
		assert.ok(g.meta[0]!.x < firstWindow.meta[0]!.x);
		const long = provider.at(-1)!;
		assert.ok(row(g, long).includes("Extraordinarily Long Model Name"));
		assert.ok(row(g, long).includes("$67.8/$123.45"));
		assert.ok(row(g, long).includes("1M"));
		assert.ok(row(g, long).endsWith("[T][V][G][S]"));
	});

	it("drops metadata columns and their headers in lockstep down to width 40", () => {
		const wide = [...mixed, m("google-vertex-anthropic", "Claude Sonnet 4.5 Thinking", 15, 3, true, true)];
		let dropped = 0;
		for (let width = 120; width >= 40; width--) {
			const g = layoutTable(wide, width, true);
			const shown = g.meta.map((c) => c.column);
			assert.deepEqual(shown, META_COLUMNS.filter((c) => !DROP_ORDER.slice(0, 3 - shown.length).includes(c)));
			dropped = Math.max(dropped, 3 - shown.length);
			const h = header(g, { column: "modality", arrow: "▼" });
			assert.ok(h.length <= width, `header ${width}`);
			assert.equal(h.includes("Price"), shown.includes("cost"));
			assert.equal(h.includes("Ctx"), shown.includes("ctx"));
			assert.equal(h.includes("Modality"), shown.includes("modality"));
			for (const model of wide) assert.ok(row(g, model, true).length <= width, `row ${width}`);
		}
		assert.equal(dropped, 3, "width 40 leaves only model and provider");
		const narrow = layoutTable(wide, 40, true);
		assert.deepEqual(narrow.meta, []);
		assert.match(header(narrow, null), /^ {2}Model +Provider/);
	});
});

describe("sorting", () => {
	it("Model ▲/▼ and Provider ▲/▼ sort A→Z and Z→A with matching header arrows", () => {
		assert.deepEqual(activeColumn("model-asc", "all"), { column: "model", arrow: "▲" });
		assert.deepEqual(activeColumn("model-desc", "all"), { column: "model", arrow: "▼" });
		assert.deepEqual(sortRows(mixed, "model-asc", "all").map((r) => `${r.name}@${r.provider}`),
			["Alpha@acme", "Alpha@zeta-ai", "Bravo@acme", "Charlie@mid", "Delta@mid", "Echo@zeta-ai"]);
		assert.deepEqual(sortRows(mixed, "model-desc", "all").map((r) => `${r.name}@${r.provider}`),
			["Echo@zeta-ai", "Delta@mid", "Charlie@mid", "Bravo@acme", "Alpha@acme", "Alpha@zeta-ai"]);

		assert.deepEqual(activeColumn("provider-asc", "all"), { column: "provider", arrow: "▲" });
		assert.deepEqual(activeColumn("provider-desc", "all"), { column: "provider", arrow: "▼" });
		assert.deepEqual(sortRows(mixed, "provider-asc", "all").map((r) => `${r.provider}/${r.name}`),
			["acme/Alpha", "acme/Bravo", "mid/Charlie", "mid/Delta", "zeta-ai/Alpha", "zeta-ai/Echo"]);
		assert.deepEqual(sortRows(mixed, "provider-desc", "all").map((r) => `${r.provider}/${r.name}`),
			["zeta-ai/Alpha", "zeta-ai/Echo", "mid/Charlie", "mid/Delta", "acme/Alpha", "acme/Bravo"]);
	});

	it("Price ▲/▼ puts paid models low→high / high→low and $0 / missing prices last", () => {
		const free = { ...m("p", "Aardvark Free"), cost: undefined };
		const rows = [m("p", "Zero"), m("p", "Pricey", 15, 3), free, m("p", "Cheap", 1, 0.5), m("p", "Cheap Twin", 1, 0.2), m("p", "Input Only", 0, 0.1)];
		assert.deepEqual(activeColumn("price-asc", "all"), { column: "cost", arrow: "▲" });
		assert.deepEqual(activeColumn("price-desc", "all"), { column: "cost", arrow: "▼" });
		assert.deepEqual(names(sortRows(rows, "price-asc", "all")), ["Input Only", "Cheap Twin", "Cheap", "Pricey", "Aardvark Free", "Zero"]);
		assert.deepEqual(names(sortRows(rows, "price-desc", "all")), ["Pricey", "Cheap", "Cheap Twin", "Input Only", "Aardvark Free", "Zero"]);
	});

	it("Ctx ▲/▼ sorts known context windows small→large / large→small with unknown/0 last and fits Ctx ▲ without truncation", () => {
		const rows = [m("p", "Unknown", 0, 0, false, false, 0), m("p", "Mid", 0, 0, false, false, 128_000), m("p", "Huge", 0, 0, false, false, 1_000_000), m("p", "Tiny", 0, 0, false, false, 8_000)];
		assert.deepEqual(activeColumn("ctx-asc", "all"), { column: "ctx", arrow: "▲" });
		assert.deepEqual(activeColumn("ctx-desc", "all"), { column: "ctx", arrow: "▼" });
		assert.deepEqual(names(sortRows(rows, "ctx-asc", "all")), ["Tiny", "Mid", "Huge", "Unknown"]);
		assert.deepEqual(names(sortRows(rows, "ctx-desc", "all")), ["Huge", "Mid", "Tiny", "Unknown"]);
		const g = layoutTable([m("p", "Only200k")], 100, false);
		assert.ok(header(g, { column: "ctx", arrow: "▲" }).includes("Ctx ▲"));
		assert.ok(header(g, { column: "ctx", arrow: "▼" }).includes("Ctx ▼"));
	});

	it("Modality ▲/▼ sorts fewest→most and most→fewest badges, never putting 1 badge above 3 badges", () => {
		assert.deepEqual(activeColumn("modality-asc", "all"), { column: "modality", arrow: "▲" });
		assert.deepEqual(activeColumn("modality-desc", "all"), { column: "modality", arrow: "▼" });
		assert.deepEqual(sortRows(mixed, "modality-desc", "all").map((r) => `${r.name}@${r.provider}`),
			["Alpha@acme", "Bravo@acme", "Charlie@mid", "Alpha@zeta-ai", "Delta@mid", "Echo@zeta-ai"]);
		assert.deepEqual(sortRows(mixed, "modality-asc", "all").map((r) => `${r.name}@${r.provider}`),
			["Delta@mid", "Echo@zeta-ai", "Alpha@zeta-ai", "Charlie@mid", "Bravo@acme", "Alpha@acme"]);
		const threeNoVision = m("p", "ThreeNoVision", 0, 0, false, true, 128_000, ["image", "audio"]);
		const oneVision = m("p", "OneVision", 0, 0, true, false, 128_000, []);
		assert.deepEqual(names(sortRows([oneVision, threeNoVision], "modality-desc", "all")), ["ThreeNoVision", "OneVision"]);
		assert.deepEqual(names(sortRows([threeNoVision, oneVision], "modality-asc", "all")), ["OneVision", "ThreeNoVision"]);
	});

	it("cycles every visible column ▲ then ▼ with zero no-op presses on All, Favorites,Provider, and narrow widths", () => {
		const cycle = (ctx: Parameters<typeof nextSort>[1]) => {
			const seen: SortMode[] = [];
			const start = effectiveSort("default", ctx);
			let mode: SortMode = "default";
			do {
				const eff = effectiveSort(mode, ctx);
				seen.push(eff);
				mode = nextSort(mode, ctx);
				assert.notEqual(effectiveSort(mode, ctx), eff, `Ctrl+S must change effective sort from ${eff}`);
			} while (effectiveSort(mode, ctx) !== start);
			return seen;
		};
		assert.deepEqual(cycle("all"), [
			"model-asc", "model-desc", "provider-asc", "provider-desc",
			"price-asc", "price-desc", "ctx-asc", "ctx-desc", "modality-asc", "modality-desc",
		]);
		assert.deepEqual(cycle("favorites"), [
			"default", "model-asc", "model-desc", "provider-asc", "provider-desc",
			"price-asc", "price-desc", "ctx-asc", "ctx-desc", "modality-asc", "modality-desc",
		]);
		assert.deepEqual(cycle({ kind: "provider", pinnedCurrent: false }), [
			"model-asc", "model-desc", "price-asc", "price-desc", "ctx-asc", "ctx-desc", "modality-asc", "modality-desc",
		]);
		assert.deepEqual(cycle({ kind: "provider", pinnedCurrent: true }), [
			"default", "model-asc", "model-desc", "price-asc", "price-desc", "ctx-asc", "ctx-desc", "modality-asc", "modality-desc",
		]);
		const wide = [...mixed, m("google-vertex-anthropic", "Claude Sonnet 4.5 Thinking", 15, 3, true, true)];
		assert.deepEqual(cycle({ kind: "all", visibleColumns: visibleColumnsOf(layoutTable(mixed, 40, true)) }), [
			"model-asc", "model-desc", "provider-asc", "provider-desc", "price-asc", "price-desc", "ctx-asc", "ctx-desc",
		]);
		assert.deepEqual(cycle({ kind: "all", visibleColumns: visibleColumnsOf(layoutTable(wide, 40, true)) }), [
			"model-asc", "model-desc", "provider-asc", "provider-desc",
		]);
	});

	it("never shows Model ▲ when default pins currentModel out of alphabetical order, and does when alphabetical", () => {
		const rows = [m("p", "Charlie"), m("p", "Bravo"), m("p", "Alpha")];
		assert.equal(pinsCurrentFirst(rows, { provider: "p", id: "charlie" }), true);
		assert.equal(pinsCurrentFirst(rows, { provider: "p", id: "alpha" }), false);
		assert.equal(pinsCurrentFirst(rows, { provider: "other", id: "charlie" }), false);

		assert.deepEqual(names(sortRows(rows, "default", "provider", { provider: "p", id: "charlie" })), ["Charlie", "Alpha", "Bravo"]);
		assert.equal(activeColumn("default", { kind: "provider", pinnedCurrent: true }), null);
		assert.deepEqual(activeColumn("default", { kind: "provider", pinnedCurrent: false }), { column: "model", arrow: "▲" });

		const saved = [mixed[4]!, mixed[0]!, mixed[3]!];
		assert.deepEqual(sortRows(saved, "default", "favorites"), saved);
		assert.equal(activeColumn("default", "favorites"), null);
		assert.deepEqual(activeColumn("default", "all"), { column: "model", arrow: "▲" });
	});

	it("dims sort arrows while searchRanked is true, but allows Ctrl+S to sort search matches with arrows", () => {
		for (const mode of SORT_MODES) {
			assert.equal(activeColumn(mode, { kind: "all", hasQuery: true, searchRanked: true }), null);
		}
		const first = nextSortState("price-desc", { kind: "all", hasQuery: true, searchRanked: true });
		assert.deepEqual(first, { mode: "model-asc", searchRanked: false });
		assert.deepEqual(activeColumn(first.mode, { kind: "all", hasQuery: true, searchRanked: first.searchRanked }), { column: "model", arrow: "▲" });
		const wrap = nextSortState("modality-desc", { kind: "all", hasQuery: true, searchRanked: false });
		assert.deepEqual(wrap, { mode: "default", searchRanked: true });
		assert.equal(activeColumn(wrap.mode, { kind: "all", hasQuery: true, searchRanked: wrap.searchRanked }), null);
	});

	it("windowStart keeps the selected row inside the 10-row window", () => {
		for (let selected = 0; selected < 26; selected++) {
			const start = windowStart(selected, 26, 10);
			assert.ok(start >= 0 && start <= 16 && selected >= start && selected < start + 10);
		}
	});
});
