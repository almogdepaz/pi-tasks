import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const LARGEST_LIST_LIMIT = 10;

export interface TaskMetricCount {
	readonly taskId: string;
	readonly charCount: number;
}

export interface TaskMetricsDiagnostic {
	readonly severity: "warning" | "error";
	readonly code: string;
	readonly path: string;
	readonly message: string;
}

export interface TaskGroupingMetrics {
	readonly byPhaseId: Readonly<Record<string, number>>;
	readonly byIssueId: Readonly<Record<string, number>>;
	readonly byRootCause: Readonly<Record<string, number>>;
	readonly loopsPerIssueId: Readonly<Record<string, number>>;
}

export interface TaskStoreMetricsReport {
	readonly schemaVersion: 1;
	readonly tasksRoot: string;
	readonly totalTaskRecords: number;
	readonly statusCounts: Readonly<Record<string, number>>;
	readonly preflight: {
		readonly rejectedCount: number;
		readonly failedChecksByName: Readonly<Record<string, number>>;
		readonly unavailableChecksByName: Readonly<Record<string, number>>;
	};
	readonly characterSizes: {
		readonly totalTaskTextChars: number;
		readonly totalAssignmentChars: number;
		readonly totalInstructionChars: number;
		readonly totalResultSummaryChars: number;
		readonly totalSerializedResultPayloadChars: number;
	};
	readonly largest: {
		readonly taskPrompts: readonly TaskMetricCount[];
		readonly results: readonly TaskMetricCount[];
	};
	readonly grouping: TaskGroupingMetrics;
	readonly verification: {
		readonly entryCount: number;
		readonly commandCounts: Readonly<Record<string, number>>;
		readonly statusCounts: Readonly<Record<string, number>>;
	};
	readonly diagnostics: readonly TaskMetricsDiagnostic[];
}

type JsonReadResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly missing: boolean; readonly message: string };

interface MutableTotals {
	totalTaskRecords: number;
	preflightRejectedCount: number;
	totalTaskTextChars: number;
	totalAssignmentChars: number;
	totalInstructionChars: number;
	totalResultSummaryChars: number;
	totalSerializedResultPayloadChars: number;
	verificationEntryCount: number;
}

export async function analyzeTaskStoreMetrics(tasksRoot: string): Promise<TaskStoreMetricsReport> {
	const diagnostics: TaskMetricsDiagnostic[] = [];
	const taskPrompts: TaskMetricCount[] = [];
	const results: TaskMetricCount[] = [];
	const statusCounts: Record<string, number> = {};
	const failedChecksByName: Record<string, number> = {};
	const unavailableChecksByName: Record<string, number> = {};
	const byPhaseId: Record<string, number> = {};
	const byIssueId: Record<string, number> = {};
	const byRootCause: Record<string, number> = {};
	const commandCounts: Record<string, number> = {};
	const verificationStatusCounts: Record<string, number> = {};
	const totals: MutableTotals = {
		totalTaskRecords: 0,
		preflightRejectedCount: 0,
		totalTaskTextChars: 0,
		totalAssignmentChars: 0,
		totalInstructionChars: 0,
		totalResultSummaryChars: 0,
		totalSerializedResultPayloadChars: 0,
		verificationEntryCount: 0,
	};

	let entries;
	try {
		entries = await readdir(tasksRoot, { withFileTypes: true });
	} catch (error) {
		diagnostics.push({
			severity: "error",
			code: "tasks_root_unreadable",
			path: tasksRoot,
			message: errorMessage(error),
		});
		return buildReport(tasksRoot, totals, statusCounts, failedChecksByName, unavailableChecksByName, byPhaseId, byIssueId, byRootCause, commandCounts, verificationStatusCounts, taskPrompts, results, diagnostics);
	}

	for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => compareStrings(left.name, right.name))) {
		await analyzeTaskDirectory({
			tasksRoot,
			taskDirectoryName: entry.name,
			totals,
			statusCounts,
			failedChecksByName,
			unavailableChecksByName,
			byPhaseId,
			byIssueId,
			byRootCause,
			commandCounts,
			verificationStatusCounts,
			taskPrompts,
			results,
			diagnostics,
		});
	}

	return buildReport(tasksRoot, totals, statusCounts, failedChecksByName, unavailableChecksByName, byPhaseId, byIssueId, byRootCause, commandCounts, verificationStatusCounts, taskPrompts, results, diagnostics);
}

interface TaskDirectoryAnalysis {
	readonly tasksRoot: string;
	readonly taskDirectoryName: string;
	readonly totals: MutableTotals;
	readonly statusCounts: Record<string, number>;
	readonly failedChecksByName: Record<string, number>;
	readonly unavailableChecksByName: Record<string, number>;
	readonly byPhaseId: Record<string, number>;
	readonly byIssueId: Record<string, number>;
	readonly byRootCause: Record<string, number>;
	readonly commandCounts: Record<string, number>;
	readonly verificationStatusCounts: Record<string, number>;
	readonly taskPrompts: TaskMetricCount[];
	readonly results: TaskMetricCount[];
	readonly diagnostics: TaskMetricsDiagnostic[];
}

async function analyzeTaskDirectory(analysis: TaskDirectoryAnalysis): Promise<void> {
	const taskPath = join(analysis.tasksRoot, analysis.taskDirectoryName, "task.json");
	const relativeTaskPath = join(analysis.taskDirectoryName, "task.json");
	const taskRead = await readJson(taskPath);
	if (!taskRead.ok) {
		analysis.diagnostics.push({
			severity: taskRead.missing ? "warning" : "error",
			code: taskRead.missing ? "missing_task_json" : "malformed_task_json",
			path: relativeTaskPath,
			message: taskRead.message,
		});
		return;
	}
	if (!isRecord(taskRead.value)) {
		analysis.diagnostics.push({
			severity: "error",
			code: "malformed_task_json",
			path: relativeTaskPath,
			message: "task.json must contain an object",
		});
		return;
	}

	const task = taskRead.value;
	const taskId = typeof task.id === "string" && task.id.length > 0 ? task.id : analysis.taskDirectoryName;
	analysis.totals.totalTaskRecords += 1;

	const status = typeof task.status === "string" && task.status.length > 0 ? task.status : "unknown";
	increment(analysis.statusCounts, status);

	const taskText = typeof task.taskText === "string" ? task.taskText : "";
	analysis.totals.totalTaskTextChars += taskText.length;
	analysis.taskPrompts.push({ taskId, charCount: taskText.length });

	analyzeMetadata(task.metadata, analysis);
	analyzePreflight(task, status, analysis);
	await analyzeAssignment(analysis);
	await analyzeResult(analysis, taskId);
}

function analyzeMetadata(metadata: unknown, analysis: TaskDirectoryAnalysis): void {
	if (!isRecord(metadata)) {
		return;
	}
	incrementStringField(analysis.byPhaseId, metadata.phaseId);
	incrementStringField(analysis.byIssueId, metadata.issueId);
	incrementStringField(analysis.byRootCause, metadata.rootCause);
}

function analyzePreflight(task: Record<string, unknown>, status: string, analysis: TaskDirectoryAnalysis): void {
	const preflight = isRecord(task.preflight) ? task.preflight : undefined;
	const error = isRecord(task.error) ? task.error : undefined;
	if (status === "rejected" && (error?.code === "preflight_failed" || preflight?.ok === false)) {
		analysis.totals.preflightRejectedCount += 1;
	}

	if (!preflight || !Array.isArray(preflight.checks)) {
		return;
	}
	for (const check of preflight.checks) {
		if (!isRecord(check) || typeof check.name !== "string") {
			continue;
		}
		if (check.status === "failed") {
			increment(analysis.failedChecksByName, check.name);
		} else if (check.status === "unavailable") {
			increment(analysis.unavailableChecksByName, check.name);
		}
	}
}

async function analyzeAssignment(analysis: TaskDirectoryAnalysis): Promise<void> {
	const relativePath = join(analysis.taskDirectoryName, "assignment.json");
	const assignmentRead = await readJson(join(analysis.tasksRoot, relativePath));
	if (!assignmentRead.ok) {
		if (!assignmentRead.missing) {
			analysis.diagnostics.push({
				severity: "error",
				code: "malformed_assignment_json",
				path: relativePath,
				message: assignmentRead.message,
			});
		}
		return;
	}

	const assignment = assignmentRead.value;
	analysis.totals.totalAssignmentChars += typeof assignment === "string" ? assignment.length : JSON.stringify(assignment).length;
	if (isRecord(assignment) && typeof assignment.instructions === "string") {
		analysis.totals.totalInstructionChars += assignment.instructions.length;
	}
}

async function analyzeResult(analysis: TaskDirectoryAnalysis, taskId: string): Promise<void> {
	const relativePath = join(analysis.taskDirectoryName, "result.json");
	const resultRead = await readJson(join(analysis.tasksRoot, relativePath));
	if (!resultRead.ok) {
		analysis.diagnostics.push({
			severity: resultRead.missing ? "warning" : "error",
			code: resultRead.missing ? "missing_result_json" : "malformed_result_json",
			path: relativePath,
			message: resultRead.message,
		});
		return;
	}
	if (!isRecord(resultRead.value)) {
		analysis.diagnostics.push({
			severity: "error",
			code: "malformed_result_json",
			path: relativePath,
			message: "result.json must contain an object",
		});
		return;
	}

	const storedResult = resultRead.value;
	const summaryChars = typeof storedResult.summary === "string" ? storedResult.summary.length : 0;
	const payloadChars = "result" in storedResult ? JSON.stringify(storedResult.result).length : 0;
	analysis.totals.totalResultSummaryChars += summaryChars;
	analysis.totals.totalSerializedResultPayloadChars += payloadChars;
	analysis.results.push({ taskId, charCount: summaryChars + payloadChars });

	if (!isRecord(storedResult.result) || !Array.isArray(storedResult.result.verification)) {
		return;
	}
	for (const entry of storedResult.result.verification) {
		analysis.totals.verificationEntryCount += 1;
		if (!isRecord(entry)) {
			continue;
		}
		if (typeof entry.command === "string" && entry.command.length > 0) {
			increment(analysis.commandCounts, entry.command);
		}
		if (typeof entry.status === "string" && entry.status.length > 0) {
			increment(analysis.verificationStatusCounts, entry.status);
		}
	}
}

function buildReport(
	tasksRoot: string,
	totals: MutableTotals,
	statusCounts: Record<string, number>,
	failedChecksByName: Record<string, number>,
	unavailableChecksByName: Record<string, number>,
	byPhaseId: Record<string, number>,
	byIssueId: Record<string, number>,
	byRootCause: Record<string, number>,
	commandCounts: Record<string, number>,
	verificationStatusCounts: Record<string, number>,
	taskPrompts: TaskMetricCount[],
	results: TaskMetricCount[],
	diagnostics: TaskMetricsDiagnostic[],
): TaskStoreMetricsReport {
	const issueCounts = sortedCounts(byIssueId);
	return {
		schemaVersion: 1,
		tasksRoot,
		totalTaskRecords: totals.totalTaskRecords,
		statusCounts: sortedCounts(statusCounts),
		preflight: {
			rejectedCount: totals.preflightRejectedCount,
			failedChecksByName: sortedCounts(failedChecksByName),
			unavailableChecksByName: sortedCounts(unavailableChecksByName),
		},
		characterSizes: {
			totalTaskTextChars: totals.totalTaskTextChars,
			totalAssignmentChars: totals.totalAssignmentChars,
			totalInstructionChars: totals.totalInstructionChars,
			totalResultSummaryChars: totals.totalResultSummaryChars,
			totalSerializedResultPayloadChars: totals.totalSerializedResultPayloadChars,
		},
		largest: {
			taskPrompts: largestFirst(taskPrompts),
			results: largestFirst(results),
		},
		grouping: {
			byPhaseId: sortedCounts(byPhaseId),
			byIssueId: issueCounts,
			byRootCause: sortedCounts(byRootCause),
			loopsPerIssueId: { ...issueCounts },
		},
		verification: {
			entryCount: totals.verificationEntryCount,
			commandCounts: sortedCounts(commandCounts),
			statusCounts: sortedCounts(verificationStatusCounts),
		},
		diagnostics,
	};
}

async function readJson(path: string): Promise<JsonReadResult> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		return { ok: false, missing: errorCode(error) === "ENOENT", message: errorMessage(error) };
	}
	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch (error) {
		return { ok: false, missing: false, message: errorMessage(error) };
	}
}

function largestFirst(values: readonly TaskMetricCount[]): readonly TaskMetricCount[] {
	return [...values]
		.sort((left, right) => right.charCount - left.charCount || compareStrings(left.taskId, right.taskId))
		.slice(0, LARGEST_LIST_LIMIT);
}

function sortedCounts(counts: Readonly<Record<string, number>>): Record<string, number> {
	return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareStrings(left, right)));
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function increment(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function incrementStringField(counts: Record<string, number>, value: unknown): void {
	if (typeof value === "string" && value.length > 0) {
		increment(counts, value);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
