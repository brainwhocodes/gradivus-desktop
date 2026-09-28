import type { BrowserWindow } from "electron";
import type { LocalChatConsentDecision, LocalChatConsentRequest } from "../shared/local-chat-consent";
import type { LocalChatConsentPresenter } from "./local-chat-consent";

interface PendingConsentPresentation {
	request: LocalChatConsentRequest;
	resolve: (decision: LocalChatConsentDecision) => void;
	timer: NodeJS.Timeout;
}

function decision(value: unknown): LocalChatConsentDecision {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Local chat consent decision must be an object");
	}
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !== 2 ||
		typeof input.requestId !== "string" ||
		(input.decision !== "allow" && input.decision !== "deny" && input.decision !== "unavailable")
	) {
		throw new TypeError("Local chat consent decision is invalid");
	}
	return { requestId: input.requestId, decision: input.decision };
}

export class DesktopLocalChatConsentPresenter implements LocalChatConsentPresenter {
	readonly #window: () => BrowserWindow | undefined;
	readonly #pending = new Map<string, PendingConsentPresentation>();

	constructor(window: () => BrowserWindow | undefined) {
		this.#window = window;
	}

	present(request: LocalChatConsentRequest): Promise<LocalChatConsentDecision> {
		const window = this.#window();
		if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
			return Promise.resolve({ requestId: request.requestId, decision: "unavailable" });
		}
		const result = Promise.withResolvers<LocalChatConsentDecision>();
		const timer = setTimeout(
			() => this.#resolve(request.requestId, { requestId: request.requestId, decision: "unavailable" }),
			Math.max(0, request.expiresAt - Date.now()),
		);
		this.#pending.set(request.requestId, { request, resolve: result.resolve, timer });
		try {
			if (window.isMinimized()) window.restore();
			window.show();
			window.focus();
			window.webContents.send("gradivus:local-chat-consent-request", request);
		} catch {
			this.#resolve(request.requestId, { requestId: request.requestId, decision: "unavailable" });
		}
		return result.promise;
	}

	respond(value: unknown): boolean {
		const response = decision(value);
		const pending = this.#pending.get(response.requestId);
		if (!pending || pending.request.expiresAt <= Date.now()) return false;
		this.#resolve(response.requestId, response);
		return true;
	}

	cancelAll(): void {
		for (const pending of [...this.#pending.values()]) {
			this.#resolve(pending.request.requestId, {
				requestId: pending.request.requestId,
				decision: "unavailable",
			});
		}
	}

	#resolve(requestId: string, response: LocalChatConsentDecision): void {
		const pending = this.#pending.get(requestId);
		if (!pending) return;
		this.#pending.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve(response);
	}
}
