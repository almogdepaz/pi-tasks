import type {
	AgentTaskRecord,
	CreateDispatchedTaskInput,
	ListInboxOptions,
	StoredTaskResult,
	TaskResultPayload,
	TerminalTaskStatus,
	WaitForTaskOptions,
} from "./types";
import type { CreateOrReuseDispatchedTaskResult } from "./store";

export interface TaskCommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type TaskCommandExecutor = (
	command: string,
	args: readonly string[],
	options?: { readonly signal?: AbortSignal },
) => Promise<TaskCommandResult>;

export interface DispatchTaskInput {
	readonly projectDir: string;
	readonly task: AgentTaskRecord;
	readonly target: string;
	readonly assignment: string;
	readonly signal?: AbortSignal;
}

export type DispatchTaskResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly message: string; readonly retryable: boolean };

export interface TaskStore {
	readonly name: string;
	readonly tasksDir: string;
	readonly createOrReuseDispatchedTask: (input: CreateDispatchedTaskInput) => Promise<CreateOrReuseDispatchedTaskResult>;
	readonly readTask: (projectDir: string, taskId: string) => Promise<AgentTaskRecord>;
	readonly readTaskResult: (projectDir: string, taskId: string) => Promise<StoredTaskResult | undefined>;
	readonly expireTaskIfOverdue: (projectDir: string, taskId: string) => Promise<AgentTaskRecord>;
	readonly waitForTask: (projectDir: string, taskId: string, options: WaitForTaskOptions) => Promise<AgentTaskRecord>;
	readonly listInbox: (
		projectDir: string,
		parentSession: string,
		options: ListInboxOptions,
	) => Promise<readonly AgentTaskRecord[]>;
	readonly ackTask: (projectDir: string, taskId: string, parentSession: string) => Promise<AgentTaskRecord>;
	readonly cancelTask: (projectDir: string, taskId: string, reason: string | undefined) => Promise<AgentTaskRecord>;
	readonly completeTask: (
		projectDir: string,
		taskId: string,
		status: TerminalTaskStatus,
		payload: TaskResultPayload,
	) => Promise<AgentTaskRecord>;
}

export interface TaskTransport {
	readonly name: string;
	readonly getCurrentSessionName: (env: Record<string, string | undefined>) => string;
	readonly dispatchTask: (input: DispatchTaskInput) => Promise<DispatchTaskResult>;
}

export interface TaskCommunicationLayer {
	readonly store: TaskStore;
	readonly transport: TaskTransport;
}
