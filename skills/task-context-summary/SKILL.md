---
name: task-context-summary
description: Recover or reuse a bounded Wolfpack task context summary when the parent needs to reconstruct handoff context without copying a transcript.
---

# task context summary

parent authors normal summaries. use this skill only for recovery or reuse when the parent lacks enough already-loaded context.

## evidence order

1. inspect relevant docs/code first.
2. use an existing session summary next, if one exists.
3. inspect only the selective recent transcript needed to resolve remaining gaps.

do not copy a full transcript, infer unseen file contents, or automatically cache generated summaries. when evidence disagrees, state the disagreement explicitly instead of silently choosing a version.

## output

return concise Markdown, under 16KiB UTF-8, using any useful subset:

```md
## constraints and preferences
## progress
### done
### in progress
### blocked
## key decisions
## critical context
## failed approaches
## open questions
```

include selected refs separately in the task request. mention a ref's path, selector, and purpose only; do not read or duplicate ref contents merely to populate the summary.
