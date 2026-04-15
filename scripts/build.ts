#!/usr/bin/env bun
/**
 * build.ts -- Compile plugin YAML files into verified-plugins.json
 *
 * Reads all plugins/**\/*.yaml, validates, sorts alphabetically,
 * preserves verifiedAt for unchanged entries (by comparing against the
 * live registry), and outputs dist/verified-plugins.json.
 *
 * The output is unsigned -- run scripts/sign.ts afterward to sign it.
 *
 * Usage:
 *   bun run scripts/build.ts
 *
 * Environment:
 *   BRIKA_REGISTRY -- base URL of the live registry (default: https://registry.brika.dev)
 */
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "@brika/registry";
import type { VerifiedPlugin, VerifiedPluginsList } from "@brika/registry";
import { Glob } from "bun";
import { parse as parseYaml } from "yaml";
import { PluginEntrySchema } from "../schema/plugin-entry";

const REGISTRY_URL =
	process.env.BRIKA_REGISTRY ?? "https://registry.brika.dev";
const ROOT_DIR = resolve(import.meta.dir, "..");
const OUTPUT_PATH = resolve(ROOT_DIR, "dist", "verified-plugins.json");

/**
 * Fetch the current live registry as baseline for verifiedAt stability.
 * Returns null if unavailable (first build or offline).
 */
async function fetchBaseline(): Promise<Map<string, VerifiedPlugin> | null> {
	try {
		const res = await fetch(
			`${REGISTRY_URL}/verified-plugins.json`,
			{
				headers: { Accept: "application/json" },
			},
		);
		if (!res.ok) return null;

		const data = (await res.json()) as VerifiedPluginsList;
		const map = new Map<string, VerifiedPlugin>();
		for (const plugin of data.plugins) {
			map.set(plugin.name, plugin);
		}
		return map;
	} catch {
		console.warn(
			"Could not fetch baseline registry, all entries will get fresh verifiedAt",
		);
		return null;
	}
}

/**
 * Check if plugin content changed compared to the baseline.
 * Compares all contributor-authored fields (ignores verifiedAt, signature).
 */
function pluginContentChanged(
	current: {
		name: string;
		description: string;
		tags: string[];
		category: string;
		source: string;
		featured: boolean;
		verifiedBy: string;
		minVersion?: string;
	},
	baseline: VerifiedPlugin,
): boolean {
	const currentPayload = canonicalize({
		name: current.name,
		description: current.description,
		tags: current.tags,
		category: current.category,
		source: current.source,
		featured: current.featured,
		verifiedBy: current.verifiedBy,
		...(current.minVersion ? { minVersion: current.minVersion } : {}),
	});
	const baselinePayload = canonicalize({
		name: baseline.name,
		description: baseline.description ?? "",
		tags: baseline.tags ?? [],
		category: baseline.category ?? "community",
		source: baseline.source ?? "npm",
		featured: baseline.featured ?? false,
		verifiedBy: baseline.verifiedBy,
		...(baseline.minVersion ? { minVersion: baseline.minVersion } : {}),
	});
	return currentPayload !== baselinePayload;
}

async function main(): Promise<void> {
	console.log("Building registry...");

	// 1. Load baseline for verifiedAt stability
	const baseline = await fetchBaseline();
	if (baseline) {
		console.log(
			`Baseline loaded: ${baseline.size} existing plugins`,
		);
	}

	// 2. Glob all plugin YAML files
	const glob = new Glob("plugins/**/*.yaml");
	const files: string[] = [];
	for await (const path of glob.scan({ cwd: ROOT_DIR })) {
		files.push(path);
	}
	console.log(`Found ${files.length} plugin files`);

	// 3. Parse and validate each file
	const now = new Date().toISOString();
	const plugins: VerifiedPlugin[] = [];

	for (const file of files) {
		const content = readFileSync(resolve(ROOT_DIR, file), "utf-8");
		const raw = parseYaml(content);
		const parsed = PluginEntrySchema.safeParse(raw);

		if (!parsed.success) {
			console.error(
				`Validation failed for ${file}:`,
				parsed.error.issues,
			);
			process.exit(1);
		}

		const entry = parsed.data;
		const existing = baseline?.get(entry.name);

		// Determine verifiedAt: preserve if content unchanged, else now
		let verifiedAt: string;
		if (existing && !pluginContentChanged(entry, existing)) {
			verifiedAt = existing.verifiedAt;
		} else {
			verifiedAt = now;
			if (existing) {
				console.log(`  Updated: ${entry.name}`);
			} else {
				console.log(`  New: ${entry.name}`);
			}
		}

		plugins.push({
			name: entry.name,
			verifiedAt,
			verifiedBy: entry.verifiedBy,
			description: entry.description,
			tags: entry.tags,
			featured: entry.featured,
			category: entry.category,
			source: entry.source,
			...(entry.minVersion ? { minVersion: entry.minVersion } : {}),
		});
	}

	// 4. Sort alphabetically by name (deterministic output)
	plugins.sort((a, b) => a.name.localeCompare(b.name));

	// 5. Assemble registry document (unsigned)
	const registry: VerifiedPluginsList = {
		version: "2.0.0",
		lastUpdated: now,
		plugins,
	};

	// 6. Write output
	mkdirSync(resolve(ROOT_DIR, "dist"), { recursive: true });
	Bun.write(OUTPUT_PATH, JSON.stringify(registry, null, 2));

	console.log(
		`\nBuilt ${plugins.length} plugins -> dist/verified-plugins.json`,
	);
	console.log(
		"Run `bun run sign` to sign the registry before deploying.",
	);
}

main().catch((err) => {
	console.error("Build failed:", err);
	process.exit(1);
});
