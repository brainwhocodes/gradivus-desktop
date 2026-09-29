import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type {} from "./workspace-fixture-data";

const fixturePath = "/e2e/workspace-fixture.html";

function collectErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("requestfailed", (request) => {
		if (request.url().startsWith("http://127.0.0.1:"))
			errors.push(
				`${request.method()} ${request.url()}: ${request.failure()?.errorText}`,
			);
	});
	return errors;
}

async function openSettings(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Settings", exact: true }),
	).toBeVisible();
}

test("updates scoped settings, persists the change across navigation, and searches without losing scope", async ({
	page,
}, testInfo) => {
	const errors = collectErrors(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(fixturePath);
	await openSettings(page);
	await page
		.getByRole("navigation", { name: "Settings categories" })
		.getByRole("button", { name: "Tools", exact: true })
		.click();
	const toggle = page.getByRole("checkbox", { name: /^Generate Image/ });
	await expect(toggle).toBeChecked();
	await toggle.uncheck();
	await expect(toggle).not.toBeChecked();
	await page
		.getByRole("button", { name: "Image Question Timeout", exact: true })
		.click();
	await page.getByRole("option", { name: "1 minute", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Image Question Timeout", exact: true }),
	).toContainText("1 minute");
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(toggle).not.toBeChecked();
	const search = page.getByRole("searchbox", { name: "Search settings" });
	await search.fill("Default Read Limit");
	await expect(
		page.getByRole("heading", { name: "Files", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Default Read Limit", exact: true }),
	).toBeVisible();
	await search.fill("nothing matches this setting");
	await expect(page.getByText(/No settings match/)).toBeVisible();
	await page.getByRole("button", { name: "Clear search", exact: true }).click();
	await expect(search).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath("settings-desktop.png") });
	const accessibility = await new AxeBuilder({ page })
		.include(".settings-shell")
		.analyze();
	expect(accessibility.violations).toEqual([]);
	expect(errors).toEqual([]);
});

test("keeps prompt edits when navigation is cancelled and saves an override for the next spawn", async ({
	page,
}) => {
	const errors = collectErrors(page);
	await page.goto(fixturePath);
	await openSettings(page);
	await page
		.getByRole("navigation", { name: "Settings categories" })
		.getByRole("button", { name: "Agent prompts" })
		.click();
	const prompt = page.getByRole("textbox", {
		name: "System prompt",
		exact: true,
	});
	await expect(prompt).toHaveValue(/Reviewer/);
	await prompt.fill("Review reconnect behavior and preserve drafts.");
	await expect(
		page.getByText("Unsaved changes", { exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Back to workspace", exact: true })
		.click();
	const confirmation = page.getByRole("dialog", {
		name: "Discard unsaved subagent prompt?",
		exact: true,
	});
	await expect(confirmation).toBeVisible();
	await confirmation
		.getByRole("button", { name: "Keep editing", exact: true })
		.click();
	await expect(prompt).toHaveValue(
		"Review reconnect behavior and preserve drafts.",
	);
	await page.getByRole("button", { name: "Save prompt", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Save prompt", exact: true }),
	).toBeDisabled();
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(prompt).toHaveValue(
		"Review reconnect behavior and preserve drafts.",
	);
	expect(errors).toEqual([]);
});

test("sends a follow-up to a retained agent and keeps advisor controls read only", async ({
	page,
}, testInfo) => {
	const errors = collectErrors(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(fixturePath);
	await page.getByRole("button", { name: /^Open Agent Hub/ }).click();
	await page
		.getByRole("button", { name: "Reviewer, parked", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: "Reviewer", exact: true });
	await expect(dialog).toBeInViewport();
	expect((await dialog.boundingBox())?.width).toBeGreaterThan(400);
	await expect(dialog.getByRole("log")).toContainText(
		"The draft survives reconnects",
	);
	await dialog
		.getByRole("textbox", { name: "Message Reviewer", exact: true })
		.fill("Check keyboard focus after recovery.");
	await dialog
		.getByRole("button", { name: "Send message", exact: true })
		.click();
	await expect(dialog.getByRole("log")).toContainText(
		"Check keyboard focus after recovery.",
	);
	await expect(
		dialog.getByRole("textbox", { name: "Message Reviewer", exact: true }),
	).toHaveValue("");
	await dialog
		.getByRole("button", { name: "Show details", exact: true })
		.click();
	await expect(
		dialog.getByRole("button", { name: "Kill agent", exact: true }),
	).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("agent-hub-desktop.png") });
	await dialog
		.getByRole("button", { name: "Close Agent Hub session", exact: true })
		.click();
	await page
		.getByRole("button", {
			name: "Architecture advisor, idle, read only",
			exact: true,
		})
		.click();
	const advisor = page.getByRole("dialog", {
		name: "Architecture advisor",
		exact: true,
	});
	await expect(
		advisor.getByRole("button", { name: "Send message", exact: true }),
	).toHaveCount(0);
	await advisor
		.getByRole("button", { name: "Show details", exact: true })
		.click();
	await expect(advisor.getByText(/This advisor is read only/)).toBeVisible();
	await expect(
		advisor.getByRole("button", { name: "Kill agent", exact: true }),
	).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("reviews changed files and images in the narrow inspector without horizontal overflow", async ({
	page,
}, testInfo) => {
	const errors = collectErrors(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(fixturePath);
	await page.getByRole("button", { name: /^Open Files/ }).click();
	const tree = page.getByRole("tree", { name: "Files and artifacts" });
	await expect(tree).toBeVisible();
	await tree.getByRole("treeitem", { name: /preview.png/ }).click();
	await expect(
		page.getByRole("img", { name: "Preview of preview.png" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Review diff", exact: true })).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath("files-mobile.png") });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
		390,
	);
	await page.getByRole("button", { name: "All files", exact: true }).click();
	await expect(tree).toBeVisible();
	await tree.getByRole("treeitem", { name: /recovery.ts/ }).click();
	await page.getByRole("button", { name: "Review diff", exact: true }).click();
	await expect(
		page.getByRole("document", { name: "Patch for src/recovery.ts" }),
	).toContainText("keepDraft = true");
	await expect(
		page.getByText("Current working-tree changes for this file."),
	).toBeVisible();
	expect(errors).toEqual([]);
});

test("edits task content and displays reported session statistics", async ({
	page,
}, testInfo) => {
	const errors = collectErrors(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(fixturePath);
	await page.getByRole("button", { name: /^Expand session todos/ }).click();
	const task = page.getByRole("textbox", {
		name: "Task text for Keep attachment references",
		exact: true,
	});
	await task.fill("Keep attachment references through reconnect");
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Save changes", exact: true }),
	).toBeDisabled();
	await page.getByRole("button", { name: /^Collapse session todos/ }).click();
	await page.getByLabel("Session actions", { exact: true }).click();
	await page
		.getByRole("button", { name: "Session statistics", exact: true })
		.click();
	const stats = page.getByRole("dialog", {
		name: "Session statistics",
		exact: true,
	});
	await expect(stats).toContainText("84,260");
	await expect(stats).toContainText("$0.1842");
	await expect(
		stats.getByRole("progressbar", { name: "Context window used" }),
	).toHaveAttribute("value", "36200");
	await page.screenshot({ path: testInfo.outputPath("session-stats.png") });
	await stats.getByRole("button", { name: "Close", exact: true }).click();
	await expect(stats).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("saves plan feedback and starts approved execution with the selected model", async ({
	page,
}, testInfo) => {
	const errors = collectErrors(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(fixturePath);
	await expect(
		page.getByRole("heading", { name: "Running chat" }),
	).toBeVisible();
	await page.evaluate(() => window.workspaceFixture.showPlanReview());
	const dialog = page.getByRole("dialog", {
		name: "Improve connection recovery",
	});
	await expect(dialog).toBeVisible();
	await dialog
		.getByRole("textbox", { name: "Additional refinement feedback" })
		.fill("Include a keyboard-only reconnect check.");
	await dialog.getByRole("radio", { name: "fast Fast model" }).check();
	await expect(
		dialog.getByRole("button", { name: "Approve and execute", exact: true }),
	).toBeEnabled();
	await expect(
		dialog.getByRole("button", { name: "Refine plan", exact: true }),
	).toBeEnabled();
	await page.screenshot({ path: testInfo.outputPath("plan-review.png") });
	await dialog
		.getByRole("button", { name: "Approve and execute", exact: true })
		.click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByRole("heading", {
			name: "Execute connection recovery",
			exact: true,
		}),
	).toBeVisible();
	await openSettings(page);
	await page
		.getByRole("navigation", { name: "Settings categories" })
		.getByRole("button", { name: "Current chat", exact: true })
		.click();
	await expect(
		page.getByRole("button", {
			name: "Use Fast model from fixture",
			exact: true,
		}),
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", {
			name: "Use Balanced model from fixture",
			exact: true,
		}),
	).toHaveAttribute("aria-pressed", "false");
	expect(
		await page.evaluate(
			() =>
				window.workspaceFixture.readPlanReview().annotationState
					?.additionalFeedback,
		),
	).toBe("Include a keyboard-only reconnect check.");
	expect(errors).toEqual([]);
});

test("uses the light settings palette and a stacked form at mobile width", async ({
	page,
}, testInfo) => {
	const errors = collectErrors(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(fixturePath);
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	await openSettings(page);
	await page.getByRole("button", { name: "Theme", exact: true }).click();
	await page.getByRole("option", { name: "Light", exact: true }).click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	await page
		.getByRole("button", { name: "Settings category", exact: true })
		.click();
	await page.getByRole("option", { name: /Shell/ }).click();
	await expect(
		page.getByRole("textbox", { name: "Shell Path", exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
		390,
	);
	await page.screenshot({
		path: testInfo.outputPath("settings-mobile-light.png"),
	});
	const accessibility = await new AxeBuilder({ page })
		.include(".settings-shell")
		.analyze();
	expect(accessibility.violations).toEqual([]);
	expect(errors).toEqual([]);
});

test("preserves a draft through an external reset and reconnect registry refresh", async ({
	page,
}) => {
	const errors = collectErrors(page);
	await page.goto(fixturePath);
	const composer = page.getByRole("combobox", {
		name: "Message OMP",
		exact: true,
	});
	await composer.fill("Keep this unsent recovery note.");
	await page.evaluate(() => window.workspaceFixture.resetActiveSession());
	await expect(composer).toHaveValue("Keep this unsent recovery note.");
	await page.evaluate(() =>
		window.workspaceFixture.reconnectWithout("session-review"),
	);
	await expect(page.getByRole("button", { name: /^Review chat/ })).toHaveCount(
		0,
	);
	await expect(
		page.getByRole("heading", { name: "Running chat" }),
	).toBeVisible();
	await expect(composer).toHaveValue("Keep this unsent recovery note.");
	expect(errors).toEqual([]);
});

test("selects a surviving chat after reconnect and clears the active view when none remain", async ({
	page,
}) => {
	const errors = collectErrors(page);
	await page.goto(fixturePath);
	await expect(
		page.getByRole("heading", { name: "Running chat" }),
	).toBeVisible();
	await page.evaluate(() =>
		window.workspaceFixture.reconnectWithout("session-running"),
	);
	await expect(
		page.getByRole("heading", { name: "Review chat" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /^Running chat/ })).toHaveCount(
		0,
	);
	await page.evaluate(() => window.workspaceFixture.reconnectEmpty());
	await expect(page.getByRole("heading", { name: "Review chat" })).toHaveCount(
		0,
	);
	await expect(
		page.getByRole("heading", {
			name: "Make the next useful thing.",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Message OMP", exact: true }),
	).toHaveCount(0);
	expect(errors).toEqual([]);
});
