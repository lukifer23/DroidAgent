const textEncoder = new TextEncoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function trimLeadingUtf8Bytes(value: string, bytesToTrim: number): string {
  if (bytesToTrim <= 0 || value.length === 0) {
    return value;
  }

  if (byteLength(value) <= bytesToTrim) {
    return "";
  }

  let cutIndex = 0;
  let trimmedBytes = 0;
  while (cutIndex < value.length && trimmedBytes < bytesToTrim) {
    const codePoint = value.codePointAt(cutIndex);
    const charLength = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    const nextChar = value.slice(cutIndex, cutIndex + charLength);
    trimmedBytes += byteLength(nextChar);
    cutIndex += charLength;
  }
  return value.slice(cutIndex);
}

export class Utf8TailBuffer {
  private readonly chunks: Array<{ text: string; bytes: number }> = [];
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  clear(): void {
    this.chunks.splice(0, this.chunks.length);
    this.totalBytes = 0;
  }

  replace(text: string): { truncated: boolean; bytes: number } {
    this.clear();
    return this.append(text);
  }

  append(text: string): { truncated: boolean; bytes: number } {
    if (!text) {
      return {
        truncated: false,
        bytes: this.totalBytes,
      };
    }

    const chunkBytes = byteLength(text);
    this.chunks.push({
      text,
      bytes: chunkBytes,
    });
    this.totalBytes += chunkBytes;

    let truncated = false;
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.totalBytes - this.maxBytes;
      const head = this.chunks[0]!;
      if (head.bytes <= overflow) {
        this.chunks.shift();
        this.totalBytes -= head.bytes;
        truncated = true;
        continue;
      }

      const nextText = trimLeadingUtf8Bytes(head.text, overflow);
      const nextBytes = byteLength(nextText);
      this.chunks[0] = {
        text: nextText,
        bytes: nextBytes,
      };
      this.totalBytes = this.totalBytes - head.bytes + nextBytes;
      truncated = true;
      break;
    }

    return {
      truncated,
      bytes: this.totalBytes,
    };
  }

  snapshot(): string {
    return this.chunks.map((chunk) => chunk.text).join("");
  }

  size(): number {
    return this.totalBytes;
  }
}
