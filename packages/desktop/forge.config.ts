import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

const root = path.dirname(fileURLToPath(import.meta.url));
const backendName = process.platform === "win32" ? "omp.exe" : "omp";
const config: ForgeConfig = {
	packagerConfig: {
		name: "Gradivus",
		asar: {
			unpackDir: path.join(".vite", "native"),
		},
		prune: false,
		executableName: "Gradivus",
		appBundleId: "labs.gradivus.desktop",
		win32metadata: {
			CompanyName: "Gradivus",
			FileDescription: "Gradivus desktop workspace powered by Oh My Pi",
			ProductName: "Gradivus",
			OriginalFilename: "Gradivus.exe",
		},
		icon: path.join(root, "resources", "icon"),
		extraResource: [
			path.join(root, "..", "coding-agent", "dist", backendName),
			path.join(root, "THIRD_PARTY_LICENSES.txt"),
			path.join(root, "resources", "rpc-config.yml"),
		],
		ignore: [/\\test\\/, /\\scripts\\check-styles\.ts$/, /[\\/]node_modules[\\/]/],
	},
	rebuildConfig: {},
	makers: [
		new MakerSquirrel({
			name: "Gradivus",
			authors: "Gradivus",
			description: "Gradivus desktop workspace powered by Oh My Pi",
			setupExe: "GradivusSetup.exe",
			setupIcon: path.join(root, "resources", "icon.ico"),
			noMsi: true,
		}),
	],
	plugins: [
		new VitePlugin({
			build: [
				{ entry: "src/main/main.ts", config: "vite.main.config.ts" },
				{ entry: "src/main/preload.ts", config: "vite.preload.config.ts" },
			],
			renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
		}),
		new FusesPlugin({
			version: FuseVersion.V1,
			[FuseV1Options.RunAsNode]: false,
			[FuseV1Options.EnableCookieEncryption]: true,
			[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
			[FuseV1Options.EnableNodeCliInspectArguments]: false,
			[FuseV1Options.OnlyLoadAppFromAsar]: true,
			[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
		}),
	],
};

export default config;
