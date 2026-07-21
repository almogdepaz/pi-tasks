# pi-tasks plugin v1

status: implemented

## ~~1. Scaffold package and test harness~~

status: done

success:
- package exists under `../pi-tasks`
- bun test/typecheck scripts exist
- pi manifest points at extension entrypoint

## ~~2. Implement shared task store~~

status: done

success:
- creates tasks in `<project>/.wolfpack/tasks/<taskId>`
- writes `task.json`, `events.jsonl`, `assignment.json`, `result.json`
- uses atomic task writes and lock dirs
- enforces terminal first-writer-wins

## ~~3. Implement extension tools~~

status: done

success:
- parent: `agent_task_send/status/wait/inbox/cancel`
- child: `agent_task_done` returns `terminate: true`
- dispatch uses existing `wolfpack session send`

## ~~4. Add background ui notifications~~

status: done

success:
- polls local task store
- updates status/notifications only
- never injects model messages automatically

## ~~5. Add natural-language delegation skill~~

status: done

success:
- package ships `wolfpack-pi-task-delegation`
- skill delegates Wolfpack spawn/control to existing Wolfpack skills
- skill routes work through `agent_task_send` and completion through `agent_task_done`

## ~~6. Verify~~

status: done

success:
- store tests pass
- protocol helper tests pass
- typecheck passes
