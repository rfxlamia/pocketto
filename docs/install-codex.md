# Install Pocketto in Codex

Codex supports repository marketplaces through `.agents/plugins/marketplace.json`. The marketplace in this repository points to a portable plugin manifest at the repository root.

## Install

Add the marketplace from the repository:

```bash
codex plugin marketplace add rfxlamia/pocketto
```

Then open the plugin browser with `/plugins`, select the Pocketto marketplace, and install Pocketto. Start a new session before using the installed skills.

The marketplace command is documented by [OpenAI's plugin packaging guide](https://developers.openai.com/plugins/build/plugins). The `/plugins` browser is the documented Codex CLI installation flow; this repository's installation has not yet been smoke-tested in Codex CLI.

## Skills included

The repository-root plugin exposes all 16 Pocketto skills, including the two Enterprise skills (`pocket-enterprise` and `create-pr`). This is not a Core-only installation. Do not install it if Enterprise skills must be excluded.

For local skill discovery without installing a plugin, use the community-maintained `npx skills` CLI:

```bash
npx skills add rfxlamia/pocketto --skill '*' -a codex -y
```

This installs skills into the repository's `.agents/skills/` directory. `npx skills` is a third-party project maintained at [vercel-labs/skills](https://github.com/vercel-labs/skills), not a Pocketto product.

## Verify

In Codex, run `/skills` or start a new session and ask Codex to use `$pocket-init`. The repository includes all 16 skills; plugin behavior has not been smoke-tested against a real Codex CLI installation.

## Compatibility notes

- Codex reads repository marketplace catalogs from `.agents/plugins/marketplace.json`. OpenAI also documents `.claude-plugin/marketplace.json` as a Claude-compatible marketplace location; `.codex-plugin/` is reserved for the Codex plugin compatibility manifest.
- The plugin uses the portable Agent Plugins 1.0 manifest at `plugin.json`. Codex fixed plugin paths discover skills in the repository-root `skills/` directory; Pocketto's surface-role metadata in `surfaces.json` is not part of Codex's plugin schema.
- OpenAI documentation: [Build and package plugins](https://developers.openai.com/plugins/build/plugins), [Codex plugin management](https://developers.openai.com/codex/enterprise/plugin-management), and [Codex plugins](https://developers.openai.com/codex/plugins).
