# node-compatible pi extension startup

## Goal

The default pi-tasks extension loads and operates under Pi's Node/Jiti runtime while preserving Bun development and SQLite behavior.

## 1. Lock the runtime regression

Add a deterministic regression that loads the real extension through a Node/Jiti path and fails on the current static `bun:sqlite` dependency. Keep existing Bun store tests as the compatibility side of the contract.

## 2. Add the minimal cross-runtime SQLite boundary

Replace the Bun-only static dependency with a small synchronous runtime adapter selecting the native SQLite implementation provided by the active runtime. Normalize only the database/query/transaction operations used by `task-store.ts`; do not change schemas, task semantics, storage paths, or add a third-party database dependency.

## 3. Verify and deploy

Run the startup regression, focused store/extension tests, full suite, typecheck, package/runtime smoke, and diff checks. Commit directly to `main`, push `origin/main`, verify the remote head, and leave the configured local checkout on that exact clean commit.

## Non-goals

- no Wolfpack source or deployment changes
- no task protocol, schema, migration, or lifecycle changes
- no package publication or version bump
- no unrelated refactor
