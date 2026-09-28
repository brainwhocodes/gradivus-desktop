import { describe, expect, it } from "vitest";
import type { HostedChatPayload } from "../src/lib/protocol";
import {
	GRADIVUS_CHAT_PROTOCOL_VERSION,
	hostedChatFailure,
	hostedChatSuccess,
	isHostedChatOperation,
	validateHostedCommandEnvelope,
} from "../src/lib/protocol";

const createPayload: HostedChatPayload<"createInWorkspace"> = { workspaceId: "workspace-opaque", kind: "code" };
const exportPayload: HostedChatPayload<"exportHtml"> = { sessionId: "session-opaque" };

// @ts-expect-error Hosted creation cannot represent a browser-supplied local path.
const invalidCreatePayload: HostedChatPayload<"createInWorkspace"> = { ...createPayload, cwd: "C:/secret" };
// @ts-expect-error Hosted export cannot represent a browser-supplied output path.
const invalidExportPayload: HostedChatPayload<"exportHtml"> = { ...exportPayload, outputPath: "C:/secret/export.html" };
void invalidCreatePayload;
void invalidExportPayload;

describe("hosted chat protocol", () => {
	it("accepts only the closed four-field command envelope", () => {
		const command = {
			protocolVersion: GRADIVUS_CHAT_PROTOCOL_VERSION,
			id: "request-1",
			operation: "createInWorkspace",
			payload: createPayload,
		};

		expect(validateHostedCommandEnvelope(command)).toEqual({ ok: true, value: command });
		expect(validateHostedCommandEnvelope({ ...command, cwd: "C:/secret" })).toMatchObject({
			ok: false,
			error: { code: "validation_error" },
		});
		expect(validateHostedCommandEnvelope({ ...command, protocolVersion: 2 })).toMatchObject({
			ok: false,
			error: { code: "protocol_mismatch", retryable: false },
		});
		expect(validateHostedCommandEnvelope({ ...command, operation: "createBrowser" })).toMatchObject({
			ok: false,
			error: { code: "validation_error" },
		});
	});

	it("keeps Desktop-only extension, browser, terminal, and provider mutations outside the operation set", () => {
		for (const operation of [
			"extensionResponse",
			"createBrowser",
			"writeTerminal",
			"loginProvider",
			"removeOAuthAccount",
		]) {
			expect(isHostedChatOperation(operation)).toBe(false);
		}
	});

	it("serializes correlated success and failure results with sequence checkpoints", () => {
		expect(
			hostedChatSuccess<"exportHtml">("request-2", 41, {
				action: { actionId: "action-1", kind: "save_export", state: "cancelled" },
				cancelled: true,
			}),
		).toEqual({
			protocolVersion: 1,
			id: "request-2",
			ok: true,
			atSequence: 41,
			value: {
				action: { actionId: "action-1", kind: "save_export", state: "cancelled" },
				cancelled: true,
			},
		});
		expect(
			hostedChatFailure("request-3", 42, {
				code: "scope_denied",
				message: "Desktop presentation is required.",
				retryable: false,
			}),
		).toEqual({
			protocolVersion: 1,
			id: "request-3",
			ok: false,
			atSequence: 42,
			error: {
				code: "scope_denied",
				message: "Desktop presentation is required.",
				retryable: false,
			},
		});
	});
});
