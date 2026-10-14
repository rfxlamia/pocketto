# Install Pocketto in Gemini CLI

> The installation command follows the official Gemini CLI extension format. End-to-end installation has not yet been smoke-tested with Gemini CLI.

## Install

```bash
gemini extensions install https://github.com/rfxlamia/pocketto
```

Gemini CLI installs extensions from a GitHub repository URL. See the official [extension reference](https://geminicli.com/docs/extensions/reference/) and [extension authoring guide](https://geminicli.com/docs/extensions/writing-extensions/).

## Skills included

Installing this repository-root extension makes **all 16 skills** discoverable, including Pocketto's two Enterprise skills (`pocket-enterprise` and `create-pr`). Gemini CLI discovers skills under an extension's `skills/` directory and activates them when relevant; their full contents are not eagerly imported into `GEMINI.md`.

This is not a Core-only distribution. Do not install it if Enterprise skills must be excluded.

## Verify

```bash
gemini extensions list
```

The `pocketto` extension should appear. Start a new Gemini CLI session to use its skills.

## Alternative: community skills installer

```bash
npx skills add rfxlamia/pocketto --skill '*' -a gemini-cli -y
```

This alternative installs the repository's skills through the third-party [`vercel-labs/skills`](https://github.com/vercel-labs/skills) CLI. The installer supports symlinks and copies; pass `--copy` to force a copy. Run `npx skills update` from the project directory to refresh installed skills.

## Antigravity

The repository does not claim that Antigravity installs or interprets Gemini CLI extensions in the same way. Its `npx skills` adapter is separate and has not been individually verified here.
