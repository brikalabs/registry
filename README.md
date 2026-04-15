# Brika Plugin Registry

The official registry of **verified** Brika plugins.

All Brika plugins are discoverable in the store via npm. This registry maintains the list of plugins that have been reviewed and carry the **verified badge** (blue star). Unverified plugins work the same way -- they just don't have the badge.

## How It Works

```
plugins/brika/plugin-spotify.yaml    # one file per plugin
       /brika/blocks-builtin.yaml
       /brika/plugin-matter.yaml
       /<scope>/<name>.yaml          # community plugins go here too
```

Each plugin is a simple YAML file:

```yaml
name: "@brika/plugin-spotify"
description: "Spotify Connect player for BRIKA dashboards"
tags: [spotify, music, media]
category: official
source: npm
featured: true
verifiedBy: maintainer
```

When a PR is merged:
1. CI compiles all YAML files into a signed `verified-plugins.json`
2. Ed25519 signatures are applied (per-plugin and registry-level)
3. The Brika hub fetches this file and verifies signatures
4. Verified plugins get the blue star in the store

## Submit Your Plugin

### Using the CLI (recommended)

```bash
git clone https://github.com/brikalabs/registry.git
cd registry
bun install
bun run submit @scope/my-plugin
```

The CLI will fetch your package from npm, generate the YAML, and open a PR automatically.

### Manually

1. Fork this repo
2. Add `plugins/<scope>/<name>.yaml` for your plugin
3. Open a PR

CI will automatically:
- Validate the YAML schema
- Check the package exists on npm
- Verify it has `engines.brika` in package.json
- Post a detailed validation report on the PR

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

## Structure

```
plugins/          # One YAML file per verified plugin
schema/           # Zod validation schema
scripts/
  submit.ts       # CLI to submit a plugin for verification
  validate.ts     # PR validation (schema + npm existence check)
  build.ts        # Compiles YAML -> verified-plugins.json
  sign.ts         # Ed25519 signing
  stale-check.ts  # Weekly health check for stale plugins
worker/           # Cloudflare Worker serving registry.brika.dev
```

## License

MIT
