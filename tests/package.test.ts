import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const packageJsonPath = new URL("../package.json", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);
const delegationSkillPath = new URL("../skills/wolfpack-pi-task-delegation/SKILL.md", import.meta.url);
const summarySkillPath = new URL("../skills/task-context-summary/SKILL.md", import.meta.url);

describe("gateway package documentation", () => {
	test("publishes the extension and package skills", async () => {
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { readonly pi?: { readonly extensions?: readonly string[]; readonly skills?: readonly string[] } };
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
			"real second peer",
			"read-only analyzers",
		]) expect(normalized).toContain(detail);
		expect(normalized).not.toContain("wolfpack session send");
		expect(normalized).not.toContain("createFilesystemTaskStore");
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
