/**
 * ROOM-TOOLS-CODE-01 / ADR-0043 §3 output bounds, enforced again on the parent
 * side (the sandbox already enforces them): stdout + stderr together keep at
 * most 64 KB and 5,000 lines, terminal escape sequences and other control
 * characters are dropped, and the result is plain text for React text nodes.
 */
export const CODE_OUTPUT_MAX_BYTES = 64 * 1024;
export const CODE_OUTPUT_MAX_LINES = 5_000;

export type CodeOutputStream = "stdout" | "stderr";

export interface CodeOutputChunk {
  readonly stream: CodeOutputStream;
  readonly text: string;
}

// CSI / OSC / single-character ESC sequences, then remaining C0/C1 controls
// except tab and newline. Carriage returns become newlines first.
const escapeSequence =
  // eslint-disable-next-line no-control-regex -- Stripping terminal control sequences is the point.
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex -- Stripping control characters is the point.
const controlCharacter = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitizeOutputText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(escapeSequence, "")
    .replace(controlCharacter, "");
}

const encoder = new TextEncoder();

export class CodeOutputBuffer {
  private chunks: CodeOutputChunk[] = [];
  private bytes = 0;
  private lines = 0;
  private cut = false;

  get truncated(): boolean {
    return this.cut;
  }

  get lineCount(): number {
    const last = this.chunks[this.chunks.length - 1];
    return this.lines + (last && !last.text.endsWith("\n") ? 1 : 0);
  }

  snapshot(): readonly CodeOutputChunk[] {
    return this.chunks;
  }

  text(): string {
    return this.chunks.map((chunk) => chunk.text).join("");
  }

  /** Appends text; returns `false` once the bound has been reached. */
  append(stream: CodeOutputStream, raw: string): boolean {
    if (this.cut) return false;
    let text = sanitizeOutputText(raw);
    if (!text) return true;

    const lineRoom = CODE_OUTPUT_MAX_LINES - this.lines;
    let newlineIndex = -1;
    let seen = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) {
        seen += 1;
        if (seen === lineRoom) {
          newlineIndex = index;
          break;
        }
      }
    }
    if (newlineIndex >= 0) {
      text = text.slice(0, newlineIndex + 1);
      this.cut = true;
    }

    const room = CODE_OUTPUT_MAX_BYTES - this.bytes;
    const encoded = encoder.encode(text);
    if (encoded.byteLength > room) {
      // Cut on a character boundary that fits the remaining bytes.
      let end = Math.min(text.length, room);
      while (end > 0 && encoder.encode(text.slice(0, end)).byteLength > room) {
        end -= 1;
      }
      text = text.slice(0, end);
      this.cut = true;
    }
    if (text) {
      this.bytes += encoder.encode(text).byteLength;
      for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) this.lines += 1;
      }
      const last = this.chunks[this.chunks.length - 1];
      if (last && last.stream === stream) {
        this.chunks[this.chunks.length - 1] = {
          stream,
          text: last.text + text,
        };
      } else {
        this.chunks.push({ stream, text });
      }
    }
    return !this.cut;
  }
}
