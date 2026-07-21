# debug pi installation structured delegation

status: implemented

## goal
make wolfpack/pi structured subagent delegation work as intended: parent opens a child, delegates via `agent_task_send`, child completes with `agent_task_done`, parent reads structured result.

## assumptions
- plugin should be installed where `/Users/home/Dev/wolfpack` pi sessions can load it, not only this repo.
- validating with a real wolfpack parent/child session is required.
- fixes should be minimal and limited to plugin/install flow issues discovered during reproduction.

## steps
- [x] inspect pi package install state and plugin load behavior
- [x] inspect plugin code path for store root, dispatch, and target completion
- [x] install/configure plugin at the correct scope if missing
- [x] open a fresh wolfpack parent session
- [x] instruct parent to spawn a child and use structured task delegation
- [x] verify task storage and `agent_task_done` result
- [x] fix any plugin issues found
- [x] run relevant tests/typecheck
