import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { deliverTaskInbox } from "./task-inbox";
import { createWolfpackTaskCore } from "./wolfpack-task-relay";
import type { TaskCore } from "./task-core";

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1_000;
const MIN_TASK_TIMEOUT_MS = 1_000;
const MAX_TASK_TIMEOUT_MS = 86_400_000;
const BACKGROUND_POLL_MS = 5_000;
const WAIT_POLL_MS = 250;
const SUMMARY_MAX_CHARS = 1_200;

const EndpointParams = Type.Object({
	relay: Type.String({ minLength: 1, description: "relay identifier" }),
	id: Type.String({ minLength: 1, description: "opaque endpoint identifier" }),
});
const SendParams = Type.Object({
	to: EndpointParams,
	task: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
	timeoutMs: Type.Optional(Type.Integer({ minimum: MIN_TASK_TIMEOUT_MS, maximum: MAX_TASK_TIMEOUT_MS })),
});
const TaskIdParams = Type.Object({ taskId: Type.String({ minLength: 1 }) });
const WaitParams = Type.Object({ taskId: Type.String({ minLength: 1 }), timeoutMs: Type.Optional(Type.Integer({ minimum: MIN_TASK_TIMEOUT_MS, maximum: MAX_TASK_TIMEOUT_MS })) });
const MessageParams = Type.Object({ taskId: Type.String({ minLength: 1 }), type: StringEnum(["question", "answer", "information"] as const), message: Type.String({ minLength: 1, maxLength: 16 * 1024 }) });
const DoneParams = Type.Object({
	taskId: Type.String({ minLength: 1 }), status: StringEnum(["completed", "failed", "cancelled"] as const), summary: Type.String({ minLength: 1, maxLength: SUMMARY_MAX_CHARS }),
	result: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String(), retryable: Type.Boolean() })),
	artifacts: Type.Optional(Type.Array(Type.Object({ path: Type.String({ minLength: 1, description: "artifact paths are receiver-project-relative regular files" }), mimeType: Type.Optional(Type.String()), description: Type.Optional(Type.String()) }))),
});

export type ConfiguredCoreFactory = (signal?: AbortSignal) => Promise<TaskCore>;

/** Reuses a successful configured core while allowing the next lifecycle operation to retry a failed setup. */
export function createConfiguredCoreLoader(factory: ConfiguredCoreFactory): ConfiguredCoreFactory {
	let corePromise: Promise<TaskCore> | undefined;
	return async (signal?: AbortSignal): Promise<TaskCore> => {
		if (corePromise) return corePromise;
		const candidate = Promise.resolve().then(() => factory(signal));
		corePromise = candidate;
		try {
			return await candidate;
		} catch (error) {
			if (corePromise === candidate) corePromise = undefined;
			throw error;
		}
	};
}

/** Registers v2 endpoint-owned tools using a configured durable Wolfpack relay by default. */
export function registerAgentTaskTools(pi: ExtensionAPI, core: TaskCore | undefined = undefined, createCore: ConfiguredCoreFactory = (signal) => createWolfpackTaskCore({}, signal)): void {
	let inboxContext: ExtensionContext | undefined;
	let backgroundTimer: ReturnType<typeof setInterval> | undefined;
	const configuredCore: ConfiguredCoreFactory = core === undefined ? createConfiguredCoreLoader(createCore) : async (): Promise<TaskCore> => core;
	const refreshInbox = createSingleFlightInboxRefresh(async (signal) => {
		if (!inboxContext) return;
		const activeCore = await configuredCore(signal);
		await activeCore.flushOutbox(signal);
		await activeCore.evaluateTimeouts(signal);
		await deliverTaskInbox(pi, activeCore, inboxContext, signal);
	});

	pi.on("session_start", async (_event, context) => {
		inboxContext = context;
		try {
			await (await configuredCore()).connect();
			backgroundTimer = setInterval(() => {
				void refreshInbox().catch(() => {
					context.ui.setStatus("pi-tasks", context.ui.theme.fg("warning", "tasks: relay unavailable"));
				});
			}, BACKGROUND_POLL_MS);
			await refreshInbox();
		} catch {
			context.ui.setStatus("pi-tasks", context.ui.theme.fg("warning", "tasks: relay unavailable"));
		}
	});
	pi.on("agent_end", async (_event, context) => {
		inboxContext = context;
		await refreshInbox();
	});
	pi.on("session_shutdown", () => {
		if (backgroundTimer) clearInterval(backgroundTimer);
		backgroundTimer = undefined;
		inboxContext = undefined;
	});

	pi.registerTool({
		name: "agent_task_send", label: "Send Agent Task", description: "Persist an endpoint-owned task and submit its opaque assignment envelope to a relay.", parameters: SendParams,
		async execute(_id, params, signal) {
			try {
				const sent = await (await configuredCore(signal)).createTask({ target: params.to, task: params.task, timeoutMs: params.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS }, signal);
				return toolResult(sent, `## task accepted\n- task: \`${sent.taskId}\`\n- target: \`${params.to.relay}/${params.to.id}\`\n- delivery: relay acceptance only`);
			} catch (error) { return taskError(error); }
		},
		renderResult(result, _options, theme) { return new Text(theme.fg("accent", text(result))); },
	});
	pi.registerTool({
		name: "agent_task_status", label: "Task Status", description: "Read local endpoint-owned task state; status is unavailable while its origin is offline.", parameters: TaskIdParams,
		async execute(_id, params, signal) {
			try {
				const task = (await configuredCore(signal)).getTask(params.taskId);
				return task ? toolResult(task, `## task status\n- task: \`${task.taskId}\`\n- status: ${task.status}`) : taskError(new Error("unknown local task"));
			} catch (error) { return taskError(error); }
		}, renderResult(result, _options, theme) { return new Text(theme.fg("accent", text(result))); },
	});
	pi.registerTool({
		name: "agent_task_wait", label: "Wait Agent Task", description: "Wait for a locally-known endpoint-owned task to reach a terminal state.", parameters: WaitParams,
		async execute(_id, params, signal, onUpdate) {
			const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
			try {
				for (;;) {
					await refreshInbox(signal);
					const task = (await configuredCore(signal)).getTask(params.taskId);
					if (!task) return taskError(new Error("unknown local task"));
					if (terminal(task.status)) return toolResult(task, `## task status\n- task: \`${task.taskId}\`\n- status: ${task.status}`);
					if (Date.now() >= deadline) return toolResult({ taskId: params.taskId, status: task.status }, `## task wait\n- task: \`${params.taskId}\`\n- status: ${task.status}\n- wait timed out`);
					onUpdate?.({ content: [{ type: "text", text: `waiting for ${params.taskId}...` }], details: {} });
					await sleep(Math.min(WAIT_POLL_MS, deadline - Date.now()), signal);
				}
			} catch (error) { return taskError(error); }
		}, renderResult(result, _options, theme) { return new Text(theme.fg("accent", text(result))); },
	});
	pi.registerTool({
		name: "agent_task_inbox", label: "Task Inbox", description: "Read local task records after processing relay deliveries without acknowledging task lifecycle.", parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			try {
				await refreshInbox(signal);
				const tasks = (await configuredCore(signal)).listTasks();
				return toolResult({ tasks }, `## task inbox\n${tasks.map((task) => `- \`${task.taskId}\`: ${task.status}`).join("\n") || "- empty"}`);
			} catch (error) { return taskError(error); }
		},
		renderResult(result, _options, theme) { return new Text(theme.fg("accent", text(result))); },
	});
	pi.registerTool({
		name: "agent_task_message", label: "Message Agent Task", description: "Persist a message intent before relay submission.", parameters: MessageParams,
		async execute(_id, params, signal) { try { await (await configuredCore(signal)).submitIntent({ taskId: params.taskId, type: `task.${params.type}`, payload: { message: params.message } }, signal); return toolResult({ taskId: params.taskId }, `## task ${params.type}\n- task: \`${params.taskId}\``); } catch (error) { return taskError(error); } },
		renderResult(result, _options, theme) { return new Text(theme.fg("accent", text(result))); },
	});
	pi.registerTool({
		name: "agent_task_cancel", label: "Cancel Agent Task", description: "Persist cancellation before relay submission.", parameters: TaskIdParams,
		async execute(_id, params, signal) { try { await (await configuredCore(signal)).submitIntent({ taskId: params.taskId, type: "task.cancelled", payload: {} }, signal); return toolResult({ taskId: params.taskId }, `## task cancellation requested\n- task: \`${params.taskId}\``); } catch (error) { return taskError(error); } },
		renderResult(result, _options, theme) { return new Text(theme.fg("accent", text(result))); },
	});
	pi.registerTool({
		name: "agent_task_ack", label: "Acknowledge Agent Task", description: "Record parent acknowledgement as an origin-owned logical event.", parameters: TaskIdParams,
		async execute(_id, params, signal) { try { await (await configuredCore(signal)).acknowledgeParent(params.taskId, signal); return toolResult({ taskId: params.taskId }, `## task acknowledged\n- task: \`${params.taskId}\``); } catch (error) { return taskError(error); } },
		renderResult(result, _options, theme) { return new Text(theme.fg("accent", text(result))); },
	});
	pi.registerTool({
		name: "agent_task_done", label: "Complete Agent Task", description: "Persist a terminal task intent before relay submission.", parameters: DoneParams,
		async execute(_id, params, signal) {
			try {
				await (await configuredCore(signal)).submitIntent({ taskId: params.taskId, type: `task.${params.status}`, payload: { summary: params.summary, ...(params.result === undefined ? {} : { result: params.result }), ...(params.error === undefined ? {} : { error: params.error }), ...(params.artifacts === undefined ? {} : { artifacts: params.artifacts }) } }, signal);
				return { ...toolResult({ taskId: params.taskId }, `## task ${params.status}\n- task: \`${params.taskId}\`\n- ${params.summary}`), terminate: true };
			} catch (error) { return taskError(error); }
		}, renderResult(result, _options, theme) { return new Text(theme.fg("accent", text(result))); },
	});
}

export function createSingleFlightInboxRefresh(refresh: (signal?: AbortSignal) => Promise<void>): (signal?: AbortSignal) => Promise<void> {
	let inFlight: Promise<void> | undefined;
	return (signal): Promise<void> => {
		if (inFlight) return inFlight;
		const current = refresh(signal).finally(() => {
			if (inFlight === current) inFlight = undefined;
		});
		inFlight = current;
		return current;
	};
}

export default function piTasks(pi: ExtensionAPI): void {
	registerAgentTaskTools(pi);
}

function toolResult(details: unknown, markdown: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: markdown }], details };
}

function taskError(error: unknown): AgentToolResult<unknown> {
	const message = error instanceof Error ? error.message : "task operation failed";
	return toolResult({ error: { code: "TASK_ERROR", message, retryable: true } }, `## task error\n- ${message}`);
}

function terminal(status: string): boolean {
	return ["completed", "failed", "cancelled", "timed_out"].includes(status);
}

function text(result: { readonly content?: readonly unknown[] }): string {
	const first = result.content?.[0];
	return first && typeof first === "object" && "type" in first && first.type === "text" && "text" in first && typeof first.text === "string" ? first.text : "";
}

async function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error("task wait was cancelled");
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, Math.max(1, milliseconds));
		signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("task wait was cancelled")); }, { once: true });
	});
}
