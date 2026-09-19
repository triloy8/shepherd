import { loadUiAssets } from "../server/adapters/web/ui_assets.js";

const assets = await loadUiAssets();
const bundle = Object.fromEntries([...assets].map(([name, asset]) => [name, {
  base64: Buffer.from(asset.body).toString("base64"), contentType: asset.contentType,
}]));
const result = await Bun.build({
  entrypoints: ["server/main.ts"],
  compile: { outfile: "release/shepherd" },
  define: { SHEPHERD_UI_BUNDLE: JSON.stringify(bundle) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("Compiled Shepherd with built-in UI assets.");
