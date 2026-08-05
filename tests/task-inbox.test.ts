import { describe, expect, test } from "bun:test";

import { deliverTaskInbox, restoredInboxCursor } from "../src/task-inbox";
import type { TaskEvent, WolfpackGatewayClient } from "../src/gateway-client";

const assignmentEvent = event("task.created", "receiver", "event-assignment", "99");
const answerEvent = event("task.answer", "receiver", "event-answer", "100", "use the gateway");

function event(type: string, destination: "parent" | "receiver", id: string, sequence: string, message?: string): TaskEvent {
	return {
		id,
		taskId: "task-1",
		type,
		actor: destination === "receiver" ? "parent" : "receiver",
		source: { machine: "machine", sessionId: "parent-id" },
		destination: { machine: "machine", sessionId: destination === "receiver" ? "receiver-id" : "parent-id" },
		sequence,
		occurredAt: "2026-08-03T00:00:00.000Z",
		payload: { kind: "none" },
		...(message && { message }),
	};
}

function harness(options: { readonly existing?: readonly string[]; readonly idle?: boolean; readonly pending?: boolean } = {}) {
	const sent: Array<{ readonly content: string; readonly details: { readonly taskId: string; readonly eventId: string } }> = [];
	const deliveryOptions: Array<{ readonly triggerTurn: true; readonly deliverAs?: "followUp" }> = [];
	const cursors: unknown[] = [];
	const actions: string[] = [];
	let queued = false;
	const client: Pick<WolfpackGatewayClient, "inbox" | "status" | "delivered"> = {
		async inbox(cursor: string, _includeAcknowledged: boolean) {
			if (cursor === "0") return { events: [assignmentEvent], nextCursor: "1", hasMore: true };
			return { events: [answerEvent], nextCursor: "2", hasMore: false };
		},
		async status() {
			return {
				task: {
					taskId: "task-1", source: { machine: "machine", sessionId: "parent-id" }, target: { machine: "machine", sessionId: "receiver-id" }, task: "implement narrowly", createdAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T01:00:00.000Z",
					context: { summary: "## constraints and preferences\n- no legacy transport", refs: [{ path: "src/a.ts", purpose: "scope" }] }, onCompletePrompt: "review the diff",
				},
				status: "active", events: [], warnings: [],
			};
		},
		async delivered(taskId: string, eventId: string) {
			actions.push(`ack:${eventId}`);
			delivered.push({ taskId, eventId });
			return { taskId, eventId, sequence: "3", warnings: [] };
		},
	};
	const delivered: Array<{ readonly taskId: string; readonly eventId: string }> = [];
	const entries = (options.existing ?? []).map((eventId) => ({ type: "custom_message", customType: "wolfpack-task-event", details: { taskId: "task-1", eventId } }));
	const ctx = {
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => (options.pending ?? false) || queued,
		sessionManager: { buildContextEntries: () => entries, getEntries: () => entries },
	};
	const pi = {
		sendMessage(message: { readonly content: string; readonly details: { readonly taskId: string; readonly eventId: string } }, sendOptions?: { readonly triggerTurn: true; readonly deliverAs?: "followUp" }) {
			actions.push(`insert:${message.details.eventId}`);
			sent.push(message);
			if (sendOptions) deliveryOptions.push(sendOptions);
			if (ctx.isIdle()) entries.push({ type: "custom_message", customType: "wolfpack-task-event", details: message.details });
			else queued = true;
		},
		appendEntry(_type: string, data: unknown) { cursors.push(data); },
	};
	const settleQueued = (): void => {
		for (const message of sent) {
			if (!entries.some((entry) => entry.type === "custom_message" && entry.details.eventId === message.details.eventId)) {
				entries.push({ type: "custom_message", customType: "wolfpack-task-event", details: message.details });
			}
		}
		queued = false;
	};
	return { client, ctx, pi, sent, deliveryOptions, delivered, cursors, actions, settleQueued };
}

describe("gateway inbox delivery", () => {
	test("drains pages in order, inserts structured custom messages, then acknowledges and advances the cursor", async () => {
		const fixture = harness();
		await deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, "0");

		expect(fixture.sent.map((message) => message.details)).toEqual([
			{ taskId: "task-1", eventId: "event-assignment" },
			{ taskId: "task-1", eventId: "event-answer" },
		]);
		expect(fixture.delivered).toEqual([
			{ taskId: "task-1", eventId: "event-assignment" },
			{ taskId: "task-1", eventId: "event-answer" },
		]);
		expect(fixture.cursors.at(-1)).toEqual({ cursor: "2" });
		expect(fixture.actions).toEqual(["insert:event-assignment", "ack:event-assignment", "insert:event-answer", "ack:event-answer"]);
		expect(fixture.sent[0]?.content).toContain("## task assignment");
		expect(fixture.sent[0]?.content).toContain("src/a.ts");
	});

	test("renders assignment role without rendering metadata", async () => {
		const fixture = harness();
		fixture.client.status = async () => ({
			task: {
				taskId: "task-1", source: { machine: "machine", sessionId: "parent-id" }, target: { machine: "machine", sessionId: "receiver-id" }, task: "implement narrowly", createdAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T01:00:00.000Z", role: "implementer", metadata: { issueId: "do-not-render" },
			}, status: "active", events: [], warnings: [],
		});

		await deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, "0");

		expect(fixture.sent[0]?.content).toContain("## role\nimplementer");
		expect(fixture.sent[0]?.content).not.toContain("do-not-render");
	});

	test("reconstructs acknowledged active history for a fresh Pi session", async () => {
		const fixture = harness();
		const inbox = fixture.client.inbox;
		fixture.client.inbox = async (cursor: string, includeAcknowledged: boolean) => includeAcknowledged
			? inbox(cursor, includeAcknowledged)
			: { events: [], nextCursor: "2", hasMore: false };
		await deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, "0");
		expect(fixture.sent.map((message) => message.details.eventId)).toEqual(["event-assignment", "event-answer"]);
	});

	test("continues acknowledged fresh replay after the first insertion interrupts the poll", async () => {
		let idle = true;
		const includeAcknowledged: boolean[] = [];
		const fixture = harness();
		fixture.ctx.isIdle = () => idle;
		fixture.client.inbox = async (_cursor: string, includeAck: boolean) => {
			includeAcknowledged.push(includeAck);
			return includeAck
				? { events: [assignmentEvent, answerEvent], nextCursor: "2", hasMore: false }
				: { events: [], nextCursor: "2", hasMore: false };
		};
		const sendMessage = fixture.pi.sendMessage;
		fixture.pi.sendMessage = (message) => {
			sendMessage(message);
			if (message.details.eventId === "event-assignment") idle = false;
		};

		expect(await deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, "0")).toBe("0");
		expect(fixture.cursors).toHaveLength(0);
		idle = true;
		fixture.settleQueued();
		const restored = restoredInboxCursor(fixture.ctx.sessionManager.buildContextEntries());
		expect(restored).toBe("0");
		await deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, restored);

		expect(includeAcknowledged).toEqual([true, true]);
		expect(fixture.sent.map((message) => message.details.eventId)).toEqual(["event-assignment", "event-answer"]);
		expect(fixture.delivered.filter((delivery) => delivery.eventId === "event-answer")).toEqual([{ taskId: "task-1", eventId: "event-answer" }]);
	});

	test("queues one follow-up while Pi is busy and waits for structural evidence before acknowledging", async () => {
		const busy = harness({ idle: false });
		await deliverTaskInbox(busy.pi, busy.client, busy.ctx, "0");
		await deliverTaskInbox(busy.pi, busy.client, busy.ctx, "0");

		expect(busy.sent).toHaveLength(1);
		expect(busy.sent[0]?.details).toEqual({ taskId: "task-1", eventId: "event-assignment" });
		expect(busy.deliveryOptions).toEqual([{ triggerTurn: true, deliverAs: "followUp" }]);
		expect(busy.delivered).toHaveLength(0);
		expect(busy.cursors).toHaveLength(0);

		const recovered = harness({ existing: ["event-assignment"] });
		await deliverTaskInbox(recovered.pi, recovered.client, recovered.ctx, "0");
		expect(recovered.sent).toHaveLength(1);
		expect(recovered.sent[0]?.details).toEqual({ taskId: "task-1", eventId: "event-answer" });
		expect(recovered.delivered).toEqual([
			{ taskId: "task-1", eventId: "event-assignment" },
			{ taskId: "task-1", eventId: "event-answer" },
		]);
	});

	test("queues a follow-up when Pi becomes busy while status is pending", async () => {
		let idle = true;
		const fixture = harness();
		fixture.ctx.isIdle = () => idle;
		fixture.client.status = async () => {
			idle = false;
			return { task: { taskId: "task-1", source: { machine: "machine", sessionId: "parent-id" }, target: { machine: "machine", sessionId: "receiver-id" }, task: "implement", createdAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T01:00:00.000Z" }, status: "active", events: [], warnings: [] };
		};
		await deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, "0");
		expect(fixture.sent).toHaveLength(1);
		expect(fixture.deliveryOptions).toEqual([{ triggerTurn: true, deliverAs: "followUp" }]);
		expect(fixture.delivered).toHaveLength(0);
		expect(fixture.cursors).toHaveLength(0);
	});

	test("stops before insertion when pending work arrives while status is pending", async () => {
		let pending = false;
		const fixture = harness();
		fixture.ctx.hasPendingMessages = () => pending;
		fixture.client.status = async () => {
			pending = true;
			return { task: { taskId: "task-1", source: { machine: "machine", sessionId: "parent-id" }, target: { machine: "machine", sessionId: "receiver-id" }, task: "implement", createdAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T01:00:00.000Z" }, status: "active", events: [], warnings: [] };
		};
		await deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, "0");
		expect(fixture.sent).toHaveLength(0);
		expect(fixture.delivered).toHaveLength(0);
		expect(fixture.cursors).toHaveLength(0);
	});

	test("leaves the cursor retryable when sendMessage does not create structural evidence", async () => {
		const fixture = harness();
		fixture.pi.sendMessage = (message: { readonly content: string; readonly details: { readonly taskId: string; readonly eventId: string } }) => {
			fixture.actions.push(`insert:${message.details.eventId}`);
			fixture.sent.push(message);
		};
		await deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, "0");
		expect(fixture.sent).toHaveLength(1);
		expect(fixture.delivered).toHaveLength(0);
		expect(fixture.cursors).toHaveLength(0);
	});

	test("uses durable session entries rather than compacted active context as incorporation evidence", async () => {
		const sent: unknown[] = [];
		const delivered: unknown[] = [];
		const durableEntries = [{ type: "custom_message", customType: "wolfpack-task-event", details: { taskId: "task-1", eventId: "event-assignment" } }];
		const client = {
			async inbox() { return { events: [assignmentEvent], nextCursor: "1", hasMore: false }; },
			async status() { return { task: { taskId: "task-1", source: { machine: "machine", sessionId: "parent-id" }, target: { machine: "machine", sessionId: "receiver-id" }, task: "implement", createdAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T01:00:00.000Z" }, status: "active", events: [], warnings: [] }; },
			async delivered(taskId: string, eventId: string) { delivered.push({ taskId, eventId }); },
		};
		const ctx = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { buildContextEntries: () => [], getEntries: () => durableEntries } };
		const pi = { sendMessage(message: unknown) { sent.push(message); }, appendEntry() {} };

		await deliverTaskInbox(pi, client, ctx, "0");

		expect(sent).toHaveLength(0);
		expect(delivered).toEqual([{ taskId: "task-1", eventId: "event-assignment" }]);
	});

	test("fails closed without advancing the cursor for unknown model-visible events", async () => {
		const fixture = harness();
		fixture.client.inbox = async () => ({ events: [event("task.new_contract_event", "receiver", "unknown", "1")], nextCursor: "1", hasMore: false });

		await expect(deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, "0")).rejects.toThrow("unknown task inbox event type");

		expect(fixture.sent).toHaveLength(0);
		expect(fixture.cursors).toHaveLength(0);
	});

	test("skips non-model protocol events while advancing the cursor", async () => {
		const internal = ["task.receipt_confirmed", "task.delivered", "message.delivered", "task.parent_ack_pending", "task.parent_acknowledged", "event.delivery_failed"].map((type, index) => event(type, "receiver", `internal-${index}`, String(index + 1)));
		const model = event("task.information", "receiver", "event-information", "7", "model-relevant");
		const fixture = harness();
		fixture.client.inbox = async () => ({ events: [...internal, model], nextCursor: "7", hasMore: false });
		await deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, "0");
		expect(fixture.sent.map((message) => message.details.eventId)).toEqual(["event-information"]);
		expect(fixture.delivered).toEqual([{ taskId: "task-1", eventId: "event-information" }]);
		expect(fixture.cursors.at(-1)).toEqual({ cursor: "7" });
	});

	test("retries structurally proven delivery before suppressing acknowledged terminal history", async () => {
		const fixture = harness({ existing: ["event-assignment"] });
		fixture.client.inbox = async () => ({ events: [assignmentEvent], nextCursor: "1", hasMore: false });
		fixture.client.status = async () => ({
			task: { taskId: "task-1", source: { machine: "machine", sessionId: "parent-id" }, target: { machine: "machine", sessionId: "receiver-id" }, task: "complete", createdAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T01:00:00.000Z" },
			status: "completed", events: [event("task.parent_acknowledged", "parent", "event-parent-ack", "3")], warnings: [],
		});

		await deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, "0");

		expect(fixture.sent).toHaveLength(0);
		expect(fixture.delivered).toEqual([{ taskId: "task-1", eventId: "event-assignment" }]);
		expect(fixture.cursors.at(-1)).toEqual({ cursor: "1" });
	});

	test("does not replay history of a terminal task already acknowledged by its parent", async () => {
		const fixture = harness();
		const completed = event("task.completed", "parent", "event-completed", "2");
		fixture.client.inbox = async () => ({ events: [assignmentEvent, completed], nextCursor: "2", hasMore: false });
		fixture.client.status = async () => ({
			task: { taskId: "task-1", source: { machine: "machine", sessionId: "parent-id" }, target: { machine: "machine", sessionId: "receiver-id" }, task: "complete", createdAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T01:00:00.000Z" },
			status: "completed", events: [event("task.parent_acknowledged", "parent", "event-parent-ack", "3")], warnings: [],
		});
		await deliverTaskInbox(fixture.pi, fixture.client, fixture.ctx, "0");
		expect(fixture.sent).toHaveLength(0);
		expect(fixture.cursors.at(-1)).toEqual({ cursor: "2" });
	});

	test("delivers parent completion prompts without auto-acknowledging parent work", async () => {
		const terminal = event("task.completed", "parent", "event-result", "3");
		const sent: Array<{ readonly content: string; readonly details: unknown }> = [];
		const delivered: unknown[] = [];
		const client = {
			async inbox() { return { events: [terminal], nextCursor: "7", hasMore: false }; },
			async status() { return { task: { taskId: "task-1", source: { machine: "machine", sessionId: "parent-id" }, target: { machine: "machine", sessionId: "receiver-id" }, task: "implement", createdAt: "2026-08-03T00:00:00.000Z", expiresAt: "2026-08-03T01:00:00.000Z", onCompletePrompt: "review the receiver diff" }, status: "completed", events: [], completion: { summary: "implemented", warnings: [] }, warnings: [] }; },
			async delivered(...args: unknown[]) { delivered.push(args); },
		};
		const ctx = { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { buildContextEntries: () => [], getEntries: () => [] } };
		const pi = { sendMessage(message: { readonly content: string; readonly details: unknown }) { sent.push(message); }, appendEntry() {} };
		await deliverTaskInbox(pi, client, ctx, "0");
		expect(sent[0]?.content).toContain("review the receiver diff");
		expect(delivered).toHaveLength(0);
	});
});
