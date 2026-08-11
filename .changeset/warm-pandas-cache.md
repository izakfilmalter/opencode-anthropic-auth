---
'@ex-machina/opencode-anthropic-auth': patch
---

Restore Anthropic prompt-cache breakpoints when OpenCode's synthetic V2 provider route omits them, lower unsupported chronological system-message positions before OAuth requests are sent, and recognize Claude Opus 5's full output limit so large tool calls are not truncated at 4,096 tokens.
