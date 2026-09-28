import { GRADIVUS_CHAT_ACCESS_TOKEN_AUDIENCE, GRADIVUS_CHAT_INITIAL_SCOPES } from "@gradivus/chat/protocol";
import { describe, expect, it, vi } from "vitest";
import type { DesktopHost } from "../src/main/desktop-host";
import {
	type HostedCommandDispatchError,
	HostedCommandDispatcher,
	type HostedNativeCommandActions,
} from "../src/main/hosted-command-dispatcher";
import { validateHostedCommandPayload } from "../src/main/hosted-command-validation";
import { HostedGrantCapabilityStore } from "../src/main/hosted-grant-capabilities";
import { HostedProjection } from "../src/main/hosted-projection";
import { LOCAL_CHAT_OWNER } from "../src/main/local-chat-oauth";
import type { VerifiedLocalAccess } from "../src/main/local-chat-tokens";
import type { ProcessState, SessionRecordV1 } from "../src/shared/contracts";

function sessionRecord(overrides: Partial<SessionRecordV1> = {}): SessionRecordV1 {
	return {
		id: "session-1",
		kind: "code",
		surface: "chat",
		cwd: process.cwd(),
		ompSessionId: "internal-session-id",
		sessionFile: `${process.cwd()}/.omp/internal.jsonl`,
		title: "Current title",
		createdAt: "2026-08-30T00:00:00.000Z",
		lastOpenedAt: "2026-08-30T00:00:01.000Z",
		...overrides,
	};
}

function access(scopes = [...GRADIVUS_CHAT_INITIAL_SCOPES]): VerifiedLocalAccess {
	const now = Math.floor(Date.now() / 1_000);
	return {
		claims: {
			iss: "http://127.0.0.1:47832",
			aud: GRADIVUS_CHAT_ACCESS_TOKEN_AUDIENCE,
			sub: LOCAL_CHAT_OWNER.id,
			cid: "gradivus-chat-web",
			scope: scopes.join(" "),
			jti: "token-1",
			iat: now,
			nbf: now,
			exp: now + 3_600,
		},
		grant: {
			id: "grant-1",
			clientId: "gradivus-chat-web",
			origin: "https://gradivus.brainwhocodes.rocks",
			scopes,
			status: "active",
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
			expiresAt: Date.now() + 3_600_000,
		},
		jtiHash: "token-hash",
	};
}

const nativeActions: HostedNativeCommandActions = {
	chooseWorkspaceAndCreate: async () => ({
		action: { actionId: "choose-1", kind: "choose_workspace", state: "cancelled" },
	}),
	exportHtml: async () => ({
		action: { actionId: "export-1", kind: "save_export", state: "cancelled" },
		cancelled: true,
	}),
	openWorkspaceFile: async () => ({ actionId: "open-1", kind: "open_file", state: "completed" }),
	reconnectRuntime: async () => ({
		action: { actionId: "reconnect-1", kind: "open_accounts", state: "completed" },
	}),
	openDesktopAccounts: async () => ({ actionId: "accounts-1", kind: "open_accounts", state: "completed" }),
};

function command(operation: string, payload: Record<string, unknown>) {
	return validateHostedCommandPayload({
		protocolVersion: 1,
		id: `command-${operation}`,
		operation: operation as never,
		payload,
	});
}

async function harness(record = sessionRecord(), state: ProcessState = "ready") {
	const setFastMode = vi.fn(async () => {});
	const deleteSession = vi.fn();
	const host = {
		resolveHostedChatSessionAuthority: () => ({ record, state }),
		setFastMode,
		deleteSession,
	} as unknown as DesktopHost;
	const projection = await HostedProjection.create();
	const capabilities = new HostedGrantCapabilityStore();
	capabilities.allowSession("grant-1", await projection.projectHostedSessionRecord(record));
	return {
		dispatcher: new HostedCommandDispatcher({ host, projection, capabilities, native: nativeActions }),
		setFastMode,
		deleteSession,
	};
}

describe("HostedCommandDispatcher authorization", () => {
	it("executes a permitted mutation only after grant, capability, surface, and state checks", async () => {
		const { dispatcher, setFastMode } = await harness();
		await expect(
			dispatcher.dispatch(command("setFastMode", { sessionId: "session-1", enabled: true }), access()),
		).resolves.toBeNull();
		expect(setFastMode).toHaveBeenCalledWith("session-1", true);
	});

	it("rejects missing scope, stale capability, browser surface, and invalid runtime state", async () => {
		const permitted = command("setFastMode", { sessionId: "session-1", enabled: true });
		const missingExecute = access(["chat.read", "sessions.manage", "files.read"]);
		const ready = await harness();
		await expect(ready.dispatcher.dispatch(permitted, missingExecute)).rejects.toMatchObject({
			code: "scope_denied",
		});

		await expect(
			ready.dispatcher.dispatch(command("setFastMode", { sessionId: "other-session", enabled: true }), access()),
		).rejects.toMatchObject({ code: "unauthorized" });

		const browser = await harness(sessionRecord({ surface: "browser-selection" }));
		await expect(browser.dispatcher.dispatch(permitted, access())).rejects.toMatchObject({ code: "unauthorized" });

		const stopped = await harness(sessionRecord(), "stopped");
		await expect(stopped.dispatcher.dispatch(permitted, access())).rejects.toMatchObject({ code: "conflict" });
	});

	it("requires delete confirmation to match the freshly resolved id and title", async () => {
		const { dispatcher, deleteSession } = await harness();
		await expect(
			dispatcher.dispatch(
				command("deleteSession", {
					sessionId: "session-1",
					confirmation: { sessionId: "session-1", title: "Old title" },
				}),
				access(),
			),
		).rejects.toEqual(
			expect.objectContaining<Partial<HostedCommandDispatchError>>({
				code: "conflict",
			}),
		);
		expect(deleteSession).not.toHaveBeenCalled();
	});
});
