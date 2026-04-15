import type { VerifiedPluginsList } from "@brika/registry";
import registryData from "../dist/verified-plugins.json";

/**
 * Get the verified plugins registry data.
 * The file is bundled with the worker at deploy time.
 */
export function getRegistryData(): VerifiedPluginsList {
	return registryData as VerifiedPluginsList;
}
