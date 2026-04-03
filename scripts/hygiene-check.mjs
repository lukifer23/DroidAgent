#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const codeRoots = ["apps", "packages", "scripts", "tests"];
const allowedExtensions = new Set([".ts", ".tsx", ".js", ".mjs"]);
const requiredDocs = [
  "docs/openclaw-boundary.md",
  "docs/surface-inventory.md",
];
const duplicateHelperRules = [
  {
    name: "formatDurationMs",
    canonicalPath: "apps/web/src/lib/formatters.ts",
    pattern: /\b(?:export\s+)?function\s+formatDurationMs\b|\bconst\s+formatDurationMs\s*=/g,
  },
  {
    name: "formatHostBytes",
    canonicalPath: "apps/web/src/lib/formatters.ts",
    pattern: /\b(?:export\s+)?function\s+formatHostBytes\b|\bconst\s+formatHostBytes\s*=/g,
  },
  {
    name: "formatTimeLabel",
    canonicalPath: "apps/web/src/lib/formatters.ts",
    pattern: /\b(?:export\s+)?function\s+formatTimeLabel\b|\bconst\s+formatTimeLabel\s*=/g,
  },
  {
    name: "metricDescription",
    canonicalPath: "apps/web/src/lib/formatters.ts",
    pattern: /\b(?:export\s+)?function\s+metricDescription\b|\bconst\s+metricDescription\s*=/g,
  },
  {
    name: "roleLabel",
    canonicalPath: "apps/web/src/lib/formatters.ts",
    pattern: /\b(?:export\s+)?function\s+roleLabel\b|\bconst\s+roleLabel\s*=/g,
  },
  {
    name: "waitForHealth",
    canonicalPath: "scripts/lib/common.mjs",
    pattern: /\b(?:export\s+)?async\s+function\s+waitForHealth\b|\bconst\s+waitForHealth\s*=/g,
  },
  {
    name: "readMaintenanceStatus",
    canonicalPath: "scripts/lib/common.mjs",
    pattern: /\b(?:export\s+)?async\s+function\s+readMaintenanceStatus\b|\bconst\s+readMaintenanceStatus\s*=/g,
  },
];
const genericLineLimit = 900;
const screenLineLimit = 500;
const oversizedAllowlist = new Map([
  [
    "apps/web/src/components/chat-screen-shell.tsx",
    "Operator chat surface is intentionally consolidated while hardening decision and recovery UX.",
  ],
  [
    "apps/web/src/components/settings-core-panels.tsx",
    "Settings panel remains grouped during maintenance and memory hardening; extraction is tracked separately.",
  ],
  [
    "apps/web/src/screens/settings-screen.tsx",
    "Settings orchestration remains centralized while canonical maintenance recovery actions settle.",
  ],
  [
    "apps/server/src/services/openclaw-service.ts",
    "OpenClaw service remains the compatibility boundary while gateway/chat/runtime extraction is still in progress.",
  ],
]);

async function collectFiles(entryPath) {
  const stat = await fs.stat(entryPath);
  if (stat.isFile()) {
    return [entryPath];
  }

  const children = await fs.readdir(entryPath, { withFileTypes: true });
  const files = [];
  for (const child of children) {
    if (child.name === "dist" || child.name === "node_modules") {
      continue;
    }
    const childPath = path.join(entryPath, child.name);
    if (child.isDirectory()) {
      files.push(...(await collectFiles(childPath)));
      continue;
    }
    if (allowedExtensions.has(path.extname(child.name))) {
      files.push(childPath);
    }
  }
  return files;
}

async function loadCodeFiles() {
  const files = [];
  for (const root of codeRoots) {
    const absoluteRoot = path.join(repoRoot, root);
    try {
      files.push(...(await collectFiles(absoluteRoot)));
    } catch {
      // ignore missing roots
    }
  }
  return files;
}

async function loadScriptFiles() {
  const scriptsRoot = path.join(repoRoot, "scripts");
  const files = [];

  async function walk(currentPath) {
    const stat = await fs.stat(currentPath);
    if (stat.isFile()) {
      files.push(currentPath);
      return;
    }

    const children = await fs.readdir(currentPath, { withFileTypes: true });
    for (const child of children) {
      if (child.name === "node_modules" || child.name === "dist") {
        continue;
      }
      await walk(path.join(currentPath, child.name));
    }
  }

  try {
    await walk(scriptsRoot);
    return files;
  } catch {
    return [];
  }
}

function isProductionSource(relativePath) {
  return (
    (relativePath.startsWith("apps/") || relativePath.startsWith("packages/")) &&
    !relativePath.includes(".test.") &&
    !relativePath.includes("/testing/") &&
    !relativePath.endsWith(".config.ts")
  );
}

function isScreenLikeFile(relativePath) {
  return (
    relativePath.includes("/screens/") ||
    relativePath.endsWith("/app-layout.tsx")
  );
}

function extractScriptReferences(contents, fromFile) {
  const references = new Set();
  const importPatterns = [
    /\bfrom\s+["'](\.\/[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.\/[^"']+)["']\s*\)/g,
    /\bnode\s+\.\/(scripts\/[^"'`\s)]+)/g,
    /\b(?:pnpm|npm)\s+(?:run\s+)?([a-z0-9:-]+)/gi,
  ];

  for (const match of contents.matchAll(importPatterns[0])) {
    const target = match[1];
    if (!target) {
      continue;
    }
    const resolved = path.relative(
      repoRoot,
      path.resolve(path.dirname(fromFile), target),
    );
    references.add(resolved);
  }

  for (const match of contents.matchAll(importPatterns[1])) {
    const target = match[1];
    if (!target) {
      continue;
    }
    const resolved = path.relative(
      repoRoot,
      path.resolve(path.dirname(fromFile), target),
    );
    references.add(resolved);
  }

  for (const match of contents.matchAll(importPatterns[2])) {
    const target = match[1];
    if (target) {
      references.add(target);
    }
  }

  return references;
}

async function loadRootScriptEntrypoints() {
  const pkg = JSON.parse(
    await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  const entrypoints = new Set();
  for (const script of Object.values(pkg.scripts ?? {})) {
    for (const match of String(script).matchAll(
      /(?:node\s+)?\.\/(scripts\/[^"'`\s&|;]+)/g,
    )) {
      if (match[1]) {
        entrypoints.add(match[1]);
      }
    }
    for (const match of String(script).matchAll(/(?:^|\s)(scripts\/[^"'`\s&|;]+)/g)) {
      if (match[1]) {
        entrypoints.add(match[1]);
      }
    }
  }
  return entrypoints;
}

async function main() {
  const errors = [];
  const codeFiles = await loadCodeFiles();
  const scriptFilesOnDisk = await loadScriptFiles();
  const relativeScriptFiles = scriptFilesOnDisk.map((filePath) =>
    path.relative(repoRoot, filePath),
  );

  for (const docPath of requiredDocs) {
    try {
      await fs.access(path.join(repoRoot, docPath));
    } catch {
      errors.push(`Missing required documentation inventory file: ${docPath}`);
    }
  }

  try {
    const developmentDoc = await fs.readFile(
      path.join(repoRoot, "docs/development.md"),
      "utf8",
    );
    if (!developmentDoc.includes("## Boundary Review Checklist")) {
      errors.push(
        "docs/development.md must include the Boundary Review Checklist section.",
      );
    }
  } catch {
    errors.push("Missing required documentation file: docs/development.md");
  }

  for (const rule of duplicateHelperRules) {
    const declarations = [];
    for (const filePath of codeFiles) {
      const relativePath = path.relative(repoRoot, filePath);
      if (!isProductionSource(relativePath) && !relativePath.startsWith("scripts/")) {
        continue;
      }
      const contents = await fs.readFile(filePath, "utf8");
      const matches = contents.match(rule.pattern);
      if (matches && matches.length > 0) {
        declarations.push(relativePath);
      }
    }

    if (declarations.length !== 1 || declarations[0] !== rule.canonicalPath) {
      errors.push(
        `Helper ${rule.name} must be declared exactly once in ${rule.canonicalPath}; found ${declarations.join(", ") || "none"}.`,
      );
    }
  }

  for (const filePath of codeFiles) {
    const relativePath = path.relative(repoRoot, filePath);
    if (!isProductionSource(relativePath)) {
      continue;
    }
    if (oversizedAllowlist.has(relativePath)) {
      continue;
    }

    const contents = await fs.readFile(filePath, "utf8");
    const lineCount = contents.split(/\r?\n/).length;
    const limit = isScreenLikeFile(relativePath) ? screenLineLimit : genericLineLimit;
    if (lineCount > limit) {
      errors.push(
        `${relativePath} is ${lineCount} lines; limit is ${limit}. Extract shared logic or add an explicit allowlist entry with a reason.`,
      );
    }
  }

  const trackedScriptFiles = relativeScriptFiles.filter(
    (relativePath) => relativePath !== "scripts/lib/common.mjs",
  );
  const scriptEntrypoints = await loadRootScriptEntrypoints();
  for (const entrypoint of scriptEntrypoints) {
    if (!relativeScriptFiles.includes(entrypoint)) {
      errors.push(`Root package.json references missing script file: ${entrypoint}`);
    }
  }

  const reachableScripts = new Set(scriptEntrypoints);
  const queue = [...scriptEntrypoints];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || !relativeScriptFiles.includes(current)) {
      continue;
    }
    const absolutePath = path.join(repoRoot, current);
    const contents = await fs.readFile(absolutePath, "utf8");
    for (const reference of extractScriptReferences(contents, absolutePath)) {
      if (
        !reference.startsWith("scripts/") ||
        reachableScripts.has(reference) ||
        !relativeScriptFiles.includes(reference)
      ) {
        continue;
      }
      reachableScripts.add(reference);
      queue.push(reference);
    }
  }

  for (const scriptFile of trackedScriptFiles) {
    if (!reachableScripts.has(scriptFile)) {
      errors.push(`Orphaned script file is not reachable from package scripts: ${scriptFile}`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exit(1);
  }

  console.log(
    `Hygiene check passed for ${codeFiles.length} code files and ${trackedScriptFiles.length} script entry files.`,
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
