import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TaskStoreDiagnostic {
	readonly severity: "warning" | "error";
	readonly code: string;
	readonly path: string;
	readonly message: string;
}

export interface TaskStoreArtifactRecord {
	readonly taskDirectoryName: string;
	readonly task: Record<string, unknown>;
	readonly assignment: unknown | undefined;
	readonly result: Record<string, unknown> | undefined;
}

export interface TaskStoreArtifactRead {
	readonly records: readonly TaskStoreArtifactRecord[];
	readonly diagnostics: readonly TaskStoreDiagnostic[];
}

type JsonReadResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly missing: boolean; readonly message: string };

export async function readTaskStoreArtifacts(tasksRoot: string): Promise<TaskStoreArtifactRead> {
	const diagnostics: TaskStoreDiagnostic[] = [];
	const records: TaskStoreArtifactRecord[] = [];
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
		return { records, diagnostics };
	}

	const directories = entries
		.filter((entry) => entry.isDirectory())
		.sort((left, right) => compareStrings(left.name, right.name));
	for (const directory of directories) {
		const taskDirectoryName = directory.name;
		const taskRead = await readJson(join(tasksRoot, taskDirectoryName, "task.json"));
		if (!taskRead.ok) {
			diagnostics.push({
				severity: taskRead.missing ? "warning" : "error",
				code: taskRead.missing ? "missing_task_json" : "malformed_task_json",
				path: join(taskDirectoryName, "task.json"),
				message: taskRead.message,
			});
			continue;
		}
		if (!isRecord(taskRead.value)) {
			diagnostics.push({
				severity: "error",
				code: "malformed_task_json",
				path: join(taskDirectoryName, "task.json"),
				message: "task.json must contain an object",
			});
			continue;
		}

		const assignment = await readAssignment(tasksRoot, taskDirectoryName, diagnostics);
		const result = await readResult(tasksRoot, taskDirectoryName, diagnostics);
		records.push({ taskDirectoryName, task: taskRead.value, assignment, result });
	}

	return { records, diagnostics };
}

async function readAssignment(
	tasksRoot: string,
	taskDirectoryName: string,
	diagnostics: TaskStoreDiagnostic[],
): Promise<unknown | undefined> {
	const relativePath = join(taskDirectoryName, "assignment.json");
	const assignmentRead = await readJson(join(tasksRoot, relativePath));
	if (assignmentRead.ok) {
		return assignmentRead.value;
	}
	if (!assignmentRead.missing) {
		diagnostics.push({
			severity: "error",
			code: "malformed_assignment_json",
			path: relativePath,
			message: assignmentRead.message,
		});
	}
	return undefined;
}

async function readResult(
	tasksRoot: string,
	taskDirectoryName: string,
	diagnostics: TaskStoreDiagnostic[],
): Promise<Record<string, unknown> | undefined> {
	const relativePath = join(taskDirectoryName, "result.json");
	const resultRead = await readJson(join(tasksRoot, relativePath));
	if (!resultRead.ok) {
		diagnostics.push({
			severity: resultRead.missing ? "warning" : "error",
			code: resultRead.missing ? "missing_result_json" : "malformed_result_json",
			path: relativePath,
			message: resultRead.message,
		});
		return undefined;
	}
	if (!isRecord(resultRead.value)) {
		diagnostics.push({
			severity: "error",
			code: "malformed_result_json",
			path: relativePath,
			message: "result.json must contain an object",
		});
		return undefined;
	}
	return resultRead.value;
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

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
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
