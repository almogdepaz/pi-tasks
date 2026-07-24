# sender-defined completion prompt

status: implemented
created: 2026-07-23

## goal

let the sending agent attach parent-side follow-up instructions to a dispatched task, so async idle notifications can remind the parent what it intended to do after the worker finishes.

## assumptions

1. the follow-up prompt is authored by the sender at dispatch time.
2. it is parent-side only; it must not be included in the worker assignment text.
3. idle notification remains nonblocking and only fires when parent chat is idle/no pending messages.
4. `agent_task_wait` stays blocking and is not the default completion path.

## steps

- [x] add failing tests for sender-defined completion prompt storage and idle prompt rendering
- [x] add optional `onCompletePrompt` to `agent_task_send`
- [x] persist the sender-defined prompt on task records and compact inbox/status results
- [x] include the prompt in idle notifications without sending it to worker assignments
- [x] update docs/skill guidance
- [x] run `bun test`
- [x] run `bun run typecheck`
