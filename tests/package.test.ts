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

	test("documents local and peer gateway delegation without legacy transport guidance", async () => {
		const [readme, skill] = await Promise.all([readFile(readmePath, "utf8"), readFile(delegationSkillPath, "utf8")]);
		const normalized = `${readme}\n${skill}`.replace(/\s+/g, " ");
		for (const detail of [
			"{ machine, sessionId }",
			"agent_task_message",
			"agent_task_inbox({ ack: true })",
			"WOLFPACK_PORT",
			"structured custom messages",
			"canonical HTTPS Tailnet origin",
			"trusted local processes and trusted Tailnet machines",
			"one initial attempt",
			"four total attempts",
			"specific live peer",
			"read-only analyzers",
		]) expect(normalized).toContain(detail);
		expect(normalized).not.toContain("wolfpack session send");
		expect(normalized).not.toContain("createFilesystemTaskStore");
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

	test("ships a recovery-only context summary workflow", async () => {
		const skill = await readFile(summarySkillPath, "utf8");
		expect(skill).toContain("parent authors normal summaries");
		expect(skill).toContain("docs/code");
		expect(skill).toContain("session summary");
		expect(skill).toContain("16KiB");
		expect(skill).toContain("disagreement");
	});
});
