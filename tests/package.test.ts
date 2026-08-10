import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const packageJsonPath = new URL("../package.json", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);
const delegationSkillPath = new URL("../skills/wolfpack-pi-task-delegation/SKILL.md", import.meta.url);
const summarySkillPath = new URL("../skills/task-context-summary/SKILL.md", import.meta.url);

describe("gateway package documentation", () => {
	test("publishes the extension and package skills", async () => {
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
			readonly description?: string;
			readonly pi?: { readonly extensions?: readonly string[]; readonly skills?: readonly string[] };
		};
		expect(packageJson.description).toContain("Wolfpack task gateway");
		expect(packageJson.description).not.toContain("pluggable stores and transports");
		expect(packageJson.pi?.extensions).toEqual(["./src/extension.ts"]);
		expect(packageJson.pi?.skills).toContain("./skills");
	});

	test("publishes v1 only as an explicit compatibility entry while v2 remains the default", async () => {
		const [packageJson, readme, v2Extension] = await Promise.all([
			readFile(packageJsonPath, "utf8").then((value) => JSON.parse(value) as { readonly exports?: Record<string, string>; readonly pi?: { readonly extensions?: readonly string[] } }),
			readFile(readmePath, "utf8"),
			readFile(new URL("../src/extension.ts", import.meta.url), "utf8"),
		]);
		expect(packageJson.pi?.extensions).toEqual(["./src/extension.ts"]);
		expect(packageJson.exports?.["./v1-compat-extension"]).toBe("./src/v1-compat-extension.ts");
		expect(readme).toContain("@sgtbeatdown/pi-tasks/v1-compat-extension");
		expect(readme).toContain("explicit opt-in");
		expect(readme).toContain("does not fall back");
		expect(v2Extension).not.toContain("legacy-extension");
	});

	test("documents deterministic per-session v2 storage", async () => {
		const readme = await readFile(readmePath, "utf8");
		expect(readme).not.toContain("~/.pi/tasks/v2/tasks.sqlite");
		expect(readme).toContain("~/.pi/tasks/v2/sessions/<sha256(WOLFPACK_SESSION_NAME)>/tasks.sqlite");
		expect(readme).toContain("deterministic per-session path");
	});

	test("documents local and peer gateway delegation without legacy transport guidance", async () => {
		const [readme, skill] = await Promise.all([readFile(readmePath, "utf8"), readFile(delegationSkillPath, "utf8")]);
		const normalized = `${readme}\n${skill}`.replace(/\s+/g, " ");
		for (const detail of [
			"{ machine, sessionId }",
			"agent_task_message",
			"agent_task_ack({ taskId })",
			"WOLFPACK_PORT",
			"structured custom messages",
			"canonical HTTPS Tailnet origin",
			"trusted local processes and trusted Tailnet machines",
			"one initial attempt",
			"four total attempts",
			"specific live peer",
			"read-only analyzers",
		]) expect(normalized).toContain(detail);
		expect(normalized).toContain("task-adapter-contract.md");
		expect(normalized).not.toContain("agent_task_inbox({ ack: true })");
		expect(normalized).not.toContain("wolfpack session send");
		expect(normalized).not.toContain("createFilesystemTaskStore");
	});

	test("documents idle worker spawning and active-turn follow-up insertion", async () => {
		const [readme, skill] = await Promise.all([readFile(readmePath, "utf8"), readFile(delegationSkillPath, "utf8")]);
		for (const document of [readme, skill]) {
			expect(document).toContain("delivery remains pending until `task.delivered`");
			expect(document).toContain('`deliverAs: "followUp"`');
		}
		expect(skill).toContain("omit `--prompt`");
		expect(skill).toContain("Do not start a disposable worker with a blocking");
	});

	test("documents the structured correction path for invalid sends", async () => {
		const readme = await readFile(readmePath, "utf8");
		const minimalEnvelope = readme.match(/### minimal valid send envelope\n\n```json\n([\s\S]+?)\n```/);

		expect(minimalEnvelope?.[1]).toBe(JSON.stringify({
			to: { machine: "local", sessionId: "receiver-broker-id" },
			task: "implement the narrow change and run focused tests",
		}, null, 2));
		expect(readme).toContain("`INVALID_REQUEST.error.path`");
		expect(readme).toContain("RFC 6901 JSON Pointer");
		expect(readme).toContain("rejected send field");
		expect(readme).toContain("pre-persistence validation rejection creates no task");
		expect(readme).toContain("idempotency remains necessary");
		expect(readme).toContain("creation status is uncertain");
	});

	test("separates changed-file reporting from receiver-project artifact declarations", async () => {
		const [readme, skill] = await Promise.all([readFile(readmePath, "utf8"), readFile(delegationSkillPath, "utf8")]);
		for (const document of [readme, skill]) {
			expect(document).toContain("result.changedFiles");
			expect(document).toContain("receiver-project-relative regular files");
			expect(document).toContain('"artifacts": [{ "path": "verification/task-2.md" }]');
		}
		expect(readme).toContain("canonical Wolfpack artifact contract");
	});

	test("requires current live-peer readiness before remote dispatch", async () => {
		const [readme, skill] = await Promise.all([readFile(readmePath, "utf8"), readFile(delegationSkillPath, "utf8")]);
		for (const document of [readme, skill]) {
			expect(document).toContain("Live-peer readiness checklist");
			expect(document).toContain("operator-recorded package/reload evidence");
			expect(document).toContain("fixture-only verification");
			expect(document).not.toContain("A real second peer is not currently available");
		}
		expect(readme).toContain("Isolated coverage is the deterministic acceptance gate");
		expect(skill).toContain("Isolated coverage is the deterministic acceptance gate");
	});

	test("keeps phase role reuse, compact handoffs, and parent verification in the delegation workflow", async () => {
		const skill = await readFile(delegationSkillPath, "utf8");
		for (const detail of [
			"one persistent implementer and one persistent read-only reviewer",
			"Do not rotate a healthy role session for routine corrections",
			"context.summary` only for constraints, decisions, and recovery state",
			"Do not copy plans, source contents, or transcripts",
			"terminal `send` is only for explicit human steering",
			"independently verifies files, diff, tests, and artifacts",
			"agent_task_ack({ taskId })",
		]) expect(skill).toContain(detail);
	});

	test("ships a recovery-only context summary workflow", async () => {
		const skill = await readFile(summarySkillPath, "utf8");
		expect(skill).toContain("parent authors normal summaries");
		expect(skill).toContain("docs/code");
		expect(skill).toContain("session summary");
		expect(skill).toContain("16KiB");
		expect(skill).toContain("disagreement");
	});
});
