import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { compare, type ODiffOptions } from "odiff-bin";

export interface VisualDiffResult {
	match: boolean;
	diffPercentage: number;
	diffCount: number;
	reason?: string;
	diffDataUrl?: string;
	baselineDataUrl?: string;
	actualDataUrl?: string;
}

export interface VisualDiffOptions extends ODiffOptions {
	/** Matching color threshold from 0 (strict) to 1 (permissive). Defaults to 0.1. */
	threshold?: number;
	/** Color in hex format (#ff00ff) used to highlight different pixels. */
	diffColor?: string;
	/** Whether to ignore anti-aliasing pixels. Defaults to true. */
	antialiasing?: boolean;
}

function parseBase64Buffer(dataUrlOrBase64: string): Buffer {
	const commaIdx = dataUrlOrBase64.indexOf(",");
	const rawBase64 = commaIdx >= 0 ? dataUrlOrBase64.slice(commaIdx + 1) : dataUrlOrBase64;
	return Buffer.from(rawBase64, "base64");
}

export async function compareImages(
	baselinePath: string,
	actualPath: string,
	diffOutputPath: string,
	options: VisualDiffOptions = {},
): Promise<VisualDiffResult> {
	const defaultOptions: ODiffOptions = {
		outputDiffMask: true,
		threshold: options.threshold ?? 0.1,
		diffColor: options.diffColor ?? "#ff00ff",
		antialiasing: options.antialiasing ?? true,
	};

	try {
		const res = await compare(baselinePath, actualPath, diffOutputPath, defaultOptions);
		if (res.match) {
			return {
				match: true,
				diffPercentage: 0,
				diffCount: 0,
			};
		}
		return {
			match: false,
			diffPercentage: "diffPercentage" in res ? (res.diffPercentage ?? 0) : 0,
			diffCount: "diffCount" in res ? (res.diffCount ?? 0) : 0,
			reason: res.reason,
		};
	} catch (error) {
		return {
			match: false,
			diffPercentage: 100,
			diffCount: -1,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function diffElementSnapshots(
	baselineDataUrl: string,
	actualDataUrl: string,
	options: VisualDiffOptions = {},
): Promise<VisualDiffResult> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "odiff-element-"));
	const baselinePath = path.join(tempDir, "baseline.png");
	const actualPath = path.join(tempDir, "actual.png");
	const diffPath = path.join(tempDir, "diff.png");

	try {
		await fs.writeFile(baselinePath, parseBase64Buffer(baselineDataUrl));
		await fs.writeFile(actualPath, parseBase64Buffer(actualDataUrl));

		const result = await compareImages(baselinePath, actualPath, diffPath, options);

		let diffDataUrl: string | undefined;
		try {
			const diffBuffer = await fs.readFile(diffPath);
			diffDataUrl = `data:image/png;base64,${diffBuffer.toString("base64")}`;
		} catch {}

		return {
			...result,
			baselineDataUrl,
			actualDataUrl,
			diffDataUrl,
		};
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}
