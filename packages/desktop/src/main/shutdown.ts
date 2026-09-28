export interface DesktopShutdownContext {
	localChatServer?: { stop(): Promise<void> };
	host?: { stopAll(): Promise<void>; close(): Promise<void> };
	workspace?: { stop(): Promise<void> };
	runtimeClient?: { close(): Promise<void> };
	quit?: () => void;
}
export async function shutdownDesktopServices(context: DesktopShutdownContext): Promise<void> {
	try {
		if (context.localChatServer) await context.localChatServer.stop().catch(() => {});
		if (context.host) await context.host.stopAll().catch(() => {});
		if (context.workspace) await context.workspace.stop().catch(() => {});
	} finally {
		try {
			if (context.runtimeClient) await context.runtimeClient.close().catch(() => {});
		} finally {
			try {
				if (context.host) await context.host.close().catch(() => {});
			} finally {
				context.quit?.();
			}
		}
	}
}
