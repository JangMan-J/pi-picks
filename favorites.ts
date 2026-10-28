/**
 * Favorites: the user's ordered, authoritative list of `provider/id` refs,
 * stored under `pi-picks.favorites` in settings.json.
 *
 * Stored refs are the source of truth. A model missing from the current
 * catalogue stays stored and only drops out of `resolve()`. Refs compare
 * case-insensitively; duplicates collapse to the first position.
 */

import { readFileSync, writeFileSync } from "node:fs";

interface ModelId {
	provider: string;
	id: string;
}

const SETTINGS_KEY = "pi-picks";

const refOf = (model: ModelId): string => `${model.provider}/${model.id}`;
const fold = (ref: string): string => ref.toLowerCase();

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Valid, non-empty, de-duplicated refs; the first spelling of each wins. */
function normalize(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const refs: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !entry || seen.has(fold(entry))) continue;
		seen.add(fold(entry));
		refs.push(entry);
	}
	return refs;
}

function readStored(path: string): string[] {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return isRecord(raw) && isRecord(raw[SETTINGS_KEY]) ? normalize(raw[SETTINGS_KEY].favorites) : [];
	} catch {
		return []; // Missing or malformed settings read as no favorites.
	}
}

export type SaveResult = { ok: true } | { ok: false; error: string };

/**
 * Write `refs` into settings.json, preserving every other setting. Refuses to
 * replace a file it cannot parse as a JSON object, so a typo in settings.json
 * is never turned into data loss.
 */
function save(path: string, refs: string[]): SaveResult {
	try {
		let raw: Record<string, unknown> = {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			if (!isRecord(parsed)) throw new Error("the file is not a JSON object");
			raw = parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const block = isRecord(raw[SETTINGS_KEY]) ? raw[SETTINGS_KEY] : {};
		raw[SETTINGS_KEY] = { ...block, favorites: refs };
		writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf-8");
		return { ok: true };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Could not save favorites to settings.json: ${reason}` };
	}
}

export class Favorites {
	private readonly path: string;
	private stored: string[];

	private constructor(path: string, stored: string[]) {
		this.path = path;
		this.stored = stored;
	}

	/** Read the current favorites from the settings file at `path`. */
	static open(path: string): Favorites {
		return new Favorites(path, readStored(path));
	}

	/** Stored refs in order, including those whose models are unavailable. */
	refs(): string[] {
		return [...this.stored];
	}

	has(model: ModelId): boolean {
		const ref = fold(refOf(model));
		return this.stored.some((r) => fold(r) === ref);
	}

	/** Apply `next` and persist it; on failure the previous refs stay in force. */
	private commit(next: string[]): SaveResult {
		const result = save(this.path, next);
		if (result.ok) this.stored = next;
		return result;
	}

	add(model: ModelId): SaveResult {
		return this.commit(normalize([...this.stored, refOf(model)]));
	}

	remove(model: ModelId): SaveResult {
		const ref = fold(refOf(model));
		return this.commit(this.stored.filter((r) => fold(r) !== ref));
	}

	/**
	 * Remove stored favorites, available or not: every one, or only those of
	 * `provider`. Does nothing, and writes nothing, when none match.
	 */
	clear(provider?: string): SaveResult {
		const prefix = provider === undefined ? undefined : `${fold(provider)}/`;
		const next = prefix === undefined ? [] : this.stored.filter((r) => !fold(r).startsWith(prefix));
		return next.length === this.stored.length ? { ok: true } : this.commit(next);
	}

	/** The favorites present in `catalog`, in stored order. */
	resolve<M extends ModelId>(catalog: readonly M[]): M[] {
		return this.stored.flatMap((ref) => {
			const match = catalog.find((m) => fold(refOf(m)) === fold(ref));
			return match ? [match] : [];
		});
	}
}
