import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createInMemoryTaskRelay } from "../src/in-memory-task-relay";
import { createTaskCore } from "../src/task-core";
import { createTaskStore } from "../src/task-store";
import { registerAgentTaskTools } from "../src/extension";

interface Tool {
	readonly name: string;
	readonly description: string;
	readonly parameters: unknown;
	execute(id: string, parameters: Record<string, unknown>, signal: AbortSignal, update: undefined, context: unknown): Promise<{ readonly content: readonly { readonly text: string }[]; readonly details: unknown }>;
}

test("registers endpoint-owned tools with only relay-qualified opaque targets", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const core = createTaskCore({ endpoint: { relay: "memory", id: "parent" }, relay, store: createTaskStore({ path: ":memory:" }), ids: sequence("parent") });
	await core.connect();
	await relay.connect({ endpoint: { relay: "memory", id: "child" }, protocolVersion: "pi-tasks/v2", receiveCursor: "0" });
	const tools: Record<string, Tool> = {};
	registerAgentTaskTools({ on: () => undefined, registerTool(tool: unknown) { const value = tool as Tool; tools[value.name] = value; } } as unknown as ExtensionAPI, core);

	const result = await tools.agent_task_send!.execute("call", { to: { relay: "memory", id: "child" }, task: "implement narrowly", timeoutMs: 1_000 }, new AbortController().signal, undefined, {});

	expect(result.content[0]?.text).toContain("## task accepted");
	expect(result.content[0]?.text).toContain("memory/child");
	expect(JSON.stringify(tools.agent_task_send?.parameters)).not.toContain("machine");
	expect(JSON.stringify(tools.agent_task_send?.parameters)).not.toContain("tailnet");

	await tools.agent_task_message!.execute("call", { taskId: "parent-1", type: "information", message: "owner update" }, new AbortController().signal, undefined, {});
	expect(core.getTask("parent-1")?.events.at(-1)?.type).toBe("task.information");
});

test("runs timeout evaluation and durable outbox retry in the default extension lifecycle", async () => {
	const relay = createInMemoryTaskRelay("memory");
	const now = { value: 0 };
	const store = createTaskStore({ path: ":memory:" });
	const core = createTaskCore({ endpoint: { relay: "memory", id: "parent" }, relay, store, clock: { now: (): number => now.value }, ids: sequence("parent") });
	await core.connect();
	await relay.connect({ endpoint: { relay: "memory", id: "child" }, protocolVersion: "pi-tasks/v2", receiveCursor: "0" });
	const created = await core.createTask({ target: { relay: "memory", id: "child" }, task: "expire", timeoutMs: 1_000 });
	relay.failNextSend();
	await expect(core.submitIntent({ taskId: created.taskId, type: "task.information", payload: { message: "retry me" } })).rejects.toThrow("in-memory relay send failed");
	now.value = 1_000;

	let sessionStart: ((event: unknown, context: unknown) => Promise<unknown>) | undefined;
	registerAgentTaskTools({
		on(event: string, handler: unknown) { if (event === "session_start") sessionStart = handler as (event: unknown, context: unknown) => Promise<unknown>; },
		registerTool() { undefined; },
	} as unknown as ExtensionAPI, core);
	const context = {
		hasPendingMessages: (): boolean => false,
		sessionManager: { getEntries: (): readonly unknown[] => [] },
		ui: { setStatus: (): void => undefined, theme: { fg: (_color: string, text: string): string => text } },
	};
	expect(sessionStart).toBeDefined();
	await sessionStart!({}, context);

	expect(core.getTask(created.taskId)?.status).toBe("timed_out");
	expect(store.outbox("pending")).toEqual([]);
});

test("publishes the supported core and relay contract independently from the Pi extension", async () => {
	const [source, packageJson] = await Promise.all([
		Bun.file(new URL("../src/extension.ts", import.meta.url)).text(),
		Bun.file(new URL("../package.json", import.meta.url)).json() as Promise<{ readonly module: string }>,
	]);
	expect(source).not.toContain("gateway-client");
	expect(source).not.toContain("core: TaskCore = createInMemoryExtensionCore()");
	expect(packageJson.module).toBe("src/index.ts");
});

function sequence(prefix: string): () => string {
	let number = 0;
	return (): string => `${prefix}-${++number}`;
}
