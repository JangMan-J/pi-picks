import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Favorites } from "./favorites.ts";

const model = (provider: string, id: string) => ({ provider, id });

let dir: string;
let path: string;
const write = (value: unknown) => writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
const stored = () => JSON.parse(readFileSync(path, "utf-8"));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-picks-favorites-"));
	path = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reading", () => {
	it("starts empty when settings.json does not exist", () => {
		assert.deepEqual(Favorites.open(path).refs(), []);
	});

	it("reads stored refs in order", () => {
		write({ "pi-picks": { favorites: ["openai/gpt-4o", "anthropic/claude-sonnet"] } });
		assert.deepEqual(Favorites.open(path).refs(), ["openai/gpt-4o", "anthropic/claude-sonnet"]);
	});

	it("matches models case-insensitively", () => {
		write({ "pi-picks": { favorites: ["OpenAI/GPT-4o"] } });
		const favorites = Favorites.open(path);
		assert.equal(favorites.has(model("openai", "gpt-4o")), true);
		assert.equal(favorites.has(model("openai", "gpt-4o-mini")), false);
	});

	it("resolves only available models, in stored order, keeping unavailable refs stored", () => {
		write({ "pi-picks": { favorites: ["openai/gpt-4o", "anthropic/claude-sonnet", "xai/grok"] } });
		const favorites = Favorites.open(path);
		const catalog = [model("xai", "grok"), model("anthropic", "claude-sonnet")];
		assert.deepEqual(favorites.resolve(catalog), [model("anthropic", "claude-sonnet"), model("xai", "grok")]);
		assert.deepEqual(favorites.refs(), ["openai/gpt-4o", "anthropic/claude-sonnet", "xai/grok"]);
	});

	it("collapses case-variant duplicates to the first position without writing", () => {
		const raw = { "pi-picks": { favorites: ["openai/gpt-4o", "x/y", "OpenAI/GPT-4o"] } };
		write(raw);
		assert.deepEqual(Favorites.open(path).refs(), ["openai/gpt-4o", "x/y"]);
		assert.deepEqual(stored(), raw);
	});

	it("ignores a wrong-shaped favorites value and non-string or empty entries", () => {
		write({ "pi-picks": { favorites: "openai/gpt-4o" } });
		assert.deepEqual(Favorites.open(path).refs(), []);
		write({ "pi-picks": { favorites: ["a/b", 7, "", null] } });
		assert.deepEqual(Favorites.open(path).refs(), ["a/b"]);
	});

	it("reloads the file each time it is opened", () => {
		write({ "pi-picks": { favorites: ["a/b"] } });
		assert.deepEqual(Favorites.open(path).refs(), ["a/b"]);
		write({ "pi-picks": { favorites: ["c/d"] } });
		assert.deepEqual(Favorites.open(path).refs(), ["c/d"]);
	});

	it("reads as empty from a malformed file", () => {
		write("{ not json");
		assert.deepEqual(Favorites.open(path).refs(), []);
	});
});

describe("adding and removing", () => {
	it("adds a favorite, persists it, and preserves unrelated settings", () => {
		write({ theme: "dark", "pi-picks": { shortcut: "alt+m", favorites: ["a/b"] }, other: { keep: true } });
		const favorites = Favorites.open(path);
		assert.deepEqual(favorites.add(model("c", "d")), { ok: true });
		assert.deepEqual(favorites.refs(), ["a/b", "c/d"]);
		assert.deepEqual(stored(), {
			theme: "dark",
			"pi-picks": { shortcut: "alt+m", favorites: ["a/b", "c/d"] },
			other: { keep: true },
		});
	});

	it("creates settings.json when it does not exist", () => {
		assert.deepEqual(Favorites.open(path).add(model("a", "b")), { ok: true });
		assert.deepEqual(stored(), { "pi-picks": { favorites: ["a/b"] } });
	});

	it("does not add a case-variant duplicate", () => {
		write({ "pi-picks": { favorites: ["OpenAI/GPT-4o"] } });
		const favorites = Favorites.open(path);
		assert.deepEqual(favorites.add(model("openai", "gpt-4o")), { ok: true });
		assert.deepEqual(favorites.refs(), ["OpenAI/GPT-4o"]);
	});

	it("removes a favorite by case-insensitive identity", () => {
		write({ "pi-picks": { favorites: ["a/b", "OpenAI/GPT-4o", "c/d"] } });
		const favorites = Favorites.open(path);
		assert.deepEqual(favorites.remove(model("openai", "gpt-4o")), { ok: true });
		assert.deepEqual(favorites.refs(), ["a/b", "c/d"]);
		assert.deepEqual(stored(), { "pi-picks": { favorites: ["a/b", "c/d"] } });
	});

	it("writes a normalized list on the next successful save", () => {
		write({ "pi-picks": { favorites: ["a/b", 7, "", "A/B"] } });
		const favorites = Favorites.open(path);
		favorites.add(model("c", "d"));
		assert.deepEqual(stored(), { "pi-picks": { favorites: ["a/b", "c/d"] } });
	});
});

describe("a failed save", () => {
	it("leaves a malformed settings.json untouched, rolls back, and reports the error", () => {
		write("{ not json");
		const favorites = Favorites.open(path);
		const result = favorites.add(model("a", "b"));
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /settings\.json/);
		assert.deepEqual(favorites.refs(), []);
		assert.equal(readFileSync(path, "utf-8"), "{ not json");
	});

	it("refuses to overwrite a settings file whose root is not an object", () => {
		write("[1, 2]");
		const favorites = Favorites.open(path);
		assert.equal(favorites.add(model("a", "b")).ok, false);
		assert.equal(readFileSync(path, "utf-8"), "[1, 2]");
	});

	it("rolls back a removal when the file cannot be written", () => {
		write({ "pi-picks": { favorites: ["a/b"] } });
		const favorites = Favorites.open(path);
		rmSync(path);
		mkdirSync(path); // a directory where the file was: reading and writing both fail
		const result = favorites.remove(model("a", "b"));
		assert.equal(result.ok, false);
		assert.deepEqual(favorites.refs(), ["a/b"]);
	});
});

describe("clearing", () => {
	const seed = { "pi-picks": { favorites: ["anthropic/claude-sonnet", "openai/gpt-4o", "Anthropic/old-model"] } };

	it("clears every stored favorite, including unavailable ones", () => {
		write(seed);
		const favorites = Favorites.open(path);
		assert.deepEqual(favorites.clear(), { ok: true });
		assert.deepEqual(favorites.refs(), []);
		assert.deepEqual(stored(), { "pi-picks": { favorites: [] } });
	});

	it("clears one provider's stored favorites, available or not, case-insensitively", () => {
		write(seed);
		const favorites = Favorites.open(path);
		assert.deepEqual(favorites.clear("anthropic"), { ok: true });
		assert.deepEqual(favorites.refs(), ["openai/gpt-4o"]);
		assert.deepEqual(stored(), { "pi-picks": { favorites: ["openai/gpt-4o"] } });
	});

	it("treats a provider that is a prefix of another as a different provider", () => {
		write({ "pi-picks": { favorites: ["open/x", "openai/gpt-4o"] } });
		const favorites = Favorites.open(path);
		favorites.clear("open");
		assert.deepEqual(favorites.refs(), ["openai/gpt-4o"]);
	});

	it("does not touch the file when nothing matches", () => {
		write("{ not json");
		const favorites = Favorites.open(path);
		assert.deepEqual(favorites.clear("anthropic"), { ok: true });
		assert.equal(readFileSync(path, "utf-8"), "{ not json");
	});

	it("rolls back when the clear cannot be saved", () => {
		write(seed);
		const favorites = Favorites.open(path);
		rmSync(path);
		mkdirSync(path);
		assert.equal(favorites.clear().ok, false);
		assert.deepEqual(favorites.refs(), ["anthropic/claude-sonnet", "openai/gpt-4o", "Anthropic/old-model"]);
	});
});
