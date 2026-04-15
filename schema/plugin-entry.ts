/**
 * Zod schema for plugin YAML entries in the registry.
 *
 * This defines what contributors provide in their YAML files.
 * Computed fields (verifiedAt, signature) are added during the build step.
 */
import { z } from "zod";

/** npm-style package name pattern */
export const npmNamePattern =
	/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Plugin categories */
export const PluginCategory = z.enum([
	"official",
	"community",
	"utility",
	"integration",
	"workflow",
]);
export type PluginCategory = z.infer<typeof PluginCategory>;

/** Plugin source -- where the package is hosted */
export const PluginSource = z.enum(["npm", "github", "url"]);
export type PluginSource = z.infer<typeof PluginSource>;

/**
 * Schema for a plugin YAML entry (contributor-authored).
 * Does NOT include `verifiedAt` or `signature` -- those are computed by CI.
 */
export const PluginEntrySchema = z.object({
	name: z
		.string()
		.regex(npmNamePattern, "Must be a valid npm package name"),
	description: z.string().min(1, "Description is required"),
	tags: z.array(z.string()).default([]),
	category: PluginCategory.default("community"),
	source: PluginSource.default("npm"),
	featured: z.boolean().default(false),
	verifiedBy: z.string().min(1),
	minVersion: z
		.string()
		.regex(/^\d+\.\d+\.\d+$/, "Must be valid semver (x.y.z)")
		.optional(),
	/** Repository URL -- required for source: github */
	repository: z.string().url().optional(),
	/** Package URL -- required for source: url */
	url: z.string().url().optional(),
});
export type PluginEntry = z.infer<typeof PluginEntrySchema>;

/**
 * Derive the expected plugin name from its file path.
 *
 * - `plugins/brika/plugin-spotify.yaml` -> `@brika/plugin-spotify`
 * - `plugins/_unscoped/my-plugin.yaml` -> `my-plugin`
 */
export function expectedNameFromPath(relativePath: string): string {
	const match = relativePath.match(
		/^plugins\/([^/]+)\/([^/]+)\.yaml$/,
	);
	if (!match) {
		throw new Error(`Invalid plugin path: ${relativePath}`);
	}

	const [, scope, name] = match;
	if (scope === "_unscoped") {
		return name;
	}
	return `@${scope}/${name}`;
}

/**
 * Derive the expected file path from a plugin name.
 *
 * - `@brika/plugin-spotify` -> `plugins/brika/plugin-spotify.yaml`
 * - `my-plugin` -> `plugins/_unscoped/my-plugin.yaml`
 */
export function pathFromName(name: string): string {
	const scopedMatch = name.match(/^@([^/]+)\/(.+)$/);
	if (scopedMatch) {
		return `plugins/${scopedMatch[1]}/${scopedMatch[2]}.yaml`;
	}
	return `plugins/_unscoped/${name}.yaml`;
}
