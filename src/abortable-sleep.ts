/** Sleep until the timeout, an optional early wake, or abort; every exit path releases the timer and both subscriptions. */
export async function abortableSleep(milliseconds: number, signal: AbortSignal | undefined, cancellationError: () => Error, subscribeWake?: (wake: () => void) => () => void): Promise<void> {
	if (signal?.aborted) throw cancellationError();
	await new Promise<void>((resolve, reject) => {
		let unsubscribeWake: (() => void) | undefined;
		const release = (): void => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			unsubscribeWake?.();
		};
		const timeout = setTimeout(() => {
			release();
			resolve();
		}, milliseconds);
		const abort = (): void => {
			release();
			reject(cancellationError());
		};
		signal?.addEventListener("abort", abort, { once: true });
		unsubscribeWake = subscribeWake?.(() => {
			release();
			resolve();
		});
	});
}
