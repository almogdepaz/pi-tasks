import { analyzeTaskStoreMetrics } from "./metrics";
import { buildTaskBoard } from "./task-board";

export async function runTaskMetricsCli(args: readonly string[]): Promise<number> {
	const tasksRoot = args[0];
	if (!tasksRoot) {
		console.error("usage: bun run task-metrics <tasksRoot> [--board]");
		return 1;
	}

	const report = args.includes("--board")
		? await buildTaskBoard(tasksRoot)
		: await analyzeTaskStoreMetrics(tasksRoot);
	console.log(JSON.stringify(report, null, 2));
	return 0;
}

if (import.meta.main) {
	process.exitCode = await runTaskMetricsCli(process.argv.slice(2));
}
