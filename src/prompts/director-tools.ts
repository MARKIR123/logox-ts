/**
 * Actor and subagent coordination tool prompts.
 * Designed after Claude Code's colocated tool prompts:
 * Clear descriptions, operational constraints, and concise coordination guidelines.
 */

export const DISPATCH_ROLE_PROMPT = {
  description: 'Dispatch subagent tasks to coordinate roles concurrently. Independent tasks (e.g. visual assets, algorithms, testing) should be dispatched in the same batch to maximize parallel throughput. Turn ends to await automatic return of results. Use resumeTask to resume failed activities. (派发角色任务，支持并行推进)',
  usageNotes: `[Subagent Coordination Guidelines]
- Concurrent execution (并行推进): Independent read-only/research tasks must be dispatched together in a single dispatch_role batch.
- Always synthesize: Never lazily forward raw reports. Synthesize companion findings into an exact specification with concrete file paths, lines, and drop-in code before dispatching implementation.
- Feature bundle sizing: Group related file changes into one cohesive implementation task. Never fragment coupled edits into tiny serial micro-steps.
- Structured contract: Explicitly specify goal, constraints, minDeliverable, and stopCondition.
- Clean scratchpad: Require all temporary test scripts and probe screenshots to reside in the session scratchpad directory.`,
};

export const CRAFT_ACTOR_PROMPT = {
  description: 'Submit actor Markdown specification (Frontmatter configuration + persona definition). Requires user approval before saving and reloading. (提交完整角色 Markdown)',
};

export const READ_ACTOR_PROMPT = {
  description: 'Read concise summary and execution transcripts of an actor\'s active branch on demand. (按需读取角色当前有效分支)',
};

export const BORROW_SKILL_PROMPT = {
  description: 'Borrow an existing skill index for the current task. Active only for the duration of this task. (为本任务借阅已有技能索引)',
};
