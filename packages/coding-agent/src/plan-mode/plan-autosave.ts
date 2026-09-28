import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectAgentDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

import { expandTilde } from "../tools/path-utils";
import { cfgPlanAutosave, cfgPlanAutosaveDir } from "./settings";
import { planSaveFileName } from "./plan-save";

const MAX_AUTOSAVE_CANDIDATES = 1000;

/** Default autosave location: `<project>/.omp/plans/`. */
export function defaultPlanAutosaveDir(cwd: string): string {
	return path.join(getProjectAgentDir(cwd), "plans");
}

/** Resolve the autosave directory: `plan.autosaveDir` (`~`/absolute/cwd-relative)
 *  or the project-local default when unset/blank. */
export function resolvePlanAutosaveDir(settings: Settings, cwd: string): string {
	const raw = cfgPlanAutosaveDir.get(settings);
	if (typeof raw !== "string" || raw.trim() === "") return defaultPlanAutosaveDir(cwd);
	const expanded = expandTilde(raw.trim());
	if (path.isAbsolute(expanded)) return path.normalize(expanded);
	return path.resolve(cwd, expanded);
}

export function isPlanAutosaveEnabled(settings: Settings): boolean {
	try {
		return cfgPlanAutosave.get(settings) === true;
	} catch {
		return false;
	}
}

function autosaveCandidate(dir: string, filename: string, index: number): string {
	if (index === 0) return path.join(dir, filename);
	const ext = path.extname(filename);
	const stem = filename.slice(0, filename.length - ext.length);
	return path.join(dir, `${stem}-${index}${ext}`);
}

/** Claim the first free `<dir>/<filename>` with an exclusive create, so two
 *  sessions approving same-titled plans at once can't settle on the same
 *  candidate (`<stem>-<n><ext>` on collision). `wx` (O_CREAT|O_EXCL) makes the
 *  check-and-claim a single syscall; EEXIST advances to the next candidate. */
async function claimAutosavePath(dir: string, filename: string, planContent: string): Promise<string> {
	for (let index = 0; index < MAX_AUTOSAVE_CANDIDATES; index += 1) {
		const candidate = autosaveCandidate(dir, filename, index);
		try {
			await fs.writeFile(candidate, planContent, { flag: "wx" });
			return candidate;
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
		}
	}
	const fallback = path.join(dir, `${Date.now()}-${filename}`);
	await fs.writeFile(fallback, planContent, { flag: "wx" });
	return fallback;
}

/** Best-effort copy of an approved plan into the autosave dir.
 *  Returns the destination path, or null when autosave is disabled/empty. */
export async function autosaveApprovedPlan(input: {
	settings: Settings;
	cwd: string;
	title: string;
	planContent: string;
}): Promise<string | null> {
	if (!isPlanAutosaveEnabled(input.settings)) return null;
	if (input.planContent.trim() === "") return null;
	const dir = resolvePlanAutosaveDir(input.settings, input.cwd);
	// fs.writeFile (unlike Bun.write) leaves parent creation to us; one mkdir
	// up front covers every candidate the claim loop below may create.
	await fs.mkdir(dir, { recursive: true });
	return claimAutosavePath(dir, planSaveFileName(input.title), input.planContent);
}
