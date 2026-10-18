import { expect, spyOn, test } from "bun:test";
import { createTaskStore } from "../src/task-store";
import { TASK_PROTOCOL_VERSION, TaskEnvelopeKind, type TaskEvent } from "../src/task-protocol";

const a = { relay: "memory", id: "a" }, b = { relay: "memory", id: "b" };
const task = (taskId: string, createdAt = 1) => ({ taskId, protocolVersion: TASK_PROTOCOL_VERSION, origin: a, target: b, task: "work", createdAt, expiresAt: 10, status: "active" as const });
const event = (taskId: string, sequence: number, eventId = `${taskId}-${sequence}`): TaskEvent => ({ eventId, taskId, sequence: String(sequence), type: "task.information", source: a, target: b, occurredAt: 1, payload: { message: eventId } });
const envelope = (envelopeId: string, taskId: string) => ({ protocolVersion: TASK_PROTOCOL_VERSION, envelopeId, source: a, target: b, kind: TaskEnvelopeKind.intent, taskId, payload: "{}", createdAt: "1" });
const sequences = (store: ReturnType<typeof createTaskStore>, id: string) => store.getTask(id)?.events.map(item => item.eventId);

test("events stay grouped per task and ordered by sequence across interleaved appends, and listTasks agrees with getTask", () => {
	const store = createTaskStore();
	store.putTask(task("x", 2)); store.putTask(task("y", 1));
	for (const [id, sequence] of [["x", 3], ["y", 1], ["x", 1], ["y", 2], ["x", 2]] as const) store.appendEvent(event(id, sequence));
	expect(store.appendEvent(event("x", 1))).toBe(false);
	expect(sequences(store, "x")).toEqual(["x-1", "x-2", "x-3"]);
	expect(sequences(store, "y")).toEqual(["y-1", "y-2"]);
	expect(store.listTasks().map(item => [item.taskId, item.events.map(e => e.eventId)])).toEqual([["y", ["y-1", "y-2"]], ["x", ["x-1", "x-2", "x-3"]]]);
	expect(store.listTasks()).toEqual([store.getTask("y")!, store.getTask("x")!]);
	store.close();
});

test("a throwing transaction leaves tasks, events, status, the active state and quarantine lookups unchanged", () => {
	const store = createTaskStore();
	store.putTask(task("x")); store.appendEvent(event("x", 1)); store.setStatus("x", "completed");
	store.putOutbox(envelope("kept", "x"));
	const before = store.listTasks();
	expect(() => store.transaction(() => {
		store.setStatus("x", "active"); store.appendEvent(event("x", 2));
		store.putTask(task("y")); store.appendEvent(event("y", 1));
		store.quarantineOutbox("kept", { errorCode: "TARGET_NOT_REGISTERED", reason: "lost", details: {}, quarantinedAt: 1 });
		expect(store.hasActiveTasks()).toBe(true);
		expect(store.getQuarantine("kept")?.errorCode).toBe("TARGET_NOT_REGISTERED");
		throw new Error("rollback");
	})).toThrow("rollback");
	expect(store.listTasks()).toEqual(before);
	expect(store.getTask("y")).toBeUndefined();
	expect(store.hasActiveTasks()).toBe(false);
	expect(store.getQuarantine("kept")).toBeUndefined();
	expect(store.getOutboxRecord("kept")?.state).toBe("pending");
	// The rolled-back event id is free again, and the same task id can be admitted afresh.
	store.putTask(task("y")); expect(store.appendEvent(event("y", 1))).toBe(true); expect(sequences(store, "y")).toEqual(["y-1"]);
	store.close();
});

test("hasActiveTasks follows admission, status changes, nested rollback and clear", () => {
	const store = createTaskStore();
	expect(store.hasActiveTasks()).toBe(false);
	store.putTask(task("x")); expect(store.hasActiveTasks()).toBe(true);
	store.transaction(() => {
		store.setStatus("x", "completed");
		expect(() => store.transaction(() => { store.setStatus("x", "active"); throw new Error("inner"); })).toThrow("inner");
		expect(store.hasActiveTasks()).toBe(false);
	});
	expect(store.hasActiveTasks()).toBe(false);
	store.putTask(task("y")); store.clear();
	expect(store.hasActiveTasks()).toBe(false); expect(store.listTasks()).toEqual([]);
	store.putTask(task("y")); store.appendEvent(event("y", 1)); expect(sequences(store, "y")).toEqual(["y-1"]);
	store.close();
});

test("getQuarantine finds one quarantined envelope by id", () => {
	const store = createTaskStore();
	store.putTask(task("x")); store.putOutbox(envelope("one", "x")); store.putOutbox(envelope("two", "x"));
	store.quarantineOutbox("two", { errorCode: "UNAUTHORIZED_INTENT", reason: "refused", details: { why: 1 }, quarantinedAt: 5 });
	expect(store.getQuarantine("one")).toBeUndefined();
	expect(store.getQuarantine("two")).toEqual(store.quarantinedOutbox()[0]!);
	expect(store.getQuarantine("two")).toMatchObject({ errorCode: "UNAUTHORIZED_INTENT", priorState: "pending", envelope: { envelopeId: "two" } });
	store.close();
});

test("each stored cell is parsed at most once, and returned values cannot change the store", () => {
	const store = createTaskStore();
	for (const id of ["x", "y", "z"]) { store.putTask(task(id)); for (let i = 1; i <= 20; i++) store.appendEvent(event(id, i)); }
	const parse = spyOn(JSON, "parse");
	try {
		store.getTask("x"); store.listTasks();
		parse.mockClear();
		for (let i = 0; i < 5; i++) { store.getTask("x"); store.listTasks(); }
		expect(parse).toHaveBeenCalledTimes(0);
	} finally { parse.mockRestore(); }
	const snapshot = store.getTask("x")!;
	try { (snapshot.events[0]!.payload as { message: string }).message = "changed"; } catch (error) { expect(error).toBeInstanceOf(TypeError); }
	try { (snapshot.target as { id: string }).id = "changed"; } catch (error) { expect(error).toBeInstanceOf(TypeError); }
	expect(store.getTask("x")!.events[0]!.payload).toEqual({ message: "x-1" });
	expect(store.getTask("x")!.target).toEqual(b);
	store.close();
});

test("mutating a checkpoint read inside the store does not leak into the stored checkpoint before it is written", () => {
	const store = createTaskStore();
	store.trackRelayDeliveries(a, [{ cursor: "1", envelopeId: "e1" }, { cursor: "2", envelopeId: "e2" }]);
	expect(() => store.trackRelayDeliveries(a, [{ cursor: "3", envelopeId: "e3" }, { cursor: "1", envelopeId: "other" }])).toThrow("identity");
	expect(store.pendingRelayDeliveries(a)).toEqual([{ cursor: "1", envelopeId: "e1" }, { cursor: "2", envelopeId: "e2" }]);
	store.requestRelayAcknowledgement(a, "2"); store.acknowledgeRelayCursor(a, "1");
	expect(store.pendingRelayDeliveries(a)).toEqual([{ cursor: "2", envelopeId: "e2" }]);
	expect(store.getReceiveCursor()).toBe("1");
	store.close();
});
