import { describe } from "bun:test";

import { createInMemoryTaskRelay, runTaskRelayConformance } from "../src/index";

describe("in-memory task relay conformance", () => {
	runTaskRelayConformance(() => createInMemoryTaskRelay("relay"));
});
