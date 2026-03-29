import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { BuildInfoSchema, type BuildInfo } from "@droidagent/shared";

import { paths } from "../env.js";

interface RootPackageJson {
  name?: string;
  version?: string;
  packageManager?: string;
}

function readRootPackageJson(): RootPackageJson {
  const packageJsonPath = path.join(paths.workspaceRoot, "package.json");
  const raw = fs.readFileSync(packageJsonPath, "utf8");
  return JSON.parse(raw) as RootPackageJson;
}

function detectGitCommit(): string | null {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: paths.workspaceRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }

  const commit = result.stdout.trim();
  return commit || null;
}

export class BuildInfoService {
  private cached: BuildInfo | null = null;

  getBuildInfo(): BuildInfo {
    if (this.cached) {
      return this.cached;
    }

    const rootPackage = readRootPackageJson();
    this.cached = BuildInfoSchema.parse({
      productName: "DroidAgent",
      version: rootPackage.version ?? "0.0.0",
      gitCommit: detectGitCommit(),
      packageManager: rootPackage.packageManager ?? null,
      nodeVersion: process.version,
    });
    return this.cached;
  }
}

export const buildInfoService = new BuildInfoService();
