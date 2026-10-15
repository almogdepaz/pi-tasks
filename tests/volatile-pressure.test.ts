import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTaskStore } from "../src/task-store";
import { createVolatileTaskSession } from "../src/volatile-task-session";
import { deliverTaskInbox } from "../src/task-inbox";
import { TaskDeliveryStage } from "../src/task-protocol";

const source = process.env.PI_TASKS_WOLFPACK_SOURCE;
const revision = process.env.PI_TASKS_WOLFPACK_REVISION;

for (const historicalEvents of [0, 1_000, 10_000]) test.skipIf(!source)(`byte-limited worker refresh fetches one page with ${historicalEvents} historical Pi events and full receipts`, async () => {
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim()).toBe(revision!);
  expect(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: source, encoding: "utf8" }).trim()).toBe("");
  const { WorkerRelayGateway } = await import(join(source!, "src/task-relay/worker-client.ts"));
  const { validateJwtHs256 } = await import(join(source!, "src/auth.ts"));
  const { createRateLimiter } = await import(join(source!, "src/server/http.ts"));
  const root = mkdtempSync(join(tmpdir(), "pi-tasks-pressure-"));
  const worker = new WorkerRelayGateway({ profile: "volatile-v1", root: join(root, "relay"),
    inspectSession: async (name: string) => ({ ok: true, session: name, sessionId: name, projectPath: root, harness: "pi", alive: true }) });
  const secret = crypto.randomUUID();
  const jwtBody = [Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url")].join(".");
  const token = `${jwtBody}.${createHmac("sha256", secret).update(jwtBody).digest("base64url")}`;
  const frames: any[] = [], pages: any[] = [];
  let rejectSends = false;
  const limiter = createRateLimiter(120);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 64 * 1024, async fetch(request) {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token || !validateJwtHs256(token, secret).ok) return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
    if (!limiter.allow()) return Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429 });
    const body = await request.json() as any; frames.push(body);
    if (rejectSends && body.operation === "send") return new Response(null, { status: 429 });
    const result = await worker.volatile(body);
    if (body.operation === "receive" && result.ok) pages.push(result.value);
    return Response.json(result, { status: result.ok ? 200 : 409 });
  } });
  const stores = [createTaskStore(), createTaskStore()];
  // The transport has no credential provider: inject fixture credentials, never inherited live auth.
  const sessions = stores.map((store, i) => createVolatileTaskSession({ store, callerSession: `pressure-${i}`, url: `${server.url.origin}/fixture`,
    fetch: Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } }), { preconnect: fetch.preconnect }) }));
  try {
    await worker.initialize();
    const [sender, receiver] = await Promise.all(sessions.map(session => session.connect()));
    const history = SessionManager.create(root, join(root, "history"));
    history.appendMessage({ role: "assistant", content: [], api: "openai-responses", provider: "fixture", model: "none", usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }, stopReason: "stop", timestamp: Date.now() });
    for (let i = 0; i < historicalEvents; i++) history.appendCustomMessageEntry("pi-tasks-event", "historical fixture completion", true, {
      taskId: `archive-task-${i}`, eventId: `archive-event-${i}`,
    });
    const pi = {
      sendMessage(message: any) { history.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
      appendEntry(type: string, data: any) { history.appendCustomEntry(type, data); },
    };
    for (let i = 0; i < 15; i++) await sender!.createTask({ target: receiver!.endpoint, task: `${i}:${"x".repeat(16 * 1024)}`, timeoutMs: 60_000 });
    if (historicalEvents === 0) {
      const beforeHeld = frames.length;
      await deliverTaskInbox(pi, receiver!, { isIdle: () => false, hasPendingMessages: () => true, sessionManager: history });
      expect(frames.slice(beforeHeld).filter(frame => frame.operation === "receive")).toHaveLength(1);
      expect(pages.at(-1).hasMore).toBe(true);
      expect(stores[1]!.getReceiveCursor()).toBe("0");
      pages.length = 0;
    }
    const before = frames.length, started = performance.now();
    await deliverTaskInbox(pi, receiver!, { isIdle: () => true, hasPendingMessages: () => false, sessionManager: history });
    const cycle = frames.slice(before), inserted = history.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "pi-tasks-event").length - historicalEvents;
    console.log(JSON.stringify({ kind: "full-inbox-budget-basis", historicalEvents, elapsedMs: performance.now() - started, inserted,
      sends: cycle.filter(frame => frame.operation === "send").length, acks: cycle.filter(frame => frame.operation === "acknowledge").length,
      pages: pages.map(page => ({ length: page.deliveries.length, hasMore: page.hasMore, nextCursor: page.nextCursor })), historyEntries: history.getEntries().length }));
    expect(pages[0].deliveries.length).toBeLessThan(50);
    expect(pages[0].hasMore).toBe(true);
    expect(inserted).toBe(pages[0].deliveries.length);
    expect(inserted).toBeLessThan(15);
    expect(cycle.filter(frame => frame.operation === "send").length).toBeLessThanOrEqual(64);
    expect(cycle.filter(frame => frame.operation === "receive")).toHaveLength(1);
    const stages = new Map<string, string[]>();
    for (const frame of cycle.filter(frame => frame.operation === "send")) {
      const receipt = frame.envelope.payload.payload.payload;
      stages.set(receipt.eventId, [...(stages.get(receipt.eventId) ?? []), receipt.stage]);
    }
    expect(stages.size).toBe(inserted);
    for (const recorded of stages.values()) expect(recorded.sort()).toEqual([
      TaskDeliveryStage.receiverRecorded, TaskDeliveryStage.piInserted, TaskDeliveryStage.wakeRequested, TaskDeliveryStage.wakeAccepted,
    ].sort());
    const reopened = SessionManager.open(history.getSessionFile()!);
    expect(reopened.getEntries()).toHaveLength(history.getEntries().length);
    if (historicalEvents === 0) {
      const heldBefore = frames.length, cursor = stores[1]!.getReceiveCursor();
      await deliverTaskInbox(pi, receiver!, { isIdle: () => false, hasPendingMessages: () => true, sessionManager: history });
      expect(frames.slice(heldBefore).filter(frame => frame.operation === "receive")).toHaveLength(1);
      expect(stores[1]!.getReceiveCursor()).toBe(cursor);
      for (let i = 0; i < 2; i++) {
        const start = frames.length;
        await deliverTaskInbox(pi, receiver!, { isIdle: () => true, hasPendingMessages: () => false, sessionManager: history });
        expect(frames.slice(start).filter(frame => frame.operation === "receive")).toHaveLength(1);
      }
      expect(history.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "pi-tasks-event")).toHaveLength(15);
      // Exercise the full origin raw-receipt -> two canonical copies -> archive/ACK path too.
      const parentHistory = SessionManager.create(root, join(root, "parent-history"));
      const starter = history.getEntries().find(entry => entry.type === "message");
      if (starter?.type === "message" && starter.message.role === "assistant") parentHistory.appendMessage(starter.message);
      const parentPi = {
        sendMessage(message: any) { parentHistory.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
        appendEntry(type: string, data: any) { parentHistory.appendCustomEntry(type, data); },
      };
      for (let i = 0; i < 6; i++) {
        await Bun.sleep(1_100);
        const start = frames.length;
        try { await deliverTaskInbox(parentPi, sender!, { isIdle: () => true, hasPendingMessages: () => false, sessionManager: parentHistory }); }
        catch (error) { expect(error).toMatchObject({ code: "TASK_DELIVERY_DEFERRED" }); }
        const current = frames.slice(start);
        expect(current.filter(frame => frame.operation === "send").length).toBeLessThanOrEqual(64);
        expect(current.filter(frame => frame.operation === "acknowledge").length).toBeLessThanOrEqual(48);
        expect(current.filter(frame => frame.operation === "receive")).toHaveLength(1);
        if (parentHistory.getEntries().filter(entry => entry.type === "custom" && entry.customType === "pi-tasks-event-record").length === 60) break;
      }
      expect(parentHistory.getEntries().filter(entry => entry.type === "custom" && entry.customType === "pi-tasks-event-record")).toHaveLength(60);
      expect(sender!.listTasks().every(task => task.events.filter(event => event.type === "task.delivery_receipt").length === 4)).toBe(true);
      expect(stores[0]!.outbox("pending")).toEqual([]);
      expect(SessionManager.open(parentHistory.getSessionFile()!).getEntries()).toHaveLength(parentHistory.getEntries().length);
      await Bun.sleep(1_100); // Refill the production token bucket between distinct fixture phases.
      rejectSends = true;
      const pressureStart = frames.length;
      for (let i = 0; i < 32; i++) await expect(sender!.createTask({ target: receiver!.endpoint, task: `pending-${i}`, timeoutMs: 60_000 })).rejects.toBeDefined();
      const pending = stores[0]!.outbox("pending");
      expect(pending).toHaveLength(32);
      expect(frames.slice(pressureStart).filter(frame => frame.operation === "send").length).toBeLessThanOrEqual(64);
      const suppressed = frames.length;
      await expect(sender!.flushOutbox()).rejects.toMatchObject({ code: "TASK_DELIVERY_DEFERRED" });
      expect(frames).toHaveLength(suppressed);
      rejectSends = false;
      pending.forEach(record => stores[0]!.postponeOutbox!(record.envelope.envelopeId, 0));
      for (let i = 0; i < 4; i++) {
        const start = frames.length;
        try { await sender!.flushOutbox(); } catch (error) { expect(error).toMatchObject({ code: "TASK_DELIVERY_DEFERRED" }); }
        expect(frames.slice(start).filter(frame => frame.operation === "send").length).toBeLessThanOrEqual(8);
      }
      expect(stores[0]!.outbox("pending")).toEqual([]);
      expect(stores[0]!.outbox("accepted").slice(-32).map(record => record.envelope)).toEqual(pending.map(record => record.envelope));
    }
  } finally {
    sessions.forEach(session => session.close());
    stores.forEach(store => store.close());
    await server.stop(true); await worker.close(); rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
