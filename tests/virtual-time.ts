import { TaskProtocolError } from "../src/task-protocol";
import type { TaskTimers } from "../src/task-work-scope";

/**
 * Virtual time shared by a core, its work scopes and a fixture's own waits. Time moves only inside `run` and
 * `advance`, and only after every runnable microtask and immediate has settled, so a deadline never fires
 * before the code under test reaches the wait it bounds.
 */
export function virtualTime(start = Date.UTC(2026, 0, 1)) {
	let now = start, order = 0;
	const due: { readonly at: number; readonly order: number; readonly fire: () => void }[] = [];
	const schedule = (ms: number, fire: () => void) => {
		const item = { at: now + Math.max(0, ms), order: order++, fire };
		due.push(item);
		return () => { const index = due.indexOf(item); if (index >= 0) due.splice(index, 1); };
	};
	const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise<void>(resolve => setImmediate(resolve)); };
	const next = () => due.sort((left, right) => left.at - right.at || left.order - right.order)[0];
	const fire = () => { const item = due.shift()!; now = item.at; item.fire(); };
	const timers: TaskTimers = {
		now: () => now,
		elapsed: () => now - start,
		timeout(ms) {
			const controller = new AbortController();
			schedule(ms, () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")));
			return controller.signal;
		},
	};
	return {
		timers,
		now: () => now,
		/** A fixture wait of `ms` virtual milliseconds; `signal` cancels it with `cancelled()`. */
		sleep(ms: number, signal?: AbortSignal, cancelled: () => unknown = () => new TaskProtocolError("ABORTED", "fixture cancelled")): Promise<void> {
			return new Promise((resolve, reject) => {
				const abort = () => { cancel(); reject(cancelled()); };
				const cancel = schedule(ms, () => { signal?.removeEventListener("abort", abort); resolve(); });
				if (signal?.aborted) { abort(); return; }
				signal?.addEventListener("abort", abort, { once: true });
			});
		},
		/** Settles `promise`, jumping to each next due timer only when nothing else can run. */
		async run<T>(promise: Promise<T>, limitMs = 60_000): Promise<T> {
			let settled = false;
			promise.then(() => { settled = true; }, () => { settled = true; });
			const until = now + limitMs;
			for (;;) {
				await settle();
				if (settled) return promise;
				const item = next();
				if (!item || item.at > until) throw new Error(`virtual time: still pending with ${item ? "no timer due" : "no timer left"} within ${limitMs}ms`);
				fire();
			}
		},
		/** Moves exactly `ms` forward, firing each due timer in order after a settle. */
		async advance(ms: number): Promise<void> {
			const until = now + ms;
			for (;;) {
				await settle();
				const item = next();
				if (!item || item.at > until) break;
				fire();
			}
			now = until;
			await settle();
		},
	};
}
