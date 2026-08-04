import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { SendTaskInput } from "../src/gateway-client";
import { GatewayClientError, createWolfpackGatewayClient } from "../src/gateway-client";

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let sendRequests = 0;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/api/tasks/v1/status") {
				return Response.json({ ok: true, task: assignment(), status: "active", events: [], warnings: [] });
			}
			if (url.pathname === "/api/tasks/v1/send") {
				sendRequests += 1;
				return Response.json({ ok: true, taskId: "018f7f00-0000-7000-8000-000000000001", eventId: "018f7f00-0000-7000-8000-000000000002", sequence: "1", warnings: [] });
			}
			if (url.pathname === "/api/tasks/v1/message") return Response.json({ ok: true, taskId: "018f7f00-0000-7000-8000-000000000001", eventId: "018f7f00-0000-7000-8000-000000000003", sequence: "2" });
			if (url.pathname === "/failure") {
				return Response.json({ ok: false, error: { code: "TARGET_NOT_FOUND", message: "target missing", retryable: false } }, { status: 404 });
			}
			if (url.pathname === "/failure-with-path") {
				return Response.json({ ok: false, error: { code: "INVALID_REQUEST", message: "task missing", retryable: false, path: "/task" } }, { status: 400 });
			}
			if (url.pathname === "/malformed-path") {
				return Response.json({ ok: false, error: { code: "INVALID_REQUEST", message: "task missing", retryable: false, path: "task" } }, { status: 400 });
			}
			if (url.pathname === "/malformed") return Response.json({ nope: true });
			if (url.pathname === "/slow") {
				return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
			}
			return new Response("missing", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

function assignment(): Record<string, unknown> {
	return {
		taskId: "018f7f00-0000-7000-8000-000000000001",
		source: { machine: "local-machine", sessionId: "parent-id" },
		target: { machine: "local-machine", sessionId: "receiver-id" },
		task: "inspect the client",
		createdAt: "2026-08-03T00:00:00.000Z",
		expiresAt: "2026-08-03T00:30:00.000Z",
	};
}

describe("wolfpack gateway client", () => {
	test("uses WOLFPACK_PORT, sends the caller selector, and validates successful responses", async () => {
		const previousPort = process.env.WOLFPACK_PORT;
		process.env.WOLFPACK_PORT = String(server.port);
		const client = createWolfpackGatewayClient({ sessionName: "parent" });
		const receipt = await client.send({
			to: { machine: "local", sessionId: "receiver" },
			task: "inspect the client",
		});

		expect(receipt).toMatchObject({ taskId: "018f7f00-0000-7000-8000-000000000001", sequence: "1" });
		await expect(client.message({ taskId: receipt.taskId, type: "information", message: "gateway responses may omit warnings" })).resolves.toMatchObject({ sequence: "2", warnings: [] });
		if (previousPort === undefined) delete process.env.WOLFPACK_PORT;
		else process.env.WOLFPACK_PORT = previousPort;
	});

	test("maps structured gateway failures and malformed upstream responses to stable errors", async () => {
		const client = createWolfpackGatewayClient({ baseUrl, sessionName: "parent" });

		await expect(client.request("GET", "/failure")).rejects.toMatchObject({
			name: "GatewayClientError",
			code: "TARGET_NOT_FOUND",
			retryable: false,
			path: undefined,
		});
		await expect(client.request("GET", "/failure-with-path")).rejects.toMatchObject({
			name: "GatewayClientError",
			code: "INVALID_REQUEST",
			retryable: false,
			path: "/task",
		});
		await expect(client.request("GET", "/malformed-path")).rejects.toMatchObject({
			name: "GatewayClientError",
			code: "MALFORMED_RESPONSE",
			retryable: true,
		});
		await expect(client.request("GET", "/malformed")).rejects.toMatchObject({
			name: "GatewayClientError",
			code: "MALFORMED_RESPONSE",
			retryable: true,
		});
	});

	test("rejects client-side bounded message payloads before a network request", async () => {
		const client = createWolfpackGatewayClient({ baseUrl, sessionName: "parent" });
		await expect(client.message({ taskId: "task-1", type: "information", message: "x".repeat(16 * 1024 + 1) })).rejects.toMatchObject({ code: "INVALID_REQUEST", retryable: false });
	});

	test("identifies local send validation fields without HTTP requests", async () => {
		const client = createWolfpackGatewayClient({ baseUrl, sessionName: "parent" });
		const sendsBefore = sendRequests;
		const invalidInputs = [
			{ input: { to: { machine: "local", sessionId: "receiver" }, task: "" }, path: "/task" },
			{ input: { to: { machine: "local", sessionId: "" }, task: "send" }, path: "/to/sessionId" },
			{ input: { to: { machine: "local", sessionId: "receiver" }, task: "send", context: { refs: [{ path: "" }] } }, path: "/context/refs/0/path" },
			{ input: { to: { machine: "local", sessionId: "receiver" }, task: "send", context: { refs: {} } } as unknown as SendTaskInput, path: "/context/refs" },
			{ input: { to: { machine: "local", sessionId: "receiver" }, task: "send", preflight: { requiredProject: "" } }, path: "/preflight/requiredProject" },
			{ input: { to: { machine: "local", sessionId: "receiver" }, task: "send", timeoutMs: 999 }, path: "/timeoutMs" },
		] as const;

		for (const invalid of invalidInputs) {
			await expect(client.send(invalid.input)).rejects.toMatchObject({ code: "INVALID_REQUEST", retryable: false, path: invalid.path });
		}
		expect(sendRequests).toBe(sendsBefore);
	});

	test("rejects a >48KiB but <64KiB UTF-8 assignment envelope before network dispatch", async () => {
		const client = createWolfpackGatewayClient({ baseUrl, sessionName: "parent" });
		await expect(client.send({ to: { machine: "local", sessionId: "receiver" }, task: "small", context: { refs: Array.from({ length: 49 }, () => ({ path: "x".repeat(1_000) })) } })).rejects.toMatchObject({ code: "INVALID_REQUEST", retryable: false });
	});

	test("bounds the serialized HTTP envelope before dispatch", async () => {
		const client = createWolfpackGatewayClient({ baseUrl, sessionName: "parent" });
		await expect(client.send({ to: { machine: "local", sessionId: "receiver" }, task: "small", context: { refs: Array.from({ length: 100 }, () => ({ path: "x".repeat(1_000) })) } })).rejects.toMatchObject({ code: "INVALID_REQUEST", retryable: false });
	});

	test("honors caller aborts and bounded request timeouts", async () => {
		const client = createWolfpackGatewayClient({ baseUrl, sessionName: "parent", timeoutMs: 20 });
		await expect(client.request("GET", "/slow")).rejects.toMatchObject({ name: "GatewayClientError", code: "TIMEOUT" });

		const controller = new AbortController();
		controller.abort();
		await expect(client.request("GET", "/slow", undefined, controller.signal)).rejects.toMatchObject({
			name: "GatewayClientError",
			code: "ABORTED",
		});
	});
});
