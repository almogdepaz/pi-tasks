# idle task result notification

status: implemented

## goal
when delegated tasks complete in the background, notify the parent agent/model at a safe idle boundary instead of only updating UI status.

## assumptions
- do not interrupt active parent turns.
- do not reorder ahead of queued user messages.
- auto-notification should prompt the parent to consume results through `agent_task_inbox({ ack: true })` so structured task state remains source of truth.
- `agent_task_wait` remains blocking/in-band and should not additionally trigger the background notification path.

## steps
- [x] inspect pi_compaction idle apply pattern and pi extension message API
- [x] add failing tests for idle notification prompt helpers
- [x] implement minimal idle background notification scheduling
- [x] run tests/typecheck
- [x] live async smoke: parent sent without wait, idle watcher injected inbox prompt, parent acked result
- [ ] commit and push
