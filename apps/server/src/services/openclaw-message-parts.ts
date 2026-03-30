import {
  ChatAttachmentSchema,
  nowIso,
  type ChatAttachment,
  type ChatMessage,
  type ChatMessagePart,
  type ChatSendRequest,
} from "@droidagent/shared";

const ATTACHMENT_PAYLOAD_START = "<<DROIDAGENT_ATTACHMENTS_V1>>";
const ATTACHMENT_PAYLOAD_END = "<<END_DROIDAGENT_ATTACHMENTS_V1>>";

export interface GatewayAttachmentRecord {
  id: string;
  name: string;
  kind: string;
  mimeType: string;
  size: number;
  url: string;
  filePath: string;
}

export interface GatewayAttachmentPayload {
  text: string;
  attachments: GatewayAttachmentRecord[];
}

export function extractAttachmentPayload(
  value: string,
): { payload: GatewayAttachmentPayload | null; remainder: string } {
  const startIndex = value.indexOf(ATTACHMENT_PAYLOAD_START);
  const endIndex = value.indexOf(ATTACHMENT_PAYLOAD_END);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return { payload: null, remainder: value };
  }

  const payloadText = value
    .slice(startIndex + ATTACHMENT_PAYLOAD_START.length, endIndex)
    .trim();
  const remainder = value
    .slice(endIndex + ATTACHMENT_PAYLOAD_END.length)
    .trim();

  try {
    const parsed = JSON.parse(payloadText) as GatewayAttachmentPayload;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.text !== "string" ||
      !Array.isArray(parsed.attachments)
    ) {
      return { payload: null, remainder: value };
    }

    return {
      payload: {
        text: parsed.text,
        attachments: parsed.attachments,
      },
      remainder,
    };
  } catch {
    return { payload: null, remainder: value };
  }
}

export function publicAttachmentsFromPayload(
  payload: GatewayAttachmentPayload | null,
): ChatAttachment[] {
  if (!payload) {
    return [];
  }

  return payload.attachments.map((attachment) =>
    ChatAttachmentSchema.parse({
      id: attachment.id,
      name: attachment.name,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      size: attachment.size,
      url: attachment.url,
    }),
  );
}

export function stripGeneratedAttachmentInstructions(value: string): string {
  const { payload, remainder } = extractAttachmentPayload(value);
  if (!payload) {
    return value;
  }

  return payload.text.trim() || remainder.trim() || "Inspect the attached files.";
}

function markdownPartsFromText(text: string): ChatMessagePart[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const parts: ChatMessagePart[] = [];
  const codeBlockPattern = /```([a-z0-9_+\-.#]*)\n?([\s\S]*?)```/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockPattern.exec(trimmed)) !== null) {
    const preceding = trimmed.slice(lastIndex, match.index).trim();
    if (preceding) {
      parts.push({
        type: "markdown",
        text: preceding,
      });
    }

    const language = match[1]?.trim() || null;
    const code = match[2]?.replace(/\n$/, "") ?? "";
    if (code.trim()) {
      parts.push({
        type: "code_block",
        language,
        code,
      });
    }

    lastIndex = match.index + match[0].length;
  }

  const trailing = trimmed.slice(lastIndex).trim();
  if (trailing) {
    parts.push({
      type: "markdown",
      text: trailing,
    });
  }

  return parts.length > 0
    ? parts
    : [
        {
          type: "markdown",
          text: trimmed,
        },
      ];
}

function parseToolCallPart(text: string): ChatMessagePart | null {
  const match = text.trim().match(/^Tool call:\s*([^\n]+)\n?([\s\S]*)$/i);
  if (!match) {
    return null;
  }

  const toolName = match[1]?.trim() || "tool";
  const details = match[2]?.trim() || null;
  return {
    type: "tool_call_summary",
    toolName,
    summary: `Calling ${toolName}`,
    details,
  };
}

function parseToolResultPart(text: string): ChatMessagePart | null {
  const match = text
    .trim()
    .match(/^Tool result(?:\s*-\s*([^\n]+))?\n?([\s\S]*)$/i);
  if (!match) {
    return null;
  }

  const toolName = match[1]?.trim() || null;
  const details = match[2]?.trim() || null;
  return {
    type: "tool_result_summary",
    toolName,
    summary: toolName ? `${toolName} returned output` : "Tool returned output",
    details,
  };
}

function parseApprovalRequestPart(text: string): ChatMessagePart | null {
  if (!/^Approval required/i.test(text.trim())) {
    return null;
  }

  const approvalId =
    text.match(/Approval required\s+\(id\s+([^)]+)\)/i)?.[1]?.trim() ?? null;

  return {
    type: "approval_request",
    approvalId,
    title: "Approval required",
    details: text.trim(),
    resolution: "pending",
  };
}

function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function collectTextParts(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value] : [];
  }

  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextParts(entry));
  }

  if (typeof value !== "object") {
    const text = String(value).trim();
    return text ? [text] : [];
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  const parts: string[] = [];

  if (type === "text" && typeof record.text === "string") {
    return record.text.trim() ? [record.text] : [];
  }

  if (type === "toolCall") {
    const toolName =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : "tool";
    const renderedArguments = formatStructuredValue(record.arguments).trim();
    return renderedArguments
      ? [`Tool call: ${toolName}\n${renderedArguments}`]
      : [`Tool call: ${toolName}`];
  }

  if (type === "toolResult") {
    const renderedResult = collectTextParts(
      record.content ?? record.text ?? record.result ?? record.output,
    );
    if (renderedResult.length > 0) {
      return [`Tool result\n${renderedResult.join("\n\n")}`];
    }
    const fallback = formatStructuredValue(
      record.result ?? record.output ?? record.content,
    ).trim();
    return fallback ? [`Tool result\n${fallback}`] : [];
  }

  for (const key of ["text", "content", "summary", "message", "detail"]) {
    if (key in record) {
      parts.push(...collectTextParts(record[key]));
    }
  }

  return parts;
}

function resolveStructuredToolName(record: Record<string, unknown>): string | null {
  for (const key of ["name", "toolName", "tool"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function renderStructuredDetails(value: unknown): string | null {
  const lines = collectTextParts(value);
  if (lines.length > 0) {
    const joined = lines.join("\n\n").trim();
    if (joined) {
      return joined;
    }
  }

  const rendered = formatStructuredValue(value).trim();
  return rendered || null;
}

export function structuredPartsFromContent(
  value: unknown,
  role: ChatMessage["role"],
): ChatMessagePart[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    if (role === "tool") {
      return [
        {
          type: "tool_result_summary",
          toolName: null,
          summary: "Tool returned output",
          details: trimmed,
        },
      ];
    }

    return parseMessageParts({
      text: value,
      attachments: [],
      role,
      status: "complete",
    });
  }

  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => structuredPartsFromContent(entry, role));
  }

  if (typeof value !== "object") {
    return structuredPartsFromContent(String(value), role);
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;

  if (type === "text" && typeof record.text === "string") {
    return structuredPartsFromContent(record.text, role);
  }

  if (type === "toolCall") {
    const toolName = resolveStructuredToolName(record) ?? "tool";
    return [
      {
        type: "tool_call_summary",
        toolName,
        summary: `Calling ${toolName}`,
        details: renderStructuredDetails(record.arguments),
      },
    ];
  }

  if (type === "toolResult") {
    const toolName = resolveStructuredToolName(record);
    return [
      {
        type: "tool_result_summary",
        toolName,
        summary: toolName
          ? `${toolName} returned output`
          : "Tool returned output",
        details: renderStructuredDetails(
          record.content ?? record.text ?? record.result ?? record.output,
        ),
      },
    ];
  }

  if (typeof record.text === "string") {
    return structuredPartsFromContent(record.text, role);
  }

  if (
    role === "tool" &&
    ("content" in record || "result" in record || "output" in record)
  ) {
    const toolName = resolveStructuredToolName(record);
    return [
      {
        type: "tool_result_summary",
        toolName,
        summary: toolName
          ? `${toolName} returned output`
          : "Tool returned output",
        details: renderStructuredDetails(
          record.content ?? record.result ?? record.output,
        ),
      },
    ];
  }

  if ("content" in record) {
    const nested = structuredPartsFromContent(record.content, role);
    if (nested.length > 0) {
      return nested;
    }
  }

  if ("result" in record || "output" in record) {
    const toolName = resolveStructuredToolName(record);
    const details = renderStructuredDetails(record.result ?? record.output);
    return details
      ? [
          {
            type: "tool_result_summary",
            toolName,
            summary: toolName
              ? `${toolName} returned output`
              : "Tool returned output",
            details,
          },
        ]
      : [];
  }

  return [];
}

export function parseMessageParts(params: {
  text: string;
  attachments: ChatAttachment[];
  role: ChatMessage["role"];
  status: ChatMessage["status"];
}): ChatMessagePart[] {
  const trimmed = params.text.trim();
  const parts: ChatMessagePart[] = [];

  if (params.attachments.length > 0) {
    parts.push({
      type: "attachments",
      attachments: params.attachments,
    });
  }

  if (!trimmed) {
    return parts;
  }

  if (params.status === "error") {
    parts.push({
      type: "error",
      message: trimmed,
      details: null,
    });
    return parts;
  }

  const approvalPart = parseApprovalRequestPart(trimmed);
  if (approvalPart) {
    parts.push(approvalPart);
    return parts;
  }

  if (params.role !== "user") {
    const toolCallPart = parseToolCallPart(trimmed);
    if (toolCallPart) {
      parts.push(toolCallPart);
      return parts;
    }

    const toolResultPart = parseToolResultPart(trimmed);
    if (toolResultPart) {
      parts.push(toolResultPart);
      return parts;
    }
  }

  parts.push(...markdownPartsFromText(trimmed));
  return parts;
}

function messagePartSignature(part: ChatMessagePart): string {
  if (part.type === "attachments") {
    return `attachments:${part.attachments
      .map((attachment) => attachment.id)
      .sort()
      .join(",")}`;
  }

  if (part.type === "markdown") {
    return `markdown:${part.text.trim()}`;
  }

  if (part.type === "code_block") {
    return `code_block:${part.language ?? ""}:${part.code}`;
  }

  if (part.type === "tool_call_summary") {
    return `tool_call:${part.toolName}:${part.summary}:${part.details ?? ""}`;
  }

  if (part.type === "tool_result_summary") {
    return `tool_result:${part.toolName ?? ""}:${part.summary}:${part.details ?? ""}`;
  }

  if (part.type === "approval_request") {
    return `approval:${part.approvalId ?? ""}:${part.title}:${part.details}`;
  }

  return `error:${part.message}:${part.details ?? ""}`;
}

export function dedupeMessageParts(parts: ChatMessagePart[]): ChatMessagePart[] {
  const deduped: ChatMessagePart[] = [];

  for (const part of parts) {
    const previous = deduped.at(-1);
    if (!previous) {
      deduped.push(part);
      continue;
    }

    if (part.type === "markdown" && previous.type === "markdown") {
      const currentText = part.text.trim();
      const previousText = previous.text.trim();
      if (!currentText) {
        continue;
      }
      if (previousText === currentText) {
        continue;
      }
      deduped[deduped.length - 1] = {
        type: "markdown",
        text: `${previousText}\n\n${currentText}`,
      };
      continue;
    }

    if (part.type === "attachments" && previous.type === "attachments") {
      const mergedAttachments = [...previous.attachments];
      for (const attachment of part.attachments) {
        if (!mergedAttachments.some((existing) => existing.id === attachment.id)) {
          mergedAttachments.push(attachment);
        }
      }
      deduped[deduped.length - 1] = {
        type: "attachments",
        attachments: mergedAttachments,
      };
      continue;
    }

    if (messagePartSignature(previous) === messagePartSignature(part)) {
      continue;
    }

    deduped.push(part);
  }

  return deduped;
}

export function renderHistoryContent(message: Record<string, unknown>): string {
  const lines = collectTextParts(message.content ?? message.text);
  if (lines.length > 0) {
    return stripGeneratedAttachmentInstructions(lines.join("\n\n"));
  }

  if (typeof message.text === "string" && message.text.trim()) {
    return stripGeneratedAttachmentInstructions(message.text);
  }

  return stripGeneratedAttachmentInstructions(
    formatStructuredValue(message.content ?? ""),
  );
}

export function resolveMessageRole(role: unknown): ChatMessage["role"] {
  if (role === "assistant" || role === "system" || role === "tool") {
    return role;
  }

  if (role === "toolResult") {
    return "tool";
  }

  return "user";
}

export function resolveIsoTimestamp(message: Record<string, unknown>): string {
  const timestamp =
    message.ts ??
    message.createdAtMs ??
    message.updatedAtMs ??
    message.updatedAt ??
    message.createdAt;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }

  if (typeof timestamp === "string" && timestamp.trim()) {
    const parsed = Number(timestamp);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
    const normalized = new Date(timestamp);
    if (!Number.isNaN(normalized.getTime())) {
      return normalized.toISOString();
    }
  }

  return nowIso();
}

function attachmentToolGuidance(kind: string): string {
  if (kind === "image") {
    return "Use the image tool to inspect it.";
  }
  if (kind === "pdf") {
    return "Use the pdf tool to extract and analyze it.";
  }
  return "Use the read tool to inspect it.";
}

export function buildAttachmentPrompt(
  request: ChatSendRequest,
  attachments: GatewayAttachmentRecord[],
): string {
  if (attachments.length === 0) {
    return request.text.trim();
  }

  const normalizedText =
    request.text.trim() ||
    "Inspect the attached files and respond with the most useful summary, findings, and next actions.";
  const payload: GatewayAttachmentPayload = {
    text: normalizedText,
    attachments,
  };
  const manifest = JSON.stringify(payload, null, 2);

  const attachmentSummary = attachments
    .map(
      (attachment) =>
        `- ${attachment.name} (${attachment.kind}, ${attachment.mimeType}, ${attachment.size} bytes)\n  Local path: ${attachment.filePath}\n  ${attachmentToolGuidance(attachment.kind)}`,
    )
    .join("\n");

  return [
    ATTACHMENT_PAYLOAD_START,
    manifest,
    ATTACHMENT_PAYLOAD_END,
    "Local attachments are available for this request. Use the listed local paths and the appropriate tools instead of guessing.",
    attachmentSummary,
    "",
    "User request:",
    normalizedText,
  ].join("\n");
}
