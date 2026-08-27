const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

fs.rmSync(path.resolve(process.cwd(), ".svelte-check"), { recursive: true, force: true });

const packageNodeModules = path.resolve(__dirname, "../node_modules");
const checkerBin = path.resolve(__dirname, "../../../node_modules/@gradivus/svelte-check/bin/svelte-check");
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveGradivus(request, parent, isMain, options) {
  if (request === "typescript" || request === "typescript/package.json") {
    return resolveFilename.call(this, request, { paths: [packageNodeModules] }, isMain, options);
  }
  return resolveFilename.call(this, request, parent, isMain, options);
};

require(checkerBin);
