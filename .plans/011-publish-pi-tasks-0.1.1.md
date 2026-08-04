# Publish Pi Tasks 0.1.1

Goal: publish the accepted Wolfpack task-gateway Pi extension as `@sgtbeatdown/pi-tasks@0.1.1` from the merged `main` branch while preserving unrelated local files.

## 1. Prepare release metadata

Add a regression assertion for accurate package metadata, update the stale description, and bump the package patch version from registry-current 0.1.0 to 0.1.1.

## 2. Verify the release candidate

Run the focused package test, full test suite, typecheck, diff checks, and a package dry run. Confirm the tarball contains the intended extension, gateway client, inbox logic, skills, documentation, and historical read-only metrics only.

## 3. Commit and merge

Commit only intended release files on `feat/federated-task-context-protocol`, push it, verify PR #1 is mergeable, merge it into `main`, and verify the remote main head. Leave unrelated `.edc` and plans 005/007/009 untouched.

## 4. Publish and verify

Publish `@sgtbeatdown/pi-tasks@0.1.1` publicly with the `latest` tag from clean merged `main`, then query the npm registry and inspect the published package metadata/files.
