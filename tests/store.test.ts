import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	ackTask,
	appendProgress,
	cancelTask,
	completeTask,
	createDispatchedTask,
	listInbox,
	readTask,
	createOrReuseDispatchedTask,
	waitForTask,
} from "../src/store";
import type { TaskResultPayload } from "../src/types";

let projectDir: string;

beforeEach(async () => {
	projectDir = await mkdtemp(join(tmpdir(), "pi-tasks-"));
});

afterEach(async () => {
	await rm(projectDir, { recursive: true, force: true });
});

describe("task store", () => {
	test("creates a dispatched task with assignment and event history", async () => {
		const task = await createDispatchedTask({
			projectDir,
			parentSession: "parent",
			targetSession: "worker",
			taskText: "inspect auth",
			assignment: { taskId: "placeholder", instructions: "inspect auth" },
			timeoutMs: 30_000,
		});

		const saved = await readTask(projectDir, task.id);

		expect(saved.status).toBe("dispatched");
		expect(saved.parentSession).toBe("parent");
		expect(saved.targetSession).toBe("worker");
		expect(saved.assignmentRef).toBe(`file://.pi/tasks/${task.id}/assignment.json`);
	});

	test("reuses idempotent dispatched tasks instead of creating duplicates", async () => {
		const first = await createOrReuseDispatchedTask({
			projectDir,
			parentSession: "parent",
			targetSession: "worker",
			taskText: "inspect auth",
			assignment: { taskId: "placeholder", instructions: "inspect auth" },
			timeoutMs: 30_000,
			idempotencyKey: "same-request",
		});
		const second = await createOrReuseDispatchedTask({
			projectDir,
			parentSession: "parent",
			targetSession: "worker",
			taskText: "inspect auth again",
			assignment: { taskId: "placeholder", instructions: "inspect auth again" },
			timeoutMs: 30_000,
			idempotencyKey: "same-request",
		});

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.task.id).toBe(first.task.id);
		expect(second.task.taskText).toBe("inspect auth");
	});

	test("first terminal completion wins and conflicting completion is rejected", async () => {
		const task = await createDispatchedTask({
			projectDir,
			parentSession: "parent",
			targetSession: "worker",
			taskText: "inspect auth",
			assignment: { taskId: "placeholder", instructions: "inspect auth" },
			timeoutMs: 30_000,
		});
		const result: TaskResultPayload = { summary: "auth is fine", result: { ok: true } };

		const completed = await completeTask(projectDir, task.id, "completed", result);
		const duplicate = await completeTask(projectDir, task.id, "completed", result);

		expect(completed.status).toBe("completed");
		expect(duplicate.status).toBe("completed");
		await expect(
			completeTask(projectDir, task.id, "failed", {
				summary: "nope",
				error: { code: "conflict", message: "conflict", retryable: false },
			}),
		).rejects.toThrow("terminal task conflict");
	});

	test("inbox lists unacknowledged terminal tasks for the parent and ack removes them", async () => {
		const task = await createDispatchedTask({
			projectDir,
			parentSession: "parent",
			targetSession: "worker",
			taskText: "inspect auth",
			assignment: { taskId: "placeholder", instructions: "inspect auth" },
			timeoutMs: 30_000,
		});
		await completeTask(projectDir, task.id, "completed", { summary: "done" });

		const inbox = await listInbox(projectDir, "parent", { includeAcknowledged: false });
		expect(inbox.map((item) => item.id)).toEqual([task.id]);

		await ackTask(projectDir, task.id, "parent");
		const afterAck = await listInbox(projectDir, "parent", { includeAcknowledged: false });
		expect(afterAck).toEqual([]);
	});

	test("wait resolves when task becomes terminal", async () => {
		const task = await createDispatchedTask({
			projectDir,
			parentSession: "parent",
			targetSession: "worker",
			taskText: "inspect auth",
			assignment: { taskId: "placeholder", instructions: "inspect auth" },
			timeoutMs: 30_000,
		});

		const waiting = waitForTask(projectDir, task.id, { timeoutMs: 1_000, pollMs: 10 });
		await completeTask(projectDir, task.id, "completed", { summary: "done" });

		await expect(waiting).resolves.toMatchObject({ status: "completed" });
	});

	test("wait can acknowledge returned terminal tasks for the parent", async () => {
		const task = await createDispatchedTask({
			projectDir,
			parentSession: "parent",
			targetSession: "worker",
			taskText: "inspect auth",
			assignment: { taskId: "placeholder", instructions: "inspect auth" },
			timeoutMs: 30_000,
		});

		const waiting = waitForTask(projectDir, task.id, { timeoutMs: 1_000, pollMs: 10, ackParentSession: "parent" });
		await completeTask(projectDir, task.id, "completed", { summary: "done" });
		await expect(waiting).resolves.toMatchObject({ status: "completed", parentAckAt: expect.any(String) });

		const inbox = await listInbox(projectDir, "parent", { includeAcknowledged: false });
		expect(inbox).toEqual([]);
	});

	test("progress and cancellation update task state without terminal prose", async () => {
		const task = await createDispatchedTask({
			projectDir,
			parentSession: "parent",
			targetSession: "worker",
			taskText: "inspect auth",
			assignment: { taskId: "placeholder", instructions: "inspect auth" },
			timeoutMs: 30_000,
		});

		await appendProgress(projectDir, task.id, "reading files");
		const cancelled = await cancelTask(projectDir, task.id, "user changed priority");

		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.error?.code).toBe("cancelled");
	});

	test("wait marks overdue non-terminal tasks as timed out", async () => {
		const task = await createDispatchedTask({
			projectDir,
			parentSession: "parent",
			targetSession: "worker",
			taskText: "inspect auth",
			assignment: { taskId: "placeholder", instructions: "inspect auth" },
			timeoutMs: 1000,
		});

		const timedOut = await waitForTask(projectDir, task.id, { timeoutMs: 1500, pollMs: 25 });

		expect(timedOut.status).toBe("timed_out");
		expect(timedOut.error?.code).toBe("timed_out");
	});
});
