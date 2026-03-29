import { runCommand } from "./process.js";

const OLLAMA_SHOW_TIMEOUT_MS = 5_000;
const SECTION_HEADINGS = new Set([
  "model",
  "capabilities",
  "parameters",
  "system",
  "template",
  "license",
  "details",
]);

export function parseOllamaCapabilities(output: string): string[] {
  const capabilities: string[] = [];
  let inCapabilities = false;

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      if (inCapabilities && capabilities.length > 0) {
        break;
      }
      continue;
    }

    const normalizedHeading = line.toLowerCase().replace(/:$/u, "");
    if (!inCapabilities) {
      if (normalizedHeading === "capabilities") {
        inCapabilities = true;
      }
      continue;
    }

    if (SECTION_HEADINGS.has(normalizedHeading)) {
      break;
    }

    if (/^[a-z][a-z0-9_-]*$/iu.test(line)) {
      capabilities.push(line.toLowerCase());
      continue;
    }

    if (capabilities.length > 0) {
      break;
    }
  }

  return [...new Set(capabilities)];
}

export async function getOllamaModelCapabilities(
  modelId: string,
): Promise<string[]> {
  try {
    const result = await runCommand(
      "ollama",
      ["show", modelId],
      { timeoutMs: OLLAMA_SHOW_TIMEOUT_MS },
    );
    return parseOllamaCapabilities(result.stdout);
  } catch {
    return [];
  }
}

export async function ollamaModelSupportsVision(
  modelId: string,
): Promise<boolean> {
  const capabilities = await getOllamaModelCapabilities(modelId);
  return capabilities.includes("vision");
}
