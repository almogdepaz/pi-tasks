import { describe, expect, test } from "bun:test";

import { buildAssignment, compactTaskResult } from "../src/protocol";
import type { AgentTaskRecord, StoredTaskResult } from "../src/types";

const baseTask: AgentTaskRecord = {
	schemaVersion: 1,
	id: "task_abc",
	projectDir: "/repo",
	parentSession: "parent",
	targetSession: "worker",
	taskText: "inspect auth",
	status: "completed",
	createdAt: "2026-07-19T00:00:00.000Z",
	updatedAt: "2026-07-19T00:00:01.000Z",
	dispatchedAt: "2026-07-19T00:00:00.000Z",
	runningAt: undefined,
	completedAt: "2026-07-19T00:00:01.000Z",
	timeoutAt: "2026-07-19T00:30:00.000Z",
	timeoutMs: 30_000,
	idempotencyKey: undefined,
	assignmentRef: "file://.pi/tasks/task_abc/assignment.json",
	resultRef: "file://.pi/tasks/task_abc/result.json",
	parentAckAt: undefined,
	targetTaskProtocol: "pi.agentTask.v1",
	error: undefined,
};

describe("protocol helpers", () => {
	test("builds transport-neutral assignment text that requires agent_task_done and forbids prose completion", () => {
		const assignment = buildAssignment({ taskId: "task_abc", fromSession: "parent", instructions: "inspect auth" });

		expect(assignment).toContain('"type": "pi.task.assignment.v1"');
		expect(assignment).toContain('"finishByCalling": "agent_task_done"');
		expect(assignment).toContain('"completionIsStructuredOnly": true');
		expect(assignment).not.toContain("wolfpack");
	});

	test("compacts task results for parent model consumption", () => {
		const result: StoredTaskResult = {
			schemaVersion: 1,
			taskId: "task_abc",
			status: "completed",
			completedAt: "2026-07-19T00:00:01.000Z",
			summary: "done",
			result: { ok: true },
		};
		const compact = compactTaskResult(baseTask, result);

		expect(compact).toEqual({
			schemaVersion: 1,
			taskId: "task_abc",
			status: "completed",
			summary: "done",
			artifacts: ["file://.pi/tasks/task_abc/result.json"],
			error: null,
		});
	});

});
