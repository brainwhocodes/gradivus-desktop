import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { compareImages, diffElementSnapshots } from "../src/main/visual-diff";

// 1x1 base64 PNGs for testing
const RED_PNG_BASE64 =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const BLUE_PNG_BASE64 =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==";

describe("odiff Visual Regression Engine", () => {
	it("identifies identical images with zero pixel difference", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "odiff-test-identical-"));
		const img1 = path.join(tempDir, "base.png");
		const img2 = path.join(tempDir, "actual.png");
		const diff = path.join(tempDir, "diff.png");

		try {
			const buf = Buffer.from(RED_PNG_BASE64.split(",")[1], "base64");
			await fs.writeFile(img1, buf);
			await fs.writeFile(img2, buf);

			const result = await compareImages(img1, img2, diff, { threshold: 0.1 });
			expect(result.match).toBe(true);
			expect(result.diffPercentage).toBe(0);
			expect(result.diffCount).toBe(0);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("detects pixel differences and generates a difference mask", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "odiff-test-diff-"));
		const img1 = path.join(tempDir, "base.png");
		const img2 = path.join(tempDir, "actual.png");
		const diff = path.join(tempDir, "diff.png");

		try {
			const buf1 = Buffer.from(RED_PNG_BASE64.split(",")[1], "base64");
			const buf2 = Buffer.from(BLUE_PNG_BASE64.split(",")[1], "base64");
			await fs.writeFile(img1, buf1);
			await fs.writeFile(img2, buf2);

			const result = await compareImages(img1, img2, diff, {
				threshold: 0.1,
				diffColor: "#ff00ff",
			});
			expect(result.match).toBe(false);
			expect(result.diffPercentage).toBe(100);
			expect(result.diffCount).toBeGreaterThan(0);

			const diffStat = await fs.stat(diff);
			expect(diffStat.size).toBeGreaterThan(0);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("diffElementSnapshots accepts data URLs and returns diff image data URL", async () => {
		const result = await diffElementSnapshots(RED_PNG_BASE64, BLUE_PNG_BASE64, {
			threshold: 0.1,
			diffColor: "#ff00ff",
		});

		expect(result.match).toBe(false);
		expect(result.diffPercentage).toBe(100);
		expect(result.diffCount).toBe(1);
		expect(result.baselineDataUrl).toBe(RED_PNG_BASE64);
		expect(result.actualDataUrl).toBe(BLUE_PNG_BASE64);
		expect(result.diffDataUrl).toMatch(/^data:image\/png;base64,/);
	});

	it("diffElementSnapshots returns match: true for matching data URLs", async () => {
		const result = await diffElementSnapshots(RED_PNG_BASE64, RED_PNG_BASE64);

		expect(result.match).toBe(true);
		expect(result.diffPercentage).toBe(0);
		expect(result.diffCount).toBe(0);
	});
});
