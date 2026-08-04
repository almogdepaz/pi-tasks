import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerAgentTaskTools } from "../src/extension";

interface RegisteredTool {
	readonly name: string;
	readonly execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: { readonly cwd: string }) => Promise<{ readonly details: unknown; readonly terminate?: boolean }>;
}

function toolsFor(client: Record<string, unknown>): Record<string, RegisteredTool> {
	const tools: Record<string, RegisteredTool> = {};
	registerAgentTaskTools({ on: () => undefined, registerTool(tool: unknown) { const registered = tool as RegisteredTool; tools[registered.name] = registered; } } as unknown as ExtensionAPI, client as never);
	return tools;
}

function clientFixture() {
	const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
	const task = {
		taskId: "task-1", source: { machine: "machine", sessionId: "parent-id" }, target: { machine: "machine", sessionId: "receiver-id" }, task: "implement narrowly", createdAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T01:00:00.000Z",
	};
	return {
		calls,
		async send(input: unknown) { calls.push({ name: "send", input }); return { taskId: "task-1", eventId: "event-1", sequence: "1", warnings: [] }; },
		async status() { return { task, status: "active", events: [], warnings: [] }; },
		async sessionStatus() { return { sessionId: "receiver-id" }; },
		async message(input: unknown) { calls.push({ name: "message", input }); return { taskId: "task-1", eventId: "event-2", sequence: "2", warnings: [] }; },
		async complete(input: unknown) { calls.push({ name: "complete", input }); return { taskId: "task-1", eventId: "event-3", sequence: "3", warnings: [] }; },
		async cancel(taskId: string) { calls.push({ name: "cancel", input: taskId }); return { taskId, eventId: "event-4", sequence: "4", warnings: [] }; },
		async inbox() { return { events: [], nextCursor: "0", hasMore: false }; },
		async ack(taskId: string) { calls.push({ name: "ack", input: taskId }); return { taskId, eventId: "event-5", sequence: "5", warnings: [] }; },
		async delivered() { return { taskId: "task-1", eventId: "event-1", sequence: "1", warnings: [] }; },
	};
}

describe("gateway-backed task tools", () => {
	test("sends the locked gateway request shape without legacy fields", async () => {
		const client = clientFixture();
		const tools = toolsFor(client);
		await tools.agent_task_send!.execute("call", {
			to: { machine: "local", sessionId: "receiver" }, task: "implement narrowly",
			context: { summary: "## progress\n- scoped", refs: [{ path: "src/extension.ts", selector: "L1", purpose: "scope" }] },
			role: "implementer", preflight: { requiredProject: "repo" }, metadata: { issueId: "task-3" }, onCompletePrompt: "review diff", timeoutMs: 1_000, idempotencyKey: "send-1",
		}, new AbortController().signal, undefined, { cwd: "/tmp/project" });
		expect(client.calls).toEqual([{
			name: "send",
			input: {
				to: { machine: "local", sessionId: "receiver" }, task: "implement narrowly",
				context: { summary: "## progress\n- scoped", refs: [{ path: "src/extension.ts", selector: "L1", purpose: "scope" }] },
				role: "implementer", preflight: { requiredProject: "repo" }, metadata: { issueId: "task-3" }, onCompletePrompt: "review diff", timeoutMs: 1_000, idempotencyKey: "send-1",
			},
		}]);
	});

	test("terminates only receiver questions and every done response, not parent questions", async () => {
		const receiverClient = clientFixture();
		const receiverTools = toolsFor(receiverClient);
		const receiverQuestion = await receiverTools.agent_task_message!.execute("call", { taskId: "task-1", type: "question", message: "which test?" }, new AbortController().signal, undefined, { cwd: "/tmp/project" });
		expect(receiverQuestion.terminate).toBe(true);

		const parentClient = clientFixture();
		parentClient.sessionStatus = async () => ({ sessionId: "parent-id" });
		const parentTools = toolsFor(parentClient);
		const parentQuestion = await parentTools.agent_task_message!.execute("call", { taskId: "task-1", type: "question", message: "which test?" }, new AbortController().signal, undefined, { cwd: "/tmp/project" });
		expect(parentQuestion.terminate).toBeUndefined();

		const done = await receiverTools.agent_task_done!.execute("call", { taskId: "task-1", status: "completed", summary: "implemented", result: { changedFiles: ["src/extension.ts"] } }, new AbortController().signal, undefined, { cwd: "/tmp/project" });
		expect(done.terminate).toBe(true);
		expect(receiverClient.calls.at(-1)).toEqual({ name: "complete", input: { taskId: "task-1", status: "completed", result: { summary: "implemented", result: { changedFiles: ["src/extension.ts"] } } } });
	});
});
