import { describe, expect, test } from "bun:test";

import { buildAssignment, compactTaskResult, validateStructuredTaskResult } from "../src/protocol";
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
	onCompletePrompt: undefined,
	metadata: undefined,
	contextRefs: undefined,
	preflight: undefined,
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

	test("includes structured workflow metadata and context refs outside assignment instructions", () => {
		const assignment = buildAssignment({
			taskId: "task_abc",
			fromSession: "parent",
			instructions: "inspect auth",
			metadata: { phaseId: "phase-1", issueId: "auth-boundary", role: "reviewer", verificationTier: "focused" },
			contextRefs: [{ path: ".plans/current.md", selector: "L10-L20", required: true, purpose: "task scope" }],
		});
		const envelope = JSON.parse(assignment.match(/```json\n(?<json>[\s\S]*?)\n```/)?.groups?.json ?? "{}");

		expect(envelope.instructions).toBe("inspect auth");
		expect(envelope.metadata).toEqual({
			phaseId: "phase-1",
			issueId: "auth-boundary",
			role: "reviewer",
			verificationTier: "focused",
		});
		expect(envelope.contextRefs).toEqual([
			{ path: ".plans/current.md", selector: "L10-L20", required: true, purpose: "task scope" },
		]);
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
			onCompletePrompt: undefined,
			error: null,
		});
	});

	test("compacts sender-defined parent follow-up prompts for inbox/status consumers", () => {
		const compact = compactTaskResult(
			{ ...baseTask, onCompletePrompt: "review the worker diff before reporting completion" },
			undefined,
		);

		expect(compact).toMatchObject({
			taskId: "task_abc",
			onCompletePrompt: "review the worker diff before reporting completion",
		});
	});

	test("validates compact structured task result payloads", () => {
		expect(
			validateStructuredTaskResult({
				issueId: "auth-boundary",
				verdict: "changes_required",
				changedFiles: ["src/auth.ts"],
				verification: [{ command: "bun test tests/auth.test.ts", status: "failed", exitCode: 1, summary: "regression fails" }],
				blockers: [{ id: "auth-1", severity: "high", evidence: "missing authorization", minimalFix: "check owner" }],
				risks: ["needs full suite"],
				next: "fix blocker auth-1",
			}),
		).toEqual({ ok: true });

		expect(validateStructuredTaskResult({ verdict: "done", verification: [{ status: "wat" }] })).toEqual({
			ok: false,
			errors: ["verdict must be one of completed, changes_required, rejected, failed, cancelled", "verification[0].status is invalid"],
		});
	});
});
