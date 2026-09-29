import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const fixturePath = "/e2e/workspace-fixture.html";

function collectErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("pageerror", (error) => errors.push(error.message));
	return errors;
}

test("uses nested lists, native session buttons, and object-specific deletion", async ({
	page,
}) => {
	const errors = collectErrors(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(fixturePath);

	await expect(
		page.getByRole("heading", { name: "Running chat" }),
	).toBeVisible();
	const workspaceList = page.getByRole("list", {
		name: "Workspaces and chats",
	});
	await expect(workspaceList).toBeVisible();
	const chatList = page.getByRole("list", { name: "fixture-workspace chats" });
	await expect(chatList.getByRole("listitem")).toHaveCount(2);
	const runningChat = chatList.getByRole("button", { name: /^Running chat/ });
	await expect(runningChat).toHaveAttribute("aria-current", "page");
	await expect(runningChat).toContainText("Running");

	await page
		.getByRole("button", { name: "Collapse workspace fixture-workspace" })
		.click();
	await expect(chatList).toHaveCount(0);
	await page
		.getByRole("button", { name: "Expand workspace fixture-workspace" })
		.press("Enter");
	await expect(
		page.getByRole("list", { name: "fixture-workspace chats" }),
	).toBeVisible();

	const deleteButton = page.getByRole("button", {
		name: "Delete chat Running chat",
	});
	await deleteButton.focus();
	await deleteButton.click();
	const dialog = page.getByRole("dialog", {
		name: "Delete “Running chat” from Gradivus?",
	});
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(
		"The Gradivus chat entry will be removed. The OMP transcript file remains on this computer.",
	);
	await expect(page.getByRole("button", { name: "Keep chat" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(deleteButton).toBeFocused();
	await expect(errors).toEqual([]);
});

test("traps focus in the mobile chats drawer and inspector sheet", async ({
	page,
}) => {
	const errors = collectErrors(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(fixturePath);

	const chatsButton = page.getByRole("button", { name: "Chats", exact: true });
	await expect(chatsButton).toBeVisible();
	await chatsButton.click();
	const drawer = page.getByRole("dialog", { name: "Chats" });
	await expect(drawer).toBeVisible();
	await expect(page.locator(".settings-workspace-source")).toHaveAttribute(
		"inert",
		"",
	);
	await expect(page.locator("#mobile-chat-drawer-close")).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	expect(
		await drawer.evaluate((element) =>
			element.contains(document.activeElement),
		),
	).toBe(true);

	await drawer.getByRole("button", { name: /^Review chat/ }).click();
	await expect(drawer).toHaveCount(0);
	await expect(chatsButton).toBeFocused();

	const agentsButton = page.getByRole("button", { name: /^Open Agent Hub/ });
	await agentsButton.click();
	const inspector = page.getByRole("dialog", { name: "Agent Hub inspector" });
	await expect(inspector).toBeVisible();
	const backToChat = inspector.getByRole("button", { name: "Back to chat" });
	await expect(backToChat).toBeFocused();
	await page.keyboard.press("Tab");
	expect(
		await inspector.evaluate((element) =>
			element.contains(document.activeElement),
		),
	).toBe(true);
	await page.keyboard.press("Escape");
	await expect(inspector).toHaveCount(0);
	await expect(agentsButton).toBeFocused();
	await expect(errors).toEqual([]);
});

test("keeps the 320px page free of horizontal overflow", async ({ page }) => {
	await page.setViewportSize({ width: 320, height: 568 });
	await page.goto(fixturePath);
	await expect(
		page.getByRole("button", { name: "Chats", exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
		320,
	);
});

test("finds chats without losing the current conversation or collapsed workspace state", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(fixturePath);
	await page
		.getByRole("button", { name: "Collapse workspace fixture-workspace" })
		.click();
	const search = page.getByRole("searchbox", { name: "Search chats" });
	await search.fill("REVIEW");
	const chatList = page.getByRole("list", { name: "fixture-workspace chats" });
	await expect(
		chatList.getByRole("button", { name: /^Review chat/ }),
	).toBeVisible();
	await expect(
		chatList.getByRole("button", { name: /^Running chat/ }),
	).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Running chat" }),
	).toBeVisible();
	await search.fill("no matching conversation");
	await expect(
		page.getByRole("status").filter({ hasText: "No matching chats" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Clear search" }).click();
	await expect(search).toHaveValue("");
	await expect(search).toBeFocused();
	await expect(
		page.getByRole("button", { name: "Expand workspace fixture-workspace" }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Expand workspace fixture-workspace" })
		.click();
	await expect(chatList.getByRole("listitem")).toHaveCount(2);
});
