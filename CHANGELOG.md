# Changelog

Notable changes to SwimTrace. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
version is the one in `package.json` and `mod/.claude-plugin/plugin.json`.

## [Unreleased]

## [0.1.3] - 2026-10-19

### Fixed

- Every symbol in the flow is now one that Windows terminal fonts (Consolas, Lucida Console, Courier New) have:
  done `√` (was ✓), failed `×` (✗), waiting `○` (◌), route `»` (⑂), workflow `♦` (◆), earlier turn `•` (◉), and
  `·►` (┄►) for step order in the narrow tree. They were drawn as boxes there.

## [0.1.2] - 2026-10-16

### Fixed

- The flow's arrows use `►` (U+25BA) instead of `▶` (U+25B6), which common Windows terminal fonts lack and drew
  as a box.

## [0.1.1] - 2026-10-16

### Added

- `swimtrace` viewer: on a terminal of at least 100×20 it splits into panes, with the flow on the left, Details
  (the selected agent, or main) and Sessions on the right, and the keys along the bottom.
- `swimtrace` viewer: click an agent to select it, or a session to open it; `--no-mouse` turns clicks off (#1).
- README: a "Terminal viewer" guide and prompts for testing the panes viewer (#1).
- `LICENSE` (MIT), this changelog, and CI that typechecks, tests and builds every push and pull request.

### Fixed

- The Flow pane title keeps the status markers and the agent count when the project name is long.
- The flow in the panes no longer jumps at each tool call of main (#1).
- Windows: `npm i` no longer fails on `chmod`; the plugin and the viewer find `~/.claude/swimtrace` through
  `USERPROFILE` when `HOME` is unset; project names are cut at `\` too (#3).
- The version is bumped so `/plugin update` actually delivers these fixes; 0.1.0 installs kept the old plugin code.

## [0.1.0] - 2026-10-12

### Added

- Claude Code plugin: a live flow of subagents above the prompt (request, plan or classify, route, agents), with
  progress, earlier turns, details, a pools view and `/swimtrace` to hide or show it.
- `swimtrace` CLI: the same flow in another terminal, a session list, `sim` scenarios that cost no tokens, and
  `clean` to delete the recorded data.
- Pools from `~/.claude/swimtrace/config.json` rules, `[pool:Name]` tags or the agent type; workflow step order
  inferred from `<step>:<key>` labels.
