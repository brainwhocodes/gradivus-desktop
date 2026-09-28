import type { DesktopActionEvent, HostedSessionKind } from "@gradivus/chat/contracts";
import type { SessionRecordV1 } from "../shared/contracts";
import type { DesktopHost } from "./desktop-host";
import type { HostedNativeCommandActions } from "./hosted-command-dispatcher";
import type { HostedEventSequencer } from "./hosted-event-sequencer";
import type { HostedProjection } from "./hosted-projection";

export class HostedNativeActionBridge implements HostedNativeCommandActions {
	readonly #host: DesktopHost;
	readonly #events: HostedEventSequencer;
	readonly #projection: HostedProjection;
	readonly #confirmOpenFile: (record: SessionRecordV1, target: string) => Promise<boolean>;
	readonly #reconnectRuntime: () => Promise<void>;
	readonly #openDesktopAccounts: () => Promise<void>;

	constructor(options: {
		host: DesktopHost;
		events: HostedEventSequencer;
		projection: HostedProjection;
		confirmOpenFile: (record: SessionRecordV1, target: string) => Promise<boolean>;
		reconnectRuntime: () => Promise<void>;
		openDesktopAccounts: () => Promise<void>;
	}) {
		this.#host = options.host;
		this.#events = options.events;
		this.#projection = options.projection;
		this.#confirmOpenFile = options.confirmOpenFile;
		this.#reconnectRuntime = options.reconnectRuntime;
		this.#openDesktopAccounts = options.openDesktopAccounts;
	}

	async chooseWorkspaceAndCreate(grantId: string, kind: HostedSessionKind) {
		const action = this.#pending(grantId, "choose_workspace");
		try {
			const snapshot = await this.#host.chooseAndCreate(kind);
			const completed = this.#finish(grantId, action, snapshot ? "completed" : "cancelled");
			return snapshot ? { action: completed, snapshot } : { action: completed };
		} catch {
			return { action: this.#finish(grantId, action, "failed") };
		}
	}

	async exportHtml(grantId: string, sessionId: string) {
		const action = this.#pending(grantId, "save_export");
		try {
			const result = await this.#host.exportHtml(sessionId, undefined);
			return {
				action: this.#finish(grantId, action, result.cancelled ? "cancelled" : "completed"),
				cancelled: result.cancelled,
			};
		} catch {
			return { action: this.#finish(grantId, action, "failed"), cancelled: false };
		}
	}

	async openWorkspaceFile(grantId: string, sessionId: string, target: string): Promise<DesktopActionEvent> {
		const action = this.#pending(grantId, "open_file");
		try {
			const { record } = this.#host.resolveHostedChatSessionAuthority(sessionId);
			if (!(await this.#confirmOpenFile(record, target))) return this.#finish(grantId, action, "cancelled");
			await this.#host.openWorkspaceFile(record.id, target);
			return this.#finish(grantId, action, "completed");
		} catch {
			return this.#finish(grantId, action, "failed");
		}
	}

	async reconnectRuntime(grantId: string) {
		const action = this.#pending(grantId, "open_accounts");
		try {
			await this.#reconnectRuntime();
			return { action: this.#finish(grantId, action, "completed"), snapshot: this.#host.bootstrap() };
		} catch {
			return { action: this.#finish(grantId, action, "failed") };
		}
	}

	async openDesktopAccounts(grantId: string): Promise<DesktopActionEvent> {
		const action = this.#pending(grantId, "open_accounts");
		try {
			await this.#openDesktopAccounts();
			return this.#finish(grantId, action, "completed");
		} catch {
			return this.#finish(grantId, action, "failed");
		}
	}

	#pending(grantId: string, kind: DesktopActionEvent["kind"]): DesktopActionEvent {
		const action = { actionId: crypto.randomUUID(), kind, state: "pending" } as const;
		this.#publish(grantId, action);
		return action;
	}

	#finish(
		grantId: string,
		action: DesktopActionEvent,
		state: Exclude<DesktopActionEvent["state"], "pending">,
	): DesktopActionEvent {
		const completed = { actionId: action.actionId, kind: action.kind, state };
		this.#publish(grantId, completed);
		return completed;
	}

	#publish(grantId: string, action: DesktopActionEvent): void {
		this.#events.publishDesktopAction(grantId, this.#projection.projectHostedDesktopAction(action));
	}
}
