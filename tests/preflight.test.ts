import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runTaskPreflight } from "../src/preflight";
import { createFilesystemTaskStore } from "../src/stores/filesystem";
import type { TaskTransport } from "../src/task-communication";

let projectDir: string;

beforeEach(async () => {
	projectDir = await mkdtemp(join(tmpdir(), "pi-preflight-"));
});

afterEach(async () => {
	await rm(projectDir, { recursive: true, force: true });
});

const inertTransport: TaskTransport = {
	name: "inert",
	getCurrentSessionName: () => "parent",
	dispatchTask: async () => ({ ok: true }),
};

describe("task preflight", () => {
	test("marks unsupported optional transport liveness as unavailable without failing", async () => {
		const result = await runTaskPreflight({
			projectDir,
			parentSession: "parent",
			target: "worker",
			store: createFilesystemTaskStore(),
			transport: inertTransport,
		});

		expect(result.ok).toBe(true);
		expect(result.checks).toContainEqual({
			name: "transport_reachable",
			status: "unavailable",
			source: "transport",
			message: "transport does not expose target preflight",
		});
	});

	test("fails when reachability is explicitly required and transport has no preflight hook", async () => {
		const result = await runTaskPreflight({
			projectDir,
			parentSession: "parent",
			target: "worker",
			store: createFilesystemTaskStore(),
			transport: inertTransport,
			requirements: { requireReachable: true },
		});

		expect(result.ok).toBe(false);
		expect(result.checks).toContainEqual({
			name: "transport_reachable",
			status: "failed",
			source: "transport",
			message: "transport does not expose target preflight",
		});
	});

	test("checks required context ref readability while treating selectors as opaque", async () => {
		await writeFile(join(projectDir, "scope.md"), "# scope\n", "utf8");

		const result = await runTaskPreflight({
			projectDir,
			parentSession: "parent",
			target: "worker",
			store: createFilesystemTaskStore(),
			transport: inertTransport,
			contextRefs: [
				{ path: "scope.md", selector: "heading:scope", required: true },
				{ path: "missing.md", selector: "L1-L2", required: false },
			],
		});

		expect(result.ok).toBe(true);
		expect(result.checks).toContainEqual({ name: "context_ref:scope.md", status: "passed", source: "protocol" });
		expect(result.checks.find((check) => check.name === "context_ref:missing.md")?.status).toBe("skipped");
	});

	test("fails preflight when another active task targets the same issue on the same session", async () => {
		const store = createFilesystemTaskStore();
		const { task } = await store.createOrReuseDispatchedTask({
			projectDir,
			parentSession: "parent",
			targetSession: "worker",
			taskText: "inspect auth",
			assignment: { instructions: "inspect auth" },
			timeoutMs: 30_000,
			metadata: { issueId: "auth-boundary" },
		});

		const result = await runTaskPreflight({
			projectDir,
			parentSession: "parent",
			target: "worker",
			store,
			transport: inertTransport,
			metadata: { issueId: "auth-boundary" },
		});

		expect(result.ok).toBe(false);
		expect(result.checks).toContainEqual({
			name: "active_issue_conflict",
			status: "failed",
			source: "store",
			message: `active task ${task.id} already targets issue auth-boundary`,
		});
	});
});
