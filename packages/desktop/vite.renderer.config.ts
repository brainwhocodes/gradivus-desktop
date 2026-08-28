import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

function rootRedirectPlugin(): Plugin {
	return {
		name: "root-redirect",
		configureServer(server) {
			server.middlewares.use((req, _res, next) => {
				if (req.url === "/" || req.url === "/index.html") {
					req.url = "/src/renderer/index.html";
				}
				next();
			});
		},
	};
}

export default defineConfig({
	plugins: [svelte(), rootRedirectPlugin()],
	server: {
		host: "127.0.0.1",
		port: 5180,
	},
	optimizeDeps: {
		exclude: ["fsevents", "@oh-my-pi/pi-natives"],
	},
	base: "./",
	build: {
		rollupOptions: {
			input: "src/renderer/index.html",
		},
	},
});
