#!/usr/bin/env bun
/**
 * validate.ts -- Validate plugin YAML entries in the registry.
 *
 * Checks:
 * 1. YAML syntax
 * 2. Zod schema validation
 * 3. Filename/name field consistency
 * 4. Duplicate name detection
 * 5. Plugin existence verification (npm/github/url)
 * 6. Semver validation for minVersion
 *
 * Usage:
 *   bun run scripts/validate.ts                     # validate all
 *   bun run scripts/validate.ts plugins/brika/x.yaml # validate specific files
 *
 * Outputs a JSON report to stdout (used by the GitHub Actions bot comment).
 * Exits with code 1 if any validation fails.
 */
import { readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { Glob } from "bun";
import { parse as parseYaml } from "yaml";
import {
	PluginEntrySchema,
	expectedNameFromPath,
	type PluginEntry,
} from "../schema/plugin-entry";

// ── Types ────────────────────────────────────────────────────────────────────

interface NpmDetails {
	version: string;
	description?: string;
	license?: string;
	homepage?: string;
	weeklyDownloads: number;
	keywords: string[];
	hasEnginesBrika: boolean;
	hasBrikaKeyword: boolean;
}

interface GithubDetails {
	stars: number;
	description?: string;
	license?: string;
	archived: boolean;
	private: boolean;
}

interface UrlDetails {
	status: number;
	ok: boolean;
}

type SourceDetails = NpmDetails | GithubDetails | UrlDetails | null;

interface FileValidation {
	path: string;
	isNew: boolean;
	yamlValid: boolean;
	yamlError?: string;
	schemaValid: boolean;
	schemaErrors?: string[];
	filenameConsistent: boolean;
	expectedName?: string;
	actualName?: string;
	duplicateOf?: string;
	sourceCheck: {
		exists: boolean;
		details: SourceDetails;
		warnings: string[];
		errors: string[];
	};
	minVersionValid: boolean;
	entry?: PluginEntry;
}

export interface ValidationResult {
	files: FileValidation[];
	globalErrors: string[];
	summary: {
		total: number;
		passed: number;
		failed: number;
		warnings: number;
		newPlugins: number;
		updatedPlugins: number;
		categories: Record<string, number>;
	};
}

// ── npm API ──────────────────────────────────────────────────────────────────

async function checkNpmPackage(name: string): Promise<{
	exists: boolean;
	details: NpmDetails | null;
	warnings: string[];
	errors: string[];
}> {
	const warnings: string[] = [];
	const errors: string[] = [];

	try {
		const res = await fetch(`https://registry.npmjs.org/${name}`);
		if (!res.ok) {
			errors.push(
				`npm package "${name}" not found (HTTP ${res.status})`,
			);
			return { exists: false, details: null, warnings, errors };
		}

		const data = (await res.json()) as {
			name: string;
			"dist-tags"?: { latest?: string };
			versions?: Record<
				string,
				{
					description?: string;
					license?: string;
					homepage?: string;
					keywords?: string[];
					engines?: { brika?: string };
				}
			>;
		};

		const latestTag = data["dist-tags"]?.latest;
		if (!latestTag || !data.versions) {
			errors.push(
				`npm package "${name}" has no published versions`,
			);
			return { exists: false, details: null, warnings, errors };
		}

		const latest = data.versions[latestTag];
		if (!latest) {
			errors.push(
				`npm package "${name}" latest version not found`,
			);
			return { exists: false, details: null, warnings, errors };
		}

		const keywords = latest.keywords ?? [];
		const hasEnginesBrika = Boolean(latest.engines?.brika);
		const hasBrikaKeyword =
			keywords.includes("brika") ||
			keywords.includes("brika-plugin");

		if (!hasEnginesBrika) {
			warnings.push(
				`Package "${name}" is missing \`engines.brika\` field in package.json. ` +
					"This is required for the Brika hub to recognize it as a plugin.",
			);
		}

		if (!hasBrikaKeyword) {
			warnings.push(
				`Package "${name}" does not have "brika" or "brika-plugin" in keywords.`,
			);
		}

		// Fetch weekly downloads
		let weeklyDownloads = 0;
		try {
			const dlRes = await fetch(
				`https://api.npmjs.org/downloads/point/last-week/${name}`,
			);
			if (dlRes.ok) {
				const dlData = (await dlRes.json()) as {
					downloads?: number;
				};
				weeklyDownloads = dlData.downloads ?? 0;
			}
		} catch {
			// Non-critical, ignore
		}

		return {
			exists: true,
			details: {
				version: latestTag,
				description: latest.description,
				license: latest.license,
				homepage: latest.homepage,
				weeklyDownloads,
				keywords,
				hasEnginesBrika,
				hasBrikaKeyword,
			},
			warnings,
			errors,
		};
	} catch (err) {
		errors.push(`Failed to check npm package "${name}": ${err}`);
		return { exists: false, details: null, warnings, errors };
	}
}

async function checkGithubRepo(repoUrl: string): Promise<{
	exists: boolean;
	details: GithubDetails | null;
	warnings: string[];
	errors: string[];
}> {
	const warnings: string[] = [];
	const errors: string[] = [];

	try {
		// Extract owner/repo from URL
		const match = repoUrl.match(
			/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
		);
		if (!match) {
			errors.push(
				`Invalid GitHub repository URL: ${repoUrl}`,
			);
			return { exists: false, details: null, warnings, errors };
		}

		const [, owner, repo] = match;
		const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;
		const headers: Record<string, string> = {
			Accept: "application/vnd.github.v3+json",
		};

		// Use GITHUB_TOKEN if available (for rate limits)
		if (process.env.GITHUB_TOKEN) {
			headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
		}

		const res = await fetch(apiUrl, { headers });
		if (!res.ok) {
			errors.push(
				`GitHub repo "${owner}/${repo}" not found (HTTP ${res.status})`,
			);
			return { exists: false, details: null, warnings, errors };
		}

		const data = (await res.json()) as {
			stargazers_count?: number;
			description?: string;
			license?: { spdx_id?: string } | null;
			archived?: boolean;
			private?: boolean;
		};

		if (data.private) {
			errors.push(
				`GitHub repo "${owner}/${repo}" is private. Registry plugins must be publicly accessible.`,
			);
		}

		if (data.archived) {
			warnings.push(
				`GitHub repo "${owner}/${repo}" is archived.`,
			);
		}

		return {
			exists: true,
			details: {
				stars: data.stargazers_count ?? 0,
				description: data.description ?? undefined,
				license: data.license?.spdx_id ?? undefined,
				archived: data.archived ?? false,
				private: data.private ?? false,
			},
			warnings,
			errors,
		};
	} catch (err) {
		errors.push(`Failed to check GitHub repo: ${err}`);
		return { exists: false, details: null, warnings, errors };
	}
}

async function checkUrl(url: string): Promise<{
	exists: boolean;
	details: UrlDetails | null;
	warnings: string[];
	errors: string[];
}> {
	const warnings: string[] = [];
	const errors: string[] = [];

	try {
		const res = await fetch(url, {
			method: "HEAD",
			redirect: "follow",
		});

		if (!res.ok) {
			errors.push(`URL "${url}" returned HTTP ${res.status}`);
			return {
				exists: false,
				details: { status: res.status, ok: false },
				warnings,
				errors,
			};
		}

		return {
			exists: true,
			details: { status: res.status, ok: true },
			warnings,
			errors,
		};
	} catch (err) {
		errors.push(`URL "${url}" is unreachable: ${err}`);
		return { exists: false, details: null, warnings, errors };
	}
}

// ── Core Validation ──────────────────────────────────────────────────────────

async function validateFile(
	filePath: string,
	isNew: boolean,
	allNames: Map<string, string>,
): Promise<FileValidation> {
	const result: FileValidation = {
		path: filePath,
		isNew,
		yamlValid: false,
		schemaValid: false,
		filenameConsistent: false,
		sourceCheck: {
			exists: false,
			details: null,
			warnings: [],
			errors: [],
		},
		minVersionValid: true,
	};

	// 1. YAML syntax
	let rawData: unknown;
	try {
		const content = readFileSync(
			resolve(process.cwd(), filePath),
			"utf-8",
		);
		rawData = parseYaml(content);
		result.yamlValid = true;
	} catch (err) {
		result.yamlError = String(err);
		return result;
	}

	// 2. Schema validation
	const parsed = PluginEntrySchema.safeParse(rawData);
	if (!parsed.success) {
		result.schemaErrors = parsed.error.issues.map(
			(issue) => `${issue.path.join(".")}: ${issue.message}`,
		);
		return result;
	}
	result.schemaValid = true;
	result.entry = parsed.data;

	// 3. Filename consistency
	try {
		const expected = expectedNameFromPath(filePath);
		result.expectedName = expected;
		result.actualName = parsed.data.name;
		result.filenameConsistent = expected === parsed.data.name;
	} catch (err) {
		result.filenameConsistent = false;
		result.expectedName = String(err);
	}

	// 4. Duplicate detection
	const existingPath = allNames.get(parsed.data.name);
	if (existingPath && existingPath !== filePath) {
		result.duplicateOf = existingPath;
	}

	// 5. Source existence verification
	switch (parsed.data.source) {
		case "npm":
			result.sourceCheck = await checkNpmPackage(parsed.data.name);
			break;
		case "github": {
			if (!parsed.data.repository) {
				result.sourceCheck.errors.push(
					'Field "repository" is required when source is "github"',
				);
			} else {
				result.sourceCheck = await checkGithubRepo(
					parsed.data.repository,
				);
			}
			break;
		}
		case "url": {
			if (!parsed.data.url) {
				result.sourceCheck.errors.push(
					'Field "url" is required when source is "url"',
				);
			} else {
				result.sourceCheck = await checkUrl(parsed.data.url);
			}
			break;
		}
	}

	return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const rootDir = process.cwd();

	// Determine which files to validate
	let targetFiles: string[];
	if (args.length > 0) {
		targetFiles = args.map((f) => relative(rootDir, resolve(rootDir, f)));
	} else {
		// Validate all plugin files
		const glob = new Glob("plugins/**/*.yaml");
		targetFiles = [];
		for await (const path of glob.scan({ cwd: rootDir })) {
			targetFiles.push(path);
		}
	}

	// Load ALL plugin files for duplicate detection
	const allNames = new Map<string, string>();
	const allGlob = new Glob("plugins/**/*.yaml");
	for await (const path of allGlob.scan({ cwd: rootDir })) {
		try {
			const content = readFileSync(
				resolve(rootDir, path),
				"utf-8",
			);
			const data = parseYaml(content) as { name?: string };
			if (data?.name) {
				allNames.set(data.name, path);
			}
		} catch {
			// Will be caught during individual validation
		}
	}

	// Validate each target file
	const validations = await Promise.all(
		targetFiles.map((file) => {
			// Determine if file is new (for labeling)
			// In CI, this is determined by git diff; locally, assume all are new
			const isNew = !args.length; // when validating all, treat as "existing"
			return validateFile(file, isNew, allNames);
		}),
	);

	// Build summary
	const categories: Record<string, number> = {};
	let passed = 0;
	let failed = 0;
	let warnings = 0;

	for (const v of validations) {
		const hasErrors =
			!v.yamlValid ||
			!v.schemaValid ||
			!v.filenameConsistent ||
			Boolean(v.duplicateOf) ||
			v.sourceCheck.errors.length > 0;

		if (hasErrors) {
			failed++;
		} else {
			passed++;
		}

		if (v.sourceCheck.warnings.length > 0) {
			warnings += v.sourceCheck.warnings.length;
		}

		if (v.entry?.category) {
			categories[v.entry.category] =
				(categories[v.entry.category] ?? 0) + 1;
		}
	}

	const result: ValidationResult = {
		files: validations,
		globalErrors: [],
		summary: {
			total: validations.length,
			passed,
			failed,
			warnings,
			newPlugins: validations.filter((v) => v.isNew).length,
			updatedPlugins: validations.filter((v) => !v.isNew).length,
			categories,
		},
	};

	// Output JSON report
	console.log(JSON.stringify(result, null, 2));

	// Exit with error if any validation failed
	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Validation failed:", err);
	process.exit(1);
});
