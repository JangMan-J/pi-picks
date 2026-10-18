#!/usr/bin/env node
// Release gate run by CI (`npm run check`): source parses, the changelog covers
// the version, the tarball holds exactly package.json "files", and the
// installer copies every packed file.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const shipped = ["package.json", ...pkg.files].sort();

const run = (cmd, args, env = process.env) =>
	execFileSync(cmd, args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let failures = 0;
function check(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL ${name}\n     ${String(error.stderr || error.message).trim().replace(/\n/g, "\n     ")}`);
	}
}

check("index.ts parses (Node type stripping)", () => {
	run(process.execPath, ["--check", "index.ts"]);
});

check(`CHANGELOG.md has a "## ${pkg.version}" section`, () => {
	const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
	const heading = `## ${pkg.version}`;
	const found = changelog.split("\n").some((line) => line === heading || line.startsWith(`${heading} `));
	if (!found) throw new Error(`rename "## Unreleased" to "${heading} — <date>" when bumping the version`);
});

check("npm pack ships exactly package.json files", () => {
	const [info] = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]));
	const packed = info.files.map((f) => f.path).sort();
	const missing = shipped.filter((f) => !packed.includes(f));
	const extra = packed.filter((f) => !shipped.includes(f));
	if (missing.length || extra.length) throw new Error(`missing: [${missing}] extra: [${extra}]`);
});

check("installer copies every shipped file", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-picks-check-"));
	try {
		run(process.execPath, ["scripts/install.js"], { ...process.env, PI_CODING_AGENT_DIR: agentDir });
		const missing = shipped.filter((f) => !existsSync(join(agentDir, "extensions", pkg.name, f)));
		if (missing.length) throw new Error(`not installed: [${missing}]`);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

process.exit(failures ? 1 : 0);
