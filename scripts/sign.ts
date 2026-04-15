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
 *   BRIKA_REGISTRY_PRIVATE_KEY -- Ed25519 private key in PEM format
 *     Accepts both PKCS#8 (-----BEGIN PRIVATE KEY-----) and
 *     OpenSSH (-----BEGIN OPENSSH PRIVATE KEY-----) formats.
 */
import {
	createPrivateKey,
	createPublicKey,
	sign,
	type KeyObject,
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

// ── PKCS#8 DER constants for Ed25519 ────────────────────────────────────────

/** PKCS#8 DER prefix for Ed25519 private keys (OID 1.3.101.112). */
const PKCS8_ED25519_PREFIX = new Uint8Array([
	0x30, 0x2e, // SEQUENCE (46 bytes)
	0x02, 0x01, 0x00, // INTEGER 0 (version)
	0x30, 0x05, // SEQUENCE (5 bytes)
	0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
	0x04, 0x22, // OCTET STRING (34 bytes)
	0x04, 0x20, // OCTET STRING (32 bytes) -- the 32-byte seed follows
]);

// ── OpenSSH key parsing ─────────────────────────────────────────────────────

/** Read a uint32 big-endian from a buffer at offset. */
function readUint32(buf: Buffer, offset: number): number {
	return buf.readUInt32BE(offset);
}

/** Read a length-prefixed string/bytes from a buffer at offset. Returns [data, newOffset]. */
function readString(buf: Buffer, offset: number): [Buffer, number] {
	const len = readUint32(buf, offset);
	return [buf.subarray(offset + 4, offset + 4 + len), offset + 4 + len];
}

/**
 * Parse an OpenSSH private key and convert it to a PKCS#8 KeyObject.
 *
 * OpenSSH Ed25519 private key binary layout:
 *   "openssh-key-v1\0" magic
 *   string ciphername ("none")
 *   string kdfname ("none")
 *   string kdfoptions
 *   uint32 number-of-keys (1)
 *   string public-key-blob
 *   string private-section:
 *     uint32 checkint1
 *     uint32 checkint2
 *     string keytype ("ssh-ed25519")
 *     string pubkey (32 bytes)
 *     string privkey (64 bytes = 32-byte seed + 32-byte pubkey)
 *     string comment
 *     padding
 */
function parseOpenSSHKey(pem: string): KeyObject {
	// Strip header/footer and decode base64
	const lines = pem
		.split("\n")
		.filter(
			(l) =>
				!l.startsWith("-----") && l.trim().length > 0,
		);
	const buf = Buffer.from(lines.join(""), "base64");

	// Verify magic
	const magic = "openssh-key-v1\0";
	if (buf.subarray(0, magic.length).toString("ascii") !== magic) {
		throw new Error("Invalid OpenSSH key: bad magic");
	}

	let offset = magic.length;

	// Skip ciphername, kdfname, kdfoptions
	let _s: Buffer;
	[_s, offset] = readString(buf, offset); // ciphername
	[_s, offset] = readString(buf, offset); // kdfname
	[_s, offset] = readString(buf, offset); // kdfoptions

	// Number of keys
	const numKeys = readUint32(buf, offset);
	offset += 4;
	if (numKeys !== 1) {
		throw new Error(
			`Expected 1 key, got ${numKeys}`,
		);
	}

	// Skip public key blob
	[_s, offset] = readString(buf, offset);

	// Read private section
	let privSection: Buffer;
	[privSection, offset] = readString(buf, offset);

	// Parse private section
	let pOffset = 0;

	// Check ints (must match)
	const check1 = readUint32(privSection, pOffset);
	pOffset += 4;
	const check2 = readUint32(privSection, pOffset);
	pOffset += 4;
	if (check1 !== check2) {
		throw new Error(
			"OpenSSH key check values mismatch (encrypted key?)",
		);
	}

	// Key type
	let keyType: Buffer;
	[keyType, pOffset] = readString(privSection, pOffset);
	if (keyType.toString("ascii") !== "ssh-ed25519") {
		throw new Error(
			`Expected ssh-ed25519, got ${keyType.toString("ascii")}`,
		);
	}

	// Public key (32 bytes)
	[_s, pOffset] = readString(privSection, pOffset);

	// Private key (64 bytes = 32 seed + 32 pubkey)
	let privKeyData: Buffer;
	[privKeyData, pOffset] = readString(privSection, pOffset);
	const seed = privKeyData.subarray(0, 32);

	// Build PKCS#8 DER
	const pkcs8Der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);

	return createPrivateKey({
		key: pkcs8Der,
		format: "der",
		type: "pkcs8",
	});
}

// ── Key Management ───────────────────────────────────────────────────────────

function loadPrivateKeyObject(): KeyObject {
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
	const pem = envKey.replaceAll(String.raw`\n`, "\n");

	// Detect format and parse
	if (pem.includes("OPENSSH PRIVATE KEY")) {
		return parseOpenSSHKey(pem);
	}

	// Standard PKCS#8 PEM
	return createPrivateKey(pem);
}

function derivePublicKeyBase64(privateKey: KeyObject): string {
	const pub = createPublicKey(privateKey);
	const der = pub.export({ type: "spki", format: "der" });
	return Buffer.from(der.subarray(SPKI_HEADER.length)).toString(
		"base64",
	);
}

function signData(data: string, privateKey: KeyObject): string {
	const sig = sign(null, Buffer.from(data, "utf-8"), privateKey);
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

	const privateKey = loadPrivateKeyObject();
	const publicKeyBase64 = derivePublicKeyBase64(privateKey);

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
			privateKey,
		);
	}

	// Sign the full registry
	const registryPayload = extractRegistryPayload(registry);
	registry.signature = signData(
		canonicalize(registryPayload),
		privateKey,
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
