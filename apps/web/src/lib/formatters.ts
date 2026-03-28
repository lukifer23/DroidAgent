export function formatTokenBudget(value: number | null | undefined): string {
  const normalized =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : 65_536;

  return `${Math.max(1, Math.floor(normalized / 1_000))}k`;
}
