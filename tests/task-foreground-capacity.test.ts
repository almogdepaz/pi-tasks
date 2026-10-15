import { expect, test } from 'bun:test';
import { createTaskCore } from '../src/task-core';
import { createTaskStore } from '../src/task-store';
import { TaskProtocolError } from '../src/task-protocol';
import type { TaskRelay } from '../src/task-protocol';

test.each([true, false])('foreground byte capacity preserves a bounded old-work opportunity (small packets fit: %s)', async smallFits => {
  const origin = { relay: 'memory', id: 'origin' }, target = { relay: 'memory', id: 'target' };
  const store = createTaskStore(), attempts: string[] = [];
  let seeding = true;
  const transport: TaskRelay = {
    id: 'memory', connect: async input => ({ endpoint: input.endpoint, receiveCursor: input.receiveCursor }),
    resolve: async input => ({ relay: input.relay, id: input.reference }),
    receive: async input => ({ deliveries: [], nextCursor: input.cursor, hasMore: false }),
    acknowledgeDelivery: async () => undefined,
    send: async input => {
      attempts.push(input.envelopeId);
      if (seeding) throw new TaskProtocolError('RELAY_UNAVAILABLE', 'seed pending assignments', { retryable: true });
      // Legitimate byte-capacity semantics: free space can admit small mail but not a new 16KiB assignment.
      if (!smallFits || Buffer.byteLength(input.payload) > 4_096) throw new TaskProtocolError('RELAY_CAPACITY', 'remaining mailbox bytes insufficient', { retryable: true });
      return { envelopeId: input.envelopeId };
    },
  };
  const core = createTaskCore({ endpoint: origin, store, relay: transport });
  for (let i = 0; i < 8; i++) {
    try { await core.createTask({ target, task: `small-${i}`, timeoutMs: 60_000 }); }
    catch (error) { expect(error).toMatchObject({ code: 'RELAY_UNAVAILABLE' }); }
  }
  const oldIds = new Set(store.outbox('pending').map(record => record.envelope.envelopeId));
  seeding = false; attempts.length = 0;
  for (let i = 0; i < 8; i++) {
    const before = attempts.length;
    try { await core.createTask({ target, task: 'x'.repeat(16_384), timeoutMs: 60_000 }); } catch (error) {
      expect(error).toMatchObject({ code: 'RELAY_CAPACITY' });
    }
    expect(attempts.length - before).toBeLessThanOrEqual(9);
    if (!smallFits) expect(attempts.slice(before).filter(id => oldIds.has(id))).toHaveLength(1);
  }
  const oldAttempts = attempts.filter(id => oldIds.has(id));
  const accepted = store.outbox('accepted').map(item => item.envelope.envelopeId);
  console.log(JSON.stringify({ probe: 'foreground-capacity-old-share', operations: 8, oldAttempts, accepted, attempts: attempts.length }));
  try { expect(accepted).toHaveLength(smallFits ? 8 : 0); expect(oldAttempts).toHaveLength(8); } finally { store.close(); }
});
