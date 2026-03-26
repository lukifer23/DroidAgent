#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const docRoots = [path.join(repoRoot, "README.md"), path.join(repoRoot, "docs")];
const knownPathPrefixes = ["README.md", "docs/", "scripts/", "apps/", "packages/", "playwright.config.ts", "tests/"];
const allowedPnpmBuiltins = new Set(["install", "exec", "dlx", "add", "remove", "create", "run", "audit"]);

function slugifyHeading(input) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

async function collectFiles(entryPath) {
  const stat = await fs.stat(entryPath);
  if (stat.isFile()) {
    return [entryPath];
  }

  const children = await fs.readdir(entryPath, { withFileTypes: true });
  const files = [];
  for (const child of children) {
    const childPath = path.join(entryPath, child.name);
    if (child.isDirectory()) {
      files.push(...(await collectFiles(childPath)));
      continue;
    }
    if (child.name.endsWith(".md")) {
      files.push(childPath);
    }
  }
  return files;
}

async function loadScripts() {
  const packageFiles = [
    path.join(repoRoot, "package.json"),
    path.join(repoRoot, "apps", "server", "package.json"),
    path.join(repoRoot, "apps", "web", "package.json"),
    path.join(repoRoot, "packages", "shared", "package.json")
  ];

  const byName = new Map();
  for (const filePath of packageFiles) {
    const pkg = JSON.parse(await fs.readFile(filePath, "utf8"));
    byName.set(pkg.name, new Set(Object.keys(pkg.scripts ?? {})));
    if (filePath === path.join(repoRoot, "package.json")) {
      byName.set("root", new Set(Object.keys(pkg.scripts ?? {})));
    }
  }
  return byName;
}

function extractHeadings(contents) {
  const anchors = new Set();
  for (const match of contents.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    anchors.add(slugifyHeading(match[1] ?? ""));
  }
  return anchors;
}

function extractCodeFragments(contents) {
  const fragments = [];
  for (const match of contents.matchAll(/```[\s\S]*?```/g)) {
    fragments.push(match[0]);
  }
  for (const match of contents.matchAll(/(^|[^`])`([^`\n]+)`(?!`)/gm)) {
    fragments.push(match[2]);
  }
  return fragments;
}

async function main() {
  const markdownFiles = [];
  for (const entry of docRoots) {
    markdownFiles.push(...(await collectFiles(entry)));
  }

  const scriptsByPackage = await loadScripts();
  const errors = [];

  for (const filePath of markdownFiles) {
    const contents = await fs.readFile(filePath, "utf8");
    const headings = extractHeadings(contents);

    for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const rawTarget = match[1]?.trim();
      if (!rawTarget || rawTarget.startsWith("http://") || rawTarget.startsWith("https://") || rawTarget.startsWith("mailto:")) {
        continue;
      }

      if (rawTarget.startsWith("#")) {
        if (!headings.has(rawTarget.slice(1))) {
          errors.push(`${path.relative(repoRoot, filePath)}: missing local anchor ${rawTarget}`);
        }
        continue;
      }

      const [targetPath, targetAnchor] = rawTarget.split("#", 2);
      const resolved = path.resolve(path.dirname(filePath), targetPath);
      try {
        const targetContents = await fs.readFile(resolved, "utf8");
        if (targetAnchor) {
          const targetHeadings = extractHeadings(targetContents);
          if (!targetHeadings.has(targetAnchor)) {
            errors.push(`${path.relative(repoRoot, filePath)}: missing anchor ${rawTarget}`);
          }
        }
      } catch {
        errors.push(`${path.relative(repoRoot, filePath)}: missing linked file ${rawTarget}`);
      }
    }

    for (const match of contents.matchAll(/`([^`]+)`/g)) {
      const token = match[1]?.trim();
      if (!token || !knownPathPrefixes.some((prefix) => token.startsWith(prefix))) {
        continue;
      }

      const resolved = path.resolve(repoRoot, token);
      try {
        await fs.access(resolved);
      } catch {
        errors.push(`${path.relative(repoRoot, filePath)}: missing referenced path ${token}`);
      }
    }

    for (const fragment of extractCodeFragments(contents)) {
      for (const match of fragment.matchAll(/pnpm\s+--filter\s+([^\s]+)\s+([a-z][a-z0-9:-]*)/gi)) {
        const pkgName = match[1];
        const scriptName = match[2];
        if (!pkgName || !scriptName || allowedPnpmBuiltins.has(scriptName)) {
          continue;
        }
        const scripts = scriptsByPackage.get(pkgName);
        if (!scripts?.has(scriptName)) {
          errors.push(`${path.relative(repoRoot, filePath)}: unknown filtered script pnpm --filter ${pkgName} ${scriptName}`);
        }
      }

      for (const match of fragment.matchAll(/pnpm\s+([a-z][a-z0-9:-]*)/gi)) {
        const scriptName = match[1];
        if (!scriptName || allowedPnpmBuiltins.has(scriptName)) {
          continue;
        }
        if (!scriptsByPackage.get("root")?.has(scriptName)) {
          errors.push(`${path.relative(repoRoot, filePath)}: unknown root script pnpm ${scriptName}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }

  console.log(`Docs check passed for ${markdownFiles.length} Markdown files.`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
