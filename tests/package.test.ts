import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const packageJsonPath = new URL("../package.json", import.meta.url);
const skillPath = new URL("../skills/wolfpack-pi-task-delegation/SKILL.md", import.meta.url);

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

	test("package exposes extension and skill resources", async () => {
		const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
			readonly pi?: { readonly extensions?: readonly string[]; readonly skills?: readonly string[] };
		};

		expect(packageJson.pi?.extensions).toContain("./src/extension.ts");
		expect(packageJson.pi?.skills).toContain("./skills");
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
});
