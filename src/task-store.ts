import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { openSqliteDatabase } from "./sqlite-database";
import type { SqliteDatabase } from "./sqlite-database";
import type { RelayEnvelope, TaskEvent, TaskRecord } from "./task-protocol";

const SCHEMA_VERSION = 3;
const OWNER_ONLY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const ENDPOINT_GENERATION_STATE_KEY = "endpoint_generation";

export interface TaskStoreOptions {
	readonly path?: string;
}

export interface OutboxRecord {
	readonly envelope: RelayEnvelope;
	readonly state: "pending" | "accepted";
}

export interface TaskStore {
	transaction<T>(operation: () => T): T;
	putTask(task: Omit<TaskRecord, "events">): void;
	getTask(taskId: string): TaskRecord | undefined;
	listTasks(): readonly TaskRecord[];
	setStatus(taskId: string, status: TaskRecord["status"]): void;
	appendEvent(event: TaskEvent): boolean;
	putOutbox(envelope: RelayEnvelope): void;
	outbox(state: OutboxRecord["state"]): readonly OutboxRecord[];
	markOutboxAccepted(envelopeId: string): void;
	persistInbox(envelope: RelayEnvelope, cursor: string): boolean;
	getReceiveCursor(): string;
	setReceiveCursor(cursor: string): void;
	putIntent(intentId: string, taskId: string, envelopeId: string): void;
	putInsertionReceipt(taskId: string, eventId: string): boolean;
	getEndpointGeneration(): string | undefined;
	setEndpointGeneration(generation: string): void;
	close(): void;
}

export function createTaskStore(options: TaskStoreOptions = {}): TaskStore {
	const path = options.path ?? join(homedir(), ".pi", "tasks", "v2", "tasks.sqlite");
	preparePath(path);
	const database = openSqliteDatabase(path);
	database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	migrate(database);

	const store: TaskStore = {
		transaction(operation) {
			return database.transaction(operation)();
		},
		putTask(task) {
			database.query(`INSERT INTO tasks (task_id, protocol_version, origin_relay, origin_id, target_relay, target_id, task, created_at, expires_at, status)
				VALUES ($taskId, $protocolVersion, $originRelay, $originId, $targetRelay, $targetId, $task, $createdAt, $expiresAt, $status)
				ON CONFLICT(task_id) DO NOTHING`).run(taskRow(task));
		},
		getTask(taskId) {
			const row = database.query("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as TaskRow | null;
			if (!row) return undefined;
			const eventRows = database.query("SELECT * FROM events WHERE task_id = ? ORDER BY CAST(sequence AS INTEGER), event_id").all(taskId) as EventRow[];
			return taskFromRow(row, eventRows);
		},
		listTasks() {
			const rows = database.query("SELECT * FROM tasks ORDER BY created_at, task_id").all() as TaskRow[];
			const events = database.query("SELECT * FROM events ORDER BY CAST(sequence AS INTEGER), event_id").all() as EventRow[];
			const eventsByTask = new Map<string, EventRow[]>();
			for (const event of events) {
				const current = eventsByTask.get(event.task_id) ?? [];
				current.push(event);
				eventsByTask.set(event.task_id, current);
			}
			return rows.map((row) => taskFromRow(row, eventsByTask.get(row.task_id) ?? []));
		},
		setStatus(taskId, status) {
			database.query("UPDATE tasks SET status = ? WHERE task_id = ?").run(status, taskId);
		},
		appendEvent(event) {
			const result = database.query(`INSERT INTO events (event_id, task_id, type, sequence, source_relay, source_id, target_relay, target_id, occurred_at, payload)
				VALUES ($eventId, $taskId, $type, $sequence, $sourceRelay, $sourceId, $targetRelay, $targetId, $occurredAt, $payload)
				ON CONFLICT(event_id) DO NOTHING`).run(eventRow(event));
			return result.changes === 1;
		},
		putOutbox(envelope) {
			database.query("INSERT INTO outbox (envelope_id, envelope, state) VALUES (?, ?, 'pending') ON CONFLICT(envelope_id) DO NOTHING").run(envelope.envelopeId, JSON.stringify(envelope));
		},
		outbox(state) {
			const rows = database.query("SELECT envelope FROM outbox WHERE state = ? ORDER BY rowid").all(state) as Array<{ readonly envelope: string }>;
			return rows.map((row) => ({ envelope: parseEnvelope(row.envelope), state }));
		},
		markOutboxAccepted(envelopeId) {
			database.query("UPDATE outbox SET state = 'accepted' WHERE envelope_id = ?").run(envelopeId);
		},
		persistInbox(envelope, cursor) {
			const result = database.query("INSERT INTO inbox (envelope_id, cursor, envelope) VALUES (?, ?, ?) ON CONFLICT(envelope_id) DO NOTHING").run(envelope.envelopeId, cursor, JSON.stringify(envelope));
			return result.changes === 1;
		},
		getReceiveCursor() {
			const row = database.query("SELECT value FROM relay_state WHERE name = 'receive_cursor'").get() as { readonly value: string } | null;
			return row?.value ?? "0";
		},
		setReceiveCursor(cursor) {
			database.query("INSERT INTO relay_state (name, value) VALUES ('receive_cursor', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(cursor);
		},
		putIntent(intentId, taskId, envelopeId) {
			database.query("INSERT INTO intents (intent_id, task_id, envelope_id) VALUES (?, ?, ?) ON CONFLICT(intent_id) DO NOTHING").run(intentId, taskId, envelopeId);
		},
		putInsertionReceipt(taskId, eventId) {
			const result = database.query("INSERT INTO insertion_receipts (task_id, event_id) VALUES (?, ?) ON CONFLICT(task_id, event_id) DO NOTHING").run(taskId, eventId);
			return result.changes === 1;
		},
		getEndpointGeneration() {
			const row = database.query("SELECT value FROM relay_state WHERE name = ?").get(ENDPOINT_GENERATION_STATE_KEY) as { readonly value: string } | null;
			return row?.value;
		},
		setEndpointGeneration(generation) {
			database.query("INSERT INTO relay_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(ENDPOINT_GENERATION_STATE_KEY, generation);
		},
		close() { database.close(); },
	};
	return store;
}

interface TaskRow {
	readonly task_id: string;
	readonly protocol_version: string;
	readonly origin_relay: string;
	readonly origin_id: string;
	readonly target_relay: string;
	readonly target_id: string;
	readonly task: string;
	readonly created_at: number;
	readonly expires_at: number;
	readonly status: string;
}

interface EventRow {
	readonly event_id: string;
	readonly task_id: string;
	readonly type: string;
	readonly sequence: string;
	readonly source_relay: string;
	readonly source_id: string;
	readonly target_relay: string;
	readonly target_id: string;
	readonly occurred_at: number;
	readonly payload: string;
}

function migrate(database: SqliteDatabase): void {
	const version = database.query("PRAGMA user_version").get() as { readonly user_version: number };
	if (version.user_version > SCHEMA_VERSION) throw new Error("task store schema is newer than this pi-tasks version");
	if (version.user_version === 0) {
		database.exec(`
			CREATE TABLE tasks (task_id TEXT PRIMARY KEY, protocol_version TEXT NOT NULL, origin_relay TEXT NOT NULL, origin_id TEXT NOT NULL, target_relay TEXT NOT NULL, target_id TEXT NOT NULL, task TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL);
			CREATE TABLE events (event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(task_id), type TEXT NOT NULL, sequence TEXT NOT NULL, source_relay TEXT NOT NULL, source_id TEXT NOT NULL, target_relay TEXT NOT NULL, target_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, payload TEXT NOT NULL);
			CREATE TABLE outbox (envelope_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending', 'accepted')));
			CREATE TABLE inbox (envelope_id TEXT PRIMARY KEY, cursor TEXT NOT NULL, envelope TEXT NOT NULL);
			CREATE TABLE intents (intent_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, envelope_id TEXT NOT NULL);
			CREATE TABLE relay_state (name TEXT PRIMARY KEY, value TEXT NOT NULL);
			PRAGMA user_version = 1;
		`);
	}
	if (version.user_version <= 1) {
		database.exec(`
			CREATE INDEX IF NOT EXISTS tasks_origin_expiry ON tasks (origin_relay, origin_id, status, expires_at);
			CREATE INDEX IF NOT EXISTS inbox_cursor ON inbox (cursor);
			PRAGMA user_version = 2;
		`);
	}
	if (version.user_version <= 2) {
		database.exec(`
			CREATE TABLE insertion_receipts (task_id TEXT NOT NULL REFERENCES tasks(task_id), event_id TEXT NOT NULL, PRIMARY KEY (task_id, event_id));
			PRAGMA user_version = 3;
		`);
	}
}

function preparePath(path: string): void {
	if (path === ":memory:") return;
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: OWNER_ONLY_MODE });
	const directoryMode = statSync(directory).mode & 0o777;
	if ((directoryMode & 0o077) !== 0) throw new Error(`task store directory is not owner-only: ${directory}`);
	if (existsSync(path)) {
		const fileMode = statSync(path).mode & 0o777;
		if ((fileMode & 0o077) !== 0) throw new Error(`task store file is not owner-only: ${path}`);
	} else {
		writeFileSync(path, "", { mode: OWNER_ONLY_FILE_MODE });
		chmodSync(path, OWNER_ONLY_FILE_MODE);
	}
}

function taskRow(task: Omit<TaskRecord, "events">): Record<string, string | number> {
	return {
		taskId: task.taskId, protocolVersion: task.protocolVersion, originRelay: task.origin.relay, originId: task.origin.id,
		targetRelay: task.target.relay, targetId: task.target.id, task: task.task, createdAt: task.createdAt, expiresAt: task.expiresAt, status: task.status,
	};
}

function taskFromRow(row: TaskRow, events: readonly EventRow[]): TaskRecord {
	return {
		taskId: row.task_id,
		protocolVersion: row.protocol_version,
		origin: { relay: row.origin_relay, id: row.origin_id },
		target: { relay: row.target_relay, id: row.target_id },
		task: row.task,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		status: row.status as TaskRecord["status"],
		events: events.map(eventFromRow),
	};
}

function eventRow(event: TaskEvent): Record<string, string | number> {
	return {
		eventId: event.eventId, taskId: event.taskId, type: event.type, sequence: event.sequence,
		sourceRelay: event.source.relay, sourceId: event.source.id, targetRelay: event.target.relay, targetId: event.target.id,
		occurredAt: event.occurredAt, payload: JSON.stringify(event.payload),
	};
}

function eventFromRow(row: EventRow): TaskEvent {
	return {
		eventId: row.event_id, taskId: row.task_id, type: row.type, sequence: row.sequence,
		source: { relay: row.source_relay, id: row.source_id }, target: { relay: row.target_relay, id: row.target_id },
		occurredAt: row.occurred_at, payload: parseRecord(row.payload),
	};
}

function parseEnvelope(value: string): RelayEnvelope {
	return JSON.parse(value) as RelayEnvelope;
}

function parseRecord(value: string): Record<string, unknown> {
	return JSON.parse(value) as Record<string, unknown>;
}
