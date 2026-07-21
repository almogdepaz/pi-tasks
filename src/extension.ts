import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { buildBackgroundTaskNotificationPrompt, selectUnpromptedTerminalTasks } from "./auto-notify";
import type { TaskCommunicationLayer } from "./task-communication";
import { createFilesystemTaskStore } from "./stores/filesystem";
import { createWolfpackTaskTransport, WOLFPACK_TASKS_DIR } from "./transports/wolfpack";
import { buildAssignment, compactTaskResult } from "./protocol";
import type { AgentTaskRecord, TaskResultPayload, TerminalTaskStatus } from "./types";
import { DEFAULT_TIMEOUT_MS, TASK_PROTOCOL_VERSION } from "./types";

const WAIT_POLL_MS = 250;
const BACKGROUND_POLL_MS = 5000;

const SendParams = Type.Object({
	to: Type.String({ description: "Target session, worker, or transport-specific address" }),
	task: Type.String({ description: "Task instructions to send to the target" }),
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

export function createDefaultTaskCommunicationLayer(pi: ExtensionAPI): TaskCommunicationLayer {
	return {
		store: createFilesystemTaskStore({ tasksDir: WOLFPACK_TASKS_DIR }),
		transport: createWolfpackTaskTransport({
			exec: (command, args, options) => pi.exec(command, [...args], options),
		}),
	};
}

export function registerAgentTaskTools(pi: ExtensionAPI, communication: TaskCommunicationLayer): void {
	const { store, transport } = communication;
	let backgroundTimer: ReturnType<typeof setInterval> | undefined;
	const notifiedTaskIds = new Set<string>();
	const autoPromptedTaskIds = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		const sessionName = transport.getCurrentSessionName(process.env);
		ctx.ui.setStatus("wolfpack-tasks", ctx.ui.theme.fg("dim", `tasks: ${sessionName}`));

		backgroundTimer = setInterval(() => {
			void refreshInboxStatus(ctx.cwd, sessionName, ctx).catch(() => {
				ctx.ui.setStatus("wolfpack-tasks", ctx.ui.theme.fg("warning", "tasks: unavailable"));
			});
		}, BACKGROUND_POLL_MS);

		await refreshInboxStatus(ctx.cwd, sessionName, ctx).catch(() => undefined);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const sessionName = transport.getCurrentSessionName(process.env);
		setTimeout(() => {
			void refreshInboxStatus(ctx.cwd, sessionName, ctx).catch(() => undefined);
		}, 0);
	});

	pi.on("session_shutdown", async () => {
		if (backgroundTimer) {
			clearInterval(backgroundTimer);
			backgroundTimer = undefined;
		}
	});

	async function refreshInboxStatus(projectDir: string, sessionName: string, ctx: ExtensionContext): Promise<void> {
		const inbox = await store.listInbox(projectDir, sessionName, { includeAcknowledged: false });
		const count = inbox.length;
		ctx.ui.setStatus("wolfpack-tasks", ctx.ui.theme.fg(count > 0 ? "accent" : "dim", `tasks: ${count} inbox`));
		for (const task of inbox) {
			if (notifiedTaskIds.has(task.id)) continue;
			notifiedTaskIds.add(task.id);
			ctx.ui.notify(`task ${task.id} ${task.status}: ${task.targetSession}`, task.status === "completed" ? "info" : "warning");
		}
		triggerIdleInboxPrompt(inbox, ctx);
	}

	function triggerIdleInboxPrompt(inbox: readonly AgentTaskRecord[], ctx: ExtensionContext): void {
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

		const tasksToPrompt = selectUnpromptedTerminalTasks(inbox, autoPromptedTaskIds);
		if (tasksToPrompt.length === 0) return;

		try {
			pi.sendUserMessage(buildBackgroundTaskNotificationPrompt(tasksToPrompt));
			for (const task of tasksToPrompt) {
				autoPromptedTaskIds.add(task.id);
			}
		} catch {
			ctx.ui.notify("task results ready; parent is busy, will retry", "info");
		}
	}

	pi.registerTool({
		name: "agent_task_send",
		label: "Send Agent Task",
		description: "Send a structured task to another agent/session/worker and return immediately without waiting.",
		promptSnippet: "Send nonblocking structured tasks to other agents/sessions/workers",
		promptGuidelines: [
			"Use agent_task_send instead of natural-language polling when delegating work to another agent/session/worker",
			"After agent_task_send returns, keep working unless the user explicitly asks to wait for the task.",
		],
		parameters: SendParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parentSession = transport.getCurrentSessionName(process.env);

			const createdTask = await store.createOrReuseDispatchedTask({
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
				return taskToolResult(compactTaskResult(task, await store.readTaskResult(ctx.cwd, task.id)));
			}

			const assignment = buildAssignment({ taskId: task.id, fromSession: parentSession, instructions: params.task });
			const dispatch = await transport.dispatchTask({ projectDir: ctx.cwd, task, target: params.to, assignment, signal });
			if (!dispatch.ok) {
				const rejected = await store.completeTask(ctx.cwd, task.id, "rejected", {
					summary: `dispatch failed: ${dispatch.message}`,
					error: {
						code: "dispatch_failed",
						message: dispatch.message,
						retryable: dispatch.retryable,
					},
				});
				return taskToolResult(compactTaskResult(rejected, await store.readTaskResult(ctx.cwd, task.id)));
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
			const task = await store.expireTaskIfOverdue(ctx.cwd, params.taskId);
			return taskToolResult(compactTaskResult(task, await store.readTaskResult(ctx.cwd, params.taskId)));
		},
	});

	pi.registerTool({
		name: "agent_task_wait",
		label: "Wait Agent Task",
		description: "Wait in tool code for a task to become terminal. Use only when the user wants the result now.",
		parameters: WaitParams,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const waitMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const sessionName = transport.getCurrentSessionName(process.env);
			const progressTimer = setInterval(() => {
				onUpdate?.({ content: [{ type: "text", text: `waiting for ${params.taskId}...` }], details: {} });
			}, 2000);
			try {
				const task = await store.waitForTask(ctx.cwd, params.taskId, { timeoutMs: waitMs, pollMs: WAIT_POLL_MS, ackParentSession: sessionName });
				return taskToolResult(compactTaskResult(task, await store.readTaskResult(ctx.cwd, params.taskId)));
			} catch (error) {
				const task = await store.readTask(ctx.cwd, params.taskId);
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
			const sessionName = transport.getCurrentSessionName(process.env);
			const tasks = await store.listInbox(ctx.cwd, sessionName, { includeAcknowledged: params.includeAcknowledged ?? false });
			const compact = [];
			for (const task of tasks) {
				compact.push(compactTaskResult(task, await store.readTaskResult(ctx.cwd, task.id)));
				if (params.ack) {
					await store.ackTask(ctx.cwd, task.id, sessionName);
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
			const task = await store.cancelTask(ctx.cwd, params.taskId, params.reason);
			return taskToolResult(compactTaskResult(task, await store.readTaskResult(ctx.cwd, params.taskId)));
		},
	});

	pi.registerTool({
		name: "agent_task_done",
		label: "Complete Agent Task",
		description: "Finish an assigned task with structured status. Use exactly once as the final action for assigned tasks.",
		promptSnippet: "Complete an assigned task with a terminating structured result",
		promptGuidelines: [
			"Use agent_task_done exactly once as the final action for pi.task.assignment.v1 tasks.",
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
			const task = await store.completeTask(ctx.cwd, params.taskId, status, payload);
			return {
				...taskToolResult(compactTaskResult(task, await store.readTaskResult(ctx.cwd, params.taskId))),
				terminate: true,
			};
		},
	});
}

export default function piTasks(pi: ExtensionAPI): void {
	registerAgentTaskTools(pi, createDefaultTaskCommunicationLayer(pi));
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
