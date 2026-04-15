import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { getRegistryData } from "./utils";

export function createRoutes() {
	const app = new Hono<{ Bindings: Env }>();

	app.use("*", cors({ origin: "*" }));

	app.get("/health", (c) => {
		const data = getRegistryData();
		return c.json({
			status: "ok",
			service: "brika-registry",
			signed: Boolean(data.signature),
			pluginCount: data.plugins.length,
		});
	});

	app.get("/public-key", (c) => {
		const data = getRegistryData();
		if (!data.publicKey) {
			return c.json({ error: "No public key configured" }, 404);
		}
		return c.json({
			publicKey: data.publicKey,
			format: "base64-raw-ed25519",
		});
	});

	app.get("/verified-plugins.json", (c) => {
		try {
			const data = getRegistryData();
			return c.json(data, {
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Cache-Control": `public, max-age=${c.env.CACHE_MAX_AGE}`,
				},
			});
		} catch (err) {
			return c.json(
				{ error: "Failed to load registry", message: String(err) },
				500,
			);
		}
	});

	app.get("/", (c) => c.redirect("/verified-plugins.json"));

	app.notFound((c) => c.json({ error: "Not found" }, 404));

	return app;
}
