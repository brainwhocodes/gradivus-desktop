import { GRADIVUS_CHAT_INITIAL_SCOPES, GRADIVUS_CHAT_ORIGIN } from "@gradivus/chat/protocol";
import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { DesktopHost } from "../src/main/desktop-host";
import type { HostedEventSequencer } from "../src/main/hosted-event-sequencer";
import { HostedGrantCapabilityStore } from "../src/main/hosted-grant-capabilities";
import { LocalChatConnectionController } from "../src/main/local-chat-connections";
import { DesktopLocalChatConsentPresenter } from "../src/main/local-chat-consent-presenter";
import { FixedHostedClientRepository } from "../src/main/local-chat-oauth";
import { LocalGrantRepository, LocalTokenService } from "../src/main/local-chat-tokens";
import type { LocalChatConsentRequest } from "../src/shared/local-chat-consent";

function consentRequest(): LocalChatConsentRequest {
	return {
		requestId: "consent-request-1",
		clientId: "gradivus-chat-web",
		clientName: "Gradivus Chat",
		origin: GRADIVUS_CHAT_ORIGIN,
		scopes: [{ scope: "chat.read", label: "View chats and transcripts" }],
		title: "Allow Gradivus Chat to use this Desktop?",
		riskNotice: "Coding access risk",
		securityNote: "Credentials remain private",
		allowLabel: "Allow coding chat access",
		denyLabel: "Deny",
		expiresAt: Date.now() + 60_000,
	};
}

describe("DesktopLocalChatConsentPresenter", () => {
	it("focuses the trusted Desktop window and resolves only the matching decision", async () => {
		const send = vi.fn();
		const window = {
			isDestroyed: () => false,
			isMinimized: () => true,
			restore: vi.fn(),
			show: vi.fn(),
			focus: vi.fn(),
			webContents: { isDestroyed: () => false, send },
		} as unknown as BrowserWindow;
		const presenter = new DesktopLocalChatConsentPresenter(() => window);
		const result = presenter.present(consentRequest());
		expect(send).toHaveBeenCalledWith("gradivus:local-chat-consent-request", consentRequest());
		expect(presenter.respond({ requestId: "different-request", decision: "allow" })).toBe(false);
		expect(presenter.respond({ requestId: "consent-request-1", decision: "allow" })).toBe(true);
		await expect(result).resolves.toEqual({ requestId: "consent-request-1", decision: "allow" });
	});

	it("resolves pending consent as unavailable when the Desktop window closes", async () => {
		const window = {
			isDestroyed: () => false,
			isMinimized: () => false,
			show: () => {},
			focus: () => {},
			webContents: { isDestroyed: () => false, send: () => {} },
		} as unknown as BrowserWindow;
		const presenter = new DesktopLocalChatConsentPresenter(() => window);
		const result = presenter.present(consentRequest());
		presenter.cancelAll();
		await expect(result).resolves.toEqual({ requestId: "consent-request-1", decision: "unavailable" });
	});
});

describe("LocalChatConnectionController", () => {
	it("revokes token authority before asynchronous attachment cleanup", async () => {
		const clients = new FixedHostedClientRepository(false);
		const grants = new LocalGrantRepository();
		const tokens = new LocalTokenService(grants);
		const grant = grants.create("gradivus-chat-web", GRADIVUS_CHAT_ORIGIN, GRADIVUS_CHAT_INITIAL_SCOPES);
		const issued = await tokens.issue({
			grantId: grant.id,
			clientId: grant.clientId,
			origin: grant.origin,
			scopes: grant.scopes,
		});
		const capabilities = new HostedGrantCapabilityStore();
		capabilities.allowAttachments(grant.id, "session-1", ["attachment-1"]);
		const closeGrant = vi.fn();
		let statusDuringRelease = "";
		const host = {
			releasePromptAttachments: vi.fn(async () => {
				statusDuringRelease = grants.list().find(candidate => candidate.id === grant.id)?.status ?? "missing";
			}),
		} as unknown as DesktopHost;
		const changed = vi.fn();
		const controller = new LocalChatConnectionController({
			clients,
			grants,
			tokens,
			events: { closeGrant } as unknown as HostedEventSequencer,
			capabilities,
			host,
			onChanged: changed,
		});
		expect(controller.list()[0]).toMatchObject({
			grantId: grant.id,
			clientName: "Gradivus Chat",
			origin: GRADIVUS_CHAT_ORIGIN,
			activeTokenCount: 1,
		});

		await expect(controller.revoke(grant.id)).resolves.toEqual([]);
		expect(statusDuringRelease).toBe("revoked");
		expect(closeGrant).toHaveBeenCalledWith(grant.id);
		expect(host.releasePromptAttachments).toHaveBeenCalledWith("session-1", ["attachment-1"]);
		expect(changed).toHaveBeenCalledWith([]);
		await expect(
			tokens.verify(issued.accessToken, { clientId: grant.clientId, origin: grant.origin }),
		).rejects.toMatchObject({ code: "grant_revoked" });
		expect(() => capabilities.assertAttachments(grant.id, "session-1", ["attachment-1"])).toThrow();
	});
});
