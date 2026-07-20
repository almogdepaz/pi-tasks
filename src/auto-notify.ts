import type { AgentTaskRecord } from "./types";

export function selectUnpromptedTerminalTasks(
	tasks: readonly AgentTaskRecord[],
	autoPromptedTaskIds: ReadonlySet<string>,
): readonly AgentTaskRecord[] {
	return tasks.filter((task) => !autoPromptedTaskIds.has(task.id));
}

export function buildBackgroundTaskNotificationPrompt(tasks: readonly AgentTaskRecord[]): string {
	const taskLines = tasks.map((task) => {
		const summary = task.error?.message ?? task.status;
		return `- ${task.id}: status=${task.status}, target=${task.targetSession}, summary=${summary}`;
	});

	return [
		"background wolfpack task results are ready for this parent session.",
		"call `agent_task_inbox` with `{ ack: true }` now to read and acknowledge the structured results.",
		"summarize the completed task results to the user concisely.",
		"do not call agent_task_wait; these tasks already reached a terminal state.",
		"tasks:",
		...taskLines,
	].join("\n");
}
