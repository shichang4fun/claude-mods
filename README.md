# claude-mods

Personal Claude Code mods, published as a local plugin marketplace.

## Install

```bash
claude plugin marketplace add ~/Desktop/Github/claude-mods
claude plugin install usage-limit@claude-mods
```

## Mods

- **usage-limit**: a band above the prompt showing context-window fill, 5h / 7d usage limits with reset countdowns, and a warning when the 5h limit will be hit before it resets.
- **next-steps-desktop**: after each turn, suggests up to three next prompts above the input. Click one to send it (desktop app) or draft it (terminal); "copy" puts it on the clipboard to edit first. Adapted from [next-steps](https://github.com/anthropics/claude-plugins-community/tree/main/next-steps) by Thariq Shihipar (MIT).
