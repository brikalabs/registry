#!/usr/bin/env bun
/**
 * stale-check.ts -- Check that all registered plugins still exist.
 *
 * Runs as a scheduled GitHub Action (weekly). For each plugin:
 * - npm: checks if the package is still published
 * - github: checks if the repo still exists and isn't archived
 * - url: checks if the URL is still reachable
 *
 * Outputs a JSON report. In CI, the workflow uses this to open issues
 * for stale plugins.
 *
 * Usage:
 *   bun run scripts/stale-check.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";
import { parse as parseYaml } from "yaml";
import { PluginEntrySchema, type PluginEntry } from "../schema/plugin-entry";

interface StaleResult {
	name: string;
	source: string;
	status: "ok" | "stale" | "error";
	reason?: string;
}

export interface StaleCheckReport {
	checkedAt: string;
	total: number;
	stale: StaleResult[];
	ok: StaleResult[];
	errors: StaleResult[];
}

async function checkNpm(name: string): Promise<StaleResult> {
	try {
		const res = await fetch(`https://registry.npmjs.org/${name}`);
		if (res.status === 404) {
			return {
				name,
				source: "npm",
				status: "stale",
				reason: "Package not found on npm (404)",
			};
		}
		if (!res.ok) {
			return {
				name,
				source: "npm",
				status: "error",
				reason: `npm returned HTTP ${res.status}`,
			};
		}

		const data = (await res.json()) as {
			"dist-tags"?: { latest?: string };
			time?: Record<string, string>;
		};

		// Check if package was unpublished (no dist-tags)
		if (!data["dist-tags"]?.latest) {
			return {
				name,
				source: "npm",
				status: "stale",
				reason: "Package has no published versions (possibly unpublished)",
			};
		}

		return { name, source: "npm", status: "ok" };
	} catch (err) {
		return {
			name,
			source: "npm",
			status: "error",
			reason: `Failed to check: ${err}`,
		};
	}
}

async function checkGithub(
	name: string,
	repoUrl: string,
): Promise<StaleResult> {
	try {
		const match = repoUrl.match(
			/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
		);
		if (!match) {
			return {
				name,
				source: "github",
				status: "error",
				reason: `Invalid repository URL: ${repoUrl}`,
			};
		}

		const [, owner, repo] = match;
		const headers: Record<string, string> = {
			Accept: "application/vnd.github.v3+json",
		};
		if (process.env.GITHUB_TOKEN) {
			headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
		}

		const res = await fetch(
			`https://api.github.com/repos/${owner}/${repo}`,
			{ headers },
		);

		if (res.status === 404) {
			return {
				name,
				source: "github",
				status: "stale",
				reason: `Repository ${owner}/${repo} not found`,
			};
		}

		if (!res.ok) {
			return {
				name,
				source: "github",
				status: "error",
				reason: `GitHub returned HTTP ${res.status}`,
			};
		}

		const data = (await res.json()) as {
			archived?: boolean;
			disabled?: boolean;
		};

		if (data.archived) {
			return {
				name,
				source: "github",
				status: "stale",
				reason: `Repository ${owner}/${repo} is archived`,
			};
		}

		if (data.disabled) {
			return {
				name,
				source: "github",
				status: "stale",
				reason: `Repository ${owner}/${repo} is disabled`,
			};
		}

		return { name, source: "github", status: "ok" };
	} catch (err) {
		return {
			name,
			source: "github",
			status: "error",
			reason: `Failed to check: ${err}`,
		};
	}
}

async function checkUrl(
	name: string,
	url: string,
): Promise<StaleResult> {
	try {
		const res = await fetch(url, {
			method: "HEAD",
			redirect: "follow",
		});
		if (!res.ok) {
			return {
				name,
				source: "url",
				status: "stale",
				reason: `URL returned HTTP ${res.status}`,
			};
		}
		return { name, source: "url", status: "ok" };
	} catch (err) {
		return {
			name,
			source: "url",
			status: "stale",
			reason: `URL unreachable: ${err}`,
		};
	}
}

async function main(): Promise<void> {
	const rootDir = process.cwd();

	// Load all plugin files
	const glob = new Glob("plugins/**/*.yaml");
	const entries: PluginEntry[] = [];

	for await (const path of glob.scan({ cwd: rootDir })) {
		const content = readFileSync(
			resolve(rootDir, path),
			"utf-8",
		);
		const raw = parseYaml(content);
		const parsed = PluginEntrySchema.safeParse(raw);
		if (parsed.success) {
			entries.push(parsed.data);
		}
	}

	console.log(`Checking ${entries.length} plugins...\n`);

	// Check each plugin in parallel (batched to avoid rate limits)
	const BATCH_SIZE = 5;
	const results: StaleResult[] = [];

	for (let i = 0; i < entries.length; i += BATCH_SIZE) {
		const batch = entries.slice(i, i + BATCH_SIZE);
		const batchResults = await Promise.all(
			batch.map((entry) => {
				switch (entry.source) {
					case "npm":
						return checkNpm(entry.name);
					case "github":
						return checkGithub(
							entry.name,
							entry.repository ?? "",
						);
					case "url":
						return checkUrl(
							entry.name,
							entry.url ?? "",
						);
					default:
						return Promise.resolve({
							name: entry.name,
							source: entry.source,
							status: "error" as const,
							reason: `Unknown source: ${entry.source}`,
						});
				}
			}),
		);
		results.push(...batchResults);
	}

	// Build report
	const report: StaleCheckReport = {
		checkedAt: new Date().toISOString(),
		total: results.length,
		stale: results.filter((r) => r.status === "stale"),
		ok: results.filter((r) => r.status === "ok"),
		errors: results.filter((r) => r.status === "error"),
	};

	// Print summary
	for (const r of results) {
		const icon =
			r.status === "ok"
				? "OK"
				: r.status === "stale"
					? "STALE"
					: "ERROR";
		const suffix = r.reason ? ` -- ${r.reason}` : "";
		console.log(`  ${icon.padEnd(6)} ${r.name}${suffix}`);
	}

	console.log(
		`\n${report.ok.length} ok, ${report.stale.length} stale, ${report.errors.length} errors`,
	);

	// Output JSON report for CI
	console.log("\n---JSON_REPORT_START---");
	console.log(JSON.stringify(report, null, 2));
	console.log("---JSON_REPORT_END---");

	if (report.stale.length > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Stale check failed:", err);
	process.exit(1);
});
