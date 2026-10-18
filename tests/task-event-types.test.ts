import { expect, test } from "bun:test";
import { TASK_EVENT_TYPES, taskEventTypes } from "../src/task-protocol";

const sorted = (types: ReadonlySet<string>) => [...types].sort();

test("the event table reproduces the event lists core, inbox, store and extension used before it", () => {
	// Inbound acceptance (v0.1.15 wire compatibility plus task.reassigned) and the inbox's known types.
	expect(Object.keys(TASK_EVENT_TYPES).sort()).toEqual(["task.answer", "task.cancelled", "task.completed", "task.created", "task.delivery_receipt", "task.failed",
		"task.information", "task.late_terminal", "task.parent_acknowledged", "task.question", "task.reassigned", "task.timed_out"]);
	expect(sorted(taskEventTypes(type => !type.visible))).toEqual(["task.delivery_receipt", "task.late_terminal", "task.parent_acknowledged"]);
	expect(sorted(taskEventTypes(type => type.terminal))).toEqual(["task.cancelled", "task.completed", "task.failed", "task.timed_out"]);
	expect(sorted(taskEventTypes(type => type.conversational))).toEqual(["task.answer", "task.information", "task.question"]);
	expect(sorted(taskEventTypes(type => type.evidence))).toEqual(["task.delivery_receipt"]);
	expect(sorted(taskEventTypes(type => type.intent))).toEqual(["task.answer", "task.cancelled", "task.completed", "task.delivery_receipt", "task.failed", "task.information", "task.question"]);
	expect(sorted(taskEventTypes(type => type.terminal && type.intent))).toEqual(["task.cancelled", "task.completed", "task.failed"]);
	expect(Object.values(TASK_EVENT_TYPES).flatMap(type => type.status ?? []).sort()).toEqual(["cancelled", "completed", "failed", "timed_out"]);
	expect(TASK_EVENT_TYPES["task.timed_out"]!.status).toBe("timed_out");
});
