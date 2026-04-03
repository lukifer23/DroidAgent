const LLAMACPP_VISION_PATTERNS = [
  /\bgemma[-_ ]?[34]\b/iu,
  /\bqwen(?:2(?:\.5)?)?[-_ ]?vl\b/iu,
  /\bllava\b/iu,
  /\bbakllava\b/iu,
  /\bmoondream\b/iu,
  /\bminicpm[-_ ]?v\b/iu,
  /\bpixtral\b/iu,
  /\binternvl\b/iu,
  /\bvision\b/iu,
] as const;

export function llamaCppModelSupportsVision(modelRef: string): boolean {
  const normalized = modelRef.trim();
  if (!normalized) {
    return false;
  }

  return LLAMACPP_VISION_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}
