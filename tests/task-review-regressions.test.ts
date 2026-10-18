import { test, expect } from 'bun:test';
import { createTaskCore } from '../src/task-core';
import { createTaskStore } from '../src/task-store';
import { createTaskWorkScope } from '../src/task-work-scope';
import { deliverTaskInbox } from '../src/task-inbox';
import { createInMemoryTaskRelay } from '../src/in-memory-task-relay';
import { TASK_PROTOCOL_VERSION, TaskProtocolError } from '../src/task-protocol';
import type { RelayDelivery, TaskRelay } from '../src/task-protocol';
import type { TaskInboxItem } from '../src/task-core';

const origin = { relay: 'memory', id: 'origin' }, target = { relay: 'memory', id: 'target' };
const relayDeliveries = (items: readonly TaskInboxItem[]): RelayDelivery[] => items.flatMap(item => item.kind === 'relay' ? [item.delivery] : []);
function wrap(base: TaskRelay): TaskRelay {
  return { id: base.id, connect: input => base.connect(input), resolve: input => base.resolve(input),
    send: (input, signal) => base.send(input, signal), receive: (input, signal) => base.receive(input, signal),
    acknowledgeDelivery: (input, signal) => base.acknowledgeDelivery(input, signal) };
}

test('deadline rotation gives every healthy old envelope an attempt', async () => {
  const store = createTaskStore(), attempts: string[] = [];
  const transport = wrap(createInMemoryTaskRelay('memory'));
  let seeding = true, serial = 0;
  transport.resolve = async input => ({ relay: input.relay, id: input.reference });
  transport.send = async input => {
    attempts.push(input.envelopeId);
    if (seeding) throw new TaskProtocolError('RELAY_UNAVAILABLE', 'seed pending work', { retryable: true });
    if (input.envelopeId === 'old-0') await new Promise<void>(() => {});
    return { envelopeId: input.envelopeId };
  };
  const core = createTaskCore({ endpoint: origin, store, relay: transport, ids: () => {
    const i = serial++; return ['task', 'event', 'old'][i % 3] + '-' + Math.floor(i / 3);
  } });
  for (let i = 0; i < 16; i++) {
    const work = createTaskWorkScope(undefined, "phased");
    try { await core.createTask({ target: { ...target, id: `target-${i}` }, task: `old-${i}`, timeoutMs: 60_000 }, work.signal, work); }
    catch (error) { expect(error).toMatchObject({ code: 'RELAY_UNAVAILABLE' }); }
  }
  const original = store.outbox('pending').map(record => record.envelope);
  const select = store.selectPendingOutbox!.bind(store);
  let inspections = 0;
  store.selectPendingOutbox = (limit, now, scan) => { inspections++; expect(scan).toBe(1); return select(limit, now, scan); };
  seeding = false; attempts.length = 0;
  const failures: string[] = [];
  for (let i = 0; i < 6; i++) {
    inspections = 0; const before = attempts.length;
    try { await core.flushOutbox(); } catch (error) { failures.push((error as TaskProtocolError).code); }
    expect(attempts.length - before).toBeLessThanOrEqual(8);
    expect(inspections).toBeLessThanOrEqual(64);
  }
  expect([...store.outbox('pending'), ...store.outbox('accepted')].map(record => record.envelope).sort((a, b) => a.envelopeId.localeCompare(b.envelopeId)))
    .toEqual(original.sort((a, b) => a.envelopeId.localeCompare(b.envelopeId)));
  const accepted = store.outbox('accepted').map(item => item.envelope.envelopeId);
  const pending = store.outbox('pending').map(item => item.envelope.envelopeId);
  console.log(JSON.stringify({ probe: 'deadline-fairness', attempts, accepted, pending, failures }));
  try { expect(accepted).toHaveLength(15); } finally { store.close(); }
}, 15_000);

test('failed requested ACK repairs leave an initial receive opportunity', async () => {
  const base: TaskRelay = createInMemoryTaskRelay('memory');
  const parentStore = createTaskStore(), childStore = createTaskStore();
  let receives = 0;
  const transport = wrap(base);
  transport.receive = async (input, signal) => { receives++; return base.receive(input, signal); };
  transport.acknowledgeDelivery = async () => { throw new TaskProtocolError('RELAY_UNAVAILABLE', 'fixture ACK service unavailable', { retryable: true }); };
  const parent = createTaskCore({ endpoint: origin, store: parentStore, relay: base });
  const child = createTaskCore({ endpoint: target, store: childStore, relay: transport });
  await parent.connect(); await child.connect();
  await parent.createTask({ target, task: 'previous one', timeoutMs: 60_000 });
  await parent.createTask({ target, task: 'previous two', timeoutMs: 60_000 });
  const previous = relayDeliveries(await child.receive());
  for (const delivery of previous) {
    try { await child.acknowledgeRelayDelivery(delivery.cursor); } catch {}
  }
  const fresh = await parent.createTask({ target, task: 'new assignment', timeoutMs: 60_000 });
  const before = receives, errors: string[] = [];
  const entries: any[] = [];
  for (let i = 0; i < 4; i++) {
    const work = createTaskWorkScope(undefined, "phased");
    try { await child.connect(work.signal, work); } catch (error) { errors.push((error as TaskProtocolError).code); }
    try { await child.evaluateTimeouts(work.signal, work); } catch (error) { errors.push((error as TaskProtocolError).code); }
    try {
      await deliverTaskInbox({ sendMessage(message) { entries.push({ type: 'custom_message', ...message }); },
        appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); } }, child,
        { isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getEntries: () => entries } }, work.signal, work);
    } catch (error) { errors.push((error as TaskProtocolError).code); }
  }
  console.log(JSON.stringify({ probe: 'ack-repair-intake', cycles: 4, newReceiveCalls: receives - before,
    freshTaskIntaken: child.getTask(fresh.taskId) !== undefined, errors,
    requested: childStore.requestedRelayAcknowledgements(target) }));
  try { expect(child.getTask(fresh.taskId)).toBeDefined(); } finally { parentStore.close(); childStore.close(); }
});

test('slow ignored-abort ACK repair preserves protected intake and uncertain requested identities', async () => {
  const base: TaskRelay = createInMemoryTaskRelay('memory');
  const parentStore = createTaskStore(), childStore = createTaskStore();
  const transport = wrap(base);
  let seeding = true, receives = 0, repairs = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  transport.receive = async input => { receives++; return base.receive(input); };
  transport.acknowledgeDelivery = async () => {
    if (seeding) throw new TaskProtocolError('RELAY_UNAVAILABLE', 'request pending ACK', { retryable: true });
    repairs++; await held; // Intentionally ignore abort; remote outcome remains uncertain.
  };
  const parent = createTaskCore({ endpoint: origin, store: parentStore, relay: base });
  const child = createTaskCore({ endpoint: target, store: childStore, relay: transport });
  await parent.connect(); await child.connect();
  await parent.createTask({ target, task: 'old one', timeoutMs: 60_000 });
  await parent.createTask({ target, task: 'old two', timeoutMs: 60_000 });
  const previous = relayDeliveries(await child.receive());
  for (const delivery of previous) await expect(child.acknowledgeRelayDelivery(delivery.cursor)).rejects.toMatchObject({ code: 'RELAY_UNAVAILABLE' });
  const requested = childStore.requestedRelayAcknowledgements(target);
  const fresh = await parent.createTask({ target, task: 'within the same held page', timeoutMs: 60_000 });
  seeding = false; receives = 0;
  const work = createTaskWorkScope(undefined, "phased");
  const errors: unknown[] = [];
  const drive = (async () => {
    try { await child.connect(work.signal, work); } catch (error) { errors.push(error); }
    try { await deliverTaskInbox({ sendMessage() { throw new Error('held prefix must not present'); }, appendEntry() {} }, child,
      { isIdle: () => false, hasPendingMessages: () => true, sessionManager: { getEntries: () => [] } }, work.signal, work); }
    catch (error) { errors.push(error); }
  })();
  let timer!: ReturnType<typeof setTimeout>;
  try {
    const completed = await Promise.race([drive.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 3_000); })]);
    expect(completed).toBe(true);
    expect(receives).toBe(1); expect(repairs).toBe(1);
    expect(child.getTask(fresh.taskId)).toBeDefined();
    expect(errors).toEqual([expect.objectContaining({ code: 'ABORTED', details: { mayHaveBeenDelivered: true } })]);
    expect(childStore.requestedRelayAcknowledgements(target)).toEqual(requested);
    expect(childStore.getReceiveCursor()).toBe('0');
    release(); await drive; await Promise.resolve();
    expect(childStore.requestedRelayAcknowledgements(target)).toEqual(requested);
    expect(childStore.getReceiveCursor()).toBe('0');
  } finally { clearTimeout(timer); release(); await drive; parentStore.close(); childStore.close(); }
});

test('public receive preserves raw-intent fanout and one-page array return', async () => {
  const base: TaskRelay = createInMemoryTaskRelay('memory');
  const parentStore = createTaskStore(), childStore = createTaskStore();
  const parent = createTaskCore({ endpoint: origin, store: parentStore, relay: base });
  const child = createTaskCore({ endpoint: target, store: childStore, relay: base });
  try {
    await parent.connect(); await child.connect();
    const created = await parent.createTask({ target, task: 'public raw path', timeoutMs: 60_000 });
    const scope = createTaskWorkScope();
    expect(await child.receive(scope.signal, scope)).toHaveLength(1);
    await child.submitIntent({ taskId: created.taskId, type: 'task.completed', payload: { summary: 'done' } });
    // The raw intent is canonicalized in the same page; the origin view is queued locally, not self-echoed.
    const items = await parent.receive();
    expect(items.map(item => item.kind)).toEqual(['local']);
    expect(items[0]!.kind === 'local' ? items[0]!.event.type : undefined).toBe('task.completed');
    expect(parent.getTask(created.taskId)?.status).toBe('completed');
    expect(parentStore.outbox('accepted').filter(record => record.envelope.kind === 'canonical_event')).toHaveLength(1);
    // Until presentation completes, the next one-page receive returns the same local item.
    const again = await parent.receive();
    expect(again).toEqual(items);
  } finally { parentStore.close(); childStore.close(); }
});

test('caller cancellation leaves ignored-abort foreground work pending and immutable', async () => {
  const store = createTaskStore(), transport = wrap(createInMemoryTaskRelay('memory'));
  let release!: () => void, entered!: () => void, waiting = true;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  transport.resolve = async input => ({ relay: input.relay, id: input.reference });
  transport.send = async input => { entered(); if (waiting) await held; return { envelopeId: input.envelopeId }; };
  const core = createTaskCore({ endpoint: origin, store, relay: transport });
  const controller = new AbortController();
  const attempt = core.createTask({ target, task: 'uncertain foreground', timeoutMs: 60_000 }, controller.signal);
  await ready; controller.abort();
  const original = store.outbox('pending')[0]!.envelope;
  try {
    await expect(attempt).rejects.toMatchObject({ code: 'ABORTED', details: { mayHaveBeenDelivered: true } });
    expect(store.outbox('pending').map(record => record.envelope)).toEqual([original]);
    expect(store.outbox('accepted')).toEqual([]); expect(store.quarantinedOutbox()).toEqual([]);
    release(); await Promise.resolve(); await Promise.resolve();
    expect(store.outbox('pending').map(record => record.envelope)).toEqual([original]);
    waiting = false; await core.flushOutbox();
    expect(store.outbox('accepted').map(record => record.envelope)).toEqual([original]);
  } finally { release(); store.close(); }
});
