# Install Pocketto in Agent-Skills-Compatible Harnesses

This guide covers the community-maintained [`npx skills`](https://github.com/vercel-labs/skills) installer for Cursor, Cline, Zed, Crush, Kilo Code, Junie, and Qwen Code. The installer selects each harness's configured skill directory; do not assume every harness uses the same on-disk path.

## Verified adapters

The `cursor` and `cline` adapters were exercised in the Pocketto installation spike: all 16 skills installed and their frontmatter parsed. The exact installer commands are:

```bash
npx skills add rfxlamia/pocketto --skill '*' -a cursor -y
npx skills add rfxlamia/pocketto --skill '*' -a cline -y
```

## Supported adapters not individually verified with Pocketto

The current [`npx skills` supported-agent list](https://github.com/vercel-labs/skills#supported-agents) includes all seven adapter IDs below. Pocketto installation and skill discovery have not been individually tested on these five harnesses:

```bash
npx skills add rfxlamia/pocketto --skill '*' -a zed -y
npx skills add rfxlamia/pocketto --skill '*' -a crush -y
npx skills add rfxlamia/pocketto --skill '*' -a kilo -y
npx skills add rfxlamia/pocketto --skill '*' -a junie -y
npx skills add rfxlamia/pocketto --skill '*' -a qwen-code -y
```

The adapter IDs are documented by the current registry, but Pocketto installation and native harness discovery remain unverified for this group.

## Skills included

All 16 repository skills are installed, including the two Enterprise skills (`pocket-enterprise` and `create-pr`). This is not a Core-only distribution. Do not use this path where Enterprise skills must be excluded.

Run the commands from your project directory for project-scoped installation. `--skill '*'` explicitly selects every skill in the repository, and `-y` skips confirmation prompts. The installer supports symlinks (recommended) and copies; pass `--copy` to force a copy. Run `npx skills update` from the project directory to refresh installed skills.

## Verify

```bash
npx skills list
```

The listed skills should include the Pocketto skills installed for the selected agent. Use each harness's own skill-discovery UI or command to verify that it can see them; those UI steps have not been verified individually.

## Manual alternative

If the installer cannot be used, copy the `skills/` directory from this repository into the destination documented for your harness. Confirm that the resulting layout is `<skill-directory>/<skill-name>/SKILL.md`.
