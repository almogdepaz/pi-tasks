import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { TaskStore, TaskTransport } from "./task-communication";
import type { ContextRef, TaskPreflightCheck, TaskPreflightRequirement, TaskPreflightResult, TaskWorkflowMetadata } from "./types";

export interface RunTaskPreflightInput {
	readonly projectDir: string;
	readonly parentSession: string;
	readonly target: string;
	readonly store: TaskStore;
	readonly transport: TaskTransport;
	readonly requirements?: TaskPreflightRequirement;
	readonly metadata?: TaskWorkflowMetadata;
	readonly contextRefs?: readonly ContextRef[];
	readonly signal?: AbortSignal;
}

export async function runTaskPreflight(input: RunTaskPreflightInput): Promise<TaskPreflightResult> {
	const checks: TaskPreflightCheck[] = [];
	checks.push(checkTargetSyntax(input.target));
	checks.push(checkRequiredProjectDir(input.projectDir, input.requirements?.requiredProjectDir));
	checks.push(await checkActiveIssueConflict(input.store, input.projectDir, input.target, input.metadata?.issueId));
	checks.push(...(await checkContextRefs(input.projectDir, input.contextRefs)));
	checks.push(checkRequiredModel(input.requirements?.requiredModel));
	checks.push(checkRequireIdle(input.requirements?.requireIdle));
	checks.push(...(await checkTransportPreflight(input)));

	return {
		ok: checks.every((check) => check.status !== "failed"),
		checks,
		targetSession: input.target,
	};
}

function checkTargetSyntax(target: string): TaskPreflightCheck {
	if (target.trim().length === 0) {
		return { name: "target_syntax", status: "failed", source: "protocol", message: "target session is empty" };
	}
	return { name: "target_syntax", status: "passed", source: "protocol" };
}

function checkRequiredProjectDir(projectDir: string, requiredProjectDir: string | undefined): TaskPreflightCheck {
	if (!requiredProjectDir) {
		return { name: "required_project_dir", status: "skipped", source: "protocol" };
	}
	if (resolve(projectDir) === resolve(requiredProjectDir)) {
		return { name: "required_project_dir", status: "passed", source: "protocol" };
	}
	return {
		name: "required_project_dir",
		status: "failed",
		source: "protocol",
		message: `expected ${resolve(requiredProjectDir)}, got ${resolve(projectDir)}`,
	};
}

async function checkActiveIssueConflict(
	store: TaskStore,
	projectDir: string,
	target: string,
	issueId: string | undefined,
): Promise<TaskPreflightCheck> {
	if (!issueId) {
		return { name: "active_issue_conflict", status: "skipped", source: "store" };
	}
	const existing = await store.findActiveTaskByIssueId(projectDir, target, issueId);
	if (!existing) {
		return { name: "active_issue_conflict", status: "passed", source: "store" };
	}
	return {
		name: "active_issue_conflict",
		status: "failed",
		source: "store",
		message: `active task ${existing.id} already targets issue ${issueId}`,
	};
}

async function checkContextRefs(projectDir: string, contextRefs: readonly ContextRef[] | undefined): Promise<readonly TaskPreflightCheck[]> {
	if (!contextRefs || contextRefs.length === 0) {
		return [{ name: "context_refs", status: "skipped", source: "protocol" }];
	}

	const checks: TaskPreflightCheck[] = [];
	for (const ref of contextRefs) {
		checks.push(await checkContextRef(projectDir, ref));
	}
	return checks;
}

async function checkContextRef(projectDir: string, contextRef: ContextRef): Promise<TaskPreflightCheck> {
	const name = `context_ref:${contextRef.path}`;
	const resolved = resolve(projectDir, contextRef.path);
	const relativePath = relative(resolve(projectDir), resolved);
	if (isAbsolute(contextRef.path) || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		return {
			name,
			status: contextRef.required ? "failed" : "skipped",
			source: "protocol",
			message: "context ref must stay inside projectDir",
		};
	}

	try {
		await readFile(resolved, "utf8");
		return { name, status: "passed", source: "protocol" };
	} catch (error) {
		return {
			name,
			status: contextRef.required ? "failed" : "skipped",
			source: "protocol",
			message: error instanceof Error ? error.message : "context ref is not readable",
		};
	}
}

function checkRequiredModel(requiredModel: string | undefined): TaskPreflightCheck {
	if (!requiredModel) {
		return { name: "required_model", status: "skipped", source: "pi" };
	}
	return {
		name: "required_model",
		status: "unavailable",
		source: "pi",
		message: "target model inspection is not exposed yet; matching is deferred",
	};
}

function checkRequireIdle(requireIdle: boolean | undefined): TaskPreflightCheck {
	if (!requireIdle) {
		return { name: "target_idle", status: "skipped", source: "pi" };
	}
	return {
		name: "target_idle",
		status: "unavailable",
		source: "pi",
		message: "target task readiness is not exposed yet",
	};
}

async function checkTransportPreflight(input: RunTaskPreflightInput): Promise<readonly TaskPreflightCheck[]> {
	if (!input.transport.preflightTarget) {
		return [
			{
				name: "transport_reachable",
				status: input.requirements?.requireReachable ? "failed" : "unavailable",
				source: "transport",
				message: "transport does not expose target preflight",
			},
		];
	}

	const result = await input.transport.preflightTarget({
		projectDir: input.projectDir,
		parentSession: input.parentSession,
		target: input.target,
		requirements: input.requirements,
		metadata: input.metadata,
		contextRefs: input.contextRefs,
		signal: input.signal,
	});

	if (result.ok) {
		return result.checks;
	}
	if (result.checks.some((check) => check.status === "failed")) {
		return result.checks;
	}
	return [
		...result.checks,
		{ name: "transport_preflight", status: "failed", source: "transport", message: "transport preflight failed" },
	];
}
