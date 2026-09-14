import { expect, test } from "bun:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerAgentTaskTools } from "../src/extension.js";
import { TaskProtocolError } from "../src/task-protocol.js";
import type { TaskCore } from "../src/task-core.js";

test("idle semantic messages persist synchronously and a triggered wake becomes durable", async () => {
	const directory = mkdtempSync("/tmp/pi-tasks-message-contract-");
	const sessionManager = SessionManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		resourceLoader,
		sessionManager,
		noTools: "all",
	});
	let agentStarts = 0;
	let agentSettlements = 0;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "agent_start") agentStarts += 1;
		if (event.type === "agent_settled") agentSettlements += 1;
	});

	try {
		const sending = session.sendCustomMessage({
			customType: "pi-tasks-event",
			content: "assignment",
			display: true,
			details: { taskId: "task-1", eventId: "event-1" },
		}, { triggerTurn: false });

		expect(sessionManager.getEntries()).toContainEqual(expect.objectContaining({
			type: "custom_message",
			customType: "pi-tasks-event",
			details: { taskId: "task-1", eventId: "event-1" },
		}));
		await sending;

		const waking = session.sendCustomMessage({
			customType: "pi-tasks-wake",
			content: "Process the pending Pi task event.",
			display: false,
			details: { taskId: "task-1", eventId: "event-1" },
		}, { triggerTurn: true, deliverAs: "followUp" });
		expect(sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-tasks-wake")).toHaveLength(0);
		await waking;
		expect(sessionManager.getEntries()).toContainEqual(expect.objectContaining({
			type: "custom_message",
			customType: "pi-tasks-wake",
			details: { taskId: "task-1", eventId: "event-1" },
		}));
		expect(sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-tasks-wake")).toHaveLength(1);
		expect(agentStarts).toBe(1);
		expect(agentSettlements).toBe(1);
	} finally {
		unsubscribe();
		session.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("automatic relay-loss evidence is durable before another prompt and does not start an agent turn", async () => {
	const directory = mkdtempSync("/tmp/pi-tasks-relay-loss-contract-");
	const sessionDirectory = join(directory, "sessions");
	const sessionManager = SessionManager.create(directory, sessionDirectory);
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "existing session" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	const { session } = await createAgentSession({ cwd: directory, agentDir: directory, resourceLoader, sessionManager, noTools: "all" });
	let agentStarts = 0;
	const unsubscribe = session.subscribe((event) => { if (event.type === "agent_start") agentStarts += 1; });
	let sessionStart: ((event: unknown, context: unknown) => Promise<void>) | undefined;
	let agentSettled: ((event: unknown, context: unknown) => Promise<void>) | undefined;
	let sessionShutdown: (() => Promise<void>) | undefined;
	let oldConnects = 0;
	const oldCore = {
		endpoint: { relay: "wolfpack-pi-tasks-v2", id: "lost-endpoint" },
		async connect(): Promise<void> { if (++oldConnects > 1) throw new TaskProtocolError("RELAY_RESET", "relay reset", { retryable: false }); },
		async flushOutbox(): Promise<void> { undefined; },
		async evaluateTimeouts(): Promise<void> { undefined; },
		async receive(): Promise<readonly []> { return []; },
		listTasks: () => [{ taskId: "lost-task", status: "active" }],
		async close(): Promise<void> { undefined; },
	} as unknown as TaskCore & { close(): Promise<void> };
	const freshCore = {
		endpoint: { relay: "wolfpack-pi-tasks-v2", id: "fresh-endpoint" },
		async connect(): Promise<void> { undefined; },
		async flushOutbox(): Promise<void> { undefined; },
		async evaluateTimeouts(): Promise<void> { undefined; },
		async receive(): Promise<readonly []> { return []; },
		listTasks: () => [],
		async close(): Promise<void> { undefined; },
	} as unknown as TaskCore & { close(): Promise<void> };
	const context = {
		isIdle: (): boolean => true,
		hasPendingMessages: (): boolean => false,
		sessionManager,
		ui: { setStatus(): void { undefined; }, notify(): void { undefined; }, theme: { fg: (_color: string, text: string): string => text } },
	};

	registerAgentTaskTools({
		on(event: string, handler: unknown): void {
			if (event === "session_start") sessionStart = handler as typeof sessionStart;
			if (event === "agent_settled") agentSettled = handler as typeof agentSettled;
			if (event === "session_shutdown") sessionShutdown = handler as typeof sessionShutdown;
		},
		registerTool(): void { undefined; },
		sendMessage(message: Parameters<typeof session.sendCustomMessage>[0], options?: Parameters<typeof session.sendCustomMessage>[1]): void {
			void session.sendCustomMessage(message, options);
		},
	} as unknown as ExtensionAPI, undefined, async (_signal, rebind) => rebind ? freshCore : oldCore);

	try {
		await sessionStart!({}, context);
		await agentSettled!({}, context);
		expect(sessionManager.getEntries()).toContainEqual(expect.objectContaining({
			type: "custom_message",
			customType: "pi-tasks-relay-loss",
			details: expect.objectContaining({ taskId: "lost-task", status: "failed", remoteOutcome: "unknown" }),
		}));
		expect(agentStarts).toBe(0);
		await sessionShutdown!();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("persistent Pi session did not create a session file");
		const reopened = SessionManager.open(sessionFile, sessionDirectory, directory);
		expect(reopened.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "pi-tasks-relay-loss")).toBe(true);
	} finally {
		unsubscribe();
		session.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});
