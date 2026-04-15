# Contributing to the Brika Plugin Registry

Thank you for contributing to the Brika plugin ecosystem!

## What Is This Registry?

This registry maintains a list of **verified** Brika plugins. All plugins are discoverable
in the Brika store regardless of whether they are in this registry. Being listed here
gives your plugin a **verified badge** (blue star), signaling to users that it has been
reviewed and approved by the community or maintainers.

Unverified plugins work just fine -- they simply don't carry the verified badge.

## Adding a Plugin

### Prerequisites

Your plugin must:

1. Be **publicly published** on npm (or available via GitHub/URL)
2. Have `engines.brika` in its `package.json` (specifies compatible Brika versions)
3. Have `brika` or `brika-plugin` in its `keywords` array

### Option A: Using the CLI (recommended)

The fastest way to submit your plugin:

```bash
git clone https://github.com/brikalabs/registry.git
cd registry
bun install
bun run submit @myorg/brika-dashboard
```

The CLI will:
- Fetch your package metadata from npm
- Let you review and customize the entry
- Create a branch, commit, and open a PR automatically

Requires the [GitHub CLI](https://cli.github.com) (`gh`) to be installed and authenticated.

### Option B: Manual submission

1. **Fork** this repository
2. **Create a YAML file** in the `plugins/` directory

   The file path must match your package name:
   - `@myorg/brika-dashboard` goes to `plugins/myorg/brika-dashboard.yaml`
   - `my-brika-plugin` (unscoped) goes to `plugins/_unscoped/my-brika-plugin.yaml`

3. **Fill in the required fields:**

   ```yaml
   name: "@myorg/brika-dashboard"
   description: "Custom dashboard widgets for Brika"
   tags:
     - dashboard
     - widgets
   category: community
   source: npm
   featured: false
   verifiedBy: community
   ```

4. **Open a Pull Request**

CI will automatically validate your entry:
- YAML syntax and schema validation
- Filename/name consistency check
- Verifies the package exists on npm/GitHub
- Checks for `engines.brika` and `brika` keyword

A maintainer will review your submission. Once merged, your plugin receives the **verified badge** in the Brika store.

### YAML Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | npm package name (must match file path) |
| `description` | Yes | Brief description of the plugin |
| `tags` | No | Searchable tags (default: `[]`) |
| `category` | No | One of: `official`, `community`, `utility`, `integration`, `workflow` (default: `community`) |
| `source` | No | One of: `npm`, `github`, `url` (default: `npm`) |
| `featured` | No | Whether to highlight in the store (default: `false`, set by maintainers) |
| `verifiedBy` | Yes | Who verified this plugin (use `community` for community submissions) |
| `minVersion` | No | Minimum Brika version required (semver, e.g. `0.3.0`) |
| `repository` | No | GitHub repo URL (required if `source: github`) |
| `url` | No | Package URL (required if `source: url`) |

### Updating a Plugin

Edit the existing YAML file and open a PR. CI re-validates automatically.

### Removing a Plugin

Delete the YAML file and open a PR. The verified badge will be removed from the store.

## Categories

- **official** -- Plugins maintained by the Brika team
- **community** -- Community-contributed plugins
- **utility** -- General-purpose utilities
- **integration** -- Third-party service integrations
- **workflow** -- Automation and workflow plugins

## How Signing Works

You do not need to sign anything. CI automatically signs all plugin entries
using Ed25519 when your PR is merged to `main`. The signed registry is then
deployed to `registry.brika.dev`. The Brika hub verifies these signatures
before granting the verified badge.

## Questions?

Open an issue or reach out to the Brika team.
