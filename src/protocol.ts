import {
	SUMMARY_MAX_CHARS,
	TASK_ASSIGNMENT_TYPE,
	TASK_PROTOCOL_VERSION,
	type AgentTaskRecord,
	type StoredTaskResult,
	type TaskError,
} from "./types";

export interface AssignmentInput {
	readonly taskId: string;
	readonly fromSession: string;
	readonly instructions: string;
}

export interface AssignmentEnvelope {
	readonly type: typeof TASK_ASSIGNMENT_TYPE;
	readonly taskId: string;
	readonly fromSession: string;
	readonly instructions: string;
	readonly finishByCalling: "agent_task_done";
	readonly taskProtocol: typeof TASK_PROTOCOL_VERSION;
	readonly resultContract: {
		readonly summaryMaxChars: number;
		readonly noFinalProseAfterTool: true;
		readonly completionIsStructuredOnly: true;
	};
}

export interface CompactTaskResult {
	readonly schemaVersion: 1;
	readonly taskId: string;
	readonly status: AgentTaskRecord["status"];
	readonly summary: string;
	readonly artifacts: readonly string[];
	readonly error: TaskError | null;
}

export function buildAssignment(input: AssignmentInput): string {
	const envelope: AssignmentEnvelope = {
		type: TASK_ASSIGNMENT_TYPE,
		taskId: input.taskId,
		fromSession: input.fromSession,
		instructions: input.instructions,
		finishByCalling: "agent_task_done",
		taskProtocol: TASK_PROTOCOL_VERSION,
		resultContract: {
			summaryMaxChars: SUMMARY_MAX_CHARS,
			noFinalProseAfterTool: true,
			completionIsStructuredOnly: true,
		},
	};

	return [
		"structured task assignment:",
		"```json",
		JSON.stringify(envelope, null, 2),
		"```",
		"finish by calling agent_task_done exactly once. do not mark completion in prose.",
	].join("\n");
}

export function compactTaskResult(task: AgentTaskRecord, result: StoredTaskResult | undefined): CompactTaskResult {
	return {
		schemaVersion: 1,
		taskId: task.id,
		status: task.status,
		summary: result?.summary ?? task.error?.message ?? task.status,
		artifacts: task.resultRef ? [task.resultRef] : [],
		error: result?.error ?? task.error ?? null,
	};
}

