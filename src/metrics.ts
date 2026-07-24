import { readTaskStoreArtifacts } from "./task-artifacts";
import type { TaskStoreArtifactRecord, TaskStoreDiagnostic } from "./task-artifacts";

const LARGEST_LIST_LIMIT = 10;

export interface TaskMetricCount {
	readonly taskId: string;
	readonly charCount: number;
}

export type TaskMetricsDiagnostic = TaskStoreDiagnostic;

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
	const artifactRead = await readTaskStoreArtifacts(tasksRoot);
	const diagnostics: TaskMetricsDiagnostic[] = [...artifactRead.diagnostics];
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
	const analysis: TaskAnalysis = {
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
	};

	for (const record of artifactRead.records) {
		analyzeTaskArtifact(record, analysis);
	}

	return buildReport(tasksRoot, totals, statusCounts, failedChecksByName, unavailableChecksByName, byPhaseId, byIssueId, byRootCause, commandCounts, verificationStatusCounts, taskPrompts, results, diagnostics);
}

interface TaskAnalysis {
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
}

function analyzeTaskArtifact(record: TaskStoreArtifactRecord, analysis: TaskAnalysis): void {
	const task = record.task;
	const taskId = typeof task.id === "string" && task.id.length > 0 ? task.id : record.taskDirectoryName;
	analysis.totals.totalTaskRecords += 1;

	const status = typeof task.status === "string" && task.status.length > 0 ? task.status : "unknown";
	increment(analysis.statusCounts, status);

	const taskText = typeof task.taskText === "string" ? task.taskText : "";
	analysis.totals.totalTaskTextChars += taskText.length;
	analysis.taskPrompts.push({ taskId, charCount: taskText.length });

	analyzeMetadata(task.metadata, analysis);
	analyzePreflight(task, status, analysis);
	analyzeAssignment(record.assignment, analysis);
	analyzeResult(record.result, taskId, analysis);
}

function analyzeMetadata(metadata: unknown, analysis: TaskAnalysis): void {
	if (!isRecord(metadata)) {
		return;
	}
	incrementStringField(analysis.byPhaseId, metadata.phaseId);
	incrementStringField(analysis.byIssueId, metadata.issueId);
	incrementStringField(analysis.byRootCause, metadata.rootCause);
}

function analyzePreflight(task: Record<string, unknown>, status: string, analysis: TaskAnalysis): void {
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

function analyzeAssignment(assignment: unknown | undefined, analysis: TaskAnalysis): void {
	if (assignment === undefined) {
		return;
	}
	const serializedAssignment = JSON.stringify(assignment);
	analysis.totals.totalAssignmentChars += typeof assignment === "string" ? assignment.length : serializedAssignment?.length ?? 0;
	if (isRecord(assignment) && typeof assignment.instructions === "string") {
		analysis.totals.totalInstructionChars += assignment.instructions.length;
	}
}

function analyzeResult(
	storedResult: Record<string, unknown> | undefined,
	taskId: string,
	analysis: TaskAnalysis,
): void {
	if (!storedResult) {
		return;
	}
	const summaryChars = typeof storedResult.summary === "string" ? storedResult.summary.length : 0;
	const payloadChars = "result" in storedResult ? (JSON.stringify(storedResult.result)?.length ?? 0) : 0;
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
