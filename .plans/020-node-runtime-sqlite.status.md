# node-compatible pi extension startup status

- plan: `.plans/020-node-runtime-sqlite.md`
- plan sha256: `b301e9bc02cdbe202ce8fe7d7b593ae04f5234b9d906eb798539b569044c3059`
- base/head: `main` at `098cbcfc80ea0a0e217b4e03f9e57a7ed8db04b0`
- overall state: `ready_to_commit`
- current phase: commit/push

## task states

1. runtime regression: `implemented`
2. cross-runtime SQLite boundary: `implemented`
3. verification/deployment: `implemented`

## constraints

- direct commit/push to main explicitly authorized.
- no Wolfpack changes or deployment.
- no package publication/version bump.

## evidence

- red manual reproduction: `printf '{"type":"get_state"}\n' | pi --mode rpc` exits 1 because Node/Jiti cannot resolve `bun:sqlite` from `src/task-store.ts`.
- introducing commit: `0c2ccbc4a9cf219c377cfaa2374855d6877da84f`; no existing upstream correction.
- runtime: Node `v24.1.0`, Pi `0.80.6`; `node:sqlite` is present. Bun `1.3.9` provides `bun:sqlite` but cannot import `node:sqlite`.
- automated red: `bun test tests/node-extension-runtime.test.ts` failed because stderr contained the exact `Failed to load extension ... Cannot find module 'bun:sqlite'` error.
- automated green: the Node/Jiti startup regression passed after selecting the active runtime's native SQLite implementation.
- focused verification: 10 tests / 30 expectations passed across Node startup, Bun store, and endpoint extension files; typecheck passed.
- live configured reproduction: `printf '{"type":"get_state"}\n' | pi --mode rpc --no-session` exited 0 with a successful `get_state` response and empty stderr.
- manual Node store smoke persisted/read a task with named parameters; transaction rollback left no task.
- full verification: 79 tests / 308 expectations passed; typecheck passed; package dry-run included `src/sqlite-database.ts`; `git diff --check` and immutable plan digest passed.
- diff review: scope is limited to one native runtime adapter, task-store wiring, the exact Node/Jiti startup regression, and plan ledgers; no protocol/schema/storage-path/dependency change.

## next action

commit and push main, verify the remote and configured local checkout, then record final deployment evidence.
