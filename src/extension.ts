import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { buildAssignment, compactTaskResult, getCurrentSessionName } from "./protocol";
import {
	ackTask,
	cancelTask,
	completeTask,
	createOrReuseDispatchedTask,
	expireTaskIfOverdue,
	listInbox,
	readTask,
	readTaskResult,
	waitForTask,
} from "./store";
import { DEFAULT_TIMEOUT_MS, TASK_PROTOCOL_VERSION, type TaskResultPayload, type TerminalTaskStatus } from "./types";

const WAIT_POLL_MS = 250;
const BACKGROUND_POLL_MS = 5000;

const SendParams = Type.Object({
	to: Type.String({ description: "Target Wolfpack session name or stable sessionId" }),
	task: Type.String({ description: "Task instructions to send to the target session" }),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 86_400_000 })),
	idempotencyKey: Type.Optional(Type.String()),
});

const TaskIdParams = Type.Object({
	taskId: Type.String({ description: "Task id, e.g. task_..." }),
});

const WaitParams = Type.Object({
	taskId: Type.String({ description: "Task id, e.g. task_..." }),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 86_400_000 })),
});

const InboxParams = Type.Object({
	ack: Type.Optional(Type.Boolean({ default: false })),
	includeAcknowledged: Type.Optional(Type.Boolean({ default: false })),
});

const CancelParams = Type.Object({
	taskId: Type.String({ description: "Task id, e.g. task_..." }),
	reason: Type.Optional(Type.String()),
});

const DoneParams = Type.Object({
	taskId: Type.String({ description: "Task id from the assignment" }),
	status: StringEnum(["completed", "failed", "cancelled", "rejected"] as const),
	summary: Type.String({ description: "Compact summary, max 1200 chars" }),
	error: Type.Optional(
		Type.Object({
			code: Type.String(),
			message: Type.String(),
			retryable: Type.Boolean(),
		}),
	),
	result: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	artifacts: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String(),
				path: Type.Optional(Type.String()),
				mimeType: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
			}),
		),
	),
});

export default function wolfpackPiTasks(pi: ExtensionAPI) {
	let backgroundTimer: ReturnType<typeof setInterval> | undefined;
	const notifiedTaskIds = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		const sessionName = getCurrentSessionName(process.env);
		ctx.ui.setStatus("wolfpack-tasks", ctx.ui.theme.fg("dim", `tasks: ${sessionName}`));

		backgroundTimer = setInterval(() => {
			void refreshInboxStatus(ctx.cwd, sessionName, ctx).catch(() => {
				ctx.ui.setStatus("wolfpack-tasks", ctx.ui.theme.fg("warning", "tasks: unavailable"));
			});
		}, BACKGROUND_POLL_MS);

		await refreshInboxStatus(ctx.cwd, sessionName, ctx).catch(() => undefined);
	});

	pi.on("session_shutdown", async () => {
		if (backgroundTimer) {
			clearInterval(backgroundTimer);
			backgroundTimer = undefined;
		}
	});

	async function refreshInboxStatus(projectDir: string, sessionName: string, ctx: ExtensionContext): Promise<void> {
		const inbox = await listInbox(projectDir, sessionName, { includeAcknowledged: false });
		const count = inbox.length;
		ctx.ui.setStatus("wolfpack-tasks", ctx.ui.theme.fg(count > 0 ? "accent" : "dim", `tasks: ${count} inbox`));
		for (const task of inbox) {
			if (notifiedTaskIds.has(task.id)) continue;
			notifiedTaskIds.add(task.id);
			ctx.ui.notify(`task ${task.id} ${task.status}: ${task.targetSession}`, task.status === "completed" ? "info" : "warning");
		}
	}

	pi.registerTool({
		name: "agent_task_send",
		label: "Send Agent Task",
		description: "Send a structured task to another Wolfpack Pi session and return immediately without waiting.",
		promptSnippet: "Send nonblocking structured tasks to other Wolfpack Pi sessions",
		promptGuidelines: [
			"Use agent_task_send instead of natural-language polling when delegating work to another Wolfpack Pi session.",
			"After agent_task_send returns, keep working unless the user explicitly asks to wait for the task.",
		],
		parameters: SendParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parentSession = getCurrentSessionName(process.env);

			const createdTask = await createOrReuseDispatchedTask({
				projectDir: ctx.cwd,
				parentSession,
				targetSession: params.to,
				taskText: params.task,
				assignment: (taskId: string) => buildAssignment({ taskId, fromSession: parentSession, instructions: params.task }),
				timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				idempotencyKey: params.idempotencyKey,
				targetTaskProtocol: TASK_PROTOCOL_VERSION,
			});
			const task = createdTask.task;
			if (!createdTask.created) {
				return taskToolResult(compactTaskResult(task, await readTaskResult(ctx.cwd, task.id)));
			}

			const assignment = buildAssignment({ taskId: task.id, fromSession: parentSession, instructions: params.task });
			const dispatch = await pi.exec("wolfpack", ["session", "send", params.to, assignment], { signal });
			if (dispatch.code !== 0) {
				const rejected = await completeTask(ctx.cwd, task.id, "rejected", {
					summary: `dispatch failed: ${dispatch.stderr || dispatch.stdout || "wolfpack session send failed"}`,
					error: {
						code: "dispatch_failed",
						message: dispatch.stderr || dispatch.stdout || "wolfpack session send failed",
						retryable: true,
					},
				});
				return taskToolResult(compactTaskResult(rejected, await readTaskResult(ctx.cwd, task.id)));
			}

			return taskToolResult({
				schemaVersion: 1,
				taskId: task.id,
				status: task.status,
				summary: `dispatched to ${params.to}`,
				artifacts: [task.assignmentRef].filter((value): value is string => Boolean(value)),
				error: null,
			});
		},
		renderResult(result, _options, theme) {
			return new Text(theme.fg("accent", getText(result)));
		},
	});

	pi.registerTool({
		name: "agent_task_status",
		label: "Task Status",
		description: "Read compact structured status for a task.",
		parameters: TaskIdParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await expireTaskIfOverdue(ctx.cwd, params.taskId);
			return taskToolResult(compactTaskResult(task, await readTaskResult(ctx.cwd, params.taskId)));
		},
	});

	pi.registerTool({
		name: "agent_task_wait",
		label: "Wait Agent Task",
		description: "Wait in tool code for a task to become terminal. Use only when the user wants the result now.",
		parameters: WaitParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const waitMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const sessionName = getCurrentSessionName(process.env);
			const progressTimer = setInterval(() => {
				onUpdate?.({ content: [{ type: "text", text: `waiting for ${params.taskId}...` }], details: {} });
			}, 2000);
			try {
				const task = await waitForTask(ctx.cwd, params.taskId, { timeoutMs: waitMs, pollMs: WAIT_POLL_MS, ackParentSession: sessionName });
				return taskToolResult(compactTaskResult(task, await readTaskResult(ctx.cwd, params.taskId)));
			} catch (error) {
				const task = await readTask(ctx.cwd, params.taskId);
				return taskToolResult({
					schemaVersion: 1,
					taskId: task.id,
					status: task.status,
					summary: error instanceof Error ? error.message : "task wait failed",
					artifacts: task.resultRef ? [task.resultRef] : [],
					error: { code: "wait_timeout", message: "task wait timed out", retryable: true },
				});
			} finally {
				clearInterval(progressTimer);
			}
		},
	});

	pi.registerTool({
		name: "agent_task_inbox",
		label: "Task Inbox",
		description: "List terminal tasks for this parent session. Results are only shown to the model when this tool is called.",
		parameters: InboxParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionName = getCurrentSessionName(process.env);
			const tasks = await listInbox(ctx.cwd, sessionName, { includeAcknowledged: params.includeAcknowledged ?? false });
			const compact = [];
			for (const task of tasks) {
				compact.push(compactTaskResult(task, await readTaskResult(ctx.cwd, task.id)));
				if (params.ack) {
					await ackTask(ctx.cwd, task.id, sessionName);
				}
			}
			return taskToolResult({ tasks: compact });
		},
	});

	pi.registerTool({
		name: "agent_task_cancel",
		label: "Cancel Agent Task",
		description: "Cancel a non-terminal task in the shared task store.",
		parameters: CancelParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await cancelTask(ctx.cwd, params.taskId, params.reason);
			return taskToolResult(compactTaskResult(task, await readTaskResult(ctx.cwd, params.taskId)));
		},
	});

	pi.registerTool({
		name: "agent_task_done",
		label: "Complete Agent Task",
		description: "Finish an assigned Wolfpack task with structured status. Use exactly once as the final action for assigned tasks.",
		promptSnippet: "Complete an assigned Wolfpack task with a terminating structured result",
		promptGuidelines: [
			"Use agent_task_done exactly once as the final action for wolfpack.agent_task.assignment.v1 tasks.",
			"After calling agent_task_done, do not emit another assistant response in prose.",
		],
		parameters: DoneParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const status = params.status as TerminalTaskStatus;
			const payload: TaskResultPayload = {
				summary: params.summary,
				...(params.result && { result: params.result }),
				...(params.error && { error: params.error }),
				...(params.artifacts && { artifacts: params.artifacts }),
			};
			const task = await completeTask(ctx.cwd, params.taskId, status, payload);
			return {
				...taskToolResult(compactTaskResult(task, await readTaskResult(ctx.cwd, params.taskId))),
				terminate: true,
			};
		},
	});
}

function taskToolResult(details: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: JSON.stringify(details) }],
		details,
	};
}

function getText(result: { readonly content?: readonly unknown[] }): string {
	const first = result.content?.[0];
	if (!first || typeof first !== "object" || !("type" in first) || first.type !== "text" || !("text" in first)) {
		return "";
	}
	return typeof first.text === "string" ? first.text : "";
}
