# Plan 015 quality and test-value differential review

## Scope

- Wolfpack diff from `5549047176e1f83261e00d91d054794c797c723c`
- Pi Tasks diff from `ab8893443ef9054fd752ae443ed3e8555148353e`
- Reviewed changed source, tests, history, Wolfpack EDC context, repository standards, plan 015/016, and the prior security report.
- Independent verification: Pi focused tests **26/26**, Pi typecheck; Wolfpack focused tests **82/82**, Wolfpack typechecks.

## Verdict

**CHANGES REQUESTED** — 0 source-quality defects; 2 medium-confidence, high-confidence test-value gaps in the Pi contract coverage. The Wolfpack disposition, filtering, remote ordering/uncertainty, opaque-field round trips, and isolated-peer coverage are lean and behavior-level.

## Findings

### Medium — lifecycle race test does not exercise the extension lifecycle

- **Location:** `tests/extension.test.ts:46-63`; production wiring at `src/extension.ts:80-91`
- **Confidence:** high
- **Evidence:** The test invokes only `createSingleFlightInboxRefresh` with a synthetic blocked callback. `toolsFor()` supplies `on: () => undefined`, so it neither registers nor invokes `session_start`, interval, or `agent_end` handlers; it also observes no inbox insertion or `delivered` call.
- **Why it matters:** The mandatory adapter contract requires one receive loop across these concrete trigger paths. This test remains green if a handler stops calling `refreshInbox`, uses the wrong context, or bypasses the gate, so it does not prove the race regression it names.
- **Test-value rationale:** This is helper testing rather than the behavior at the native-extension boundary where the race exists.
- **Minimal recommendation:** Register against a listener-capturing extension fixture, overlap session-start, timer, and agent-end refreshes around a blocked inbox/status response, then assert exactly one structural insertion and one receiver delivery acknowledgment.

### Medium — read-only inbox coverage never supplies unrelated terminal tasks

- **Location:** `tests/extension.test.ts:105-117`; tool implementation at `src/extension.ts:135-158`
- **Confidence:** high
- **Evidence:** The inbox fixture returns event IDs for `task-1` and `task-2`, but `clientFixture().status()` ignores its task ID and returns the same active `task-1` status for both. The assertion consequently expects two `task-1` entries. No terminal status is present during inbox inspection.
- **Why it matters:** The removed behavior bulk-acknowledged terminal statuses. This test would not detect a regression that acknowledges terminal inbox tasks, nor prove that a distinct unrelated terminal task remains untouched.
- **Test-value rationale:** It asserts the new explicit `ack` call, but not the dangerous state that motivated replacing bulk acknowledgment.
- **Minimal recommendation:** Return distinct terminal status fixtures for both task IDs, assert inbox inspection issues zero acknowledgments, then acknowledge only one ID and assert the other receives no `ack` call.
