#!/usr/bin/env bun
/**
 * sign.ts -- Sign the compiled registry with Ed25519.
 *
 * Reads dist/verified-plugins.json, signs each plugin entry individually,
 * then signs the full registry document (chain of trust).
 *
 * Usage:
 *   bun run scripts/sign.ts
 *
 * Environment:
 *   BRIKA_REGISTRY_PRIVATE_KEY -- PEM-encoded Ed25519 private key (required)
 */
import {
	createPrivateKey,
	createPublicKey,
	sign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	SPKI_HEADER,
	canonicalize,
	verifyWithRawKey,
} from "@brika/registry";
import type { VerifiedPlugin, VerifiedPluginsList } from "@brika/registry";

const ROOT_DIR = resolve(import.meta.dir, "..");
const REGISTRY_PATH = resolve(ROOT_DIR, "dist", "verified-plugins.json");

// ── Key Management ───────────────────────────────────────────────────────────

function loadPrivateKey(): string {
	const envKey = process.env.BRIKA_REGISTRY_PRIVATE_KEY;
	if (!envKey) {
		console.error(
			"Error: BRIKA_REGISTRY_PRIVATE_KEY environment variable is required.",
		);
		console.error(
			"In CI, this should be set from GitHub Actions secrets.",
		);
		process.exit(1);
	}
	// Unescape \\n sequences (common in CI env vars)
	return envKey.replaceAll(String.raw`\n`, "\n");
}

function derivePublicKeyBase64(privateKeyPem: string): string {
	const pub = createPublicKey(createPrivateKey(privateKeyPem));
	const der = pub.export({ type: "spki", format: "der" });
	return Buffer.from(der.subarray(SPKI_HEADER.length)).toString(
		"base64",
	);
}

function signData(data: string, privateKeyPem: string): string {
	const sig = sign(null, Buffer.from(data, "utf-8"), privateKeyPem);
	return sig.toString("hex");
}

// ── Payload Extraction ───────────────────────────────────────────────────────

/**
 * Extract the signable payload from a plugin entry (everything except `signature`).
 */
function extractPluginPayload(
	plugin: VerifiedPlugin,
): Omit<VerifiedPlugin, "signature"> {
	return {
		name: plugin.name,
		verifiedAt: plugin.verifiedAt,
		verifiedBy: plugin.verifiedBy,
		description: plugin.description,
		tags: plugin.tags,
		...(plugin.minVersion !== undefined
			? { minVersion: plugin.minVersion }
			: {}),
		featured: plugin.featured,
		category: plugin.category,
		source: plugin.source,
	};
}

/**
 * Extract the signable payload from the registry
 * (everything except `$schema` and `signature`).
 */
function extractRegistryPayload(
	registry: VerifiedPluginsList,
): Omit<VerifiedPluginsList, "$schema" | "signature"> {
	return {
		version: registry.version,
		lastUpdated: registry.lastUpdated,
		...(registry.publicKey !== undefined
			? { publicKey: registry.publicKey }
			: {}),
		plugins: registry.plugins,
	};
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
	console.log("Signing registry...\n");

	const privateKeyPem = loadPrivateKey();
	const publicKeyBase64 = derivePublicKeyBase64(privateKeyPem);

	// Read the unsigned registry
	const raw = readFileSync(REGISTRY_PATH, "utf-8");
	const registry: VerifiedPluginsList = JSON.parse(raw);

	// Set public key
	registry.publicKey = publicKeyBase64;

	// Sign each plugin entry
	for (const plugin of registry.plugins) {
		const payload = extractPluginPayload(plugin);
		plugin.signature = signData(
			canonicalize(payload),
			privateKeyPem,
		);
	}

	// Sign the full registry
	const registryPayload = extractRegistryPayload(registry);
	registry.signature = signData(
		canonicalize(registryPayload),
		privateKeyPem,
	);

	// Write signed registry
	Bun.write(REGISTRY_PATH, JSON.stringify(registry, null, 2));
	console.log(`Signed ${registry.plugins.length} plugins`);

	// Verify signatures
	console.log("\nVerifying signatures...");
	let allValid = true;

	for (const plugin of registry.plugins) {
		if (!plugin.signature) {
			console.error(`  MISSING  ${plugin.name}`);
			allValid = false;
			continue;
		}

		const payload = extractPluginPayload(plugin);
		const valid = verifyWithRawKey(
			canonicalize(payload),
			plugin.signature,
			publicKeyBase64,
		);

		if (valid) {
			console.log(`  OK       ${plugin.name}`);
		} else {
			console.error(`  INVALID  ${plugin.name}`);
			allValid = false;
		}
	}

	// Verify registry signature
	if (registry.signature) {
		const regPayload = extractRegistryPayload(registry);
		const valid = verifyWithRawKey(
			canonicalize(regPayload),
			registry.signature,
			publicKeyBase64,
		);
		if (valid) {
			console.log(`  OK       [registry]`);
		} else {
			console.error(`  INVALID  [registry]`);
			allValid = false;
		}
	}

	if (!allValid) {
		console.error("\nSignature verification failed!");
		process.exit(1);
	}

	console.log(
		"\nAll signatures verified. Ready to deploy.",
	);
}

main();
