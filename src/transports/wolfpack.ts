import type { DispatchTaskInput, DispatchTaskResult, TaskCommandExecutor, TaskTransport } from "../task-communication";

export const WOLFPACK_TASKS_DIR = ".wolfpack/tasks";

export interface WolfpackTaskTransportOptions {
	readonly exec: TaskCommandExecutor;
}

export function getCurrentWolfpackSessionName(env: Record<string, string | undefined>): string {
	return env.WOLFPACK_SESSION_NAME || "unknown-session";
}

export function createWolfpackTaskTransport(options: WolfpackTaskTransportOptions): TaskTransport {
	return {
		name: "wolfpack",
		getCurrentSessionName: getCurrentWolfpackSessionName,
		dispatchTask: async (input: DispatchTaskInput): Promise<DispatchTaskResult> => {
			const dispatch = await options.exec("wolfpack", ["session", "send", input.target, input.assignment], {
				signal: input.signal,
			});
			if (dispatch.code === 0) {
				return { ok: true };
			}
			return {
				ok: false,
				message: dispatch.stderr || dispatch.stdout || "wolfpack session send failed",
				retryable: true,
			};
		},
	};
}
