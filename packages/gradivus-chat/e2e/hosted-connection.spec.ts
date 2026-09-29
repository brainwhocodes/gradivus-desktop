import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { DesktopServiceFixture } from "./desktop-service-fixture";

const desktop = new DesktopServiceFixture();
test.beforeAll(async () => desktop.start());
test.afterAll(async () => desktop.close());
test.beforeEach(() => desktop.reset());

function observeBrowser(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (
			message.type() === "error" &&
			!(
				message.location().url.startsWith("http://127.0.0.1:47832/") &&
				/Failed to load resource.*(401|503)/.test(message.text())
			)
		)
			errors.push(message.text());
	});
	page.on("requestfailed", (request) => {
		if (request.url().startsWith("http://127.0.0.1:5190"))
			errors.push(
				`${request.method()} ${request.url()} ${request.failure()?.errorText}`,
			);
	});
	page.on("response", (response) => {
		if (
			response.url().startsWith("http://127.0.0.1:5190/") &&
			response.status() >= 400
		)
			errors.push(`${response.status()} ${response.url()}`);
	});
	return errors;
}

async function approveConnection(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Connect to Desktop" }).click();
	await expect(
		page.getByRole("heading", { name: "Approve in Desktop" }),
	).toBeVisible();
	await expect.poll(() => desktop.authorizations.length).toBe(1);
	desktop.resolveApproval(true);
	await expect(
		page.getByRole("heading", { name: "Desktop chat", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Connected to Desktop", { exact: true }),
	).toBeVisible();
}

test("connects with PKCE, chats through Desktop, requests optional native scope, and revokes on disconnect", async ({
	page,
}, testInfo) => {
	const errors = observeBrowser(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "Your Desktop. In this browser." }),
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("hosted-connect-desktop.png"),
	});
	const connect = page.getByRole("button", { name: "Connect to Desktop" });
	await connect.focus();
	await expect(connect).toBeFocused();
	await connect.press("Enter");
	await expect(
		page.getByRole("heading", { name: "Approve in Desktop" }),
	).toBeVisible();
	await expect.poll(() => desktop.authorizations.length).toBe(1);
	expect(
		desktop.authorizations[0]?.url.searchParams.get("scope"),
	).not.toContain("desktop.present");
	desktop.resolveApproval(true);
	await expect(
		page.getByRole("heading", { name: "Desktop chat", exact: true }),
	).toBeVisible();
	const composer = page.getByRole("combobox", { name: "Message OMP" });
	await composer.fill("Check the project on Desktop");
	await page.getByRole("button", { name: "Send message", exact: true }).click();
	await expect(
		page.getByText("Desktop handled: Check the project on Desktop", {
			exact: true,
		}),
	).toBeVisible();
	expect(desktop.prompts).toEqual(["Check the project on Desktop"]);
	await page.screenshot({
		path: testInfo.outputPath("hosted-connected-desktop.png"),
	});
	await page.getByRole("button", { name: "Accounts", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Managed by Desktop" }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Manage accounts in Desktop" })
		.click();
	await expect(
		page.getByText("Allow Desktop actions", { exact: true }),
	).toBeVisible();
	await expect.poll(() => desktop.authorizations.length).toBe(1);
	expect(desktop.authorizations[0]?.url.searchParams.get("scope")).toContain(
		"desktop.present",
	);
	desktop.resolveApproval(false);
	await expect(
		page.getByRole("button", { name: "Dismiss", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Dismiss", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Dismiss", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByText("Connected to Desktop", { exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Manage accounts in Desktop" })
		.click();
	await expect.poll(() => desktop.authorizations.length).toBe(1);
	desktop.resolveApproval(true);
	await expect(
		page.getByText("Continue in Gradivus Desktop → Accounts.", { exact: true }),
	).toBeVisible();
	expect(desktop.commands).toContain("openDesktopAccounts");
	await page
		.getByRole("button", { name: "Back to workspace", exact: true })
		.click();
	await page.getByRole("button", { name: "Disconnect", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Connect to Desktop" }),
	).toBeEnabled();
	expect(desktop.revocations).toBe(1);
	expect(
		await page.evaluate(() => ({
			local: localStorage.length,
			session: sessionStorage.length,
		})),
	).toEqual({ local: 0, session: 0 });
	expect(errors).toEqual([]);
});

test("denial and cancellation leave no connected shell, and approval can be retried", async ({
	page,
}) => {
	const errors = observeBrowser(page);
	await page.goto("/");
	await page.getByRole("button", { name: "Connect to Desktop" }).click();
	await expect.poll(() => desktop.authorizations.length).toBe(1);
	desktop.resolveApproval(false);
	await expect(page.getByRole("alert")).toHaveText(
		"Access was not approved in Desktop.",
	);
	expect(desktop.commands).toEqual([]);
	await page.getByRole("button", { name: "Connect to Desktop" }).click();
	await expect.poll(() => desktop.authorizations.length).toBe(1);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Connect to Desktop" }),
	).toBeEnabled();
	await expect(
		page.getByText("Connected to Desktop", { exact: true }),
	).toHaveCount(0);
	desktop.resolveApproval(false);
	await approveConnection(page);
	expect(errors).toEqual([]);
});

test("reconnect preserves the draft, recovers from snapshot failure, and reauthorizes a revoked grant", async ({
	page,
}) => {
	const errors = observeBrowser(page);
	await page.goto("/");
	await approveConnection(page);
	const composer = page.getByRole("combobox", { name: "Message OMP" });
	await composer.fill("Keep this unsent draft");
	desktop.interrupt();
	await expect(
		page.getByText("Connection paused", { exact: true }),
	).toBeVisible();
	desktop.failBootstrap = true;
	await page.getByRole("button", { name: "Reconnect", exact: true }).click();
	await expect(
		page.getByText("Desktop is restarting.", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Desktop disconnected", { exact: true }),
	).toBeVisible();
	desktop.failBootstrap = false;
	await page.getByRole("button", { name: "Reconnect", exact: true }).click();
	await expect(
		page.getByText("Connected to Desktop", { exact: true }),
	).toBeVisible();
	await expect(composer).toHaveValue("Keep this unsent draft");
	desktop.revoke();
	await page.getByRole("button", { name: "Reconnect", exact: true }).click();
	await expect(
		page.getByText("This connection was revoked in Desktop.", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Reconnect", exact: true }).click();
	await expect.poll(() => desktop.authorizations.length).toBe(1);
	desktop.resolveApproval(true);
	await expect(
		page.getByText("Connected to Desktop", { exact: true }),
	).toBeVisible();
	await expect(composer).toHaveValue("Keep this unsent draft");
	expect(desktop.prompts).toEqual([]);
	expect(errors).toEqual([]);
});

test("narrow browser connection stays within the viewport and exposes accessible chat navigation", async ({
	page,
}, testInfo) => {
	const errors = observeBrowser(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await expect(
		page.getByText(
			"Open Gradivus Desktop before connecting. Browser and Desktop must be on the same computer.",
		),
	).toBeVisible();
	const accessibility = await new AxeBuilder({ page }).analyze();
	expect(
		accessibility.violations.filter(
			(violation) =>
				violation.impact === "serious" || violation.impact === "critical",
		),
	).toEqual([]);
	await page.screenshot({
		path: testInfo.outputPath("hosted-connect-narrow.png"),
		fullPage: true,
	});
	await approveConnection(page);
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	const drawer = page.getByRole("dialog", { name: "Chats", exact: true });
	await expect(drawer).toBeVisible();
	await drawer.getByRole("button", { name: /^Desktop chat/ }).click();
	await expect(drawer).toHaveCount(0);
	await expect(
		page.getByRole("combobox", { name: "Message OMP" }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	await page.screenshot({
		path: testInfo.outputPath("hosted-connected-narrow.png"),
	});
	expect(errors).toEqual([]);
});

test("Desktop unavailability and protocol mismatch recover without granting access", async ({
	page,
}) => {
	await page.goto("/");
	desktop.unavailable = true;
	await page.getByRole("button", { name: "Connect to Desktop" }).click();
	await expect(
		page.getByRole("heading", { name: "Desktop is unavailable" }),
	).toBeVisible();
	desktop.unavailable = false;
	desktop.versionMismatch = true;
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByRole("heading", { name: "Desktop needs an update" }),
	).toBeVisible();
	desktop.versionMismatch = false;
	await page.getByRole("button", { name: "Check again" }).click();
	await expect(
		page.getByRole("heading", { name: "Approve in Desktop" }),
	).toBeVisible();
	await expect.poll(() => desktop.authorizations.length).toBe(1);
	desktop.resolveApproval(false);
	expect(desktop.commands).toEqual([]);
});

test("a callback without its original tab exposes no code and safely asks for a new connection", async ({
	page,
}) => {
	await page.goto(`/auth/callback?state=${"a".repeat(43)}&code=unclaimed-code`);
	await expect(page.getByRole("status")).toContainText("no waiting tab");
	await expect(page).toHaveURL("http://127.0.0.1:5190/auth/callback");
	await expect(page.getByText("unclaimed-code")).toHaveCount(0);
	expect(desktop.commands).toEqual([]);
});

test("expired access pauses chat until approval, and reloading forgets authorization", async ({
	page,
}) => {
	const errors = observeBrowser(page);
	desktop.tokenLifetimeSeconds = 1;
	await page.goto("/");
	await approveConnection(page);
	const composer = page.getByRole("combobox", { name: "Message OMP" });
	await composer.fill("Keep my draft through expiry");
	await expect(
		page.getByText(
			"Your connection expired. Approve access in Desktop to continue.",
			{ exact: true },
		),
	).toBeVisible();
	desktop.tokenLifetimeSeconds = 3600;
	await page.getByRole("button", { name: "Reconnect", exact: true }).click();
	await expect.poll(() => desktop.authorizations.length).toBe(1);
	desktop.resolveApproval(true);
	await expect(
		page.getByText("Connected to Desktop", { exact: true }),
	).toBeVisible();
	await expect(composer).toHaveValue("Keep my draft through expiry");
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Connect to Desktop" }),
	).toBeVisible();
	await expect(
		page.getByText("Connected to Desktop", { exact: true }),
	).toHaveCount(0);
	expect(
		await page.evaluate(() => ({
			local: localStorage.length,
			session: sessionStorage.length,
		})),
	).toEqual({ local: 0, session: 0 });
	expect(errors).toEqual([]);
});
