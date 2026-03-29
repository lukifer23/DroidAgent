import fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uploadsDir } = vi.hoisted(() => ({
  uploadsDir: `/tmp/droidagent-attachments-${Date.now()}`,
}));

vi.mock("../env.js", () => ({
  paths: {
    uploadsDir,
  },
}));

import {
  AttachmentValidationError,
  attachmentService,
} from "./attachment-service.js";

describe("attachmentService", () => {
  beforeEach(async () => {
    await fs.rm(uploadsDir, { recursive: true, force: true });
    await fs.mkdir(uploadsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  it("stores markdown uploads and returns a public attachment record", async () => {
    const file = new File(["# Hello\n"], "notes.md", {
      type: "text/markdown",
    });

    const stored = await attachmentService.saveUpload(file);
    const loaded = await attachmentService.get(stored.id);

    expect(stored.kind).toBe("markdown");
    expect(stored.url).toBe(`/api/chat/uploads/${stored.id}`);
    expect(await fs.readFile(loaded.filePath, "utf8")).toBe("# Hello\n");
  });

  it("stores image uploads for multimodal chat requests", async () => {
    const file = new File([new Uint8Array([0, 1, 2])], "photo.png", {
      type: "image/png",
    });

    const stored = await attachmentService.saveUpload(file);

    expect(stored.kind).toBe("image");
    expect(stored.mimeType).toBe("image/png");
  });

  it("rejects unsupported binary uploads", async () => {
    const file = new File([new Uint8Array([0, 1, 2])], "archive.zip", {
      type: "application/zip",
    });

    await expect(attachmentService.saveUpload(file)).rejects.toBeInstanceOf(
      AttachmentValidationError,
    );
  });
});
