import path from "node:path";

export const perfModelProfiles = [
  {
    id: "qwen35_4b_65k",
    label: "Qwen 3.5 4B",
    provider: "ollama",
    modelRef: "qwen3.5:4b",
    contextWindow: 65536,
    appPort: 4520,
    openclawPort: 18891,
    baseline: true,
  },
  {
    id: "gemma4_e4b_65k",
    label: "Gemma 4 E4B",
    provider: "ollama",
    modelRef: "gemma4:e4b",
    contextWindow: 65536,
    appPort: 4530,
    openclawPort: 18892,
    baseline: false,
    sourceUrl:
      "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf?download=true",
  },
  {
    id: "gemma4_e4b_hf_65k",
    label: "Gemma 4 E4B Q4_K_M",
    provider: "llamaCpp",
    modelRef: "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M",
    contextWindow: 65536,
    appPort: 4540,
    openclawPort: 18893,
    baseline: false,
    sourceUrl:
      "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf?download=true",
  },
];

export function defaultPerfModelProfiles() {
  return perfModelProfiles.slice(0, 2);
}

export function resolvePerfModelProfiles(argv = process.argv.slice(2)) {
  const explicitIds =
    argv
      .find((argument) => argument.startsWith("--profiles="))
      ?.slice("--profiles=".length)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean) ??
    process.env.DROIDAGENT_PERF_COMPARE_PROFILES?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ??
    [];
  if (explicitIds.length === 0) {
    return defaultPerfModelProfiles();
  }

  const selectedProfiles = explicitIds.map((id) => {
    const profile = perfModelProfiles.find((entry) => entry.id === id);
    if (!profile) {
      throw new Error(`Unknown perf model profile: ${id}`);
    }
    return profile;
  });
  if (selectedProfiles.length < 2) {
    throw new Error("Select at least two model profiles for comparison.");
  }
  return selectedProfiles;
}

export function profileArtifactDir(profile) {
  return path.join("artifacts", "perf", "model-compare", profile.id);
}

export function formatPerfModelProfile(profile) {
  return `${profile.label} (${profile.provider}/${profile.modelRef}, ${Math.round(
    profile.contextWindow / 1024,
  )}k)`;
}
