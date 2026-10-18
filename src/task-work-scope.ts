import { TaskProtocolError } from "./task-protocol";

export const TASK_WORK_LIMITS = { scopedSends: 56, retries: 8, acknowledgements: 48, pageItems: 50,
  deadlineMs: 2_000, retrySliceMs: 250, ackRepairSliceMs: 250, capacityCooldownMs: 5_000, retryInspections: 64,
  // Fetched-but-unacknowledged relay deliveries; intake pauses at this bound until ACKs drain it.
  pendingDeliveries: 200 } as const;

/** Required envelopes a phased pass persisted; its ship phase sends them in persist order. */
export interface TaskShipment {
  readonly envelopeIds: readonly string[];
  /** Throws the blocked-delivery error once the envelopes were offered. */
  readonly verify?: () => void;
  /** Runs once every envelope is accepted, e.g. staging the raw ACK that accepted fan-out authorizes. */
  readonly accepted?: () => void;
  /** Set by the ship phase, with the first send or blocked-delivery failure, if any. */
  shipped: boolean;
  failure?: unknown;
}

/** Shared counts for nested receipts/fanout; background I/O also has one finite window. */
export interface TaskWorkScope {
  readonly signal: AbortSignal;
  readonly attemptedSends: Set<string>;
  readonly attemptedAcknowledgements: Set<string>;
  readonly blockedRetryTargets: Set<string>;
  retryStarted: boolean;
  /**
   * Fixed at creation for a refresh pass: its driver runs intake, presentation, required sends,
   * ACKs and old-work retry as explicit phases, so core operations never start old-work retry
   * or ACK repair on their own.
   */
  readonly phased: boolean;
  /** Deferred required sends of a phased pass, in persist order. */
  readonly shipments: TaskShipment[];
  claimSend(envelopeId: string, retry: boolean): boolean;
  claimAcknowledgement(cursor: string): boolean;
  canAcknowledge(): boolean;
  remainingAcknowledgements(): number;
  canRetry(): boolean;
  canRepairAcknowledgement(): boolean;
  backgroundSignal(): AbortSignal;
}

export function createTaskWorkScope(signal?: AbortSignal, mode: "background" | "foreground" | "phased" = "background"): TaskWorkScope {
  const caller = signal ?? new AbortController().signal;
  let background: AbortSignal | undefined;
  const backgroundSignal = () => background ??= AbortSignal.any([caller, AbortSignal.timeout(TASK_WORK_LIMITS.deadlineMs)]);
  // Foreground requests retain the transport/caller timeout. Their speculative
  // retries start a bounded background window only after required sends finish.
  const active = mode === "foreground" ? caller : backgroundSignal();
  const attemptedSends = new Set<string>(), attemptedAcknowledgements = new Set<string>(), blockedRetryTargets = new Set<string>();
  let scopedSends = 0, retrySends = 0, acknowledgements = 0;
  let retryUntil: number | undefined, repairUntil: number | undefined;
  return {
    signal: active, attemptedSends, attemptedAcknowledgements, blockedRetryTargets, retryStarted: false, phased: mode === "phased", shipments: [],
    backgroundSignal,
    claimSend(id, retry) {
      if ((retry ? backgroundSignal() : active).aborted || attemptedSends.has(id) || (retry ? retrySends >= TASK_WORK_LIMITS.retries : scopedSends >= TASK_WORK_LIMITS.scopedSends)) return false;
      attemptedSends.add(id);
      if (retry) retrySends++; else scopedSends++;
      return true;
    },
    claimAcknowledgement(cursor) {
      if (active.aborted || attemptedAcknowledgements.has(cursor) || acknowledgements >= TASK_WORK_LIMITS.acknowledgements) return false;
      attemptedAcknowledgements.add(cursor); acknowledgements++;
      return true;
    },
    canAcknowledge() { return !active.aborted && acknowledgements < TASK_WORK_LIMITS.acknowledgements; },
    remainingAcknowledgements() { return active.aborted ? 0 : TASK_WORK_LIMITS.acknowledgements - acknowledgements; },
    // Slices stop admission, not completion: an admitted request gets the
    // remaining background window, including cancellation and late fences.
    canRetry() { return !backgroundSignal().aborted && performance.now() < (retryUntil ??= performance.now() + TASK_WORK_LIMITS.retrySliceMs); },
    canRepairAcknowledgement() { return !backgroundSignal().aborted && performance.now() < (repairUntil ??= performance.now() + TASK_WORK_LIMITS.ackRepairSliceMs); },
  };
}

export function deferredTaskDelivery(details?: Record<string, unknown>): TaskProtocolError {
  return new TaskProtocolError("TASK_DELIVERY_DEFERRED", "task delivery deferred by the local work budget or retry cooldown", { retryable: true, details });
}

/** Known admission backpressure gets at least one normal polling interval, without another timer. */
export function capacityRetryAt(error: unknown): number | undefined {
  if (!(error instanceof TaskProtocolError) || error.code !== "RELAY_CAPACITY" || !error.retryable) return undefined;
  const hint = error.details?.retryAfterMs;
  return Date.now() + Math.max(TASK_WORK_LIMITS.capacityCooldownMs, typeof hint === "number" && Number.isFinite(hint) && hint >= 0 ? hint : 0);
}
