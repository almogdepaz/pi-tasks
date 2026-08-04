export const DEFAULT_WOLFPACK_PORT = 18_790;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
export const MIN_TASK_TIMEOUT_MS = 1_000;
export const MAX_TASK_TIMEOUT_MS = 86_400_000;
// Initial limits; benchmark representative task/context payloads before adjusting them.
export const MAX_TASK_BYTES = 16 * 1024;
export const MAX_CONTEXT_SUMMARY_BYTES = 16 * 1024;
export const MAX_ASSIGNMENT_ENVELOPE_BYTES = 48 * 1024;
export const MAX_HTTP_BODY_BYTES = 64 * 1024;

export type GatewayErrorCode =
	| "ABORTED"
	| "TIMEOUT"
	| "NETWORK_ERROR"
	| "MALFORMED_RESPONSE"
	| "INVALID_RESPONSE"
	| string;

export class GatewayClientError extends Error {
	readonly code: GatewayErrorCode;
	readonly retryable: boolean;
	readonly path?: string;

	constructor(code: GatewayErrorCode, message: string, retryable: boolean, path?: string) {
		super(message);
		this.name = "GatewayClientError";
		this.code = code;
		this.retryable = retryable;
		this.path = path;
	}
}

export interface TaskAddress {
	readonly machine: string;
	readonly sessionId: string;
}

export interface ContextRef {
	readonly path: string;
	readonly selector?: string;
	readonly purpose?: string;
}

export interface TaskContext {
	readonly summary?: string;
	readonly refs?: readonly ContextRef[];
}

export interface TaskWarning {
	readonly code: string;
	readonly message: string;
}

export interface TaskAssignment {
	readonly taskId: string;
	readonly source: TaskAddress;
	readonly target: TaskAddress;
	readonly task: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly context?: TaskContext;
	readonly role?: string;
	readonly metadata?: Record<string, string>;
	readonly onCompletePrompt?: string;
}

export interface TaskEvent {
	readonly id: string;
	readonly taskId: string;
	readonly type: string;
	readonly actor: "parent" | "receiver" | "sender";
	readonly source: TaskAddress;
	readonly destination: TaskAddress;
	readonly sequence: string;
	readonly occurredAt: string;
	readonly message?: string;
	readonly replyToMessageId?: string;
	readonly payload: Record<string, unknown>;
	readonly completion?: TaskCompletion;
}

export interface TaskCompletion {
	readonly summary: string;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
	readonly artifacts?: readonly { readonly machine: string; readonly project: string; readonly path: string; readonly mimeType?: string; readonly description?: string }[];
	readonly warnings: readonly TaskWarning[];
}

export interface TaskStatus {
	readonly task: TaskAssignment;
	readonly status: string;
	readonly events: readonly TaskEvent[];
	readonly completion?: TaskCompletion;
	readonly warnings: readonly TaskWarning[];
}

export interface TaskReceipt {
	readonly taskId: string;
	readonly eventId: string;
	readonly sequence: string;
	readonly warnings: readonly TaskWarning[];
}

export interface InboxPage {
	readonly events: readonly TaskEvent[];
	readonly nextCursor: string;
	readonly hasMore: boolean;
}

export interface WolfpackGatewayClientOptions {
	readonly baseUrl?: string;
	readonly port?: string | undefined;
	readonly sessionName?: string | undefined;
	readonly timeoutMs?: number;
}

export interface SendTaskInput {
	readonly to: TaskAddress;
	readonly task: string;
	readonly context?: TaskContext;
	readonly role?: string;
	readonly preflight?: { readonly requiredProject?: string };
	readonly metadata?: Record<string, string>;
	readonly onCompletePrompt?: string;
	readonly timeoutMs?: number;
	readonly idempotencyKey?: string;
}

export interface MessageTaskInput {
	readonly taskId: string;
	readonly type: "question" | "answer" | "information";
	readonly message: string;
	readonly replyToMessageId?: string;
}

export interface TaskCompletionInput {
	readonly summary: string;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
	readonly artifacts?: readonly { readonly path: string; readonly mimeType?: string; readonly description?: string }[];
}

export interface CompleteTaskInput {
	readonly taskId: string;
	readonly status: "completed" | "failed" | "cancelled";
	readonly result: TaskCompletionInput;
}

export interface WolfpackSessionStatus {
	readonly session: string;
	readonly sessionId: string;
	readonly terminal: { readonly exists: boolean; readonly alive: boolean; readonly status: string };
}

export interface WolfpackGatewayClient {
	readonly callerSession: string;
	request(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>;
	sessionStatus(signal?: AbortSignal): Promise<WolfpackSessionStatus>;
	send(input: SendTaskInput, signal?: AbortSignal): Promise<TaskReceipt>;
	status(taskId: string, signal?: AbortSignal): Promise<TaskStatus>;
	inbox(cursor: string, includeAcknowledged: boolean, signal?: AbortSignal): Promise<InboxPage>;
	message(input: MessageTaskInput, signal?: AbortSignal): Promise<TaskReceipt>;
	complete(input: CompleteTaskInput, signal?: AbortSignal): Promise<TaskReceipt>;
	cancel(taskId: string, signal?: AbortSignal): Promise<TaskReceipt>;
	delivered(taskId: string, eventId: string, signal?: AbortSignal): Promise<TaskReceipt>;
	ack(taskId: string, signal?: AbortSignal): Promise<TaskReceipt>;
}

export function createWolfpackGatewayClient(options: WolfpackGatewayClientOptions = {}): WolfpackGatewayClient {
	const baseUrl = options.baseUrl ?? `http://127.0.0.1:${portFrom(options.port ?? process.env.WOLFPACK_PORT)}`;
	const callerSession = options.sessionName ?? process.env.WOLFPACK_SESSION_NAME ?? "unknown-session";
	const requestTimeoutMs = boundedRequestTimeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

	async function request(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		const serializedBody = body === undefined ? undefined : serializeBody(body);
		const timeout = new AbortController();
		const timeoutId = setTimeout(() => timeout.abort(), requestTimeoutMs);
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		timeout.signal.addEventListener("abort", abort, { once: true });
		try {
			const response = await fetch(new URL(path, baseUrl), {
				method,
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: serializedBody,
				signal: controller.signal,
			});
			const parsed = await parseJson(response);
			if (isErrorEnvelope(parsed)) throw new GatewayClientError(parsed.error.code, parsed.error.message, parsed.error.retryable, parsed.error.path);
			if (!response.ok) throw new GatewayClientError("MALFORMED_RESPONSE", `wolfpack returned HTTP ${response.status} without a task error envelope`, true);
			if (!isOkEnvelope(parsed)) throw new GatewayClientError("MALFORMED_RESPONSE", "wolfpack returned an invalid task response", true);
			return parsed;
		} catch (error) {
			if (error instanceof GatewayClientError) throw error;
			if (signal?.aborted) throw new GatewayClientError("ABORTED", "wolfpack request was cancelled", true);
			if (timeout.signal.aborted) throw new GatewayClientError("TIMEOUT", `wolfpack request exceeded ${requestTimeoutMs}ms`, true);
			throw new GatewayClientError("NETWORK_ERROR", error instanceof Error ? error.message : "wolfpack request failed", true);
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", abort);
		}
	}

	return {
		callerSession,
		request,
		async sessionStatus(signal) {
			return parseSessionStatus(await request("GET", query("/api/session-control/status", { session: callerSession }), undefined, signal));
		},
		async send(input, signal) {
			validateSend(input);
			return parseReceipt(await request("POST", "/api/tasks/v1/send", { callerSession, ...input }, signal));
		},
		async status(taskId, signal) {
			validateId(taskId, "task id");
			return parseStatus(await request("GET", query("/api/tasks/v1/status", { callerSession, taskId }), undefined, signal));
		},
		async inbox(cursor, includeAcknowledged, signal) {
			if (!decimal(cursor)) throw new GatewayClientError("INVALID_REQUEST", "inbox cursor must be a decimal delivery sequence", false);
			return parseInbox(await request("GET", query("/api/tasks/v1/inbox", { callerSession, cursor, includeAcknowledged: String(includeAcknowledged) }), undefined, signal));
		},
		async message(input, signal) {
			validateMessage(input);
			return parseReceipt(await request("POST", "/api/tasks/v1/message", { callerSession, ...input }, signal));
		},
		async complete(input, signal) {
			validateComplete(input);
			return parseReceipt(await request("POST", "/api/tasks/v1/complete", { callerSession, ...input }, signal));
		},
		async cancel(taskId, signal) {
			validateId(taskId, "task id");
			return parseReceipt(await request("POST", "/api/tasks/v1/cancel", { callerSession, taskId }, signal));
		},
		async delivered(taskId, eventId, signal) {
			validateId(taskId, "task id");
			validateId(eventId, "event id");
			return parseReceipt(await request("POST", "/api/tasks/v1/delivered", { callerSession, taskId, eventId }, signal));
		},
		async ack(taskId, signal) {
			validateId(taskId, "task id");
			return parseReceipt(await request("POST", "/api/tasks/v1/ack", { callerSession, taskId }, signal));
		},
	};
}

function portFrom(value: string | undefined): number {
	const port = value === undefined ? DEFAULT_WOLFPACK_PORT : Number(value);
	return Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_WOLFPACK_PORT;
}

function boundedRequestTimeout(value: number): number {
	return Number.isInteger(value) && value >= 1 && value <= 60_000 ? value : DEFAULT_REQUEST_TIMEOUT_MS;
}

function query(path: string, parameters: Record<string, string>): string {
	const search = new URLSearchParams(parameters);
	return `${path}?${search.toString()}`;
}

async function parseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new GatewayClientError("MALFORMED_RESPONSE", "wolfpack returned invalid JSON", true);
	}
}

function serializeBody(body: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(body);
	} catch {
		throw new GatewayClientError("INVALID_REQUEST", "task request must be JSON-serializable", false);
	}
	if (bytes(serialized) > MAX_HTTP_BODY_BYTES) throw new GatewayClientError("INVALID_REQUEST", "task request exceeds the 64KiB initial HTTP limit", false);
	return serialized;
}

function validateSend(input: SendTaskInput): void {
	const path = sendValidationPath(input);
	if (path !== undefined) throw new GatewayClientError("INVALID_REQUEST", "task and target address are required and bounded", false, path);
	if (input.context?.summary !== undefined && (!nonEmpty(input.context.summary) || bytes(input.context.summary) > MAX_CONTEXT_SUMMARY_BYTES)) throw new GatewayClientError("INVALID_REQUEST", "context summary exceeds the 16KiB initial limit", false, "/context/summary");
	if (bytes(JSON.stringify(input)) > MAX_ASSIGNMENT_ENVELOPE_BYTES) throw new GatewayClientError("INVALID_REQUEST", "assignment envelope exceeds the 48KiB initial limit", false, "");
	const timeoutMs = input.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TASK_TIMEOUT_MS || timeoutMs > MAX_TASK_TIMEOUT_MS) throw new GatewayClientError("INVALID_REQUEST", "task timeout must be from 1000ms through 24h", false, "/timeoutMs");
}

function sendValidationPath(input: SendTaskInput): string | undefined {
	if (!isRecord(input.to)) return "/to";
	if (!nonEmpty(input.to.machine)) return "/to/machine";
	if (!nonEmpty(input.to.sessionId)) return "/to/sessionId";
	if (!nonEmpty(input.task) || bytes(input.task) > MAX_TASK_BYTES) return "/task";
	if (input.preflight?.requiredProject !== undefined && !nonEmpty(input.preflight.requiredProject)) return "/preflight/requiredProject";
	if (input.context?.refs !== undefined) {
		if (!Array.isArray(input.context.refs)) return "/context/refs";
		for (const [index, ref] of input.context.refs.entries()) {
			if (!isRecord(ref)) return `/context/refs/${index}`;
			if (!nonEmpty(ref.path)) return `/context/refs/${index}/path`;
		}
	}
	return undefined;
}

function validateMessage(input: MessageTaskInput): void {
	validateId(input.taskId, "task id");
	if (!nonEmpty(input.message) || bytes(input.message) > MAX_TASK_BYTES || !["question", "answer", "information"].includes(input.type) || (input.replyToMessageId !== undefined && !nonEmpty(input.replyToMessageId))) throw new GatewayClientError("INVALID_REQUEST", "task message is invalid or exceeds the 16KiB initial limit", false);
}

function validateComplete(input: CompleteTaskInput): void {
	validateId(input.taskId, "task id");
	if (!nonEmpty(input.result.summary) || bytes(input.result.summary) > MAX_TASK_BYTES || !["completed", "failed", "cancelled"].includes(input.status)) throw new GatewayClientError("INVALID_REQUEST", "terminal task result is invalid or exceeds the 16KiB initial limit", false);
	if (input.result.artifacts?.some((artifact) => !nonEmpty(artifact.path))) throw new GatewayClientError("INVALID_REQUEST", "artifact paths must be non-empty", false);
}

function validateId(value: string, label: string): void {
	if (!nonEmpty(value)) throw new GatewayClientError("INVALID_REQUEST", `${label} is required`, false);
}

function parseSessionStatus(value: unknown): WolfpackSessionStatus {
	if (!isRecord(value) || value.ok !== true || !nonEmpty(value.session) || !nonEmpty(value.sessionId) || !isRecord(value.terminal) || typeof value.terminal.exists !== "boolean" || typeof value.terminal.alive !== "boolean" || !nonEmpty(value.terminal.status)) throw invalidResponse("invalid structured Wolfpack session status");
	return { session: value.session, sessionId: value.sessionId, terminal: { exists: value.terminal.exists, alive: value.terminal.alive, status: value.terminal.status } };
}

function parseReceipt(value: unknown): TaskReceipt {
	if (!isRecord(value) || !nonEmpty(value.taskId) || !nonEmpty(value.eventId) || !decimal(value.sequence) || (value.warnings !== undefined && !warnings(value.warnings))) throw invalidResponse("invalid task acknowledgement");
	return { taskId: value.taskId, eventId: value.eventId, sequence: value.sequence, warnings: value.warnings ?? [] };
}

function parseStatus(value: unknown): TaskStatus {
	if (!isRecord(value) || !assignment(value.task) || !nonEmpty(value.status) || !events(value.events) || !warnings(value.warnings) || (value.completion !== undefined && !completion(value.completion))) throw invalidResponse("invalid task status response");
	return { task: value.task, status: value.status, events: value.events, warnings: value.warnings, ...(value.completion && { completion: value.completion }) };
}

function parseInbox(value: unknown): InboxPage {
	if (!isRecord(value) || !events(value.events) || !decimal(value.nextCursor) || typeof value.hasMore !== "boolean") throw invalidResponse("invalid task inbox response");
	return { events: value.events, nextCursor: value.nextCursor, hasMore: value.hasMore };
}

function invalidResponse(message: string): GatewayClientError {
	return new GatewayClientError("INVALID_RESPONSE", message, true);
}

function isOkEnvelope(value: unknown): value is Record<string, unknown> & { readonly ok: true } {
	return isRecord(value) && value.ok === true;
}

function isErrorEnvelope(value: unknown): value is { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean; readonly path?: string } } {
	return isRecord(value) && value.ok === false && isRecord(value.error) && nonEmpty(value.error.code) && typeof value.error.message === "string" && typeof value.error.retryable === "boolean"
		&& (value.error.path === undefined || jsonPointer(value.error.path));
}

function jsonPointer(value: unknown): value is string {
	return typeof value === "string" && /^(?:|\/(?:[^~/]|~[01])*)*$/.test(value);
}

function assignment(value: unknown): value is TaskAssignment {
	return isRecord(value) && nonEmpty(value.taskId) && isAddress(value.source) && isAddress(value.target) && nonEmpty(value.task) && iso(value.createdAt) && iso(value.expiresAt)
		&& (value.context === undefined || context(value.context)) && (value.role === undefined || nonEmpty(value.role)) && (value.metadata === undefined || stringRecord(value.metadata)) && (value.onCompletePrompt === undefined || nonEmpty(value.onCompletePrompt));
}

function context(value: unknown): value is TaskContext {
	return isRecord(value) && (value.summary === undefined || nonEmpty(value.summary)) && (value.refs === undefined || (Array.isArray(value.refs) && value.refs.every((ref) => isRecord(ref) && nonEmpty(ref.path) && (ref.selector === undefined || typeof ref.selector === "string") && (ref.purpose === undefined || typeof ref.purpose === "string"))));
}

function events(value: unknown): value is readonly TaskEvent[] {
	return Array.isArray(value) && value.every((event) => isRecord(event) && nonEmpty(event.id) && nonEmpty(event.taskId) && nonEmpty(event.type) && (event.actor === "parent" || event.actor === "receiver" || event.actor === "sender") && isAddress(event.source) && isAddress(event.destination) && decimal(event.sequence) && iso(event.occurredAt) && isRecord(event.payload) && (event.message === undefined || typeof event.message === "string") && (event.replyToMessageId === undefined || nonEmpty(event.replyToMessageId)) && (event.completion === undefined || completion(event.completion)));
}

function completion(value: unknown): value is TaskCompletion {
	return isRecord(value) && nonEmpty(value.summary) && warnings(value.warnings)
		&& (value.result === undefined || isRecord(value.result))
		&& (value.error === undefined || (isRecord(value.error) && nonEmpty(value.error.code) && typeof value.error.message === "string" && typeof value.error.retryable === "boolean"))
		&& (value.artifacts === undefined || (Array.isArray(value.artifacts) && value.artifacts.every((artifact) => isRecord(artifact) && nonEmpty(artifact.machine) && nonEmpty(artifact.project) && nonEmpty(artifact.path) && (artifact.mimeType === undefined || typeof artifact.mimeType === "string") && (artifact.description === undefined || typeof artifact.description === "string"))));
}

function warnings(value: unknown): value is readonly TaskWarning[] {
	return Array.isArray(value) && value.every((warning) => isRecord(warning) && nonEmpty(warning.code) && typeof warning.message === "string");
}

function stringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((field) => typeof field === "string");
}

function isAddress(value: unknown): value is TaskAddress {
	return isRecord(value) && nonEmpty(value.machine) && nonEmpty(value.sessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function decimal(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function iso(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}
