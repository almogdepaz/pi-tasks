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
			try {
				const status = await options.exec("wolfpack", ["session", "status", input.target, "--json"], {
					signal: input.signal,
				});
				return wolfpackStatusToPreflight(input, status.code, status.stdout);
			} catch {
				return wolfpackUnavailablePreflight(input, "wolfpack status command failed");
			}
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

const SESSION_IDENTITY_MAX_CHARS = 256;
const PROJECT_PATH_MAX_CHARS = 4096;
const ERROR_CODE_MAX_CHARS = 64;
const ERROR_MESSAGE_MAX_CHARS = 160;
const TERMINAL_STATUS_VALUES = ["ready", "dead", "unavailable"] as const;
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(TERMINAL_STATUS_VALUES);
type WolfpackTerminalState = (typeof TERMINAL_STATUS_VALUES)[number];

interface WolfpackTerminalStatus {
	readonly exists: boolean;
	readonly alive: boolean;
	readonly status: WolfpackTerminalState;
}

interface WolfpackStatusSuccess {
	readonly ok: true;
	readonly session: string | undefined;
	readonly sessionId: string | undefined;
	readonly projectDir: string | undefined;
	readonly terminal: WolfpackTerminalStatus | undefined;
}

interface WolfpackStatusFailure {
	readonly ok: false;
	readonly code: string;
	readonly message: string;
}

type WolfpackStatus = WolfpackStatusSuccess | WolfpackStatusFailure;

const STATUS_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
	SESSION_NOT_FOUND: "wolfpack session not found",
	AMBIGUOUS_SELECTOR: "wolfpack session selector is ambiguous",
	SESSION_DEAD: "wolfpack session is dead",
};

function wolfpackStatusToPreflight(input: PreflightTargetInput, exitCode: number, stdout: string): TaskPreflightResult {
	const status = parseStatusJson(stdout);
	if (!status) {
		return wolfpackUnavailablePreflight(input, "wolfpack status returned invalid json");
	}
	if (!status.ok) {
		return wolfpackFailurePreflight(input, status);
	}
	if (exitCode !== 0) {
		return wolfpackUnavailablePreflight(input, "wolfpack status command failed");
	}

	const targetSession = status.session ?? input.target;
	const identity = wolfpackSessionIdentity(status.session, status.sessionId);
	const targetProjectDir = status.projectDir ? resolve(status.projectDir) : undefined;
	const checks: TaskPreflightCheck[] = [wolfpackTerminalCheck(input, status.terminal, identity)];
	checks.push(wolfpackProjectCheck(input.requirements?.requiredProjectDir, targetProjectDir));

	return {
		ok: checks.every((check) => check.status !== "failed"),
		targetSession,
		...(targetProjectDir && { targetProjectDir }),
		checks,
	};
}

function wolfpackTerminalCheck(
	input: PreflightTargetInput,
	terminal: WolfpackTerminalStatus | undefined,
	identity: string,
): TaskPreflightCheck {
	if (!terminal) {
		return wolfpackAvailabilityCheck(input, "wolfpack status did not include valid terminal liveness");
	}
	if (terminal.exists && terminal.alive && terminal.status === "ready") {
		return {
			name: "transport_reachable",
			status: "passed",
			source: "transport",
			message: `wolfpack session ${identity} is ready`,
		};
	}
	if (terminal.status === "unavailable") {
		return wolfpackAvailabilityCheck(input, "wolfpack terminal liveness is unavailable");
	}
	return {
		name: "transport_reachable",
		status: "failed",
		source: "transport",
		message: `wolfpack session ${identity} is not ready`,
	};
}

function wolfpackProjectCheck(requiredProjectDir: string | undefined, targetProjectDir: string | undefined): TaskPreflightCheck {
	if (requiredProjectDir || targetProjectDir) {
		return checkRequiredTargetProjectDir(requiredProjectDir, targetProjectDir);
	}
	return {
		name: "target_project_dir",
		status: "unavailable",
		source: "transport",
		message: "wolfpack status did not include target project path",
	};
}

function wolfpackFailurePreflight(input: PreflightTargetInput, failure: WolfpackStatusFailure): TaskPreflightResult {
	if (failure.code === "BACKEND_UNAVAILABLE") {
		return wolfpackUnavailablePreflight(input, "wolfpack backend unavailable");
	}
	const knownMessage = STATUS_FAILURE_MESSAGES[failure.code];
	const message = knownMessage ?? `wolfpack status ${failure.code}: ${truncate(failure.message, ERROR_MESSAGE_MAX_CHARS)}`;
	return {
		ok: false,
		targetSession: input.target,
		checks: [{ name: "transport_reachable", status: "failed", source: "transport", message }],
	};
}

function wolfpackUnavailablePreflight(input: PreflightTargetInput, message: string): TaskPreflightResult {
	return {
		ok: !input.requirements?.requireReachable,
		targetSession: input.target,
		checks: [wolfpackAvailabilityCheck(input, message)],
	};
}

function wolfpackAvailabilityCheck(input: PreflightTargetInput, message: string): TaskPreflightCheck {
	return {
		name: "transport_reachable",
		status: input.requirements?.requireReachable ? "failed" : "unavailable",
		source: "transport",
		message,
	};
}

function parseStatusJson(stdout: string): WolfpackStatus | undefined {
	try {
		const parsed = JSON.parse(stdout) as unknown;
		if (!isRecord(parsed)) return undefined;
		if (parsed.ok === true) {
			return {
				ok: true,
				session: readBoundedString(parsed.session, SESSION_IDENTITY_MAX_CHARS),
				sessionId: readBoundedString(parsed.sessionId, SESSION_IDENTITY_MAX_CHARS),
				projectDir: readProjectDir(parsed),
				terminal: parseTerminalStatus(parsed.terminal),
			};
		}
		if (parsed.ok !== false || !isRecord(parsed.error)) return undefined;
		const code = readBoundedString(parsed.error.code, ERROR_CODE_MAX_CHARS);
		if (!code || typeof parsed.error.message !== "string") return undefined;
		return { ok: false, code, message: parsed.error.message };
	} catch {
		return undefined;
	}
}

function parseTerminalStatus(value: unknown): WolfpackTerminalStatus | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.exists !== "boolean" || typeof value.alive !== "boolean") return undefined;
	if (!isTerminalState(value.status)) return undefined;
	return { exists: value.exists, alive: value.alive, status: value.status };
}

function isTerminalState(value: unknown): value is WolfpackTerminalState {
	return typeof value === "string" && TERMINAL_STATUSES.has(value);
}

function readProjectDir(value: Record<string, unknown>): string | undefined {
	return readBoundedString(value.projectDir, PROJECT_PATH_MAX_CHARS)
		?? readBoundedString(value.projectPath, PROJECT_PATH_MAX_CHARS);
}

function readBoundedString(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maxChars) return undefined;
	return value;
}

function wolfpackSessionIdentity(session: string | undefined, sessionId: string | undefined): string {
	if (session && sessionId) return `${session} (id ${sessionId})`;
	return session ?? sessionId ?? "target";
}

function truncate(value: string, maxChars: number): string {
	const chars = Array.from(value);
	return chars.length <= maxChars ? value : `${chars.slice(0, maxChars).join("")}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
