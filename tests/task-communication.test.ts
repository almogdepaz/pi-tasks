import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDefaultTaskCommunicationLayer, registerAgentTaskTools } from "../src/extension";
import { createFilesystemTaskStore } from "../src/stores/filesystem";
import { createWolfpackTaskTransport, getCurrentWolfpackSessionName } from "../src/transports/wolfpack";
import type { TaskCommunicationLayer } from "../src/task-communication";

let projectDir: string;

beforeEach(async () => {
	projectDir = await mkdtemp(join(tmpdir(), "pi-task-communication-"));
});

afterEach(async () => {
	await rm(projectDir, { recursive: true, force: true });
});

interface RegisteredTool {
	readonly name: string;
	readonly execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: { readonly cwd: string },
	) => Promise<{ readonly details: unknown }>;
}

function registerToolsForTest(communication: TaskCommunicationLayer): Record<string, RegisteredTool> {
	const tools: Record<string, RegisteredTool> = {};
	registerAgentTaskTools(
		{
			on: () => undefined,
			registerTool: (tool: unknown) => {
				const registered = tool as RegisteredTool;
				tools[registered.name] = registered;
			},
		} as unknown as ExtensionAPI,
		communication,
	);
	return tools;
}

describe("task store and transport split", () => {
	test("filesystem store is generic storage without dispatch or identity", async () => {
		const store = createFilesystemTaskStore({ tasksDir: ".pi/tasks" });

		const { task } = await store.createOrReuseDispatchedTask({
			projectDir,
			parentSession: "parent",
			targetSession: "worker",
			taskText: "inspect auth",
			assignment: { instructions: "inspect auth" },
			timeoutMs: 30_000,
		});

		expect(task.assignmentRef).toBe(`file://.pi/tasks/${task.id}/assignment.json`);
		expect(await store.readTask(projectDir, task.id)).toMatchObject({ id: task.id, status: "dispatched" });
		expect("dispatchTask" in store).toBe(false);
		expect("getCurrentSessionName" in store).toBe(false);
	});

	test("wolfpack transport only handles identity and assignment delivery", async () => {
		const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
		const transport = createWolfpackTaskTransport({
			exec: async (command, args) => {
				calls.push({ command, args });
				return { code: 0, stdout: "", stderr: "" };
			},
		});

		const result = await transport.dispatchTask({
			projectDir,
			task: {
				schemaVersion: 1,
				id: "task_abc",
				projectDir,
				parentSession: "parent",
				targetSession: "worker",
				taskText: "inspect auth",
				status: "dispatched",
				createdAt: "2026-07-21T00:00:00.000Z",
				updatedAt: "2026-07-21T00:00:00.000Z",
				dispatchedAt: "2026-07-21T00:00:00.000Z",
				runningAt: undefined,
				completedAt: undefined,
				timeoutAt: "2026-07-21T00:30:00.000Z",
				timeoutMs: 30_000,
				idempotencyKey: undefined,
				assignmentRef: undefined,
				resultRef: undefined,
				parentAckAt: undefined,
				targetTaskProtocol: "pi.agentTask.v1",
				onCompletePrompt: undefined,
				metadata: undefined,
				contextRefs: undefined,
				preflight: undefined,
				error: undefined,
			},
			target: "worker",
			assignment: "assignment text",
		});

		expect(result).toEqual({ ok: true });
		expect(transport.getCurrentSessionName({ WOLFPACK_SESSION_NAME: "parent" })).toBe("parent");
		expect(calls).toEqual([{ command: "wolfpack", args: ["session", "send", "worker", "assignment text"] }]);
		expect("createOrReuseDispatchedTask" in transport).toBe(false);
	});

	test("default communication layer uses generic storage with the included transport", () => {
		const layer = createDefaultTaskCommunicationLayer({
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		} as unknown as ExtensionAPI);

		expect(layer.store.tasksDir).toBe(".pi/tasks");
		expect(layer.transport.name).toBe("wolfpack");
	});

	test("agent_task_send rejects failed preflight without dispatching assignment text", async () => {
		let dispatchCount = 0;
		const store = createFilesystemTaskStore({ tasksDir: ".pi/tasks" });
		const tools = registerToolsForTest({
			store,
			transport: {
				name: "fake",
				getCurrentSessionName: () => "parent",
				preflightTarget: async () => ({
					ok: false,
					targetSession: "worker",
					checks: [{ name: "reachable", status: "failed", source: "transport", message: "dead session" }],
				}),
				dispatchTask: async () => {
					dispatchCount += 1;
					return { ok: true };
				},
			},
		});

		const send = tools.agent_task_send;
		if (!send) throw new Error("agent_task_send not registered");
		const response = await send.execute(
			"call_1",
			{ to: "worker", task: "inspect auth", preflight: { requireReachable: true } },
			new AbortController().signal,
			undefined,
			{ cwd: projectDir },
		);
		const details = response.details as { readonly taskId: string; readonly status: string; readonly error: { readonly code: string } | null };
		const task = await store.readTask(projectDir, details.taskId);

		expect(details.status).toBe("rejected");
		expect(details.error?.code).toBe("preflight_failed");
		expect(task.assignmentRef).toBeUndefined();
		expect(task.preflight?.checks).toContainEqual({ name: "reachable", status: "failed", source: "transport", message: "dead session" });
		expect(dispatchCount).toBe(0);
	});

	test("wolfpack session identity is transport-specific", () => {
		expect(getCurrentWolfpackSessionName({ WOLFPACK_SESSION_NAME: "parent" })).toBe("parent");
		expect(getCurrentWolfpackSessionName({})).toBe("unknown-session");
	});
});
