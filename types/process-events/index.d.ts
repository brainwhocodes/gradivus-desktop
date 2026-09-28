declare global {
	namespace NodeJS {
		interface Process {
			off(event: Signals, listener: SignalsListener): this;
			off(event: "exit", listener: ExitListener): this;
			off(event: "message", listener: MessageListener): this;
			off(event: "unhandledRejection", listener: UnhandledRejectionListener): this;
			off(event: "uncaughtException", listener: UncaughtExceptionListener): this;
			removeListener(event: Signals, listener: SignalsListener): this;
			removeListener(event: "exit", listener: ExitListener): this;
			removeListener(event: "message", listener: MessageListener): this;
			removeListener(event: "unhandledRejection", listener: UnhandledRejectionListener): this;
			removeListener(event: "uncaughtException", listener: UncaughtExceptionListener): this;
		}
	}
}

export {};
