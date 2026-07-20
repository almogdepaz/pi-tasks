import { describe, expect, test } from "bun:test";

import { buildBackgroundTaskNotificationPrompt, selectUnpromptedTerminalTasks } from "../src/auto-notify";
import type { AgentTaskRecord } from "../src/types";

function task(id: string, summary = "done"): AgentTaskRecord {
	return {
		schemaVersion: 1,
		id,
		projectDir: "/tmp/project",
		parentSession: "parent",
		targetSession: "worker",
		taskText: summary,
		status: "completed",
		createdAt: "2026-07-20T00:00:00.000Z",
		updatedAt: "2026-07-20T00:00:01.000Z",
		dispatchedAt: "2026-07-20T00:00:00.000Z",
		runningAt: undefined,
		completedAt: "2026-07-20T00:00:01.000Z",
		timeoutAt: "2026-07-20T00:10:00.000Z",
		timeoutMs: 600_000,
		idempotencyKey: undefined,
		assignmentRef: `file://.wolfpack/tasks/${id}/assignment.json`,
		resultRef: `file://.wolfpack/tasks/${id}/result.json`,
		parentAckAt: undefined,
		targetTaskProtocol: "pi.agentTask.v1",
		error: undefined,
	};
}

describe("background task auto notification", () => {
	test("selects only tasks that have not already triggered an idle parent notification", () => {
		const alreadyPrompted = new Set(["task_seen"]);

		expect(selectUnpromptedTerminalTasks([task("task_seen"), task("task_new")], alreadyPrompted).map((item) => item.id)).toEqual([
			"task_new",
		]);
	});

	test("builds an idle parent prompt that consumes inbox through the structured tool", () => {
		const prompt = buildBackgroundTaskNotificationPrompt([task("task_one", "review done"), task("task_two", "tests done")]);

		expect(prompt).toContain("background wolfpack task results are ready");
		expect(prompt).toContain("agent_task_inbox");
		expect(prompt).toContain("ack: true");
		expect(prompt).toContain("task_one");
		expect(prompt).toContain("task_two");
		expect(prompt).toContain("do not call agent_task_wait");
	});
});
