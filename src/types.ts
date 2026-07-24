export const TASK_PROTOCOL_VERSION = "pi.agentTask.v1";
export const TASK_ASSIGNMENT_TYPE = "pi.task.assignment.v1";
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const SUMMARY_MAX_CHARS = 1200;
export const PROGRESS_MAX_CHARS = 4000;
export const ON_COMPLETE_PROMPT_MAX_CHARS = 4000;

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

export interface TaskWorkflowMetadata {
	readonly phaseId?: string;
	readonly issueId?: string;
	readonly role?: "planner" | "implementor" | "reviewer" | "integrator" | "observer" | string;
	readonly verificationTier?: "smoke" | "focused" | "cluster" | "phaseGate" | string;
	readonly rootCause?: string;
}

export interface ContextRef {
	readonly path: string;
	readonly selector?: string;
	readonly required?: boolean;
	readonly purpose?: string;
}

export interface TaskPreflightRequirement {
	readonly requiredProjectDir?: string;
	readonly requiredModel?: string;
	readonly requireIdle?: boolean;
	readonly requireReachable?: boolean;
}

export interface TaskPreflightCheck {
	readonly name: string;
	readonly status: "passed" | "failed" | "unavailable" | "skipped";
	readonly message?: string;
	readonly source: "pi" | "transport" | "store" | "protocol";
}

export interface TaskPreflightResult {
	readonly ok: boolean;
	readonly checks: readonly TaskPreflightCheck[];
	readonly targetSession: string;
}

export interface TaskVerificationEvidence {
	readonly command?: string;
	readonly status: "passed" | "failed" | "skipped" | "not_run";
	readonly exitCode?: number;
	readonly summary?: string;
	readonly durationMs?: number;
}

export interface StructuredTaskResult {
	readonly issueId?: string;
	readonly verdict: "completed" | "changes_required" | "rejected" | "failed" | "cancelled";
	readonly changedFiles?: readonly string[];
	readonly verification?: readonly TaskVerificationEvidence[];
	readonly blockers?: readonly {
		readonly id?: string;
		readonly severity?: string;
		readonly evidence: string;
		readonly minimalFix?: string;
	}[];
	readonly risks?: readonly string[];
	readonly next?: string;
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
	readonly onCompletePrompt: string | undefined;
	readonly metadata: TaskWorkflowMetadata | undefined;
	readonly contextRefs: readonly ContextRef[] | undefined;
	readonly preflight: TaskPreflightResult | undefined;
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
	readonly onCompletePrompt?: string;
	readonly metadata?: TaskWorkflowMetadata;
	readonly contextRefs?: readonly ContextRef[];
	readonly preflight?: TaskPreflightResult;
	readonly tasksDir?: string;
}

export interface CreateRejectedTaskInput {
	readonly projectDir: string;
	readonly parentSession: string;
	readonly targetSession: string;
	readonly taskText: string;
	readonly timeoutMs: number;
	readonly summary: string;
	readonly error: TaskError;
	readonly idempotencyKey?: string;
	readonly targetTaskProtocol?: typeof TASK_PROTOCOL_VERSION;
	readonly onCompletePrompt?: string;
	readonly metadata?: TaskWorkflowMetadata;
	readonly contextRefs?: readonly ContextRef[];
	readonly preflight?: TaskPreflightResult;
	readonly tasksDir?: string;
}

export interface ListInboxOptions {
	readonly includeAcknowledged: boolean;
}

export interface WaitForTaskOptions {
	readonly timeoutMs: number;
	readonly pollMs: number;
	readonly ackParentSession?: string;
}
