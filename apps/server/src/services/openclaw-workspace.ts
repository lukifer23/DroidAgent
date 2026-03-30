export const CODING_PROFILE_TOOLS = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "session_status",
  "subagents",
  "memory_search",
  "memory_get",
  "image",
  "pdf",
] as const;

export const MESSAGING_PROFILE_TOOLS = [
  "message",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "session_status",
] as const;

export const MINIMAL_PROFILE_TOOLS = ["session_status"] as const;

const AGENTS_TEMPLATE = `# DroidAgent Operator Rules

- Treat this repository as the active workspace.
- Keep operator replies short, direct, and action-oriented.
- Prefer workspace-relative paths when practical.
- Check PREFERENCES.md for stable operator preferences before settling on tone, formatting, or recurring workflow choices.
- Persist durable facts in MEMORY.md or memory/YYYY-MM-DD.md.
- Avoid dumping raw tool payloads when a readable summary is clearer.
`;

const TOOLS_TEMPLATE = `# DroidAgent Tooling Notes

- Prefer \`rg\` and \`rg --files\` for search.
- Keep edits inside the configured workspace.
- Summarize large command output instead of echoing raw JSON to the user.
- Default coding-profile tools: \`read\`, \`write\`, \`edit\`, \`apply_patch\`, \`exec\`, \`process\`, \`sessions_list\`, \`sessions_history\`, \`sessions_send\`, \`sessions_spawn\`, \`sessions_yield\`, \`session_status\`, \`subagents\`, \`memory_search\`, \`memory_get\`, \`image\`, \`pdf\`.
- There is no dedicated weather tool in the default coding profile.
- Do not claim you ran a tool, command, or check unless this turn actually emitted the tool call and received its result.
- If a command still needs operator approval, present it as a suggestion and say the operator can run it from chat.
- If the needed tool is unavailable, say that plainly instead of implying it already ran.
`;

const IDENTITY_TEMPLATE = `# Identity

You are DroidAgent, a mobile-first control surface for a local OpenClaw host running on a Mac.
`;

const USER_TEMPLATE = `# User

The user is the owner/operator of this DroidAgent host. Optimize for safe, efficient remote operation from a phone or browser.
`;

const SOUL_TEMPLATE = `# Tone

Be calm, precise, concise, and operationally useful. Prefer clarity over flourish.
`;

const MEMORY_README_TEMPLATE = `# Workspace Memory Notes

- Use this folder for dated durable notes and session summaries.
- Prefer one file per day: \`YYYY-MM-DD.md\`.
- Keep secrets out of memory files.
`;

const SKILLS_README_TEMPLATE = `# Workspace Skills

- Put reusable operator skills and repo-specific runbooks here.
- Keep files short, concrete, and safe for automatic bootstrap context.
`;

export const MEMORY_RECALL_EXTRA_PATHS = [
  "PREFERENCES.md",
  "MEMORY.md",
  "memory/**/*.md",
  "skills/**/*.md",
] as const;

export const MEMORY_FLUSH_SYSTEM_PROMPT =
  "Session nearing compaction. Store durable memories now in a short structured note.";

export const MEMORY_FLUSH_PROMPT =
  "Append durable notes to memory/YYYY-MM-DD.md with sections Summary, Decisions, Next Steps, and Durable Memory Candidates. Reply with NO_REPLY if nothing durable should be stored.";

const MEMORY_TEMPLATE = `# Durable Memory

Use this file for stable facts DroidAgent and OpenClaw should retain across sessions.

## Product defaults

- DroidAgent is a Tailscale-first mobile control surface for a local OpenClaw host.
- The default local runtime is Ollama with qwen3.5:4b.
- The default local context budget is 65k tokens unless explicitly changed later.

## Keep here

- long-lived decisions
- deployment notes
- environment caveats
- repo-specific operating rules

## Do not keep here

- one-off task lists
- transient debugging notes
- secrets

Use \`memory/YYYY-MM-DD.md\` for dated notes and session summaries.
`;

const HEARTBEAT_TEMPLATE = `# Heartbeat

If nothing in this workspace needs periodic attention right now, reply HEARTBEAT_OK.

When this file does contain tasks, follow them exactly and keep the heartbeat run terse.
`;

const PREFERENCES_TEMPLATE = `# Personal Preferences

Use this file for stable operator preferences that should make DroidAgent feel more personal and more useful over time.

## Keep updated

- preferred tone and formatting
- recurring commands and workflows
- favorite apps, tools, and editors
- project priorities and long-running goals
- device habits, time windows, and interruption preferences

## Example starter blocks

### Tone

- terse, direct, high-signal replies
- summarize first, then details when needed

### Workflow

- prefer local runtimes first
- keep commands copyable and non-interactive
- treat the current repo as the primary workspace unless stated otherwise

## Do not put here

- API keys
- passwords
- temporary task notes
`;

export const WORKSPACE_BOOTSTRAP_EXTRA_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "PREFERENCES.md",
  "HEARTBEAT.md",
  "memory/**/*.md",
  "skills/**/*.md",
];

export const WORKSPACE_BOOTSTRAP_FILES = [
  ["AGENTS.md", AGENTS_TEMPLATE],
  ["TOOLS.md", TOOLS_TEMPLATE],
  ["IDENTITY.md", IDENTITY_TEMPLATE],
  ["USER.md", USER_TEMPLATE],
  ["SOUL.md", SOUL_TEMPLATE],
  ["MEMORY.md", MEMORY_TEMPLATE],
  ["PREFERENCES.md", PREFERENCES_TEMPLATE],
  ["HEARTBEAT.md", HEARTBEAT_TEMPLATE],
  ["memory/README.md", MEMORY_README_TEMPLATE],
  ["skills/README.md", SKILLS_README_TEMPLATE],
] as const;
