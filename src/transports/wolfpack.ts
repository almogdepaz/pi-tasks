import { resolve } from "node:path";

import type {
	DispatchTaskInput,
	DispatchTaskResult,
	PreflightTargetInput,
	TaskCommandExecutor,
	TaskTransport,
} from "../task-communication";
import type { TaskPreflightCheck, TaskPreflightResult } from "../types";
import { checkRequiredTargetProjectDir } from "../preflight";

export interface WolfpackTaskTransportOptions {
	readonly exec: TaskCommandExecutor;
}

export function getCurrentWolfpackSessionName(env: Record<string, string | undefined>): string {
	return env.WOLFPACK_SESSION_NAME || "unknown-session";
}

export function createWolfpackTaskTransport(options: WolfpackTaskTransportOptions): TaskTransport {
	return {
		name: "wolfpack",
		getCurrentSessionName: getCurrentWolfpackSessionName,
		preflightTarget: async (input: PreflightTargetInput): Promise<TaskPreflightResult> => {
			const status = await options.exec("wolfpack", ["session", "status", input.target, "--json"], {
				signal: input.signal,
			});
			return wolfpackStatusToPreflight(input, status.code, status.stdout);
		},
		dispatchTask: async (input: DispatchTaskInput): Promise<DispatchTaskResult> => {
			const dispatch = await options.exec("wolfpack", ["session", "send", input.target, input.assignment], {
				signal: input.signal,
			});
			if (dispatch.code === 0) {
				return { ok: true };
			}
			return {
				ok: false,
				message: dispatch.stderr || dispatch.stdout || "wolfpack session send failed",
				retryable: true,
			};
		},
	};
}

function wolfpackStatusToPreflight(input: PreflightTargetInput, exitCode: number, stdout: string): TaskPreflightResult {
	const parsed = parseStatusJson(stdout);
	if (!parsed.ok) {
		return {
			ok: false,
			targetSession: input.target,
			checks: [
				{
					name: "transport_reachable",
					status: "unavailable",
					source: "transport",
					message: "wolfpack status returned invalid json",
				},
			],
		};
	}

	if (exitCode !== 0) {
		return {
			ok: false,
			targetSession: input.target,
			checks: [wolfpackStatusFailureCheck(parsed.value)],
		};
	}

	const alive = readBoolean(parsed.value, ["alive", "isAlive", "terminalAlive"]);
	const targetProjectDir = readString(parsed.value, ["projectDir", "project", "cwd"]);
	const checks: TaskPreflightCheck[] = [wolfpackAliveCheck(alive)];
	if (input.requirements?.requiredProjectDir) {
		checks.push(checkRequiredTargetProjectDir(input.requirements.requiredProjectDir, targetProjectDir));
	}

	return {
		ok: checks.every((check) => check.status !== "failed"),
		targetSession: input.target,
		...(targetProjectDir && { targetProjectDir: resolve(targetProjectDir) }),
		checks,
	};
}

function wolfpackAliveCheck(alive: boolean | undefined): TaskPreflightCheck {
	if (alive === true) {
		return { name: "transport_reachable", status: "passed", source: "transport" };
	}
	if (alive === false) {
		return {
			name: "transport_reachable",
			status: "failed",
			source: "transport",
			message: "wolfpack session is not alive",
		};
	}
	return {
		name: "transport_reachable",
		status: "unavailable",
		source: "transport",
		message: "wolfpack status did not include alive state",
	};
}

function wolfpackStatusFailureCheck(value: Record<string, unknown>): TaskPreflightCheck {
	const statusCode = readNumber(value, ["statusCode", "code"]);
	switch (statusCode) {
		case 404:
			return { name: "transport_reachable", status: "failed", source: "transport", message: "wolfpack session not found" };
		case 409:
			return { name: "transport_reachable", status: "failed", source: "transport", message: "wolfpack session is ambiguous" };
		case 410:
			return { name: "transport_reachable", status: "failed", source: "transport", message: "wolfpack session is stale" };
		case 503:
			return { name: "transport_reachable", status: "unavailable", source: "transport", message: "wolfpack status unavailable" };
		default:
			return { name: "transport_reachable", status: "failed", source: "transport", message: "wolfpack session status failed" };
	}
}

function parseStatusJson(stdout: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false } {
	try {
		const value = JSON.parse(stdout) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false };
		}
		return { ok: true, value: value as Record<string, unknown> };
	} catch {
		return { ok: false };
	}
}

function readBoolean(value: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
	for (const key of keys) {
		const item = value[key];
		if (typeof item === "boolean") {
			return item;
		}
	}
	return undefined;
}

function readString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const item = value[key];
		if (typeof item === "string" && item.length > 0) {
			return item;
		}
	}
	return undefined;
}

function readNumber(value: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const item = value[key];
		if (typeof item === "number") {
			return item;
		}
	}
	return undefined;
}
