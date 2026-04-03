import type { ChatMessage } from "@droidagent/shared";

export const TRANSCRIPT_WINDOW_THRESHOLD = 48;
export const TRANSCRIPT_OVERSCAN_PX = 960;

export interface TranscriptWindowLayout {
  enabled: boolean;
  startIndex: number;
  endIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
  totalHeightPx: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function estimateChatMessageHeight(message: ChatMessage): number {
  const plainTextLength = message.text.trim().length;
  const textLines = Math.max(1, Math.ceil(plainTextLength / 96));
  let estimatedHeight = 82 + textLines * 22;

  if (message.attachments.length > 0) {
    estimatedHeight += message.attachments.length * 68;
  }

  for (const part of message.parts) {
    if (part.type === "code_block") {
      estimatedHeight += clamp(64 + Math.ceil(part.code.length / 7), 64, 240);
      continue;
    }
    if (part.type === "approval_request") {
      estimatedHeight += 140;
      continue;
    }
    if (part.type === "tool_result_summary") {
      estimatedHeight += 92;
      continue;
    }
    if (part.type === "attachments") {
      estimatedHeight += part.attachments.length * 88;
    }
  }

  return clamp(estimatedHeight, 96, 640);
}

export function computeTranscriptWindow(params: {
  count: number;
  scrollTop: number;
  viewportHeight: number;
  gapPx: number;
  threshold?: number;
  overscanPx?: number;
  getItemHeight: (index: number) => number;
}): TranscriptWindowLayout {
  const {
    count,
    gapPx,
    getItemHeight,
    overscanPx = TRANSCRIPT_OVERSCAN_PX,
    scrollTop,
    threshold = TRANSCRIPT_WINDOW_THRESHOLD,
    viewportHeight,
  } = params;

  if (count === 0) {
    return {
      enabled: false,
      startIndex: 0,
      endIndex: 0,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
      totalHeightPx: 0,
    };
  }

  const tops = new Array<number>(count);
  let totalHeightPx = 0;
  for (let index = 0; index < count; index += 1) {
    tops[index] = totalHeightPx;
    totalHeightPx += getItemHeight(index);
    if (index < count - 1) {
      totalHeightPx += gapPx;
    }
  }

  const enabled = viewportHeight > 0 && count >= threshold;
  if (!enabled) {
    return {
      enabled: false,
      startIndex: 0,
      endIndex: count,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
      totalHeightPx,
    };
  }

  const windowTop = Math.max(0, scrollTop - overscanPx);
  const windowBottom = scrollTop + viewportHeight + overscanPx;

  let startIndex = 0;
  while (startIndex < count - 1) {
    const itemTop = tops[startIndex]!;
    const itemBottom = itemTop + getItemHeight(startIndex);
    if (itemBottom >= windowTop) {
      break;
    }
    startIndex += 1;
  }

  let endIndex = startIndex;
  while (endIndex < count) {
    const itemTop = tops[endIndex]!;
    if (itemTop > windowBottom) {
      break;
    }
    endIndex += 1;
  }
  endIndex = clamp(endIndex, startIndex + 1, count);

  return {
    enabled: true,
    startIndex,
    endIndex,
    topSpacerPx: startIndex > 0 ? Math.max(0, tops[startIndex]! - gapPx) : 0,
    bottomSpacerPx:
      endIndex < count ? Math.max(0, totalHeightPx - tops[endIndex]!) : 0,
    totalHeightPx,
  };
}
