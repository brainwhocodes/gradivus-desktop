import * as fs from "node:fs";
import * as path from "node:path";
import { defineConfig, type Plugin } from "vite";

function rawTextPlugin(): Plugin {
	return {
		name: "raw-text-loader",
		enforce: "pre",
		load(id) {
			if (!id.endsWith(".md") && !id.endsWith(".txt") && !id.includes(".md?") && !id.includes(".txt?")) return;
			const filePath = id.split("?")[0]!;
			const code = fs.readFileSync(filePath, "utf8");
			return {
				code: `export default ${JSON.stringify(code)};`,
				map: { mappings: "" },
			};
		},
	};
}
function stageNativeAddonPlugin(): Plugin {
	const nativeSourceDir = path.resolve(import.meta.dirname, "../natives/native");
	return {
		name: "stage-pi-natives-addon",
		writeBundle(outputOptions) {
			const outputDir = outputOptions.dir;
			if (!outputDir) throw new Error("Vite main build did not provide an output directory");
			const sourceEntries = fs.readdirSync(nativeSourceDir).filter(entry => /^pi_natives\..+\.node$/.test(entry));
			if (sourceEntries.length === 0) {
				throw new Error(`No pi_natives native addon found in ${nativeSourceDir}`);
			}
			const targetDir = path.resolve(outputDir, "..", "native");
			fs.mkdirSync(targetDir, { recursive: true });
			for (const entry of sourceEntries) {
				fs.copyFileSync(path.join(nativeSourceDir, entry), path.join(targetDir, entry));
			}
		},
	};
}

function bundledCrosswsRequirePlugin(): Plugin {
	return {
		name: "crossws-commonjs-module-url",
		enforce: "pre",
		transform(code, id) {
			if (!id.replaceAll("\\", "/").endsWith("/crossws/dist/_chunks/libs/ws.mjs")) return;
			// Crossws constructs a require for Node builtins and optional ws accelerators.
			// Rolldown's CJS output erases import.meta.url; resolve from the emitted
			// main module instead so packaged Electron can initialize the loopback API.
			return {
				code: code.replaceAll("import.meta.url", "__filename"),
				map: { mappings: "" },
			};
		},
	};
}

export default defineConfig({
	plugins: [rawTextPlugin(), stageNativeAddonPlugin(), bundledCrosswsRequirePlugin()],
	optimizeDeps: {
		exclude: ["fsevents"],
	},
	ssr: {
		external: ["fsevents"],
	},
	build: {
		rollupOptions: {
			external: ["electron", "fsevents", /^node:/],
		},
	},
});
