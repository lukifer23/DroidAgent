import fs from "node:fs";
import path from "node:path";

import { LaunchAgentStatusSchema, type LaunchAgentStatus } from "@droidagent/shared";

import { LAUNCH_AGENT_LABEL, SERVER_PORT, baseEnv, paths } from "../env.js";
import { CommandError, runCommand } from "../lib/process.js";
import { appStateService } from "./app-state-service.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export class LaunchAgentService {
  private label = LAUNCH_AGENT_LABEL;

  private domain(): string {
    const uid = process.getuid?.();
    if (typeof uid !== "number") {
      throw new Error("LaunchAgent management requires a POSIX user id.");
    }
    return `gui/${uid}`;
  }

  private serviceTarget(): string {
    return `${this.domain()}/${this.label}`;
  }

  private serverEntrypoint(): string {
    return path.join(paths.workspaceRoot, "apps", "server", "dist", "index.js");
  }

  private buildPlist(): string {
    const environmentVariables = {
      HOME: process.env.HOME ?? "",
      PATH: baseEnv().PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      NODE_ENV: "production",
      DROIDAGENT_PORT: String(SERVER_PORT)
    };

    const envPlist = Object.entries(environmentVariables)
      .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
      .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(this.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(this.serverEntrypoint())}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(paths.workspaceRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envPlist}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(paths.launchAgentStdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(paths.launchAgentStderrPath)}</string>
</dict>
</plist>
`;
  }

  private async launchctl(args: string[], allowMissing = false) {
    try {
      return await runCommand("launchctl", args);
    } catch (error) {
      if (
        allowMissing &&
        error instanceof CommandError &&
        /could not find service|bad request|no such process|service is disabled/i.test(`${error.stdout}\n${error.stderr}`)
      ) {
        return null;
      }
      throw error;
    }
  }

  private ensureServerBuild(): void {
    if (!fs.existsSync(this.serverEntrypoint())) {
      throw new Error("The server build output is missing. Run `pnpm build` before installing the LaunchAgent.");
    }
  }

  async status(): Promise<LaunchAgentStatus> {
    const installed = fs.existsSync(paths.launchAgentPath);
    let loaded = false;
    let running = false;
    let pid: number | null = null;
    let lastExitStatus: number | null = null;
    let health = installed ? "warn" : "warn";
    let healthMessage = installed ? "LaunchAgent plist is installed but not loaded." : "LaunchAgent is not installed yet.";

    const result = await this.launchctl(["print", this.serviceTarget()], true);
    const combined = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;

    if (result && !/could not find service|bad request/i.test(combined)) {
      loaded = true;
      const pidMatch = combined.match(/\bpid = (\d+)/);
      const stateMatch = combined.match(/\bstate = ([^\n]+)/);
      const exitMatch = combined.match(/\blast exit code = (-?\d+)/i) ?? combined.match(/\blast exit status = (-?\d+)/i);
      pid = pidMatch ? Number(pidMatch[1]) : null;
      running = Boolean(pid && pid > 0) || /state = running/i.test(stateMatch?.[0] ?? "");
      lastExitStatus = exitMatch ? Number(exitMatch[1]) : null;

      if (running) {
        health = "ok";
        healthMessage = `LaunchAgent is running${pid ? ` (pid ${pid})` : ""}.`;
      } else {
        health = installed ? "warn" : "warn";
        healthMessage = installed
          ? "LaunchAgent is installed but the service is not currently running."
          : "LaunchAgent is not installed yet.";
      }
    }

    return LaunchAgentStatusSchema.parse({
      label: this.label,
      plistPath: paths.launchAgentPath,
      stdoutPath: paths.launchAgentStdoutPath,
      stderrPath: paths.launchAgentStderrPath,
      installed,
      loaded,
      running,
      pid,
      lastExitStatus,
      health,
      healthMessage
    });
  }

  async install(): Promise<LaunchAgentStatus> {
    this.ensureServerBuild();
    fs.mkdirSync(path.dirname(paths.launchAgentPath), { recursive: true });
    fs.writeFileSync(paths.launchAgentPath, this.buildPlist(), { encoding: "utf8" });
    await appStateService.updateRuntimeSettings({ launchAgentInstalled: true });
    await appStateService.markSetupStepCompleted("launchAgent");
    return await this.status();
  }

  async start(): Promise<LaunchAgentStatus> {
    this.ensureServerBuild();
    if (!fs.existsSync(paths.launchAgentPath)) {
      await this.install();
    }

    const current = await this.status();
    if (current.loaded) {
      await this.launchctl(["bootout", this.domain(), paths.launchAgentPath], true);
    }
    await this.launchctl(["bootstrap", this.domain(), paths.launchAgentPath]);
    await this.launchctl(["kickstart", "-k", this.serviceTarget()]);
    await appStateService.updateRuntimeSettings({ launchAgentInstalled: true });
    return await this.status();
  }

  async stop(): Promise<LaunchAgentStatus> {
    const current = await this.status();
    if (!current.loaded) {
      return current;
    }
    const target = fs.existsSync(paths.launchAgentPath) ? paths.launchAgentPath : this.serviceTarget();
    await this.launchctl(["bootout", this.domain(), target], true);
    return await this.status();
  }

  async uninstall(): Promise<LaunchAgentStatus> {
    await this.stop();
    if (fs.existsSync(paths.launchAgentPath)) {
      fs.unlinkSync(paths.launchAgentPath);
    }
    await appStateService.updateRuntimeSettings({ launchAgentInstalled: false });
    return await this.status();
  }
}

export const launchAgentService = new LaunchAgentService();
