import type { TaskCore } from "./task-core";
import { createTaskWorkScope } from "./task-work-scope";
import type { TaskShipment, TaskWorkScope } from "./task-work-scope";
import { TASK_EVENT_TYPES, TaskDeliveryEvidenceState, TaskDeliveryStage, TaskEnvelopeKind, TaskOutboxDeliveryError, TaskProtocolError, isBlockedOutboxDeliveryCode } from "./task-protocol";
import type { RelayDelivery, TaskEvent } from "./task-protocol";

const TASK_EVENT_CUSTOM_TYPE = "pi-tasks-event";
const TASK_WAKE_CUSTOM_TYPE = "pi-tasks-wake";
const TASK_CURSOR_CUSTOM_TYPE = "pi-tasks-relay-cursor";
const TASK_RECORD_CUSTOM_TYPE = "pi-tasks-event-record";

interface InboxContext {
	readonly isIdle: () => boolean;
	readonly hasPendingMessages: () => boolean;
	readonly sessionManager: { readonly getEntries: () => readonly unknown[] };
}

interface InboxPi {
	sendMessage(
		message: { readonly customType: string; readonly content: string; readonly display: boolean; readonly details: TaskEventDetails },
		options: { readonly triggerTurn: false } | { readonly triggerTurn: true; readonly deliverAs: "followUp" },
	): void;
	appendEntry(customType: string, data: { readonly cursor: string } | TaskEventDetails): void;
}

export interface TaskEventDetails {
	readonly taskId: string;
	readonly eventId: string;
	/** Historical evidence only; never used to rebuild active task state. */
	readonly event?: TaskEvent;
}

type DeliveryEvidencePayload =
	| { readonly stage: typeof TaskDeliveryStage.receiverRecorded | typeof TaskDeliveryStage.wakeAccepted; readonly state: typeof TaskDeliveryEvidenceState.confirmed }
	| { readonly stage: typeof TaskDeliveryStage.piInsertion; readonly state: typeof TaskDeliveryEvidenceState.blocked; readonly retryable: true };

/** Relay items carry delivery receipts; origin-local items never emit receipts, insertion records or ACKs. */
interface RelayReceipts {
	readonly signal: AbortSignal;
	readonly work: TaskWorkScope;
}

/** Persists model-visible Pi evidence before advancing the relay cursor or retiring a local item, then starts one separate turn. */
export async function deliverTaskInbox(pi: InboxPi, core: TaskCore, context: InboxContext, signal?: AbortSignal, work = createTaskWorkScope(signal, "phased")): Promise<TaskOutboxDeliveryError | undefined> {
	// Explicit phases: intake, presentation, required sends, ACKs, then old-work retry.
	if (!work.phased) throw new TypeError("inbox delivery requires a phased work scope");
	signal = work.signal;
	let outboxError: TaskOutboxDeliveryError | undefined;
	let failure: unknown;
	const receipts: RelayReceipts = { signal, work };
	try {
		// Intake persists and canonicalizes without sending; earlier required sends of this pass are already queued.
		const items = await core.intakeInbox(signal, work);
		// Presentation persists Pi evidence only. Each relay item ends in an ACK, so stop at the remaining budget.
		const budget = work.remainingAcknowledgements();
		const presented: { readonly cursor: string; readonly shipments: readonly TaskShipment[] }[] = [];
		// Shipments queued from here on are this presentation's delivery receipts.
		const receiptsFrom = work.shipments.length;
		try {
			// The first held model-visible item holds every later visible item, so none overtakes it;
			// later control facts and self-authored copies are still archived and ACKed.
			let held = false;
			for (const item of items) {
				if (item.kind === "local") {
					if (held && isPresentedToModel(core, item.event)) continue;
					if (!await presentEvent(pi, core, context, item.event, undefined)) { held = true; continue; }
					core.completeLocalPresentation(item.event.eventId);
					continue;
				}
				if (presented.length >= budget) break;
				const delivery = item.delivery;
				const mark = work.shipments.length;
				if (delivery.envelope.kind !== TaskEnvelopeKind.intent) {
					const event = inboxEvent(delivery);
					if (held && isPresentedToModel(core, event)) continue;
					if (!await presentEvent(pi, core, context, event, receipts)) { held = true; continue; }
				}
				presented.push({ cursor: delivery.cursor, shipments: work.shipments.slice(mark) });
			}
		} catch (error) {
			// Items presented before the failure still ship and ACK; the failure surfaces at the end.
			if (work.signal.aborted) throw error;
			failure = error;
		}
		// Required sends in persist order. A receipt blocked for good is reported and does not hold its ACK.
		await core.shipRequired(signal, work);
		for (const [index, shipment] of work.shipments.entries()) {
			if (shipment.failure === undefined) continue;
			if (index >= receiptsFrom && isBlockedDeliveryFailure(shipment.failure)) outboxError ??= shipment.failure;
			else failure ??= shipment.failure;
		}
		// ACK only items whose receipts were accepted or blocked for good.
		try {
			for (const { cursor, shipments } of presented) {
				if (shipments.some(shipment => !shipment.shipped || (shipment.failure !== undefined && !isBlockedDeliveryFailure(shipment.failure)))) continue;
				await core.acknowledgeRelayDelivery(cursor, signal, work);
				pi.appendEntry(TASK_CURSOR_CUSTOM_TYPE, { cursor });
			}
			await core.repairAcknowledgements(signal, work);
		} catch (error) {
			if (work.signal.aborted) throw error;
			failure ??= error;
		}
	} finally {
		// Completed, held or failed delivery yields the remaining bounded share to old work.
		if (!work.signal.aborted) try { await core.flushOutbox(work.signal, work); } catch (error) {
			if (!(error instanceof TaskOutboxDeliveryError)) throw error;
			outboxError ??= error;
		}
	}
	// Collected failures surface only after presentation, ACKs and the bounded flush had their share.
	if (failure !== undefined) throw failure;
	return outboxError;
}

/**
 * Idle gate, insertion, rescan, wake and wake evidence for one event. Returns false when presentation is held.
 * Receipts collapse to the highest stage reached in this refresh (the origin derives the stages it implies),
 * plus `pi_insertion` blocked when insertion was not observed.
 */
async function presentEvent(pi: InboxPi, core: TaskCore, context: InboxContext, event: TaskEvent, receipts: RelayReceipts | undefined): Promise<boolean> {
	const eventDetails = { taskId: event.taskId, eventId: event.eventId };
	const eventKey = key(event.taskId, event.eventId);
	if (!isPresentedToModel(core, event)) {
		// Archive control facts and confirmed self-authored conversations without model insertion or wake,
		// even while Pi is busy. This is evidence only: no task state or delivery queue is reconstructed.
		if (!recordedEventKeys(context.sessionManager.getEntries()).has(eventKey)) pi.appendEntry(TASK_RECORD_CUSTOM_TYPE, { ...eventDetails, event });
		return true;
	}
	if (context.hasPendingMessages()) return false;
	const recordReceiver = async () => {
		if (receipts && event.type === "task.created") await recordDeliveryEvidence(core, eventDetails, { stage: TaskDeliveryStage.receiverRecorded, state: TaskDeliveryEvidenceState.confirmed }, receipts);
	};
	const recordInsertion = async () => {
		if (receipts) await core.recordInsertion(eventDetails, receipts.signal, receipts.work);
	};
	if (!incorporatedEvents(context.sessionManager.getEntries()).has(eventKey)) {
		if (!context.isIdle()) { await recordReceiver(); return false; }
		pi.sendMessage({
			customType: TASK_EVENT_CUSTOM_TYPE,
			content: renderTaskEvent(event),
			display: true,
			details: { ...eventDetails, event },
		}, { triggerTurn: false });
		if (!incorporatedEvents(context.sessionManager.getEntries()).has(eventKey)) {
			await recordReceiver();
			if (receipts) await recordDeliveryEvidence(core, eventDetails, { stage: TaskDeliveryStage.piInsertion, state: TaskDeliveryEvidenceState.blocked, retryable: true }, receipts);
			return false;
		}
	}
	if (taskMessageKeys(context.sessionManager.getEntries(), TASK_WAKE_CUSTOM_TYPE).has(eventKey)) {
		if (receipts) await recordDeliveryEvidence(core, eventDetails, { stage: TaskDeliveryStage.wakeAccepted, state: TaskDeliveryEvidenceState.confirmed }, receipts);
		return true;
	}
	if (hasAcknowledgedLocalOriginTerminal(core, event)) { await recordInsertion(); return true; }
	if (!context.isIdle()) { await recordInsertion(); return false; }
	// This synchronous local write closes the ACK/wake race; do not await relay I/O before Pi emits the wake.
	const wakeRequest = receipts && core.recordWakeRequest(eventDetails, receipts.work);
	let wakeAccepted = false;
	try {
		pi.sendMessage({
			customType: TASK_WAKE_CUSTOM_TYPE,
			content: "Process the pending Pi task event.",
			display: false,
			details: eventDetails,
		}, { triggerTurn: true, deliverAs: "followUp" });
		wakeAccepted = taskMessageKeys(context.sessionManager.getEntries(), TASK_WAKE_CUSTOM_TYPE).has(eventKey);
	} finally {
		// An unaccepted or throwing wake must not leave a wake_accepted record for the outbox flush.
		if (!wakeAccepted) wakeRequest?.discard();
	}
	if (!wakeAccepted) { await recordInsertion(); return false; }
	if (receipts && wakeRequest) await wakeRequest.flush(receipts.signal);
	return true;
}

/** Persists the receipt; the phased pass ships it before the item's ACK. */
async function recordDeliveryEvidence(core: TaskCore, event: TaskEventDetails, evidence: DeliveryEvidencePayload, receipts: RelayReceipts): Promise<void> {
	await core.submitIntent({ taskId: event.taskId, type: "task.delivery_receipt", payload: { eventId: event.eventId, ...evidence } }, receipts.signal, receipts.work);
}

function isBlockedDeliveryFailure(error: unknown): error is TaskOutboxDeliveryError {
	return error instanceof TaskOutboxDeliveryError && !error.retryable && isBlockedOutboxDeliveryCode(error.code);
}

function inboxEvent(delivery: RelayDelivery): TaskEvent {
	try {
		const payload = JSON.parse(delivery.envelope.payload) as unknown;
		if (!isRecord(payload)) throw new Error("not an object");
		if (delivery.envelope.kind === TaskEnvelopeKind.assignment && isTaskEvent(payload.event)) return payload.event;
		if (delivery.envelope.kind === TaskEnvelopeKind.canonicalEvent && isTaskEvent(payload)) return payload;
	} catch { /* normalize malformed opaque payloads to a protocol error */ }
	throw new TaskProtocolError("INVALID_INBOX_EVENT", "relay envelope does not contain a valid model event");
}

/** Model insertion and wake apply; otherwise the event is archived. Throws for an unknown event type. */
function isPresentedToModel(core: TaskCore, event: TaskEvent): boolean {
	const type = TASK_EVENT_TYPES[event.type];
	if (type === undefined) throw new TaskProtocolError("UNKNOWN_EVENT", `unknown task inbox event type: ${event.type}`);
	return type.visible && !core.isSelfAuthoredConversation(event);
}

function hasAcknowledgedLocalOriginTerminal(core: TaskCore, event: TaskEvent): boolean {
	if (TASK_EVENT_TYPES[event.type]?.terminal !== true) return false;
	const task = core.getTask(event.taskId);
	if (task === undefined || task.origin.relay !== core.endpoint.relay || task.origin.id !== core.endpoint.id) return false;
	const terminalIndex = task.events.findIndex((candidate) => candidate.eventId === event.eventId && candidate.type === event.type);
	return terminalIndex >= 0 && task.events.slice(terminalIndex + 1).some((candidate) => candidate.type === "task.parent_acknowledged");
}

function renderTaskEvent(event: TaskEvent): string {
	if (event.type === "task.created") return `## task assignment\ntask: \`${event.taskId}\` · event: \`${event.eventId}\`\n\n${String(event.payload.task ?? "")}`;
	const body = typeof event.payload.message === "string" ? `\n\n${event.payload.message}` : "";
	const summary = typeof event.payload.summary === "string" ? `\n\n**summary:** ${event.payload.summary}` : "";
	return `## task ${event.type.replace(/^task\./, "").replaceAll("_", " ")}\ntask: \`${event.taskId}\` · event: \`${event.eventId}\`${body}${summary}`;
}

export function incorporatedTaskEvents(entries: readonly unknown[]): readonly TaskEventDetails[] {
	return taskMessageDetails(entries, TASK_EVENT_CUSTOM_TYPE);
}

function taskMessageDetails(entries: readonly unknown[], customType: string): readonly TaskEventDetails[] {
	const events: TaskEventDetails[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== customType || !isRecord(entry.details) || typeof entry.details.taskId !== "string" || typeof entry.details.eventId !== "string") continue;
		events.push({ taskId: entry.details.taskId, eventId: entry.details.eventId });
	}
	return events;
}

function recordedEventKeys(entries: readonly unknown[]): Set<string> {
	return new Set(entries.flatMap(entry => isRecord(entry) && entry.type === "custom" && entry.customType === TASK_RECORD_CUSTOM_TYPE
		&& isRecord(entry.data) && typeof entry.data.taskId === "string" && typeof entry.data.eventId === "string"
		? [key(entry.data.taskId, entry.data.eventId)] : []));
}

function taskMessageKeys(entries: readonly unknown[], customType: string): Set<string> {
	return new Set(taskMessageDetails(entries, customType).map((event) => key(event.taskId, event.eventId)));
}

function incorporatedEvents(entries: readonly unknown[]): Set<string> {
	return taskMessageKeys(entries, TASK_EVENT_CUSTOM_TYPE);
}

function isTaskEvent(value: unknown): value is TaskEvent {
	return isRecord(value) && typeof value.eventId === "string" && typeof value.taskId === "string" && typeof value.type === "string" && typeof value.sequence === "string" && isRecord(value.source) && isRecord(value.target) && typeof value.occurredAt === "number" && isRecord(value.payload);
}

function key(taskId: string, eventId: string): string {
	return `${taskId}\u0000${eventId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
