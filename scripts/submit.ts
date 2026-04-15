#!/usr/bin/env bun
/**
 * submit.ts -- Submit a plugin for verification via automated PR.
 *
 * Fetches package metadata from npm, generates the YAML entry,
 * creates a branch, commits, and opens a PR on brikalabs/registry.
 *
 * Requires: `gh` CLI authenticated with GitHub.
 *
 * Usage:
 *   bun run submit                        # interactive
 *   bun run submit @brika/plugin-spotify   # direct
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { stringify as yamlStringify } from "yaml";
import {
	PluginCategory,
	PluginEntrySchema,
	pathFromName,
} from "../schema/plugin-entry";

const ROOT_DIR = resolve(import.meta.dir, "..");
const REPO = "brikalabs/registry";

// ── npm API ──────────────────────────────────────────────────────────────────

interface NpmPackageInfo {
	name: string;
	version: string;
	description?: string;
	keywords?: string[];
	license?: string;
	homepage?: string;
	hasEnginesBrika: boolean;
	enginesBrika?: string;
}

async function fetchNpmPackage(
	name: string,
): Promise<NpmPackageInfo | null> {
	try {
		const res = await fetch(`https://registry.npmjs.org/${name}`);
		if (!res.ok) return null;

		const data = (await res.json()) as {
			name: string;
			"dist-tags"?: { latest?: string };
			versions?: Record<
				string,
				{
					description?: string;
					keywords?: string[];
					license?: string;
					homepage?: string;
					engines?: { brika?: string };
				}
			>;
		};

		const latestTag = data["dist-tags"]?.latest;
		if (!latestTag || !data.versions) return null;

		const latest = data.versions[latestTag];
		if (!latest) return null;

		return {
			name: data.name,
			version: latestTag,
			description: latest.description,
			keywords: latest.keywords,
			license: latest.license,
			homepage: latest.homepage,
			hasEnginesBrika: Boolean(latest.engines?.brika),
			enginesBrika: latest.engines?.brika,
		};
	} catch {
		return null;
	}
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function exec(cmd: string): string {
	return execSync(cmd, { cwd: ROOT_DIR, encoding: "utf-8" }).trim();
}

function execSafe(cmd: string): string | null {
	try {
		return exec(cmd);
	} catch {
		return null;
	}
}

function ghAvailable(): boolean {
	return execSafe("gh --version") !== null;
}

function ghAuthenticated(): boolean {
	return execSafe("gh auth status") !== null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	p.intro(pc.cyan("Brika Plugin Registry -- Submit for Verification"));

	// Check prerequisites
	if (!ghAvailable()) {
		p.log.error(
			"GitHub CLI (gh) is required. Install it: https://cli.github.com",
		);
		process.exit(1);
	}

	if (!ghAuthenticated()) {
		p.log.error(
			"GitHub CLI is not authenticated. Run: gh auth login",
		);
		process.exit(1);
	}

	// Get package name
	const args = process.argv.slice(2);
	let packageName: string;

	if (args[0]) {
		packageName = args[0];
	} else {
		// Try reading from CWD's package.json
		const cwdPkg = resolve(process.cwd(), "package.json");
		let suggestion: string | undefined;
		if (existsSync(cwdPkg)) {
			try {
				const pkg = JSON.parse(readFileSync(cwdPkg, "utf-8"));
				suggestion = pkg.name;
			} catch {
				// ignore
			}
		}

		const input = await p.text({
			message: "npm package name",
			placeholder: suggestion ?? "@scope/plugin-name",
			initialValue: suggestion,
			validate: (v) => {
				if (!v.trim()) return "Package name is required";
				return undefined;
			},
		});

		if (p.isCancel(input)) {
			p.cancel("Cancelled");
			process.exit(0);
		}
		packageName = input;
	}

	// Check if already registered
	const yamlPath = pathFromName(packageName);
	const fullYamlPath = resolve(ROOT_DIR, yamlPath);
	if (existsSync(fullYamlPath)) {
		p.log.warn(
			`${packageName} is already registered at ${yamlPath}`,
		);
		const update = await p.confirm({
			message: "Do you want to update the existing entry?",
		});
		if (p.isCancel(update) || !update) {
			p.cancel("Cancelled");
			process.exit(0);
		}
	}

	// Fetch from npm
	const spinner = p.spinner();
	spinner.start(`Fetching ${packageName} from npm...`);
	const npmInfo = await fetchNpmPackage(packageName);

	if (!npmInfo) {
		spinner.stop(`Package not found on npm`, 2);
		p.log.error(
			`Could not find "${packageName}" on npm. Make sure it is published.`,
		);
		process.exit(1);
	}

	spinner.stop(`Found ${packageName}@${npmInfo.version}`);

	// Show warnings
	if (!npmInfo.hasEnginesBrika) {
		p.log.warn(
			`Package is missing "engines.brika" in package.json. ` +
				"This is required for the Brika hub to recognize it as a plugin.",
		);
	}

	const hasBrikaKeyword =
		npmInfo.keywords?.includes("brika") ||
		npmInfo.keywords?.includes("brika-plugin");
	if (!hasBrikaKeyword) {
		p.log.warn(
			`Package does not have "brika" or "brika-plugin" in keywords.`,
		);
	}

	// Show what we found
	p.log.info(
		[
			`${pc.bold("Package info:")}`,
			`  Name:        ${npmInfo.name}`,
			`  Version:     ${npmInfo.version}`,
			`  Description: ${npmInfo.description ?? pc.dim("none")}`,
			`  License:     ${npmInfo.license ?? pc.dim("none")}`,
			`  Keywords:    ${npmInfo.keywords?.join(", ") ?? pc.dim("none")}`,
			`  engines.brika: ${npmInfo.enginesBrika ?? pc.dim("missing")}`,
		].join("\n"),
	);

	// Collect additional metadata
	const description = await p.text({
		message: "Description",
		initialValue: npmInfo.description ?? "",
		validate: (v) => {
			if (!v.trim()) return "Description is required";
			return undefined;
		},
	});
	if (p.isCancel(description)) {
		p.cancel("Cancelled");
		process.exit(0);
	}

	const tagsInput = await p.text({
		message: "Tags (comma-separated)",
		initialValue:
			npmInfo.keywords
				?.filter(
					(k) => k !== "brika" && k !== "brika-plugin",
				)
				.join(", ") ?? "",
		placeholder: "dashboard, widgets, integration",
	});
	if (p.isCancel(tagsInput)) {
		p.cancel("Cancelled");
		process.exit(0);
	}

	const category = await p.select({
		message: "Category",
		options: PluginCategory.options.map((c) => ({
			value: c,
			label: c,
		})),
		initialValue: "community" as const,
	});
	if (p.isCancel(category)) {
		p.cancel("Cancelled");
		process.exit(0);
	}

	const verifiedBy = await p.text({
		message: "Verified by",
		initialValue: "community",
		placeholder: "community",
	});
	if (p.isCancel(verifiedBy)) {
		p.cancel("Cancelled");
		process.exit(0);
	}

	const minVersion = await p.text({
		message: "Minimum Brika version (optional)",
		initialValue: npmInfo.enginesBrika?.replace(/[^0-9.]/g, "") ?? "",
		placeholder: "0.3.0",
	});
	if (p.isCancel(minVersion)) {
		p.cancel("Cancelled");
		process.exit(0);
	}

	// Build the YAML entry
	const tags = tagsInput
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	const entry: Record<string, unknown> = {
		name: packageName,
		description,
		tags,
		category,
		source: "npm",
		featured: false,
		verifiedBy,
	};

	if (minVersion.trim()) {
		entry.minVersion = minVersion.trim();
	}

	// Validate
	const parsed = PluginEntrySchema.safeParse(entry);
	if (!parsed.success) {
		p.log.error("Validation failed:");
		for (const issue of parsed.error.issues) {
			p.log.error(`  ${issue.path.join(".")}: ${issue.message}`);
		}
		process.exit(1);
	}

	// Generate YAML
	const yamlContent = yamlStringify(entry, {
		lineWidth: 0,
		defaultStringType: "QUOTE_DOUBLE",
		defaultKeyType: "PLAIN",
	});

	p.log.info(
		`\n${pc.bold("Generated YAML")} (${pc.dim(yamlPath)}):\n\n${pc.dim(yamlContent)}`,
	);

	const confirmed = await p.confirm({
		message: "Create PR with this entry?",
	});
	if (p.isCancel(confirmed) || !confirmed) {
		p.cancel("Cancelled");
		process.exit(0);
	}

	// Create branch, commit, and PR
	const branchName = `add/${packageName.replace(/[@/]/g, "").replace(/\W+/g, "-")}`;

	spinner.start("Creating branch and PR...");

	try {
		// Ensure we're on a clean main
		exec("git checkout main");
		exec("git pull origin main");

		// Create branch
		execSafe(`git branch -D ${branchName}`); // clean up if exists
		exec(`git checkout -b ${branchName}`);

		// Write YAML file
		const dir = resolve(ROOT_DIR, yamlPath, "..");
		mkdirSync(dir, { recursive: true });
		writeFileSync(fullYamlPath, yamlContent, "utf-8");

		// Commit
		exec(`git add ${yamlPath}`);
		exec(
			`git commit -m "feat: add ${packageName} to verified registry"`,
		);

		// Push and create PR
		exec(`git push -u origin ${branchName}`);

		const prBody = [
			"## Plugin Verification Request",
			"",
			`**Name**: \`${packageName}\``,
			`**Source**: npm`,
			`**Category**: ${category}`,
			"",
			"### Description",
			"",
			description,
			"",
			"### Package Info",
			"",
			`| Field | Value |`,
			`|-------|-------|`,
			`| Version | \`${npmInfo.version}\` |`,
			`| License | ${npmInfo.license ?? "N/A"} |`,
			`| \`engines.brika\` | ${npmInfo.enginesBrika ?? "missing"} |`,
			`| Keywords | ${npmInfo.keywords?.join(", ") ?? "none"} |`,
			"",
			"### Checklist",
			"",
			`- [x] Plugin is published and publicly accessible`,
			`- [${npmInfo.hasEnginesBrika ? "x" : " "}] Plugin has \`engines.brika\` field in package.json`,
			`- [${hasBrikaKeyword ? "x" : " "}] Plugin has \`brika\` keyword in package.json`,
			`- [x] YAML filename matches the \`name\` field`,
			"",
			"*This PR was automatically generated by `bun run submit`.*",
		].join("\n");

		// Write PR body to temp file to avoid shell escaping issues
		const prBodyPath = resolve(ROOT_DIR, ".pr-body.md");
		writeFileSync(prBodyPath, prBody, "utf-8");

		const prUrl = exec(
			`gh pr create --repo ${REPO} --title "feat: verify ${packageName}" --body-file "${prBodyPath}"`,
		);

		// Clean up temp file
		execSafe(`rm "${prBodyPath}"`);

		spinner.stop("PR created!");
		p.log.success(`\n${pc.green(prUrl)}`);

		// Switch back to main
		exec("git checkout main");
	} catch (err) {
		spinner.stop("Failed to create PR", 2);
		// Try to clean up
		execSafe("git checkout main");
		execSafe(`git branch -D ${branchName}`);
		p.log.error(String(err));
		process.exit(1);
	}

	p.outro(pc.green("Done! A maintainer will review your submission."));
}

main().catch((err) => {
	p.log.error(String(err));
	process.exit(1);
});
