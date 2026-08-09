import { expect, test } from "bun:test";

import { TASK_PROTOCOL_VERSION } from "./task-protocol";
import type { TaskRelay } from "./task-protocol";

/** Shared assertions external relay adapters can run against their implementation. */
export function runTaskRelayConformance(createRelay: () => TaskRelay): void {
	test("enforces registration, accepts duplicate envelopes once, and retains delivery until acknowledgement", async () => {
		const relay = createRelay();
		const source = { relay: relay.id, id: "source" };
		const target = { relay: relay.id, id: "target" };
		await relay.connect({ endpoint: source, protocolVersion: TASK_PROTOCOL_VERSION, receiveCursor: "0" });
		await relay.connect({ endpoint: target, protocolVersion: TASK_PROTOCOL_VERSION, receiveCursor: "0" });
		await expect(relay.resolve({ relay: relay.id, reference: "missing" })).rejects.toThrow("not registered");
		const envelope = { envelopeId: "envelope-1", protocolVersion: TASK_PROTOCOL_VERSION, source, target, taskId: "task-1", kind: "assignment" as const, payload: "{}" };
		await relay.send(envelope);
		await relay.send(envelope);
		const page = await relay.receive({ endpoint: target, cursor: "0", limit: 10 });
		expect(page.deliveries).toHaveLength(1);
		await relay.acknowledgeDelivery({ endpoint: target, cursor: page.nextCursor });
		expect((await relay.receive({ endpoint: target, cursor: page.nextCursor, limit: 10 })).deliveries).toHaveLength(0);
	});
}
