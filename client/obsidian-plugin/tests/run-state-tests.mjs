import * as esbuild from "esbuild";
import { pathToFileURL } from "node:url";
import path from "node:path";

const outdir = path.resolve(".test-dist");

await esbuild.build({
  entryPoints: ["tests/state.test.ts", "tests/file-policy.test.ts"],
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outExtension: { ".js": ".mjs" },
  external: ["obsidian"],
  logLevel: "silent"
});

await import(pathToFileURL(path.join(outdir, "state.test.mjs")).href);
await import(pathToFileURL(path.join(outdir, "file-policy.test.mjs")).href);
console.log("client tests passed");
