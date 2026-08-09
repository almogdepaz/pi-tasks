import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { createTaskStore } from "../src/task-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("creates an owner-only sqlite store and rejects an unsafe existing directory", () => {
	const directory = mkdtempSync("/tmp/pi-tasks-store-");
	temporaryDirectories.push(directory);
	chmodSync(directory, 0o700);
	const path = join(directory, "v2", "tasks.sqlite");
	const store = createTaskStore({ path });
	store.close();
	expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
	expect(statSync(path).mode & 0o777).toBe(0o600);

	const unsafe = join(directory, "unsafe");
	mkdirSync(unsafe);
	chmodSync(unsafe, 0o755);
	expect(() => createTaskStore({ path: join(unsafe, "tasks.sqlite") })).toThrow("not owner-only");
});

test("migrates a file-backed v1 store without losing task records", () => {
	const directory = mkdtempSync("/tmp/pi-tasks-store-");
	temporaryDirectories.push(directory);
	chmodSync(directory, 0o700);
	const path = join(directory, "tasks.sqlite");
	const store = createTaskStore({ path });
	store.putTask({
		taskId: "task-1", protocolVersion: "pi-tasks/v2", origin: { relay: "relay", id: "origin" }, target: { relay: "relay", id: "target" },
		task: "preserve", createdAt: 1, expiresAt: 2, status: "active",
	});
	store.close();

	const legacy = new Database(path);
	legacy.exec("DROP INDEX tasks_origin_expiry; DROP INDEX inbox_cursor; DROP TABLE insertion_receipts; PRAGMA user_version = 1;");
	legacy.close();

	const migrated = createTaskStore({ path });
	expect(migrated.getTask("task-1")?.task).toBe("preserve");
	migrated.close();
	const checked = new Database(path, { readonly: true });
	expect((checked.query("PRAGMA user_version").get() as { readonly user_version: number }).user_version).toBe(3);
	checked.close();
});

function dirname(path: string): string {
	const slash = path.lastIndexOf("/");
	return path.slice(0, slash);
}
