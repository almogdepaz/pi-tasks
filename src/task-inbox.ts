import type { TaskAssignment, TaskEvent, TaskStatus, WolfpackGatewayClient } from "./gateway-client";

const TASK_EVENT_CUSTOM_TYPE = "wolfpack-task-event";
const TASK_CURSOR_CUSTOM_TYPE = "wolfpack-task-cursor";

interface InboxContext {
	readonly isIdle: () => boolean;
	readonly hasPendingMessages: () => boolean;
	readonly sessionManager: {
		readonly buildContextEntries: () => readonly unknown[];
		readonly getEntries: () => readonly unknown[];
	};
}

interface InboxPi {
	sendMessage(message: { readonly customType: string; readonly content: string; readonly display: boolean; readonly details: TaskEventDetails }, options: { readonly triggerTurn: true }): void;
	appendEntry(customType: string, data: { readonly cursor: string }): void;
}

interface TaskEventDetails {
	readonly taskId: string;
	readonly eventId: string;
}

interface InboxClient {
	inbox(cursor: string, includeAcknowledged: boolean): Promise<{ readonly events: readonly TaskEvent[]; readonly nextCursor: string; readonly hasMore: boolean }>;
	status(taskId: string): Promise<TaskStatus>;
	delivered(taskId: string, eventId: string): Promise<unknown>;
}

export async function deliverTaskInbox(pi: InboxPi, client: InboxClient, ctx: InboxContext, initialCursor: string): Promise<string> {
	if (!ctx.isIdle() || ctx.hasPendingMessages()) return initialCursor;
	const entries = ctx.sessionManager.getEntries();
	const incorporated = incorporatedEvents(entries);
	const includeAcknowledged = initialCursor === "0" && !hasPersistedCursor(entries);
	let cursor = initialCursor;
	for (;;) {
		const page = await client.inbox(cursor, includeAcknowledged);
		for (const event of page.events) {
			const disposition = inboxDisposition(event.type);
			if (disposition === "internal") continue;
			if (disposition === "unknown") throw new Error(`unknown task inbox event type: ${event.type}`);
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return cursor;
			const eventKey = key(event.taskId, event.id);
			const snapshot = await client.status(event.taskId);
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return cursor;
			if (incorporated.has(eventKey)) {
				if (event.destination.sessionId === snapshot.task.target.sessionId) await client.delivered(event.taskId, event.id);
				continue;
			}
			if (terminalHistoryAcknowledged(snapshot)) continue;
			pi.sendMessage({
				customType: TASK_EVENT_CUSTOM_TYPE,
				content: renderTaskEvent(event, snapshot),
				display: true,
				details: { taskId: event.taskId, eventId: event.id },
			}, { triggerTurn: true });
			if (!incorporatedEvents(ctx.sessionManager.getEntries()).has(eventKey)) return cursor;
			incorporated.add(eventKey);
			if (event.destination.sessionId === snapshot.task.target.sessionId) await client.delivered(event.taskId, event.id);
		}
		// Inbox cursors are machine-local delivery sequences, never task event sequences.
		cursor = page.nextCursor;
		pi.appendEntry(TASK_CURSOR_CUSTOM_TYPE, { cursor });
		if (!page.hasMore) return cursor;
	}
}

function hasPersistedCursor(entries: readonly unknown[]): boolean {
	return entries.some((entry) => isRecord(entry) && entry.type === "custom" && entry.customType === TASK_CURSOR_CUSTOM_TYPE && isRecord(entry.data) && decimal(entry.data.cursor));
}

function inboxDisposition(type: string): "model-visible" | "internal" | "unknown" {
	if (type === "task.created" || type === "task.question" || type === "task.answer" || type === "task.information" || terminalEvent(type) || type === "task.cancel_requested") return "model-visible";
	if (type === "task.received" || type === "task.receipt_confirmed" || type === "task.delivered" || type === "message.delivered" || type === "task.parent_ack_pending" || type === "task.parent_acknowledged" || type === "event.delivery_failed" || type === "task.late_terminal") return "internal";
	return "unknown";
}

function terminalHistoryAcknowledged(snapshot: TaskStatus): boolean {
	return ["completed", "failed", "cancelled", "timed_out"].includes(snapshot.status) && snapshot.events.some((event) => event.type === "task.parent_acknowledged");
}

export function restoredInboxCursor(entries: readonly unknown[]): string {
	let cursor = "0";
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TASK_CURSOR_CUSTOM_TYPE || !isRecord(entry.data) || !decimal(entry.data.cursor)) continue;
		cursor = entry.data.cursor;
	}
	return cursor;
}

export function incorporatedEvents(entries: readonly unknown[]): Set<string> {
	const events = new Set<string>();
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== TASK_EVENT_CUSTOM_TYPE || !isRecord(entry.details) || !nonEmpty(entry.details.taskId) || !nonEmpty(entry.details.eventId)) continue;
		events.add(key(entry.details.taskId, entry.details.eventId));
	}
	return events;
}

export function renderTaskEvent(event: TaskEvent, snapshot: TaskStatus): string {
	const header = `task: \`${event.taskId}\` · event: \`${event.id}\``;
	if (event.type === "task.created") return renderAssignment(header, snapshot.task, snapshot.warnings);
	const message = event.message ? `\n\n${event.message}` : "";
	const completion = event.completion ?? snapshot.completion;
	const completionText = completion ? `\n\n**summary:** ${completion.summary}` : "";
	const parentPrompt = terminalEvent(event.type) && event.destination.sessionId === snapshot.task.source.sessionId && snapshot.task.onCompletePrompt
		? `\n\n## parent follow-up\n${snapshot.task.onCompletePrompt}`
		: "";
	const warnings = renderWarnings(snapshot.warnings);
	return `## task ${label(event.type)}\n${header}${message}${completionText}${parentPrompt}${warnings}`;
}

function renderAssignment(header: string, assignment: TaskAssignment, warnings: readonly { readonly code: string; readonly message: string }[]): string {
	const role = assignment.role ? `\n\n## role\n${assignment.role}` : "";
	const context = assignment.context?.summary ? `\n\n## context\n${assignment.context.summary}` : "";
	const refs = assignment.context?.refs?.length
		? `\n\n## selected refs\n${assignment.context.refs.map((ref) => `- \`${ref.path}\`${ref.selector ? ` — ${ref.selector}` : ""}${ref.purpose ? ` — ${ref.purpose}` : ""}`).join("\n")}`
		: "";
	return `## task assignment\n${header}\n\n${assignment.task}${role}${context}${refs}${renderWarnings(warnings)}`;
}

function renderWarnings(warnings: readonly { readonly code: string; readonly message: string }[]): string {
	return warnings.length === 0 ? "" : `\n\n## gateway warnings\n${warnings.map((warning) => `- ${warning.code}: ${warning.message}`).join("\n")}`;
}

function label(type: string): string {
	return type.replace(/^task\./, "").replaceAll("_", " ");
}

function terminalEvent(type: string): boolean {
	return type === "task.completed" || type === "task.failed" || type === "task.cancelled" || type === "task.timed_out";
}

function key(taskId: string, eventId: string): string {
	return `${taskId}\u0000${eventId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function decimal(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}
