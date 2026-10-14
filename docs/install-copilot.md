# Install Pocketto in GitHub Copilot CLI

GitHub Copilot CLI documents support for Claude-compatible marketplaces in `.claude-plugin/marketplace.json`. Pocketto reuses that marketplace rather than maintaining a second catalog.

## Install

```bash
copilot plugin marketplace add rfxlamia/pocketto
copilot plugin install pocketto@pocketto
```

The first command registers the marketplace; the second installs its `pocketto` plugin. These commands follow the [official Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference). The manifest format and location are documented by GitHub, but Pocketto's own end-to-end installation has not been smoke-tested with an authenticated Copilot CLI.

## Skills included

The marketplace points to Pocketto's repository plugin package, which exposes all 16 skills, including the two Enterprise skills (`pocket-enterprise` and `create-pr`). This is not a Core-only installation.

## Alternative: community skills installer

```bash
npx skills add rfxlamia/pocketto --skill '*' -a github-copilot -y
```

The agent identifier is `github-copilot`. The third-party installer supports symlinks and copies; pass `--copy` to force a copy. Run `npx skills update` from the project directory to refresh installed skills. See the [`vercel-labs/skills` project](https://github.com/vercel-labs/skills).

## Verify

```bash
copilot skill list
```

The Pocketto skills should be listed. Restart Copilot CLI if they do not appear.

## Compatibility notes

- GitHub documents `.claude-plugin/marketplace.json` as a supported marketplace location. See the [file locations and marketplace schema](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#file-locations).
- Copilot CLI gives a root Agent Plugins `plugin.json` precedence over `.claude-plugin/plugin.json`. Pocketto's root manifest uses Agent Plugins 1.0; its portable skill location is the repository-root `skills/` directory. The supported marketplace location does not establish that every Pocketto installation flow works in a live Copilot CLI; that integration still needs a smoke test.
