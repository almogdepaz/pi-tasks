import {
	SUMMARY_MAX_CHARS,
	TASK_ASSIGNMENT_TYPE,
	TASK_PROTOCOL_VERSION,
	type AgentTaskRecord,
	type ContextRef,
	type StoredTaskResult,
	type StructuredTaskResult,
	type TaskError,
	type TaskWorkflowMetadata,
} from "./types";

export interface AssignmentInput {
	readonly taskId: string;
	readonly fromSession: string;
	readonly instructions: string;
	readonly metadata?: TaskWorkflowMetadata;
	readonly contextRefs?: readonly ContextRef[];
}

export interface AssignmentEnvelope {
	readonly type: typeof TASK_ASSIGNMENT_TYPE;
	readonly taskId: string;
	readonly fromSession: string;
	readonly instructions: string;
	readonly metadata?: TaskWorkflowMetadata;
	readonly contextRefs?: readonly ContextRef[];
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
	readonly onCompletePrompt: string | undefined;
	readonly error: TaskError | null;
}

export function buildAssignment(input: AssignmentInput): string {
	const envelope: AssignmentEnvelope = {
		type: TASK_ASSIGNMENT_TYPE,
		taskId: input.taskId,
		fromSession: input.fromSession,
		instructions: input.instructions,
		...(input.metadata && { metadata: input.metadata }),
		...(input.contextRefs && { contextRefs: input.contextRefs }),
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
		onCompletePrompt: task.onCompletePrompt,
		error: result?.error ?? task.error ?? null,
	};
}

const STRUCTURED_VERDICTS = new Set<StructuredTaskResult["verdict"]>([
	"completed",
	"changes_required",
	"rejected",
	"failed",
	"cancelled",
]);

const VERIFICATION_STATUSES = new Set(["passed", "failed", "skipped", "not_run"]);

export type StructuredTaskResultValidation = { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] };

export function validateStructuredTaskResult(value: unknown): StructuredTaskResultValidation {
	if (!isRecord(value)) {
		return { ok: false, errors: ["result must be an object"] };
	}

	const errors: string[] = [];
	if (!STRUCTURED_VERDICTS.has(value.verdict as StructuredTaskResult["verdict"])) {
		errors.push("verdict must be one of completed, changes_required, rejected, failed, cancelled");
	}

	if ("verification" in value) {
		if (!Array.isArray(value.verification)) {
			errors.push("verification must be an array");
		} else {
			value.verification.forEach((item, index) => {
				if (!isRecord(item) || !VERIFICATION_STATUSES.has(String(item.status))) {
					errors.push(`verification[${index}].status is invalid`);
				}
			});
		}
	}

	if ("blockers" in value) {
		if (!Array.isArray(value.blockers)) {
			errors.push("blockers must be an array");
		} else {
			value.blockers.forEach((item, index) => {
				if (!isRecord(item) || typeof item.evidence !== "string" || item.evidence.length === 0) {
					errors.push(`blockers[${index}].evidence is required`);
				}
			});
		}
	}

	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

