# CLAUDE.md — LOGOX TS Development Guide & Project Memory

This file serves as the persistent context for Claude (both Claude Code and Claude Desktop) working on the `logox-ts` project.

## Project Overview
- **Repository**: `G:\hz\codes\logox-ts`
- **Identity**: LOGOX is a full-screen Terminal UI (TUI) programming assistant built with Node.js 24 and React/Ink, migrating from the original Python project (`../Logox`).
- **Phase Roadmap**: **Basic Features (基本功能) → Anamnesis Dreaming (入梦) → Persistent Subagents (剧团系统)**.

## Core Commands
- Install: `npm ci --ignore-scripts`
- Build: `npm run build`
- Typecheck & Docs Check: `npm run check`
- Run Tests: `npm test`
- Start TUI: `npm start`
- Start with options:
  - `npm start -- --check-config`
  - `npm start -- --list-models`
  - `npm start -- --resume`
  - `npm start -- --provider ollama --model <name>`

## Architectural Invariants (Aligned with Claude Code)
1. **English System Interface**:
   - All internal prompts, tool descriptions, UI labels, status lines, error messages, and network retry notices must be strictly in English.
   - Network notices must be concise (e.g., `[Network] Connection interrupted. Retrying (1/5)...`), never dumping noisy diagnostic walls.
   - Assistant conversational replies follow the language used by the user.
2. **Multimodal Vision Architecture**:
   - Multimodal is enabled by default (`supportsVision = true`).
   - The `read` tool description explicitly informs models that image files (PNG, JPG, etc.) can be read and rendered visually.
   - Never inject negative `NO_VISION_NOTE` prompts into system prompts.
3. **Continuous Execution Loop**:
   - `max_iterations = 0` (unlimited, while(true) natural convergence).
   - No interactive 50-turn blocking popups; tasks finish naturally or terminate on user cancellation (`Esc`/`Ctrl+C`).
4. **Scratchpad Sandbox Isolation**:
   - All ephemeral test scripts, calculation logs, and verification screenshots MUST be written to the session scratchpad directory (`tmpdir()/logox-scratchpad/<cwdHash>/<sessionId>/`), NOT in the project root.
   - `PermissionEngine` auto-approves actions inside the scratchpad directory.
5. **Human-Readable Session Transcripts**:
   - Session data in `state/sessions/<sessionId>/` maintains a clean dual-write hierarchy: `director.jsonl`, `tasks.json`, `events.json`, `README.md`, and `subagents/<actor>.jsonl`.
6. **Universal Subagent Scheduling**:
   - Four-Phase Funnel: Research (parallel read-only) → Synthesis (Director personally synthesizes; no lazy delegation) → Implementation (single cohesive Feature Bundle; no micro-step fragmentation) → Independent Verification (spawn fresh actor with tests or multimodal inspection).
   - Subagents must deliver concrete, drop-in code artifacts rather than vague advisory prose.

## Agent Persona Principles
- **Action Over Thought (与其思考，不如实践)**: Workers (like Techne) verify via execution rather than 300+ second runaway thinking chains. Keep thought blocks under 200 words, no raw SVG/code inside thinking.
- **Anti Over-Engineering (MVP First)**: Director Logox must produce a working MVP first and iterate, avoiding premature all-in-one over-engineering.
- **Persona Hierarchy**: Project-level persona definitions extend and append to user-level personas, never silently wiping them out.
- **Modular Prompts**: Keep prompts structured as static constant definitions, not dynamic string concatenations inside business logic.

## Recent Context & Ongoing Investigation (2026-10-17)
- **Latest Benchmark**: Tested on the `rail-way-town` project (`G:\hz\codes\rail-way-town\logox-deepseek\.logox`).
- **Current Observation**: As conversations grow long, latency increases and token throughput appears to degrade. High token burn ($20) observed during complex multi-actor execution.
- **Next Focus**: Optimizing context compaction, prompt token efficiency, subagent delegation sizing, and token economics.
