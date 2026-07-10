import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as esbuild from "esbuild";

const root = process.cwd();
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const watch = process.argv.includes("--watch");

async function buildOnce() {
  await mkdir(distDir, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(srcDir, "main.ts")],
    bundle: true,
    outfile: path.join(distDir, "main.js"),
    target: "es2020",
    format: "iife",
    platform: "browser",
    legalComments: "none"
  });

  const uiBundle = await esbuild.build({
    entryPoints: [path.join(srcDir, "ui.ts")],
    bundle: true,
    write: false,
    target: "es2020",
    format: "iife",
    platform: "browser",
    legalComments: "none"
  });

  const html = await readFile(path.join(srcDir, "ui.html"), "utf8");
  const warpPreview = await readFile(path.join(srcDir, "warp-preview.png"));
  const warpPreviewDataUrl = `data:image/png;base64,${Buffer.from(warpPreview).toString("base64")}`;
  const script = uiBundle.outputFiles[0].text;
  await writeFile(
    path.join(distDir, "ui.html"),
    html
      .replace("<!-- WARP_PREVIEW -->", `<img src="${warpPreviewDataUrl}" alt="" />`)
      .replace("<!-- UI_SCRIPT -->", `<script>${script}</script>`),
    "utf8"
  );
}

if (watch) {
  const ctx = await esbuild.context({
    entryPoints: [path.join(srcDir, "main.ts")],
    bundle: true,
    outfile: path.join(distDir, "main.js"),
    target: "es2020",
    format: "iife",
    platform: "browser",
    legalComments: "none"
  });

  await mkdir(distDir, { recursive: true });
  await ctx.watch();
  await buildOnce();
  console.log("Watching Figma plugin sources...");
} else {
  await buildOnce();
}
