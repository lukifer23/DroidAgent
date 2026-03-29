import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  ChatAttachmentSchema,
  type ChatAttachment,
  type ChatAttachmentKind,
} from "@droidagent/shared";

import { paths } from "../env.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".heif",
]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".rst"]);
const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".sh",
  ".zsh",
  ".bash",
  ".sql",
  ".css",
  ".html",
  ".tsx",
  ".vue",
  ".swift",
  ".kt",
  ".m",
  ".mm",
]);
const JSON_EXTENSIONS = new Set([".json", ".jsonl", ".yaml", ".yml", ".toml"]);
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".log",
  ".csv",
  ".xml",
  ".ini",
  ".conf",
  ".env",
]);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

interface AttachmentMeta {
  id: string;
  name: string;
  kind: ChatAttachmentKind;
  mimeType: string;
  size: number;
  storedAt: string;
  originalExtension: string;
}

export class AttachmentValidationError extends Error {}
export class AttachmentNotFoundError extends Error {}

export interface StoredAttachment extends ChatAttachment {
  storedAt: string;
  filePath: string;
}

function sanitizeName(name: string): string {
  const normalized = name.trim() || "attachment";
  return normalized
    .replace(/[^\w.\- ]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function extensionForName(name: string): string {
  return path.extname(name).toLowerCase();
}

function inferKind(name: string, mimeType: string): ChatAttachmentKind {
  const extension = extensionForName(name);
  const mime = mimeType.toLowerCase();

  if (mime === "application/pdf" || extension === ".pdf") {
    return "pdf";
  }

  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (
    mime === "text/markdown" ||
    mime === "text/x-markdown" ||
    MARKDOWN_EXTENSIONS.has(extension)
  ) {
    return "markdown";
  }

  if (
    mime === "application/json" ||
    mime === "application/ld+json" ||
    mime === "application/yaml" ||
    mime === "text/yaml" ||
    mime === "application/toml" ||
    JSON_EXTENSIONS.has(extension)
  ) {
    return "json";
  }

  if (
    mime.startsWith("text/") ||
    mime === "application/xml" ||
    CODE_EXTENSIONS.has(extension)
  ) {
    return CODE_EXTENSIONS.has(extension) ? "code" : "text";
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    return "text";
  }

  throw new AttachmentValidationError(
    "Unsupported attachment type. Use images, PDFs, or text-based files such as Markdown, code, JSON, or logs.",
  );
}

function maxBytesForKind(kind: ChatAttachmentKind): number {
  if (kind === "image") {
    return MAX_IMAGE_BYTES;
  }
  if (kind === "pdf") {
    return MAX_PDF_BYTES;
  }
  return MAX_TEXT_BYTES;
}

function metaPathFor(attachmentId: string): string {
  return path.join(paths.uploadsDir, attachmentId, "meta.json");
}

function blobPathFor(attachmentId: string, extension: string): string {
  return path.join(paths.uploadsDir, attachmentId, `blob${extension}`);
}

function publicAttachment(meta: AttachmentMeta): ChatAttachment {
  return ChatAttachmentSchema.parse({
    id: meta.id,
    name: meta.name,
    kind: meta.kind,
    mimeType: meta.mimeType,
    size: meta.size,
    url: `/api/chat/uploads/${encodeURIComponent(meta.id)}`,
  });
}

async function loadMeta(attachmentId: string): Promise<AttachmentMeta> {
  const raw = await fs.promises
    .readFile(metaPathFor(attachmentId), "utf8")
    .catch(() => null);
  if (!raw) {
    throw new AttachmentNotFoundError("Attachment was not found.");
  }
  const parsed = JSON.parse(raw) as AttachmentMeta;
  return {
    ...parsed,
    name: sanitizeName(parsed.name),
    originalExtension: parsed.originalExtension ?? "",
  };
}

export class AttachmentService {
  async saveUpload(file: File): Promise<StoredAttachment> {
    const name = sanitizeName(file.name);
    const mimeType = (file.type || "application/octet-stream").toLowerCase();
    const kind = inferKind(name, mimeType);
    const size = file.size;
    const maxBytes = maxBytesForKind(kind);

    if (size <= 0) {
      throw new AttachmentValidationError("Attachment is empty.");
    }

    if (size > maxBytes) {
      throw new AttachmentValidationError(
        `Attachment exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit for ${kind} files.`,
      );
    }

    const id = randomUUID();
    const extension = extensionForName(name);
    const attachmentDir = path.join(paths.uploadsDir, id);
    const filePath = blobPathFor(id, extension);
    const meta: AttachmentMeta = {
      id,
      name,
      kind,
      mimeType,
      size,
      storedAt: new Date().toISOString(),
      originalExtension: extension,
    };

    await fs.promises.mkdir(attachmentDir, { recursive: true });
    await fs.promises.writeFile(
      filePath,
      Buffer.from(await file.arrayBuffer()),
    );
    await fs.promises.writeFile(
      metaPathFor(id),
      JSON.stringify(meta, null, 2),
      "utf8",
    );

    return {
      ...publicAttachment(meta),
      storedAt: meta.storedAt,
      filePath,
    };
  }

  async get(attachmentId: string): Promise<StoredAttachment> {
    const meta = await loadMeta(attachmentId);
    const filePath = blobPathFor(attachmentId, meta.originalExtension);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(paths.uploadsDir) + path.sep)) {
      throw new Error("Attachment path escaped the uploads directory.");
    }
    await fs.promises.access(resolvedPath, fs.constants.R_OK).catch(() => {
      throw new AttachmentNotFoundError("Attachment was not found.");
    });
    return {
      ...publicAttachment(meta),
      storedAt: meta.storedAt,
      filePath: resolvedPath,
    };
  }
}

export const attachmentService = new AttachmentService();
