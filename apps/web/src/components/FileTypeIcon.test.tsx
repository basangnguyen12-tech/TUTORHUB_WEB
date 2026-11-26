// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileBadgeLabel,
  fileExtension,
  fileFormatLabel,
  FileTypeIcon,
  resolveFileVisualKind,
} from "./FileTypeIcon";

describe("resolveFileVisualKind", () => {
  it.each([
    ["De kiem tra.PDF", null, "pdf"],
    ["scan", "application/pdf", "pdf"],
    ["Bai tap.docx", null, "word"],
    [
      "x",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "word",
    ],
    ["legacy.doc", "application/msword", "word"],
    ["notes.ODT", null, "word"],
    ["Diem.xlsx", null, "excel"],
    [
      "x",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "excel",
    ],
    ["danh-sach.csv", "text/csv", "excel"],
    ["old.xls", "application/vnd.ms-excel", "excel"],
    ["Slide.pptx", null, "powerpoint"],
    [
      "x",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "powerpoint",
    ],
    ["Hinh.PNG", null, "image"],
    ["anh", "image/webp", "image"],
    ["logo.svg", null, "image"],
    ["main.py", null, "code"],
    ["App.TSX", null, "code"],
    ["query.sql", null, "code"],
    ["readme.md", "text/markdown", "code"],
    ["De.zip", null, "archive"],
    ["bundle.7z", "application/octet-stream", "archive"],
    ["voice.mp3", null, "audio"],
    ["clip", "video/mp4", "video"],
    ["unknown.bin", null, "generic"],
    ["no-extension", "", "generic"],
    // A specific MIME wins over a misleading name.
    ["report.txt", "application/pdf", "pdf"],
  ] as const)("%s (%s) → %s", (name, mediaType, kind) => {
    expect(resolveFileVisualKind(name, mediaType)).toBe(kind);
  });

  it("reads extensions case-insensitively and ignores dotfiles and paths", () => {
    expect(fileExtension("C:\\tmp\\Bai.DOCX")).toBe("docx");
    expect(fileExtension(".env")).toBe("");
    expect(fileExtension("trailing.")).toBe("");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
  });

  it("labels badges and friendly formats without raw MIME strings", () => {
    expect(fileBadgeLabel("De.pdf")).toBe("PDF");
    expect(fileBadgeLabel("Bai.docx")).toBe("DOC");
    expect(fileBadgeLabel("Diem.xlsx")).toBe("XLS");
    expect(fileBadgeLabel("lop.csv", "text/csv")).toBe("CSV");
    expect(fileBadgeLabel("Slide.pptx")).toBe("PPT");
    expect(fileBadgeLabel("Hinh.png")).toBeNull();
    expect(
      fileFormatLabel(
        "Bai tap",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("DOC");
    expect(fileFormatLabel("Bai tap.docx")).toBe("DOCX");
    expect(fileFormatLabel("scan", "application/pdf")).toBe("PDF");
    expect(fileFormatLabel("photo", "image/jpeg")).toBe("JPG");
    expect(fileFormatLabel("blob", "application/octet-stream")).toBeNull();
  });
});

describe("FileTypeIcon", () => {
  afterEach(() => cleanup());

  it.each([
    ["De.pdf", "application/pdf", "pdf", "PDF"],
    ["Bai.docx", null, "word", "DOC"],
    ["Diem.xlsx", null, "excel", "XLS"],
    ["Slide.pptx", null, "powerpoint", "PPT"],
    ["Hinh.png", "image/png", "image", null],
    ["main.py", null, "code", null],
    ["De.zip", null, "archive", null],
  ] as const)(
    "renders a decorative %s tile",
    (fileName, mediaType, kind, badge) => {
      const { container } = render(
        <FileTypeIcon fileName={fileName} mediaType={mediaType} />,
      );
      const tile = container.querySelector(".file-type-icon");
      expect(tile).toHaveAttribute("aria-hidden", "true");
      expect(tile).toHaveAttribute("data-file-kind", kind);
      expect(tile).toHaveClass("file-type-icon--md");
      expect(tile?.querySelector("svg")).not.toBeNull();
      const label = tile?.querySelector(".file-type-icon__badge");
      if (badge) expect(label).toHaveTextContent(badge);
      else expect(label).toBeNull();
    },
  );

  it("drops the badge on the 16px inline size", () => {
    const { container } = render(
      <FileTypeIcon className="extra" fileName="De.pdf" size="sm" />,
    );
    const tile = container.querySelector(".file-type-icon");
    expect(tile).toHaveClass("file-type-icon--sm", "extra");
    expect(tile?.querySelector(".file-type-icon__badge")).toBeNull();
  });
});
