import { readTaskStoreArtifacts } from "./task-artifacts";
import type { TaskStoreArtifactRecord, TaskStoreDiagnostic } from "./task-artifacts";

const DEFAULT_MAX_GROUPS = 10;
const DEFAULT_MAX_TASKS_PER_GROUP = 20;
const DEFAULT_MAX_UNGROUPED_TASKS = 20;
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "timed_out", "rejected"]);

export interface TaskBoardOptions {
	readonly maxGroups?: number;
	readonly maxTasksPerGroup?: number;
	readonly maxUngroupedTasks?: number;
}

export interface TaskBoardTask {
	readonly taskId: string;
	readonly status: string;
}

export interface TaskBoardGroup {
	readonly phaseId: string;
	readonly issueId: string;
	readonly rootCause: string;
	readonly taskCount: number;
	readonly tasks: readonly TaskBoardTask[];
	readonly omittedTaskCount: number;
	readonly statusCounts: Readonly<Record<string, number>>;
	readonly hasActiveTasks: boolean;
	readonly latestUpdatedAt: string | null;
	readonly latestCompletedAt: string | null;
	readonly verification: {
		readonly entryCount: number;
		readonly statusCounts: Readonly<Record<string, number>>;
	};
	readonly blockerCount: number;
	readonly riskCount: number;
	readonly loopIndicators: {
		readonly issueTaskCount: number;
		readonly rootCauseTaskCount: number;
		readonly rootCauseIssueCount: number;
		readonly repeatedIssue: boolean;
		readonly sharedRootCause: boolean;
		readonly possiblePingPong: boolean;
		readonly splitWorkCandidate: boolean;
	};
}

export interface TaskBoardReport {
	readonly schemaVersion: 1;
	readonly tasksRoot: string;
	readonly totalTaskRecords: number;
	readonly groupedTaskCount: number;
	readonly ungroupedTaskCount: number;
	readonly totalGroupCount: number;
	readonly groups: readonly TaskBoardGroup[];
	readonly omittedGroupCount: number;
	readonly ungrouped: {
		readonly taskCount: number;
		readonly tasks: readonly TaskBoardTask[];
		readonly omittedTaskCount: number;
		readonly statusCounts: Readonly<Record<string, number>>;
		readonly reasonCounts: {
			readonly missingPhaseId: number;
			readonly missingIssueId: number;
			readonly missingRootCause: number;
		};
	};
	readonly diagnostics: readonly TaskStoreDiagnostic[];
}

interface BoardTaskSource extends TaskBoardTask {
	readonly phaseId: string | undefined;
	readonly issueId: string | undefined;
	readonly rootCause: string | undefined;
	readonly updatedAt: string | undefined;
	readonly completedAt: string | undefined;
	readonly verificationEntryCount: number;
	readonly verificationStatusCounts: Readonly<Record<string, number>>;
	readonly blockerCount: number;
	readonly riskCount: number;
}

interface MutableBoardGroup {
	readonly phaseId: string;
	readonly issueId: string;
	readonly rootCause: string;
	readonly tasks: BoardTaskSource[];
	readonly statusCounts: Record<string, number>;
	readonly verificationStatusCounts: Record<string, number>;
	verificationEntryCount: number;
	blockerCount: number;
	riskCount: number;
	latestUpdatedAt: string | undefined;
	latestCompletedAt: string | undefined;
	hasActiveTasks: boolean;
}

export async function buildTaskBoard(tasksRoot: string, options: TaskBoardOptions = {}): Promise<TaskBoardReport> {
	const maxGroups = normalizeLimit(options.maxGroups, DEFAULT_MAX_GROUPS, "maxGroups");
	const maxTasksPerGroup = normalizeLimit(options.maxTasksPerGroup, DEFAULT_MAX_TASKS_PER_GROUP, "maxTasksPerGroup");
	const maxUngroupedTasks = normalizeLimit(options.maxUngroupedTasks, DEFAULT_MAX_UNGROUPED_TASKS, "maxUngroupedTasks");
	const artifactRead = await readTaskStoreArtifacts(tasksRoot);
	const tasks = artifactRead.records.map(toBoardTaskSource);
	const issueTaskCounts = countStringValues(tasks.map((task) => task.issueId));
	const rootCauseTaskCounts = countStringValues(tasks.map((task) => task.rootCause));
	const rootCauseIssues = collectRootCauseIssues(tasks);
	const groupedTasks = tasks.filter(hasCompleteGrouping);
	const ungroupedTasks = tasks.filter((task) => !hasCompleteGrouping(task));
	const mutableGroups = groupTasks(groupedTasks);
	const groups = mutableGroups
		.map((group) => finalizeGroup(group, issueTaskCounts, rootCauseTaskCounts, rootCauseIssues, maxTasksPerGroup))
		.sort(compareGroups);
	const visibleGroups = groups.slice(0, maxGroups);
	const sortedUngroupedTasks = [...ungroupedTasks].sort(compareTasks);

	return {
		schemaVersion: 1,
		tasksRoot,
		totalTaskRecords: tasks.length,
		groupedTaskCount: groupedTasks.length,
		ungroupedTaskCount: ungroupedTasks.length,
		totalGroupCount: groups.length,
		groups: visibleGroups,
		omittedGroupCount: groups.length - visibleGroups.length,
		ungrouped: {
			taskCount: ungroupedTasks.length,
			tasks: sortedUngroupedTasks.slice(0, maxUngroupedTasks).map(compactTask),
			omittedTaskCount: Math.max(0, ungroupedTasks.length - maxUngroupedTasks),
			statusCounts: sortedCounts(countStatuses(ungroupedTasks)),
			reasonCounts: countUngroupedReasons(ungroupedTasks),
		},
		diagnostics: artifactRead.diagnostics,
	};
}

function toBoardTaskSource(record: TaskStoreArtifactRecord): BoardTaskSource {
	const task = record.task;
	const structuredResult = record.result && isRecord(record.result.result) ? record.result.result : undefined;
	const verification = structuredResult && Array.isArray(structuredResult.verification) ? structuredResult.verification : [];
	const verificationStatusCounts: Record<string, number> = {};
	for (const entry of verification) {
		if (isRecord(entry) && nonEmptyString(entry.status)) {
			increment(verificationStatusCounts, entry.status);
		}
	}

	return {
		taskId: nonEmptyString(task.id) ? task.id : record.taskDirectoryName,
		status: nonEmptyString(task.status) ? task.status : "unknown",
		phaseId: metadataValue(task.metadata, "phaseId"),
		issueId: metadataValue(task.metadata, "issueId"),
		rootCause: metadataValue(task.metadata, "rootCause"),
		updatedAt: nonEmptyString(task.updatedAt) ? task.updatedAt : undefined,
		completedAt: latestTimestamp(
			nonEmptyString(task.completedAt) ? task.completedAt : undefined,
			record.result && nonEmptyString(record.result.completedAt) ? record.result.completedAt : undefined,
		),
		verificationEntryCount: verification.length,
		verificationStatusCounts,
		blockerCount: structuredResult && Array.isArray(structuredResult.blockers) ? structuredResult.blockers.length : 0,
		riskCount: structuredResult && Array.isArray(structuredResult.risks) ? structuredResult.risks.length : 0,
	};
}

function metadataValue(metadata: unknown, field: "phaseId" | "issueId" | "rootCause"): string | undefined {
	return isRecord(metadata) && nonEmptyString(metadata[field]) ? metadata[field] : undefined;
}

function hasCompleteGrouping(task: BoardTaskSource): task is BoardTaskSource & { readonly phaseId: string; readonly issueId: string; readonly rootCause: string } {
	return task.phaseId !== undefined && task.issueId !== undefined && task.rootCause !== undefined;
}

function groupTasks(tasks: readonly (BoardTaskSource & { readonly phaseId: string; readonly issueId: string; readonly rootCause: string })[]): readonly MutableBoardGroup[] {
	const byPhase = new Map<string, Map<string, Map<string, MutableBoardGroup>>>();
	const groups: MutableBoardGroup[] = [];
	for (const task of tasks) {
		let byIssue = byPhase.get(task.phaseId);
		if (!byIssue) {
			byIssue = new Map();
			byPhase.set(task.phaseId, byIssue);
		}
		let byRootCause = byIssue.get(task.issueId);
		if (!byRootCause) {
			byRootCause = new Map();
			byIssue.set(task.issueId, byRootCause);
		}
		let group = byRootCause.get(task.rootCause);
		if (!group) {
			group = {
				phaseId: task.phaseId,
				issueId: task.issueId,
				rootCause: task.rootCause,
				tasks: [],
				statusCounts: {},
				verificationStatusCounts: {},
				verificationEntryCount: 0,
				blockerCount: 0,
				riskCount: 0,
				latestUpdatedAt: undefined,
				latestCompletedAt: undefined,
				hasActiveTasks: false,
			};
			byRootCause.set(task.rootCause, group);
			groups.push(group);
		}
		addTaskToGroup(group, task);
	}
	return groups;
}

function addTaskToGroup(group: MutableBoardGroup, task: BoardTaskSource): void {
	group.tasks.push(task);
	increment(group.statusCounts, task.status);
	for (const [status, count] of Object.entries(task.verificationStatusCounts)) {
		group.verificationStatusCounts[status] = (group.verificationStatusCounts[status] ?? 0) + count;
	}
	group.verificationEntryCount += task.verificationEntryCount;
	group.blockerCount += task.blockerCount;
	group.riskCount += task.riskCount;
	group.latestUpdatedAt = latestTimestamp(group.latestUpdatedAt, task.updatedAt);
	group.latestCompletedAt = latestTimestamp(group.latestCompletedAt, task.completedAt);
	group.hasActiveTasks ||= !TERMINAL_STATUSES.has(task.status);
}

function finalizeGroup(
	group: MutableBoardGroup,
	issueTaskCounts: Readonly<Record<string, number>>,
	rootCauseTaskCounts: Readonly<Record<string, number>>,
	rootCauseIssues: ReadonlyMap<string, ReadonlySet<string>>,
	maxTasksPerGroup: number,
): TaskBoardGroup {
	const tasks = [...group.tasks].sort(compareTasks);
	const issueTaskCount = issueTaskCounts[group.issueId] ?? group.tasks.length;
	const rootCauseTaskCount = rootCauseTaskCounts[group.rootCause] ?? group.tasks.length;
	const rootCauseIssueCount = rootCauseIssues.get(group.rootCause)?.size ?? 1;
	const repeatedIssue = issueTaskCount > 1;
	const sharedRootCause = rootCauseIssueCount > 1;
	return {
		phaseId: group.phaseId,
		issueId: group.issueId,
		rootCause: group.rootCause,
		taskCount: tasks.length,
		tasks: tasks.slice(0, maxTasksPerGroup).map(compactTask),
		omittedTaskCount: Math.max(0, tasks.length - maxTasksPerGroup),
		statusCounts: sortedCounts(group.statusCounts),
		hasActiveTasks: group.hasActiveTasks,
		latestUpdatedAt: group.latestUpdatedAt ?? null,
		latestCompletedAt: group.latestCompletedAt ?? null,
		verification: {
			entryCount: group.verificationEntryCount,
			statusCounts: sortedCounts(group.verificationStatusCounts),
		},
		blockerCount: group.blockerCount,
		riskCount: group.riskCount,
		loopIndicators: {
			issueTaskCount,
			rootCauseTaskCount,
			rootCauseIssueCount,
			repeatedIssue,
			sharedRootCause,
			possiblePingPong: repeatedIssue,
			splitWorkCandidate: repeatedIssue || sharedRootCause,
		},
	};
}

function collectRootCauseIssues(tasks: readonly BoardTaskSource[]): ReadonlyMap<string, ReadonlySet<string>> {
	const rootCauseIssues = new Map<string, Set<string>>();
	for (const task of tasks) {
		if (!task.rootCause || !task.issueId) {
			continue;
		}
		let issueIds = rootCauseIssues.get(task.rootCause);
		if (!issueIds) {
			issueIds = new Set();
			rootCauseIssues.set(task.rootCause, issueIds);
		}
		issueIds.add(task.issueId);
	}
	return rootCauseIssues;
}

function countUngroupedReasons(tasks: readonly BoardTaskSource[]): TaskBoardReport["ungrouped"]["reasonCounts"] {
	let missingPhaseId = 0;
	let missingIssueId = 0;
	let missingRootCause = 0;
	for (const task of tasks) {
		if (!task.phaseId) missingPhaseId += 1;
		if (!task.issueId) missingIssueId += 1;
		if (!task.rootCause) missingRootCause += 1;
	}
	return { missingPhaseId, missingIssueId, missingRootCause };
}

function countStatuses(tasks: readonly BoardTaskSource[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const task of tasks) {
		increment(counts, task.status);
	}
	return counts;
}

function countStringValues(values: readonly (string | undefined)[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) {
		if (value) increment(counts, value);
	}
	return counts;
}

function compactTask(task: BoardTaskSource): TaskBoardTask {
	return { taskId: task.taskId, status: task.status };
}

function compareGroups(left: TaskBoardGroup, right: TaskBoardGroup): number {
	if (left.hasActiveTasks !== right.hasActiveTasks) {
		return left.hasActiveTasks ? -1 : 1;
	}
	const leftLatest = latestTimestamp(left.latestUpdatedAt ?? undefined, left.latestCompletedAt ?? undefined) ?? "";
	const rightLatest = latestTimestamp(right.latestUpdatedAt ?? undefined, right.latestCompletedAt ?? undefined) ?? "";
	return (
		compareStrings(rightLatest, leftLatest) ||
		compareStrings(left.issueId, right.issueId) ||
		compareStrings(left.rootCause, right.rootCause) ||
		compareStrings(left.phaseId, right.phaseId)
	);
}

function compareTasks(left: BoardTaskSource, right: BoardTaskSource): number {
	return compareStrings(left.taskId, right.taskId);
}

function latestTimestamp(left: string | undefined, right: string | undefined): string | undefined {
	if (!left) return right;
	if (!right) return left;
	return compareStrings(left, right) >= 0 ? left : right;
}

function sortedCounts(counts: Readonly<Record<string, number>>): Record<string, number> {
	return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareStrings(left, right)));
}

function normalizeLimit(value: number | undefined, fallback: number, name: string): number {
	const limit = value ?? fallback;
	if (!Number.isInteger(limit) || limit < 0) {
		throw new RangeError(`${name} must be a non-negative integer`);
	}
	return limit;
}

function increment(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
