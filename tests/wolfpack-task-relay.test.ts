import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createWolfpackTaskCore, createWolfpackTaskRelay } from "../src/wolfpack-task-relay";

const temporaryDirectories: string[] = [];

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
const endpointsBySession = new Map<string, { readonly relay: string; readonly id: string }>();

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = request.method === "POST" ? await request.json() : undefined;
			requests.push({ path: url.pathname, body });
			if (url.pathname === "/api/task-relay/v2/connect") {
				const callerSession = typeof body === "object" && body !== null && "callerSession" in body ? body.callerSession : undefined;
				if (callerSession === "renewing-sender") return Response.json({ ok: true, endpoint: { relay: "wolfpack-pi-tasks-v2", id: "renewing-sender" }, leaseExpiresAt: new Date(Date.now() + 20).toISOString() });
				const generation = typeof body === "object" && body !== null && "generation" in body && typeof body.generation === "string" ? body.generation : "";
				const endpoint = { relay: "wolfpack-pi-tasks-v2", id: callerSession === "restart-sender" ? `restart-${generation}` : "sender" };
				if (typeof callerSession === "string") endpointsBySession.set(callerSession, endpoint);
				return Response.json({ ok: true, endpoint, leaseExpiresAt: "2099-01-01T00:00:00.000Z" });
			}
			if (url.pathname === "/api/task-relay/v2/resolve") return Response.json({ ok: true, endpoint: { relay: "wolfpack-pi-tasks-v2", id: "receiver" } });
			if (url.pathname === "/api/task-relay/v2/send") return Response.json({ ok: true, kind: "accepted", acceptanceId: "accepted-envelope", forwarding: "local" });
			if (url.pathname === "/api/task-relay/v2/receive") {
				const endpoint = endpointsBySession.get(url.searchParams.get("callerSession") ?? "") ?? { relay: "wolfpack-pi-tasks-v2", id: "sender" };
				return Response.json({
				ok: true,
				envelopes: [{
					envelopeId: "canonical-event", protocolVersion: 2,
					source: endpoint,
					target: endpoint,
					payload: { taskId: "task-1", kind: "canonical_event", payload: { eventId: "event-2", taskId: "task-1", type: "task.information", sequence: "2", source: endpoint, target: { relay: "wolfpack-pi-tasks-v2", id: "receiver" }, occurredAt: 1, payload: { message: "progress" } } },
					createdAt: "2026-08-09T00:00:00.000Z",
				}], nextCursor: "1", hasMore: false,
				});
			}
			if (url.pathname === "/api/task-relay/v2/delivery-ack") return Response.json({ ok: true, kind: "acknowledged" });
			return Response.json({ ok: false, error: { code: "INVALID_REQUEST", message: "unexpected route", retryable: false } }, { status: 400 });
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("uses the configured Wolfpack relay v2 HTTP contract instead of the in-memory relay", async () => {
	const core = await createWolfpackTaskCore({ baseUrl, sessionName: "sender", generation: "test-process", path: ":memory:", ids: sequence() });
	await core.connect();
	const created = await core.createTask({ target: { relay: "wolfpack-pi-tasks-v2", id: "receiver" }, task: "implement narrowly", timeoutMs: 1_000 });
	const deliveries = await core.receive();
	await core.acknowledgeRelayDelivery(deliveries[0]?.cursor ?? "0");

	expect(created.taskId).toBe("task-1");
	expect(core.getTask(created.taskId)?.events.map((event) => event.type)).toEqual(["task.created", "task.information"]);
	expect(requests).toEqual(expect.arrayContaining([
		{ path: "/api/task-relay/v2/connect", body: { callerSession: "sender", generation: "test-process", protocolVersions: [2], leaseMs: 60_000 } },
		{ path: "/api/task-relay/v2/resolve", body: { callerSession: "sender", target: { relay: "wolfpack-pi-tasks-v2", id: "receiver" }, protocolVersion: 2 } },
		expect.objectContaining({ path: "/api/task-relay/v2/send", body: expect.objectContaining({ callerSession: "sender", envelope: expect.objectContaining({ envelopeId: "task-3", protocolVersion: 2, source: { relay: "wolfpack-pi-tasks-v2", id: "sender" }, target: { relay: "wolfpack-pi-tasks-v2", id: "receiver" } }) }) }),
		{ path: "/api/task-relay/v2/delivery-ack", body: { callerSession: "sender", envelopeId: "canonical-event" } },
	]));
	const send = requests.find((request) => request.path === "/api/task-relay/v2/send");
	expect(send?.body).toMatchObject({ envelope: { payload: expect.objectContaining({ taskId: "task-1", kind: "assignment" }) } });
});

test("persists the Wolfpack generation and durable receive, intent, and timeout state across restart", async () => {
	const directory = mkdtempSync("/tmp/pi-tasks-wolfpack-");
	temporaryDirectories.push(directory);
	const path = join(directory, "tasks.sqlite");
	const now = { value: 1_000 };
	const options = { baseUrl, sessionName: "restart-sender", path, clock: { now: (): number => now.value } };
	const initial = await createWolfpackTaskCore({ ...options, ids: sequence() });
	await initial.connect();
	const created = await initial.createTask({ target: { relay: "wolfpack-pi-tasks-v2", id: "receiver" }, task: "survive restart", timeoutMs: 500 });
	await initial.receive();
	expect(initial.getTask(created.taskId)?.expiresAt).toBe(1_500);
	await initial.submitIntent({ taskId: created.taskId, type: "task.information", payload: { message: "persisted intent" } });

	now.value = 1_501;
	const restarted = await createWolfpackTaskCore({ ...options, ids: sequence("restart") });
	await restarted.connect();
	expect(restarted.getTask(created.taskId)?.expiresAt).toBeLessThan(now.value);
	expect(restarted.getTask(created.taskId)?.origin).toEqual(endpointsBySession.get("restart-sender"));
	expect(restarted.getTask(created.taskId)?.status).toBe("active");
	await restarted.evaluateTimeouts();

	expect(restarted.getTask(created.taskId)?.events.map((event) => event.type)).toEqual(["task.created", "task.information", "task.information", "task.timed_out"]);
	expect(restarted.getTask(created.taskId)?.status).toBe("timed_out");
	const generations = requests
		.filter((request) => request.path === "/api/task-relay/v2/connect" && (request.body as { readonly callerSession?: string }).callerSession === "restart-sender")
		.map((request) => (request.body as { readonly generation: string }).generation);
	expect(generations).toHaveLength(2);
	expect(generations[0]).toBe(generations[1]);
});

test("renews an expired Wolfpack registration through the real connect route", async () => {
	const relay = createWolfpackTaskRelay({ baseUrl, sessionName: "renewing-sender", generation: "renewing-process" });

	const first = await relay.endpoint();
	await Bun.sleep(30);
	const second = await relay.endpoint();

	expect(first).toEqual(second);
	expect(requests.filter((request) => request.path === "/api/task-relay/v2/connect" && (request.body as { readonly callerSession?: string }).callerSession === "renewing-sender")).toHaveLength(2);
});

test("propagates caller cancellation and bounds stalled relay HTTP requests", async () => {
	const stalledFetch = ((_request: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
	})) as typeof fetch;
	const cancelled = new AbortController();
	const abortRelay = createWolfpackTaskRelay({ sessionName: "abort-sender", fetch: stalledFetch });
	const pendingAbort = abortRelay.endpoint(cancelled.signal);
	cancelled.abort();
	await expect(pendingAbort).rejects.toMatchObject({ code: "ABORTED" });

	const timeoutRelay = createWolfpackTaskRelay({ sessionName: "timeout-sender", fetch: stalledFetch, requestTimeoutMs: 10 });
	await expect(timeoutRelay.endpoint()).rejects.toMatchObject({ code: "RELAY_TIMEOUT" });
});

test("propagates caller cancellation while parsing a streamed relay response body", async () => {
	const response = streamedConnectResponse();
	const relay = createWolfpackTaskRelay({
		sessionName: "abort-stream-sender",
		fetch: ((_request: string | URL | Request, init?: RequestInit) => {
			response.attach(init?.signal);
			return Promise.resolve(response.value);
		}) as typeof fetch,
	});
	const cancelled = new AbortController();
	const pending = relay.endpoint(cancelled.signal);

	await response.jsonStarted;
	cancelled.abort();

	await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
});

test("propagates relay deadlines while parsing a streamed response body", async () => {
	const response = streamedConnectResponse();
	const relay = createWolfpackTaskRelay({
		sessionName: "timeout-stream-sender",
		requestTimeoutMs: 10,
		fetch: ((_request: string | URL | Request, init?: RequestInit) => {
			response.attach(init?.signal);
			return Promise.resolve(response.value);
		}) as typeof fetch,
	});
	const pending = relay.endpoint();

	await response.jsonStarted;

	await expect(pending).rejects.toMatchObject({ code: "RELAY_TIMEOUT" });
});

function streamedConnectResponse(): { readonly value: Response; readonly jsonStarted: Promise<void>; attach(signal: AbortSignal | null | undefined): void } {
	let signal: AbortSignal | undefined;
	let startJson: (() => void) | undefined;
	let consumed = false;
	const jsonStarted = new Promise<void>((resolve) => { startJson = resolve; });
	const stream = new ReadableStream<Uint8Array>({
		pull(controller): void {
			if (consumed) return;
			consumed = true;
			startJson?.();
			const complete = setTimeout(() => {
				controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, endpoint: { relay: "wolfpack-pi-tasks-v2", id: "stream-sender" }, leaseExpiresAt: "2099-01-01T00:00:00.000Z" })));
				controller.close();
			}, 50);
			signal?.addEventListener("abort", () => {
				clearTimeout(complete);
				controller.error(new Error("stream aborted"));
			}, { once: true });
		},
	});
	return {
		value: new Response(stream),
		jsonStarted,
		attach(value: AbortSignal | null | undefined): void {
			signal = value ?? undefined;
		},
	};
}

function sequence(prefix = "task"): () => string {
	let number = 0;
	return (): string => `${prefix}-${++number}`;
}
