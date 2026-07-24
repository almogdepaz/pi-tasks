import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { analyzeTaskStoreMetrics } from "../src/metrics";
import { buildTaskBoard } from "../src/task-board";

const tempRoots: string[] = [];

async function createTasksRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-task-metrics-"));
	tempRoots.push(root);
	return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeTaskArtifacts(
	root: string,
	task: Record<string, unknown>,
	options: { readonly assignment?: unknown; readonly result?: unknown } = {},
): Promise<void> {
	const taskId = String(task.id);
	const taskDir = join(root, taskId);
	await mkdir(taskDir, { recursive: true });
	await writeJson(join(taskDir, "task.json"), task);
	if (options.assignment !== undefined) {
		await writeJson(join(taskDir, "assignment.json"), options.assignment);
	}
	if (options.result !== undefined) {
		await writeJson(join(taskDir, "result.json"), options.result);
	}
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("task-store postmortem metrics", () => {
	test("summarizes statuses, character sizes, grouping, preflight, and structured verification", async () => {
		const root = await createTasksRoot();
		const alphaPayload = {
			verdict: "completed",
			verification: [{ command: "bun run typecheck", status: "passed" }],
		};
		const gammaPayload = {
			verdict: "failed",
			verification: [
				{ command: "bun test", status: "failed" },
				{ command: "bun test", status: "passed" },
				{ status: "not_run" },
			],
		};
		const alphaAssignment = { instructions: "do alpha" };
		const gammaAssignment = "assign gamma";

		await writeTaskArtifacts(
			root,
			{
				id: "task_alpha",
				status: "completed",
				taskText: "alpha task",
				metadata: { phaseId: "phase-1", issueId: "issue-a", rootCause: "boundary" },
				preflight: {
					ok: true,
					checks: [{ name: "target_model", status: "unavailable" }],
				},
			},
			{
				assignment: alphaAssignment,
				result: { taskId: "task_alpha", status: "completed", summary: "alpha done", result: alphaPayload },
			},
		);
		await writeTaskArtifacts(
			root,
			{
				id: "task_beta",
				status: "rejected",
				taskText: "beta",
				metadata: { phaseId: "phase-1", issueId: "issue-a", rootCause: "boundary" },
				error: { code: "preflight_failed" },
				preflight: {
					ok: false,
					checks: [
						{ name: "reachable", status: "failed" },
						{ name: "context_ref", status: "failed" },
						{ name: "target_model", status: "unavailable" },
					],
				},
			},
			{ result: { taskId: "task_beta", status: "rejected", summary: "preflight failed" } },
		);
		await writeTaskArtifacts(
			root,
			{
				id: "task_gamma",
				status: "failed",
				taskText: "gamma work",
				metadata: { phaseId: "phase-2", issueId: "issue-b", rootCause: "io" },
				preflight: {
					ok: true,
					checks: [{ name: "reachable", status: "unavailable" }],
				},
			},
			{
				assignment: gammaAssignment,
				result: { taskId: "task_gamma", status: "failed", summary: "failed it", result: gammaPayload },
			},
		);

		const report = await analyzeTaskStoreMetrics(root);

		expect(report.totalTaskRecords).toBe(3);
		expect(report.statusCounts).toEqual({ completed: 1, failed: 1, rejected: 1 });
		expect(report.preflight).toEqual({
			failedChecksByName: { context_ref: 1, reachable: 1 },
			rejectedCount: 1,
			unavailableChecksByName: { reachable: 1, target_model: 2 },
		});
		expect(report.characterSizes).toEqual({
			totalAssignmentChars: JSON.stringify(alphaAssignment).length + gammaAssignment.length,
			totalInstructionChars: "do alpha".length,
			totalResultSummaryChars: "alpha done".length + "preflight failed".length + "failed it".length,
			totalSerializedResultPayloadChars: JSON.stringify(alphaPayload).length + JSON.stringify(gammaPayload).length,
			totalTaskTextChars: "alpha task".length + "beta".length + "gamma work".length,
		});
		expect(report.grouping).toEqual({
			byIssueId: { "issue-a": 2, "issue-b": 1 },
			byPhaseId: { "phase-1": 2, "phase-2": 1 },
			byRootCause: { boundary: 2, io: 1 },
			loopsPerIssueId: { "issue-a": 2, "issue-b": 1 },
		});
		expect(report.verification).toEqual({
			commandCounts: { "bun run typecheck": 1, "bun test": 2 },
			entryCount: 4,
			statusCounts: { failed: 1, not_run: 1, passed: 2 },
		});
		expect(report.largest.taskPrompts.map(({ taskId, charCount }) => [taskId, charCount])).toEqual([
			["task_alpha", 10],
			["task_gamma", 10],
			["task_beta", 4],
		]);
		expect(report.largest.results[0]).toEqual({
			taskId: "task_gamma",
			charCount: "failed it".length + JSON.stringify(gammaPayload).length,
		});
		expect(report.diagnostics).toEqual([]);
	});

	test("reports malformed and missing artifacts without aborting valid task analysis", async () => {
		const root = await createTasksRoot();
		await writeTaskArtifacts(root, { id: "task_valid", status: "running", taskText: "valid" });

		const malformedTaskDir = join(root, "task_bad_task");
		await mkdir(malformedTaskDir);
		await writeFile(join(malformedTaskDir, "task.json"), "{not json", "utf8");

		const malformedResultDir = join(root, "task_bad_result");
		await mkdir(malformedResultDir);
		await writeJson(join(malformedResultDir, "task.json"), {
			id: "task_bad_result",
			status: "mystery_status",
			taskText: "still count me",
		});
		await writeFile(join(malformedResultDir, "result.json"), "[broken", "utf8");
		await writeFile(join(malformedResultDir, "assignment.json"), "nope", "utf8");

		await mkdir(join(root, "task_missing_task"));

		const report = await analyzeTaskStoreMetrics(root);
		const diagnosticCodes = report.diagnostics.map((diagnostic) => diagnostic.code);

		expect(report.totalTaskRecords).toBe(2);
		expect(report.statusCounts).toEqual({ mystery_status: 1, running: 1 });
		expect(diagnosticCodes).toContain("malformed_task_json");
		expect(diagnosticCodes).toContain("missing_task_json");
		expect(diagnosticCodes).toContain("missing_result_json");
		expect(diagnosticCodes).toContain("malformed_result_json");
		expect(diagnosticCodes).toContain("malformed_assignment_json");
	});

	test("bounds largest prompt and result lists", async () => {
		const root = await createTasksRoot();
		for (let index = 0; index < 12; index += 1) {
			const taskId = `task_${String(index).padStart(2, "0")}`;
			await writeTaskArtifacts(
				root,
				{ id: taskId, status: "completed", taskText: "x".repeat(index) },
				{ result: { taskId, status: "completed", summary: "y".repeat(index) } },
			);
		}

		const report = await analyzeTaskStoreMetrics(root);

		expect(report.largest.taskPrompts).toHaveLength(10);
		expect(report.largest.results).toHaveLength(10);
		expect(report.largest.taskPrompts[0]).toEqual({ taskId: "task_11", charCount: 11 });
	});

	test("prints the report as JSON through the package CLI", async () => {
		const root = await createTasksRoot();
		await writeTaskArtifacts(root, { id: "task_cli", status: "dispatched", taskText: "cli task" });

		const process = Bun.spawn(["bun", "run", "task-metrics", root], {
			cwd: new URL("..", import.meta.url).pathname,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toContain("$ bun src/metrics-cli.ts");
		expect(JSON.parse(stdout)).toMatchObject({ tasksRoot: root, totalTaskRecords: 1 });
	});

	test("returns a usage error when the CLI has no task-store root", async () => {
		const process = Bun.spawn(["bun", "run", "task-metrics"], {
			cwd: new URL("..", import.meta.url).pathname,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			process.exited,
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
		]);

		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("usage: bun run task-metrics <tasksRoot>");
	});
});

describe("task board", () => {
	test("groups repeated issue tasks and marks ping-pong candidates", async () => {
		const root = await createTasksRoot();
		await writeTaskArtifacts(root, {
			id: "task_alpha",
			status: "completed",
			updatedAt: "2026-07-24T10:00:00.000Z",
			completedAt: "2026-07-24T10:00:00.000Z",
			metadata: { phaseId: "phase-4", issueId: "issue-auth", rootCause: "validation" },
		});
		await writeTaskArtifacts(root, {
			id: "task_beta",
			status: "running",
			updatedAt: "2026-07-24T11:00:00.000Z",
			metadata: { phaseId: "phase-4", issueId: "issue-auth", rootCause: "validation" },
		});

		const board = await buildTaskBoard(root);
		const group = board.groups[0];

		expect(group).toMatchObject({
			phaseId: "phase-4",
			issueId: "issue-auth",
			rootCause: "validation",
			taskCount: 2,
			statusCounts: { completed: 1, running: 1 },
			latestUpdatedAt: "2026-07-24T11:00:00.000Z",
			latestCompletedAt: "2026-07-24T10:00:00.000Z",
			loopIndicators: {
				issueTaskCount: 2,
				repeatedIssue: true,
				possiblePingPong: true,
				splitWorkCandidate: true,
			},
		});
		expect(group?.tasks).toEqual([
			{ taskId: "task_alpha", status: "completed" },
			{ taskId: "task_beta", status: "running" },
		]);
	});

	test("marks issue groups that share a root cause", async () => {
		const root = await createTasksRoot();
		await writeTaskArtifacts(root, {
			id: "task_auth",
			status: "completed",
			updatedAt: "2026-07-24T10:00:00.000Z",
			metadata: { phaseId: "phase-4", issueId: "issue-auth", rootCause: "validation" },
		});
		await writeTaskArtifacts(root, {
			id: "task_profile",
			status: "failed",
			updatedAt: "2026-07-24T11:00:00.000Z",
			metadata: { phaseId: "phase-4", issueId: "issue-profile", rootCause: "validation" },
		});

		const board = await buildTaskBoard(root);

		expect(board.groups.map((group) => group.issueId)).toEqual(["issue-profile", "issue-auth"]);
		for (const group of board.groups) {
			expect(group.loopIndicators).toMatchObject({
				rootCauseTaskCount: 2,
				rootCauseIssueCount: 2,
				sharedRootCause: true,
				splitWorkCandidate: true,
			});
		}
	});

	test("counts verification, blockers, and risks only from structured result fields", async () => {
		const root = await createTasksRoot();
		await writeTaskArtifacts(
			root,
			{
				id: "task_structured",
				status: "completed",
				updatedAt: "2026-07-24T10:00:00.000Z",
				metadata: { phaseId: "phase-4", issueId: "issue-structured", rootCause: "contract" },
				taskText: "verification failed; blockers: ten; risks: many",
			},
			{
				result: {
					taskId: "task_structured",
					status: "completed",
					completedAt: "2026-07-24T10:01:00.000Z",
					summary: "verification failed with blocker and risk prose",
					verification: [{ status: "failed" }],
					blockers: [{ evidence: "top-level decoy" }],
					risks: ["top-level decoy"],
					result: {
						verification: [
							{ command: "bun test", status: "passed" },
							{ command: "bun run typecheck", status: "not_run" },
						],
						blockers: [{ evidence: "real blocker" }],
						risks: ["real risk", "second risk"],
					},
				},
			},
		);

		const board = await buildTaskBoard(root);

		expect(board.groups[0]).toMatchObject({
			verification: { entryCount: 2, statusCounts: { not_run: 1, passed: 1 } },
			blockerCount: 1,
			riskCount: 2,
			latestCompletedAt: "2026-07-24T10:01:00.000Z",
		});
	});

	test("bounds groups by default and sorts active, recent, then identifiers", async () => {
		const root = await createTasksRoot();
		for (let index = 0; index < 12; index += 1) {
			const suffix = String(index).padStart(2, "0");
			await writeTaskArtifacts(root, {
				id: `task_${suffix}`,
				status: index === 11 ? "running" : "completed",
				updatedAt: `2026-07-24T${suffix}:00:00.000Z`,
				metadata: { phaseId: "phase-4", issueId: `issue-${suffix}`, rootCause: `root-${suffix}` },
			});
		}

		const first = await buildTaskBoard(root);
		const second = await buildTaskBoard(root);

		expect(first.totalGroupCount).toBe(12);
		expect(first.groups).toHaveLength(10);
		expect(first.omittedGroupCount).toBe(2);
		expect(first.groups[0]?.issueId).toBe("issue-11");
		expect(first.groups.slice(1).map((group) => group.issueId)).toEqual([
			"issue-10",
			"issue-09",
			"issue-08",
			"issue-07",
			"issue-06",
			"issue-05",
			"issue-04",
			"issue-03",
			"issue-02",
		]);
		expect(second.groups).toEqual(first.groups);
	});

	test("reports legacy tasks as bounded ungrouped coverage", async () => {
		const root = await createTasksRoot();
		await writeTaskArtifacts(root, {
			id: "task_grouped",
			status: "running",
			updatedAt: "2026-07-24T12:00:00.000Z",
			metadata: { phaseId: "phase-4", issueId: "issue-new", rootCause: "contract" },
		});
		await writeTaskArtifacts(root, {
			id: "task_legacy_all",
			status: "completed",
			updatedAt: "2026-07-24T10:00:00.000Z",
		});
		await writeTaskArtifacts(root, {
			id: "task_legacy_partial",
			status: "failed",
			updatedAt: "2026-07-24T11:00:00.000Z",
			metadata: { issueId: "issue-old" },
		});

		const board = await buildTaskBoard(root, { maxUngroupedTasks: 1 });

		expect(board).toMatchObject({
			totalTaskRecords: 3,
			groupedTaskCount: 1,
			ungroupedTaskCount: 2,
			ungrouped: {
				taskCount: 2,
				statusCounts: { completed: 1, failed: 1 },
				omittedTaskCount: 1,
				reasonCounts: { missingIssueId: 1, missingPhaseId: 2, missingRootCause: 2 },
			},
		});
		expect(board.ungrouped.tasks).toEqual([{ taskId: "task_legacy_all", status: "completed" }]);
		expect(board.groupedTaskCount + board.ungrouped.taskCount).toBe(board.totalTaskRecords);
	});

	test("inherits artifact diagnostics without crashing board generation", async () => {
		const root = await createTasksRoot();
		await writeTaskArtifacts(root, {
			id: "task_valid",
			status: "running",
			updatedAt: "2026-07-24T10:00:00.000Z",
			metadata: { phaseId: "phase-4", issueId: "issue-valid", rootCause: "io" },
		});
		const malformedTaskDir = join(root, "task_bad_task");
		await mkdir(malformedTaskDir);
		await writeFile(join(malformedTaskDir, "task.json"), "{bad", "utf8");
		const malformedResultDir = join(root, "task_bad_result");
		await mkdir(malformedResultDir);
		await writeJson(join(malformedResultDir, "task.json"), {
			id: "task_bad_result",
			status: "failed",
			metadata: { phaseId: "phase-4", issueId: "issue-result", rootCause: "io" },
		});
		await writeFile(join(malformedResultDir, "result.json"), "[bad", "utf8");
		await mkdir(join(root, "task_missing_task"));

		const board = await buildTaskBoard(root);
		const diagnosticCodes = board.diagnostics.map((diagnostic) => diagnostic.code);

		expect(board.totalGroupCount).toBe(2);
		expect(diagnosticCodes).toContain("malformed_task_json");
		expect(diagnosticCodes).toContain("missing_task_json");
		expect(diagnosticCodes).toContain("missing_result_json");
		expect(diagnosticCodes).toContain("malformed_result_json");
	});

	test("prints board JSON through the metrics CLI mode", async () => {
		const root = await createTasksRoot();
		await writeTaskArtifacts(root, {
			id: "task_board_cli",
			status: "running",
			updatedAt: "2026-07-24T10:00:00.000Z",
			metadata: { phaseId: "phase-4", issueId: "issue-cli", rootCause: "cli" },
		});

		const process = Bun.spawn(["bun", "run", "task-metrics", root, "--board"], {
			cwd: new URL("..", import.meta.url).pathname,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
		const output = JSON.parse(stdout) as Record<string, unknown>;

		expect(exitCode).toBe(0);
		expect(output).toMatchObject({ schemaVersion: 1, tasksRoot: root, totalTaskRecords: 1, totalGroupCount: 1 });
		expect(output.groups).toEqual([
			expect.objectContaining({ phaseId: "phase-4", issueId: "issue-cli", rootCause: "cli", taskCount: 1 }),
		]);
	});
});
