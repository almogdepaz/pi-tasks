import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDefaultTaskCommunicationLayer } from "../src/extension";
import { createFilesystemTaskStore } from "../src/stores/filesystem";
import { createWolfpackTaskTransport, getCurrentWolfpackSessionName } from "../src/transports/wolfpack";

let projectDir: string;

beforeEach(async () => {
	projectDir = await mkdtemp(join(tmpdir(), "pi-task-communication-"));
});

afterEach(async () => {
	await rm(projectDir, { recursive: true, force: true });
});

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

	test("wolfpack session identity is transport-specific", () => {
		expect(getCurrentWolfpackSessionName({ WOLFPACK_SESSION_NAME: "parent" })).toBe("parent");
		expect(getCurrentWolfpackSessionName({})).toBe("unknown-session");
	});
});
