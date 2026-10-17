import { createRequire } from "node:module";
import { loadUiAssets } from "../server/adapters/web/ui_assets.js";

const assets = await loadUiAssets();
const bundle = Object.fromEntries([...assets].map(([name, asset]) => [name, {
  base64: Buffer.from(asset.body).toString("base64"), contentType: asset.contentType,
}]));
const result = await Bun.build({
  entrypoints: ["server/main.ts"],
  compile: { outfile: "release/shepherd" },
  plugins: [{
    name: "claude-sdk-executable",
    setup(build) {
      build.onLoad({ filter: /claude_executable\.ts$/ }, () => {
        const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
        const binary = createRequire(import.meta.url).resolve(`${packageName}/${process.platform === "win32" ? "claude.exe" : "claude"}`);
        return {
          loader: "ts",
          contents: `import binary from ${JSON.stringify(binary)} with { type: "file" };
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
let path;
export function claudeExecutablePath() { return process.env.CLAUDE_EXECUTABLE ?? (path ??= extractFromBunfs(binary)); }`,
          resolveDir: process.cwd(),
        };
      });
    },
  }],
  define: { SHEPHERD_UI_BUNDLE: JSON.stringify(bundle) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("Compiled Shepherd with built-in UI assets.");
