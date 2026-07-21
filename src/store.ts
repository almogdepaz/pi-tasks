import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	PROGRESS_MAX_CHARS,
	SUMMARY_MAX_CHARS,
	type AgentTaskRecord,
	type CreateDispatchedTaskInput,
	type ListInboxOptions,
	type StoredTaskResult,
	type TaskError,
	type TaskEvent,
	type TaskEventType,
	type TaskResultPayload,
	type TaskStatus,
	type TerminalTaskStatus,
	type WaitForTaskOptions,
} from "./types";

export const DEFAULT_TASKS_DIR = ".pi/tasks";

export interface TaskStoreScope {
	readonly projectDir: string;
	readonly tasksDir?: string;
}

export type TaskStoreLocation = string | TaskStoreScope;

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5000;

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled", "timed_out", "rejected"]);

export interface CreateOrReuseDispatchedTaskResult {
	readonly task: AgentTaskRecord;
	readonly created: boolean;
}

export function getTasksRoot(location: TaskStoreLocation): string {
	return join(getProjectDir(location), getTasksDir(location));
}

export function getTaskDir(location: TaskStoreLocation, taskId: string): string {
	return join(getTasksRoot(location), taskId);
}

function getProjectDir(location: TaskStoreLocation): string {
	return typeof location === "string" ? location : location.projectDir;
}

function getTasksDir(location: TaskStoreLocation): string {
	return typeof location === "string" ? DEFAULT_TASKS_DIR : location.tasksDir ?? DEFAULT_TASKS_DIR;
}

function taskRef(location: TaskStoreLocation, taskId: string, fileName: string): string {
	return `file://${getTasksDir(location)}/${taskId}/${fileName}`;
}

export function isTerminalStatus(status: TaskStatus): status is TerminalTaskStatus {
	return TERMINAL_STATUSES.has(status);
}

export function normalizeTimeoutMs(timeoutMs: number | undefined): number {
	const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
		throw new Error(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
	}
	return value;
}

function inputLocation(input: CreateDispatchedTaskInput): TaskStoreScope {
	return { projectDir: input.projectDir, tasksDir: input.tasksDir };
}

export async function createOrReuseDispatchedTask(input: CreateDispatchedTaskInput): Promise<CreateOrReuseDispatchedTaskResult> {
	const idempotencyKey = input.idempotencyKey;
	if (!idempotencyKey) {
		return { task: await createDispatchedTask(input), created: true };
	}

	const location = inputLocation(input);
	return withIdempotencyLock(location, input.parentSession, idempotencyKey, async () => {
		const existing = await findTaskByIdempotencyKey(location, input.parentSession, idempotencyKey);
		if (existing) {
			return { task: existing, created: false };
		}
		return { task: await createDispatchedTask(input), created: true };
	});
}

export async function createDispatchedTask(input: CreateDispatchedTaskInput): Promise<AgentTaskRecord> {
	const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
	const id = `task_${randomUUID().replace(/-/g, "")}`;
	const now = new Date().toISOString();
	const timeoutAt = new Date(Date.parse(now) + timeoutMs).toISOString();
	const location = inputLocation(input);
	const dir = getTaskDir(location, id);
	await mkdir(dir, { recursive: true });

	const assignment = typeof input.assignment === "function" ? input.assignment(id) : withTaskId(input.assignment, id);
	await writeJsonAtomic(join(dir, "assignment.json"), assignment);

	const task: AgentTaskRecord = {
		schemaVersion: 1,
		id,
		projectDir: input.projectDir,
		parentSession: input.parentSession,
		targetSession: input.targetSession,
		taskText: input.taskText,
		status: "dispatched",
		createdAt: now,
		updatedAt: now,
		dispatchedAt: now,
		runningAt: undefined,
		completedAt: undefined,
		timeoutAt,
		timeoutMs,
		idempotencyKey: input.idempotencyKey,
		assignmentRef: taskRef(location, id, "assignment.json"),
		resultRef: undefined,
		parentAckAt: undefined,
		targetTaskProtocol: input.targetTaskProtocol,
		error: undefined,
	};

	await writeJsonAtomic(join(dir, "task.json"), task);
	await appendTaskEvent(location, id, "task.created", "store", { parentSession: input.parentSession });
	await appendTaskEvent(location, id, "task.dispatched", "store", { targetSession: input.targetSession });
	return task;
}

export async function readTask(location: TaskStoreLocation, taskId: string): Promise<AgentTaskRecord> {
	return readJson<AgentTaskRecord>(join(getTaskDir(location, taskId), "task.json"));
}

export async function readTaskResult(location: TaskStoreLocation, taskId: string): Promise<StoredTaskResult | undefined> {
	return readExistingResult(location, taskId);
}

export async function expireTaskIfOverdue(location: TaskStoreLocation, taskId: string): Promise<AgentTaskRecord> {
	const current = await readTask(location, taskId);
	if (isTerminalStatus(current.status) || Date.now() < Date.parse(current.timeoutAt)) {
		return current;
	}
	return writeTerminalTask(location, taskId, "timed_out", {
		summary: "task timed out",
		error: { code: "timed_out", message: "task timed out", retryable: true },
	});
}

export async function appendProgress(location: TaskStoreLocation, taskId: string, message: string): Promise<AgentTaskRecord> {
	const progress = limitString(message, PROGRESS_MAX_CHARS, "progress");
	return withTaskLock(location, taskId, async () => {
		const current = await readTask(location, taskId);
		if (isTerminalStatus(current.status)) {
			return current;
		}
		const now = new Date().toISOString();
		const next = updateTask(current, {
			status: current.status === "dispatched" ? "running" : current.status,
			runningAt: current.runningAt ?? now,
			updatedAt: now,
		});
		await writeTask(location, next);
		if (current.status === "dispatched") {
			await appendTaskEventUnlocked(location, taskId, "task.running", "target-tool", {});
		}
		await appendTaskEventUnlocked(location, taskId, "task.progress", "target-tool", { message: progress });
		return next;
	});
}

export async function completeTask(
	location: TaskStoreLocation,
	taskId: string,
	status: TerminalTaskStatus,
	payload: TaskResultPayload,
): Promise<AgentTaskRecord> {
	return writeTerminalTask(location, taskId, status, payload);
}

export async function cancelTask(location: TaskStoreLocation, taskId: string, reason: string | undefined): Promise<AgentTaskRecord> {
	return writeTerminalTask(location, taskId, "cancelled", {
		summary: reason ?? "cancelled",
		error: { code: "cancelled", message: reason ?? "cancelled", retryable: false },
	});
}

export async function ackTask(location: TaskStoreLocation, taskId: string, parentSession: string): Promise<AgentTaskRecord> {
	return withTaskLock(location, taskId, async () => {
		const current = await readTask(location, taskId);
		if (current.parentSession !== parentSession) {
			throw new Error("task parent mismatch");
		}
		if (!isTerminalStatus(current.status)) {
			return current;
		}
		if (current.parentAckAt) {
			return current;
		}
		const now = new Date().toISOString();
		const next = updateTask(current, { parentAckAt: now, updatedAt: now });
		await writeTask(location, next);
		await appendTaskEventUnlocked(location, taskId, "task.acknowledged", "parent-tool", { parentSession });
		return next;
	});
}

export async function listInbox(
	location: TaskStoreLocation,
	parentSession: string,
	options: ListInboxOptions,
): Promise<readonly AgentTaskRecord[]> {
	const root = getTasksRoot(location);
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		return [];
	}

	const tasks: AgentTaskRecord[] = [];
	for (const entry of entries) {
		if (!entry.startsWith("task_")) continue;
		try {
			const task = await expireTaskIfOverdue(location, entry);
			if (task.parentSession !== parentSession) continue;
			if (!isTerminalStatus(task.status)) continue;
			if (!options.includeAcknowledged && task.parentAckAt) continue;
			tasks.push(task);
		} catch {
			// Ignore partial/corrupt task directories; direct status reads surface errors.
		}
	}

	return tasks.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

export async function waitForTask(
	location: TaskStoreLocation,
	taskId: string,
	options: WaitForTaskOptions,
): Promise<AgentTaskRecord> {
	const deadline = Date.now() + options.timeoutMs;
	while (Date.now() <= deadline) {
		const task = await expireTaskIfOverdue(location, taskId);
		if (isTerminalStatus(task.status)) {
			return options.ackParentSession ? ackTask(location, taskId, options.ackParentSession) : task;
		}
		await sleep(options.pollMs);
	}
	throw new Error("task wait timed out");
}

async function writeTerminalTask(
	location: TaskStoreLocation,
	taskId: string,
	status: TerminalTaskStatus,
	payload: TaskResultPayload,
): Promise<AgentTaskRecord> {
	return withTaskLock(location, taskId, async () => {
		const current = await readTask(location, taskId);
		const now = new Date().toISOString();
		const cleanPayload = normalizeResultPayload(payload);
		const result: StoredTaskResult = {
			...cleanPayload,
			schemaVersion: 1,
			taskId,
			status,
			completedAt: now,
		};

		if (isTerminalStatus(current.status)) {
			const existing = await readExistingResult(location, taskId);
			if (current.status === status && existing && terminalPayloadKey(existing) === terminalPayloadKey(result)) {
				return current;
			}
			throw new Error("terminal task conflict");
		}

		await writeJsonAtomic(join(getTaskDir(location, taskId), "result.json"), result);
		const next = updateTask(current, {
			status,
			updatedAt: now,
			completedAt: now,
			resultRef: taskRef(location, taskId, "result.json"),
			error: cleanPayload.error,
		});
		await writeTask(location, next);
		await appendTaskEventUnlocked(location, taskId, `task.${status}` as TaskEventType, "target-tool", {
			summary: cleanPayload.summary,
			error: cleanPayload.error,
		});
		return next;
	});
}

async function readExistingResult(location: TaskStoreLocation, taskId: string): Promise<StoredTaskResult | undefined> {
	try {
		return await readJson<StoredTaskResult>(join(getTaskDir(location, taskId), "result.json"));
	} catch {
		return undefined;
	}
}

function normalizeResultPayload(payload: TaskResultPayload): TaskResultPayload {
	return {
		summary: limitString(payload.summary, SUMMARY_MAX_CHARS, "summary"),
		...(payload.result && { result: payload.result }),
		...(payload.error && { error: payload.error }),
		...(payload.artifacts && { artifacts: payload.artifacts }),
	};
}

function updateTask(current: AgentTaskRecord, patch: Partial<AgentTaskRecord>): AgentTaskRecord {
	return { ...current, ...patch };
}

async function writeTask(location: TaskStoreLocation, task: AgentTaskRecord): Promise<void> {
	await writeJsonAtomic(join(getTaskDir(location, task.id), "task.json"), task);
}

async function appendTaskEvent(
	location: TaskStoreLocation,
	taskId: string,
	type: TaskEventType,
	source: TaskEvent["source"],
	payload: unknown,
): Promise<void> {
	await withTaskLock(location, taskId, async () => {
		await appendTaskEventUnlocked(location, taskId, type, source, payload);
	});
}

async function appendTaskEventUnlocked(
	location: TaskStoreLocation,
	taskId: string,
	type: TaskEventType,
	source: TaskEvent["source"],
	payload: unknown,
): Promise<void> {
	const eventsPath = join(getTaskDir(location, taskId), "events.jsonl");
	const seq = (await readLastEventSeq(eventsPath)) + 1;
	const event: TaskEvent = {
		schemaVersion: 1,
		seq,
		taskId,
		type,
		createdAt: new Date().toISOString(),
		source,
		payload,
	};
	await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

async function readLastEventSeq(eventsPath: string): Promise<number> {
	try {
		const content = await readFile(eventsPath, "utf8");
		const lines = content.trim().split("\n").filter(Boolean);
		const lastLine = lines.at(-1);
		if (!lastLine) return 0;
		const last = JSON.parse(lastLine) as { readonly seq?: unknown };
		return typeof last.seq === "number" ? last.seq : 0;
	} catch {
		return 0;
	}
}

async function findTaskByIdempotencyKey(
	location: TaskStoreLocation,
	parentSession: string,
	idempotencyKey: string,
): Promise<AgentTaskRecord | undefined> {
	const root = getTasksRoot(location);
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		return undefined;
	}

	for (const entry of entries) {
		if (!entry.startsWith("task_")) continue;
		try {
			const task = await readTask(location, entry);
			if (task.parentSession === parentSession && task.idempotencyKey === idempotencyKey) {
				return task;
			}
		} catch {
			// Ignore partial/corrupt task directories; direct status reads surface errors.
		}
	}
	return undefined;
}

async function withIdempotencyLock<T>(
	location: TaskStoreLocation,
	parentSession: string,
	idempotencyKey: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lockName = createHash("sha256").update(`${parentSession}\0${idempotencyKey}`).digest("hex");
	const lockPath = join(getTasksRoot(location), `.idempotency-${lockName}.lock`);
	await mkdir(getTasksRoot(location), { recursive: true });
	return withLockPath(lockPath, fn);
}

async function withTaskLock<T>(location: TaskStoreLocation, taskId: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = join(getTaskDir(location, taskId), ".lock");
	return withLockPath(lockPath, fn);
}

async function withLockPath<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			await mkdir(lockPath);
			break;
		} catch (error) {
			if (!isFileExistsError(error) || Date.now() > deadline) {
				throw error;
			}
			await sleep(LOCK_RETRY_MS);
		}
	}

	try {
		return await fn();
	} finally {
		await rm(lockPath, { recursive: true, force: true });
	}
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(tmpPath, path);
}

async function readJson<T>(path: string): Promise<T> {
	const content = await readFile(path, "utf8");
	return JSON.parse(content) as T;
}

function withTaskId(assignment: unknown, taskId: string): unknown {
	if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) {
		return assignment;
	}
	return { ...assignment, taskId };
}

function terminalPayloadKey(result: StoredTaskResult): string {
	return stableStringify({
		status: result.status,
		summary: result.summary,
		result: result.result,
		error: result.error,
		artifacts: result.artifacts,
	});
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

function limitString(value: string, maxChars: number, label: string): string {
	if (value.length <= maxChars) {
		return value;
	}
	throw new Error(`${label} exceeds ${maxChars} characters`);
}

function isFileExistsError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
