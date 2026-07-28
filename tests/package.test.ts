import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const packageJsonPath = new URL("../package.json", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);
const skillPath = new URL("../skills/wolfpack-pi-task-delegation/SKILL.md", import.meta.url);
const extensionPath = new URL("../src/extension.ts", import.meta.url);

describe("package skill wiring", () => {
	test("package metadata is publishable as a pi package", async () => {
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
			readonly name?: string;
			readonly version?: string;
			readonly private?: boolean;
			readonly keywords?: readonly string[];
			readonly files?: readonly string[];
		};

		expect(packageJson.name).toBe("@sgtbeatdown/pi-tasks");
		expect(packageJson.version).toBe("0.1.0");
		expect(packageJson.private).toBeUndefined();
		expect(packageJson.keywords).toContain("pi-package");
		expect(packageJson.files).toContain("src");
		expect(packageJson.files).toContain("skills");
	});

	test("package exposes extension, skill resources, and metrics CLI", async () => {
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
			readonly pi?: { readonly extensions?: readonly string[]; readonly skills?: readonly string[] };
			readonly scripts?: Record<string, string>;
		};

		expect(packageJson.pi?.extensions).toContain("./src/extension.ts");
		expect(packageJson.pi?.skills).toContain("./skills");
		expect(packageJson.scripts?.["task-metrics"]).toBe("bun src/metrics-cli.ts");
	});

	test("pi core packages are peers instead of bundled runtime dependencies", async () => {
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
			readonly dependencies?: Record<string, string>;
			readonly peerDependencies?: Record<string, string>;
		};
		const piCorePackages = [
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
			"typebox",
		];

		for (const packageName of piCorePackages) {
			expect(packageJson.dependencies?.[packageName]).toBeUndefined();
			expect(packageJson.peerDependencies?.[packageName]).toBe("*");
		}
	});

	test("delegation skill relies on wolfpack control and structured task tools", async () => {
		const skill = await readFile(skillPath, "utf8");

		expect(skill).toContain("name: wolfpack-pi-task-delegation");
		expect(skill).toContain("wolfpack-tailnet-control");
		expect(skill).toContain("wolfpack agent spawn");
		expect(skill).toContain("agent_task_send");
		expect(skill).toContain("agent_task_done");
		expect(skill).toContain("agent_task_inbox");
		expect(skill).not.toContain("poll terminal output for completion");
	});

	test("delegation docs fail fast across unsupported task boundaries", async () => {
		const readme = (await readFile(readmePath, "utf8")).replace(/\s+/g, " ");

		expect(readme).toContain("fail fast and instruct setup before dispatch");
		expect(readme).toContain("Do not use cross-repo `agent_task_send` with the filesystem store");
		expect(readme).toContain("fallback instruction channel, not a task completion protocol");
		expect(readme).toContain("`summary` at or below 1200 characters");
	});

	test("delegation guidance prohibits implicit blocking waits", async () => {
		const skill = await readFile(skillPath, "utf8");
		const extension = await readFile(extensionPath, "utf8");
		const readme = await readFile(readmePath, "utf8");
		const normalized = `${skill}\n${extension}\n${readme}`.replace(/\s+/g, " ");

		expect(normalized).toContain("Do not call `agent_task_wait` after dispatch");
		expect(normalized).toContain("only when the current user message explicitly asks to block");
		expect(normalized).toContain("normal delegation requests are fire-and-forget");
	});

	test("delegation skill enforces token-efficient task boundaries", async () => {
		const skill = await readFile(skillPath, "utf8");
		const normalizedSkill = skill.replace(/\s+/g, " ");

		for (const field of [
			"phaseId",
			"issueId",
			"role",
			"verificationTier",
			"rootCause",
			"changedFiles",
			"verification",
			"blockers",
			"risks",
			"next",
		]) {
			expect(normalizedSkill).toContain(`\`${field}\``);
		}
		expect(normalizedSkill).toContain("compact and action-oriented");
		expect(normalizedSkill).toContain("1200 characters");
		expect(normalizedSkill).toContain("Batch findings that share a root cause");
		expect(normalizedSkill).toContain("requireReachable: true");
		expect(normalizedSkill).toContain("requiredProjectDir");
		expect(normalizedSkill).toContain("shared task store");
		expect(normalizedSkill).toContain("wolfpack session send");
		expect(normalizedSkill).toContain("fallback instruction channel");
		expect(normalizedSkill).toContain("not a task completion protocol");
		expect(normalizedSkill).toContain("fail before dispatch");
		expect(normalizedSkill).toContain("Do not use symlinks");
	});
});
