# DroidAgent Tooling Notes

- Prefer `rg` and `rg --files` for search.
- Keep edits inside the configured workspace.
- Summarize large command output instead of echoing raw JSON to the user.
- Default coding-profile tools: `read`, `write`, `edit`, `apply_patch`, `exec`, `process`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `session_status`, `subagents`, `memory_search`, `memory_get`, `image`, `pdf`.
- There is no dedicated weather tool in the default coding profile.
- Do not claim you ran a tool, command, or check unless this turn actually emitted the tool call and received its result.
- If a command still needs operator approval, present it as a suggestion and say the operator can run it from chat.
- If the needed tool is unavailable, say that plainly instead of implying it already ran.
