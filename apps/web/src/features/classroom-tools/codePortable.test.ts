import { describe, expect, it } from "vitest";
import {
  PORTABLE_MAX_FILE_BYTES,
  exportCodeProject,
  importCodeProject,
  portableSlug,
} from "./codePortable";
import type { ClassroomCodeWorkspaceSnapshot } from "./codeSession";

const project: ClassroomCodeWorkspaceSnapshot = {
  activeIndex: 1,
  files: [
    {
      content: "def tong(a, b):\n    return a + b\n",
      language: "python",
      name: "lib.py",
    },
    {
      content: "from lib import tong\nprint(tong(2, 3))\n",
      language: "python",
      name: "main.py",
    },
  ],
  stdin: "2 3\n",
};

describe("portable Code project (ROOM-TOOLS-CODE-03B)", () => {
  it("names the file with an ASCII slug", () => {
    expect(portableSlug("Bài 1: Vòng lặp Đơn giản")).toBe(
      "bai-1-vong-lap-don-gian",
    );
    expect(portableSlug("   ")).toBe("tutorhub-code");
  });

  it("round-trips a project bit-exactly", async () => {
    const exported = await exportCodeProject(project, "main");
    expect(exported.fileName).toBe("main.tutorhub-code.json");
    const result = await importCodeProject(
      new Blob([exported.json], { type: "application/json" }),
    );
    expect(result).toEqual({ ok: true, snapshot: project, title: "main" });
  });

  it("refuses a file changed by one character (checksum)", async () => {
    const exported = await exportCodeProject(project, "main");
    const tampered = exported.json.replace("tong(2, 3)", "tong(2, 4)");
    expect(tampered).not.toBe(exported.json);
    await expect(importCodeProject(new Blob([tampered]))).resolves.toEqual({
      ok: false,
      reason: "classroomTools.portable.errorChecksum",
    });
  });

  it("refuses unsafe keys, other formats, empty and oversized files before use", async () => {
    const exported = await exportCodeProject(project, "main");
    const polluted = exported.json.replace(
      '"workspace":{',
      '"workspace":{"__proto__":{"x":1},',
    );
    await expect(importCodeProject(new Blob([polluted]))).resolves.toEqual({
      ok: false,
      reason: "classroomTools.portable.errorUnsafe",
    });
    await expect(
      importCodeProject(new Blob([JSON.stringify({ format: "other" })])),
    ).resolves.toEqual({
      ok: false,
      reason: "classroomTools.portable.errorFormat",
    });
    await expect(importCodeProject(new Blob([]))).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      importCodeProject(new Blob(["x".repeat(PORTABLE_MAX_FILE_BYTES + 1)])),
    ).resolves.toEqual({
      ok: false,
      reason: "classroomTools.portable.errorTooLarge",
    });
  });
});
