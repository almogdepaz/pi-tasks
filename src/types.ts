export const TASK_PROTOCOL_VERSION = "pi.agentTask.v1";
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const SUMMARY_MAX_CHARS = 1200;
export const PROGRESS_MAX_CHARS = 4000;

export type TaskStatus =
	| "pending"
	| "dispatched"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "rejected";

export type TerminalTaskStatus = "completed" | "failed" | "cancelled" | "timed_out" | "rejected";

export type TaskEventType =
	| "task.created"
	| "task.dispatched"
	| "task.running"
	| "task.progress"
	| "task.completed"
	| "task.failed"
	| "task.cancel_requested"
	| "task.cancelled"
	| "task.timed_out"
	| "task.rejected"
	| "task.acknowledged";

export interface TaskError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
}

export interface AgentTaskRecord {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly projectDir: string;
	readonly parentSession: string;
	readonly targetSession: string;
	readonly taskText: string;
	readonly status: TaskStatus;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly dispatchedAt: string | undefined;
	readonly runningAt: string | undefined;
	readonly completedAt: string | undefined;
	readonly timeoutAt: string;
	readonly timeoutMs: number;
	readonly idempotencyKey: string | undefined;
	readonly assignmentRef: string | undefined;
	readonly resultRef: string | undefined;
	readonly parentAckAt: string | undefined;
	readonly targetTaskProtocol: typeof TASK_PROTOCOL_VERSION | undefined;
	readonly error: TaskError | undefined;
}

export interface TaskEvent {
	readonly schemaVersion: 1;
	readonly seq: number;
	readonly taskId: string;
	readonly type: TaskEventType;
	readonly createdAt: string;
	readonly source: "store" | "parent-tool" | "target-tool";
	readonly payload: unknown;
}

export interface TaskResultPayload {
	readonly summary: string;
	readonly result?: Record<string, unknown>;
	readonly error?: TaskError;
	readonly artifacts?: readonly TaskArtifact[];
}

export interface TaskArtifact {
	readonly name: string;
	readonly path?: string;
	readonly mimeType?: string;
	readonly description?: string;
}

export interface StoredTaskResult extends TaskResultPayload {
	readonly schemaVersion: 1;
	readonly taskId: string;
	readonly status: TerminalTaskStatus;
	readonly completedAt: string;
}

export interface CreateDispatchedTaskInput {
	readonly projectDir: string;
	readonly parentSession: string;
	readonly targetSession: string;
	readonly taskText: string;
	readonly assignment: unknown | ((taskId: string) => unknown);
	readonly timeoutMs: number;
	readonly idempotencyKey?: string;
	readonly targetTaskProtocol?: typeof TASK_PROTOCOL_VERSION;
}

export interface ListInboxOptions {
	readonly includeAcknowledged: boolean;
}

export interface WaitForTaskOptions {
	readonly timeoutMs: number;
	readonly pollMs: number;
	readonly ackParentSession?: string;
}
