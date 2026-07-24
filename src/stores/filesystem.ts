import type { TaskStore } from "../task-communication";
import {
	ackTask,
	cancelTask,
	completeTask,
	createOrReuseDispatchedTask,
	createOrReusePreflightRejectedTask,
	DEFAULT_TASKS_DIR,
	expireTaskIfOverdue,
	findActiveTaskByIssueId,
	listInbox,
	readTask,
	readTaskResult,
	waitForTask,
} from "../store";
import type {
	CreateDispatchedTaskInput,
	CreateRejectedTaskInput,
	ListInboxOptions,
	TaskResultPayload,
	TerminalTaskStatus,
	WaitForTaskOptions,
} from "../types";

export interface FilesystemTaskStoreOptions {
	readonly tasksDir?: string;
}

export function createFilesystemTaskStore(options: FilesystemTaskStoreOptions = {}): TaskStore {
	const tasksDir = options.tasksDir ?? DEFAULT_TASKS_DIR;
	const scope = (projectDir: string): { readonly projectDir: string; readonly tasksDir: string } => ({ projectDir, tasksDir });

	return {
		name: "filesystem",
		tasksDir,
		createOrReuseDispatchedTask: (input: CreateDispatchedTaskInput) =>
			createOrReuseDispatchedTask({ ...input, tasksDir: input.tasksDir ?? tasksDir }),
		createOrReusePreflightRejectedTask: (input: CreateRejectedTaskInput) =>
			createOrReusePreflightRejectedTask({ ...input, tasksDir: input.tasksDir ?? tasksDir }),
		readTask: (projectDir: string, taskId: string) => readTask(scope(projectDir), taskId),
		readTaskResult: (projectDir: string, taskId: string) => readTaskResult(scope(projectDir), taskId),
		expireTaskIfOverdue: (projectDir: string, taskId: string) => expireTaskIfOverdue(scope(projectDir), taskId),
		waitForTask: (projectDir: string, taskId: string, options: WaitForTaskOptions) => waitForTask(scope(projectDir), taskId, options),
		listInbox: (projectDir: string, parentSession: string, options: ListInboxOptions) =>
			listInbox(scope(projectDir), parentSession, options),
		findActiveTaskByIssueId: (projectDir: string, targetSession: string, issueId: string) =>
			findActiveTaskByIssueId(scope(projectDir), targetSession, issueId),
		ackTask: (projectDir: string, taskId: string, parentSession: string) => ackTask(scope(projectDir), taskId, parentSession),
		cancelTask: (projectDir: string, taskId: string, reason: string | undefined) => cancelTask(scope(projectDir), taskId, reason),
		completeTask: (projectDir: string, taskId: string, status: TerminalTaskStatus, payload: TaskResultPayload) =>
			completeTask(scope(projectDir), taskId, status, payload),
	};
}
