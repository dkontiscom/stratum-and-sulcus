// SPDX-License-Identifier: MIT
import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Tests that don't require a populated database — auth is rejected before any DB query
// when no credentials are provided at all.
describe("Subsonic auth — unauthenticated requests", () => {
	it("returns XML error (code 40) for missing credentials", async () => {
		const request = new IncomingRequest("http://example.com/rest/ping");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const text = await response.text();
		expect(text).toContain('status="failed"');
		expect(text).toContain('code="40"');
	});

	it("returns JSON error (code 40) when f=json", async () => {
		const response = await SELF.fetch("https://example.com/rest/ping?f=json");
		const data = await response.json() as any;
		expect(data["subsonic-response"].status).toBe("failed");
		expect(data["subsonic-response"].error.code).toBe(40);
	});
});

// Tests that require a populated D1 database:
// it.todo("returns ping success with valid admin credentials")
// it.todo("getArtists returns artist list")
// it.todo("getSong returns track metadata")
// it.todo("stream returns 302 redirect to presigned S3 URL")
