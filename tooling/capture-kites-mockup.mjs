#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const usage = `Usage:
  node tooling/capture-kites-mockup.mjs --mockup <html-file> --out <directory>

Options:
  --mockup   Attached kites-modern-mockups.html file
  --out      Directory for PNG screenshots and manifest.json
  --themes   Comma-separated list: light,dark (default: light,dark)
  --scale    Screenshot device scale factor (default: 3)
  --chrome   Optional Chromium executable path
`;

function optionsFromArgs(args) {
  const options = { themes: "light,dark", scale: "3" };
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    if (key === "--help") return { help: true };
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    options[key.slice(2)] = value;
    i += 1;
  }
  return options;
}

const options = optionsFromArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage);
  process.exit(0);
}
if (!options.mockup || !options.out) {
  process.stderr.write(`${usage}\nBoth --mockup and --out are required.\n`);
  process.exit(2);
}

let puppeteer;
try {
  ({ default: puppeteer } = await import("puppeteer-core"));
} catch {
  process.stderr.write(
    "Missing Puppeteer Core. Install it in this checkout with `pnpm add -D puppeteer-core`, then rerun this script.\n",
  );
  process.exit(2);
}

const mockupPath = resolve(options.mockup);
const outputDir = resolve(options.out);
const themes = options.themes.split(",").map((theme) => theme.trim()).filter(Boolean);
const scale = Number(options.scale);
if (!Number.isFinite(scale) || scale <= 0) {
  throw new Error(`Invalid --scale value: ${options.scale}`);
}
if (themes.some((theme) => !["light", "dark"].includes(theme))) {
  throw new Error("--themes accepts only light and dark.");
}

await mkdir(outputDir, { recursive: true });
const chromePath = options.chrome ?? process.env.PUPPETEER_EXECUTABLE_PATH;
const browser = await puppeteer.launch({
  headless: true,
  ...(chromePath ? { executablePath: resolve(chromePath) } : {}),
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: scale });
  await page.goto(pathToFileURL(mockupPath).href, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const screens = await page.$$eval(".side .screen-link[data-screen]", (links) =>
    links.map((link) => ({
      id: link.dataset.screen,
      name: link.querySelector("span:nth-child(2)")?.textContent?.trim() ?? link.textContent.trim(),
      route: link.getAttribute("data-route") ?? "",
    })),
  );
  if (screens.length === 0) {
    throw new Error("No mockup screens found. Expected .side .screen-link[data-screen].");
  }

  const manifest = [];
  for (const theme of themes) {
    await page.evaluate((dark) => {
      document.body.classList.toggle("dark-mode", dark);
    }, theme === "dark");

    for (const [index, screen] of screens.entries()) {
      await page.evaluate((id) => {
        const button = document.querySelector(`.side .screen-link[data-screen="${CSS.escape(id)}"]`);
        if (!button) throw new Error(`Missing mockup navigation item: ${id}`);
        button.click();
      }, screen.id);
      await page.evaluate(
        () => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))),
      );
      const route = await page.$eval("#route-label", (label) => label.textContent.trim());

      const fileName = `${String(index + 1).padStart(2, "0")}-${screen.id}-${theme}.png`;
      const target = resolve(outputDir, fileName);
      const deviceScreen = await page.$(".device-screen");
      if (!deviceScreen) throw new Error("Mockup .device-screen element was not found.");
      await deviceScreen.screenshot({ path: target });
      manifest.push({
        index: index + 1,
        id: screen.id,
        name: screen.name,
        route,
        theme,
        screenshot: fileName,
      });
      process.stdout.write(`[${theme}] ${index + 1}/${screens.length} ${screen.name} -> ${fileName}\n`);
    }
  }

  await writeFile(
    resolve(outputDir, "manifest.json"),
    `${JSON.stringify({ mockup: basename(mockupPath), count: manifest.length, screens: manifest }, null, 2)}\n`,
  );
  process.stdout.write(`Saved ${manifest.length} screenshots and manifest.json in ${outputDir}\n`);
} finally {
  await browser.close();
}
