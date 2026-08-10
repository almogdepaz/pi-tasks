import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("loads the default extension through Pi's Node runtime", async () => {
	const home = mkdtempSync("/tmp/pi-tasks-node-runtime-");
	temporaryDirectories.push(home);
	const subprocess = Bun.spawn([
		join(repositoryRoot, "node_modules", ".bin", "pi"),
		"--no-extensions",
		"--extension", join(repositoryRoot, "src", "extension.ts"),
		"--mode", "rpc",
		"--no-session",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
	], {
		cwd: repositoryRoot,
		env: { ...process.env, HOME: home },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	subprocess.stdin.write('{"type":"get_state"}\n');
	subprocess.stdin.end();

	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);

	const messages = stdout.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as unknown);
	expect(stderr).not.toContain("Failed to load extension");
	expect(exitCode).toBe(0);
	expect(messages).toContainEqual(expect.objectContaining({ type: "response", command: "get_state", success: true }));
});
