import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { createTaskStore } from "../src/task-store";
import type { RelayEnvelope } from "../src/task-protocol";

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

test("migrates an operator-created quarantine table without losing audit rows", () => {
	const directory = mkdtempSync("/tmp/pi-tasks-store-");
	temporaryDirectories.push(directory);
	chmodSync(directory, 0o700);
	const path = join(directory, "tasks.sqlite");
	const initial = createTaskStore({ path });
	initial.close();

	const legacy = new Database(path);
	legacy.exec(`
		DROP TABLE outbox_quarantine;
		CREATE TABLE outbox_quarantine (envelope_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, reason TEXT NOT NULL, quarantined_at INTEGER NOT NULL);
		INSERT INTO outbox_quarantine VALUES ('audit-envelope', '{}', 'operator quarantine', 123);
		PRAGMA user_version = 3;
	`);
	legacy.close();

	const migrated = createTaskStore({ path });
	migrated.close();
	const checked = new Database(path, { readonly: true });
	const columns = checked.query("PRAGMA table_info(outbox_quarantine)").all() as Array<{ readonly name: string }>;
	const audit = checked.query("SELECT envelope_id, reason, quarantined_at, error_code, details, prior_state FROM outbox_quarantine").get();
	expect(columns.map((column) => column.name)).toEqual(["envelope_id", "envelope", "reason", "quarantined_at", "error_code", "details", "prior_state"]);
	expect(audit).toEqual({ envelope_id: "audit-envelope", reason: "operator quarantine", quarantined_at: 123, error_code: "UNKNOWN", details: "{}", prior_state: "pending" });
	expect((checked.query("PRAGMA user_version").get() as { readonly user_version: number }).user_version).toBe(4);
	checked.close();
});

test("persists endpoint binding and structured quarantine while removing live outbox work", () => {
	const store = createTaskStore({ path: ":memory:" });
	const endpoint = { relay: "relay", id: "origin" };
	const envelope = assignment("envelope-1", endpoint, "target");

	expect(store.getEndpointBinding()).toBeUndefined();
	store.setEndpointBinding(endpoint);
	store.putOutbox(envelope);
	store.transaction(() => {
		store.quarantineOutbox(envelope.envelopeId, {
			errorCode: "TARGET_NOT_REGISTERED",
			reason: "target is inactive",
			details: { targetId: "target" },
			quarantinedAt: 456,
		});
	});

	expect(store.getEndpointBinding()).toEqual(endpoint);
	expect(store.outbox("pending")).toEqual([]);
	expect(store.quarantinedOutbox()).toEqual([{
		envelope,
		errorCode: "TARGET_NOT_REGISTERED",
		reason: "target is inactive",
		details: { targetId: "target" },
		quarantinedAt: 456,
		priorState: "pending",
	}]);
	store.close();
});

test("preserves an existing quarantine audit row when removing a colliding live outbox record", () => {
	const store = createTaskStore({ path: ":memory:" });
	const endpoint = { relay: "relay", id: "origin" };
	const auditedEnvelope = assignment("colliding-envelope", endpoint, "audited-target");
	store.putOutbox(auditedEnvelope);
	store.transaction(() => {
		store.quarantineOutbox(auditedEnvelope.envelopeId, {
			errorCode: "OPERATOR_QUARANTINE",
			reason: "preserve this audit",
			details: { ticket: "audit-1" },
			quarantinedAt: 123,
		});
	});
	store.putOutbox(assignment("colliding-envelope", endpoint, "live-target"));

	store.transaction(() => {
		store.quarantineOutbox("colliding-envelope", {
			errorCode: "TARGET_NOT_REGISTERED",
			reason: "do not overwrite",
			details: { targetId: "live-target" },
			quarantinedAt: 456,
		});
	});

	expect(store.quarantinedOutbox()).toEqual([{
		envelope: auditedEnvelope,
		errorCode: "OPERATOR_QUARANTINE",
		reason: "preserve this audit",
		details: { ticket: "audit-1" },
		quarantinedAt: 123,
		priorState: "pending",
	}]);
	expect(store.outbox("pending")).toEqual([]);
	store.close();
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
	expect((checked.query("PRAGMA user_version").get() as { readonly user_version: number }).user_version).toBe(4);
	checked.close();
});

function assignment(envelopeId: string, source: { readonly relay: string; readonly id: string }, targetId: string): RelayEnvelope {
	return {
		envelopeId,
		protocolVersion: "pi-tasks/v2",
		source,
		target: { relay: source.relay, id: targetId },
		taskId: `task-${envelopeId}`,
		kind: "assignment",
		payload: "{}",
	};
}

function dirname(path: string): string {
	const slash = path.lastIndexOf("/");
	return path.slice(0, slash);
}
