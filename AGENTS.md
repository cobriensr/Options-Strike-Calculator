# Agent Conventions

> **All AI coding agents working in this repo (Codex, Cursor, Aider, Gemini CLI, etc.) follow the same conventions as Claude Code.** Read [CLAUDE.md](CLAUDE.md) — it is the single source of truth for project structure, the Get It Right development workflow, code style, env vars, deployment, and the Anthropic integration.

This file exists so non–Claude Code agents that auto-discover `AGENTS.md` are routed to the canonical doc. Do not duplicate conventions here.

## Why one file

A previous version of this repo maintained AGENTS.md and CLAUDE.md as near-identical copies. They drifted: AGENTS.md's env-var table fell behind, the migration count went stale, and the "Backend Modules" section referenced patterns that had been refactored. Keeping a single authoritative file (CLAUDE.md) avoids that drift.

## Pointers for new contributors (human or AI)

- **Conventions**: [CLAUDE.md](CLAUDE.md)
- **Local setup**: [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md)
- **Architecture**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Features**: [docs/FEATURES.md](docs/FEATURES.md)
- **Design specs and runbooks**: [docs/INDEX.md](docs/INDEX.md)

## Tool nomenclature

CLAUDE.md uses Claude Code tool names (Read, Edit, Bash, etc.). When working from a different agent, map them to your platform's equivalents:

- Codex: see your CLI's tool list — `shell`, `apply_patch`, etc.
- Gemini CLI: tools mapped automatically via `GEMINI.md`.
- Other agents: most have direct equivalents — Read/Edit/Bash semantics are universal.

The conventions in CLAUDE.md (typed-import patterns, `.js` extension rule for `src/`-imported-by-`api/`, Zod boundary validation, Vercel function patterns) apply regardless of which tool surface you use to read or edit files.
