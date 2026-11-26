import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CanonicalPdfAnnotationAuthority,
  decodeStroke,
  dequantizeCoordinate,
  encodeStroke,
  isTrustedPresenterAwareness,
  PDF_ANNOTATION_LIMITS,
  PdfAnnotationAuthorityError,
  quantizeCoordinate,
  simplifyStroke,
  type PdfAnnotationCapability,
  type PdfAnnotationErrorCode,
  type PdfStrokeInput,
} from "./pdfAnnotationAuthority";
import { derivePdfProviderDocumentName } from "./pdfAnnotationSession";
import { deriveCodeProviderDocumentName } from "./codeWorkspaceSession";
import { deriveProviderDocumentName } from "./browserSession";

const PRESENTATION_ID = "8c40ee79-5d4a-4d53-8845-6d295958dd42";
const FILE_ID = "1f0c3a52-7e1b-4f6a-9d5c-2b8e4a6c0d17";
const SCOPE = {
  documentId: PRESENTATION_ID,
  generation: 1,
  tenantId: "tenant-a",
};
const BINDING = { fileId: FILE_ID, pageCount: 6, versionId: "version-7" };
const TEACHER = "teacher-actor-0001";
const STUDENT = "student-actor-0002";

function newAuthority(
  document: Y.Doc,
  actorId: string,
  capability: PdfAnnotationCapability,
): CanonicalPdfAnnotationAuthority {
  let counter = 0;
  return new CanonicalPdfAnnotationAuthority(document, SCOPE, actorId, {
    capability,
    newStrokeId: () =>
      `${String(Date.now()).padStart(13, "0")}${actorId.slice(0, 3)}${String(++counter).padStart(6, "0")}`,
  });
}

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(
    to,
    Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)),
    "remote",
  );
}

function syncBoth(left: Y.Doc, right: Y.Doc): void {
  sync(left, right);
  sync(right, left);
}

function line(count = 2, tool: PdfStrokeInput["tool"] = "pen"): PdfStrokeInput {
  return {
    points: Array.from({ length: count }, (_, index) => ({
      x: 0.1 + (0.8 * index) / Math.max(1, count - 1),
      y: 0.2 + 0.3 * Math.sin(index / 3),
    })),
    tone: 3,
    tool,
    width: "m",
  };
}

function expectCode(action: () => unknown, code: PdfAnnotationErrorCode): void {
  expect(action).toThrowError(
    expect.objectContaining({ code }) as unknown as PdfAnnotationAuthorityError,
  );
}

function presenterSetup() {
  const teacherDoc = new Y.Doc();
  const teacher = newAuthority(teacherDoc, TEACHER, "present");
  teacher.initialize(BINDING);
  return { teacher, teacherDoc };
}

describe("CanonicalPdfAnnotationAuthority (pdf.annotations.v1)", () => {
  it("derives a disjoint pd_ provider name from the opaque presentation id", () => {
    const name = derivePdfProviderDocumentName(PRESENTATION_ID);
    expect(name).toBe("pd_8c40ee795d4a4d5388456d295958dd42");
    expect(name).not.toBe(deriveProviderDocumentName(PRESENTATION_ID));
    expect(name).not.toBe(deriveCodeProviderDocumentName(PRESENTATION_ID));
    expect(() => derivePdfProviderDocumentName("not-a-uuid")).toThrow(
      "collaboration_document_id_invalid",
    );
  });

  it("initializes meta and every page map once, presenter only, within one bounded update", () => {
    const document = new Y.Doc();
    const updates: number[] = [];
    document.on("update", (update: Uint8Array) =>
      updates.push(update.byteLength),
    );
    const editor = newAuthority(document, STUDENT, "edit");
    expectCode(() => editor.initialize(BINDING), "authority_not_presenter");
    const viewer = newAuthority(document, STUDENT, "view");
    expectCode(() => viewer.initialize(BINDING), "authority_read_only");

    const teacher = newAuthority(document, TEACHER, "present");
    expectCode(
      () => teacher.initialize({ ...BINDING, pageCount: 301 }),
      "binding_invalid",
    );
    expectCode(
      () => teacher.initialize({ ...BINDING, fileId: "nope" }),
      "binding_invalid",
    );
    teacher.initialize({ ...BINDING, pageCount: 300 });
    expectCode(
      () => teacher.initialize(BINDING),
      "authority_already_initialized",
    );
    expect(teacher.binding()).toEqual({ ...BINDING, pageCount: 300 });
    expect(document.getMap("pages").size).toBe(300);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toBeLessThan(32 * 1024);
    expect(teacher.metaState()).toEqual({
      followLock: false,
      hiddenPages: [],
      pageCount: 300,
      presenterPage: 1,
    });
    expect(teacher.violation()).toBeNull();
  });

  it("quantizes page-normalized coordinates to uint16 and round-trips within one quantum", () => {
    expect(quantizeCoordinate(0)).toBe(0);
    expect(quantizeCoordinate(1)).toBe(65_535);
    expect(quantizeCoordinate(0.5)).toBe(32_768);
    expect(quantizeCoordinate(-0.2)).toBe(0);
    expect(quantizeCoordinate(1.3)).toBe(65_535);
    expectCode(() => quantizeCoordinate(Number.NaN), "stroke_invalid");
    for (const value of [0.0001, 0.123456, 0.5, 0.987654]) {
      expect(
        Math.abs(dequantizeCoordinate(quantizeCoordinate(value)) - value),
      ).toBeLessThanOrEqual(1 / 65_535);
    }
  });

  it("simplifies strokes with Ramer–Douglas–Peucker and never exceeds 2,000 points", () => {
    const straight = Array.from({ length: 1_000 }, (_, index) => ({
      x: index / 999,
      y: index / 999,
    }));
    const simplified = simplifyStroke(straight);
    expect(simplified).toEqual([straight[0], straight[999]]);

    const noisy = Array.from({ length: 5_000 }, (_, index) => ({
      x: index / 4_999,
      y: 0.5 + (index % 2 === 0 ? 0.01 : -0.01) * Math.sin(index),
    }));
    const bounded = simplifyStroke(noisy);
    expect(bounded.length).toBeLessThanOrEqual(
      PDF_ANNOTATION_LIMITS.maxPointsPerStroke,
    );
    expect(bounded[0]).toEqual(noisy[0]);
    expect(bounded[bounded.length - 1]).toEqual(noisy[4_999]);
    expectCode(
      () => simplifyStroke([{ x: Number.POSITIVE_INFINITY, y: 0 }]),
      "stroke_invalid",
    );
  });

  it("encodes strokes deterministically and rejects malformed encodings", () => {
    const stroke = {
      actorId: TEACHER,
      points: [
        [0, 0],
        [65_535, 65_535],
        [100, 200],
      ] as Array<[number, number]>,
      tone: 7,
      tool: "highlighter" as const,
      width: "l" as const,
    };
    const encoded = encodeStroke(stroke);
    expect(encodeStroke(stroke)).toBe(encoded);
    expect(encoded.startsWith(`1|highlighter|7|l|${TEACHER}|`)).toBe(true);
    expect(decodeStroke(encoded)).toEqual(stroke);
    for (const forged of [
      encoded.replace("|7|", "|9|"),
      encoded.replace("highlighter", "laser"),
      encoded.replace(`|${TEACHER}|`, "|bad|actor|"),
      `${encoded}=`,
      `${encoded}A`,
      "2|pen|0|s|teacher-actor-0001|AAAAAA",
      42,
    ]) {
      expect(decodeStroke(forged)).toBeNull();
    }
  });

  it("syncs strokes between two Y.Docs and keeps every transaction under 32 KiB", () => {
    const { teacher, teacherDoc } = presenterSetup();
    const studentDoc = new Y.Doc();
    sync(teacherDoc, studentDoc);
    const student = newAuthority(studentDoc, STUDENT, "edit");
    expect(student.binding()).toEqual(BINDING);

    const updates: number[] = [];
    teacherDoc.on("update", (update: Uint8Array) =>
      updates.push(update.byteLength),
    );
    const denseNoise: PdfStrokeInput = {
      points: Array.from({ length: 5_000 }, () => ({
        x: Math.random(),
        y: Math.random(),
      })),
      tone: 1,
      tool: "pen",
      width: "s",
    };
    const [heavy] = teacher.addStrokes(2, [denseNoise]);
    const batch = teacher.addStrokes(
      3,
      Array.from({ length: 40 }, () => line(400)),
    );
    expect(batch).toHaveLength(40);
    expect(updates.length).toBeGreaterThan(2);
    expect(Math.max(...updates)).toBeLessThan(32 * 1024);

    sync(teacherDoc, studentDoc);
    const remote = student.strokes(2);
    expect(remote).toHaveLength(1);
    expect(remote[0]?.id).toBe(heavy);
    expect(remote[0]?.actorId).toBe(TEACHER);
    expect(remote[0]?.points.length).toBeLessThanOrEqual(2_000);
    expect(student.strokes(3)).toHaveLength(40);
    expect(student.strokes(2)).toEqual(teacher.strokes(2));
  });

  it("isolates undo/redo per actor and limits erasing to own strokes for edit", () => {
    const { teacher, teacherDoc } = presenterSetup();
    const studentDoc = new Y.Doc();
    sync(teacherDoc, studentDoc);
    const student = newAuthority(studentDoc, STUDENT, "edit");

    const teacherStroke = teacher.addStroke(1, line(10));
    const studentStroke = student.addStroke(1, line(12, "highlighter"));
    syncBoth(teacherDoc, studentDoc);
    expect(
      student
        .strokes(1)
        .map((stroke) => stroke.id)
        .sort(),
    ).toEqual([teacherStroke, studentStroke].sort());

    expect(student.undoLast()).toBe(true);
    syncBoth(teacherDoc, studentDoc);
    expect(teacher.strokes(1).map((stroke) => stroke.id)).toEqual([
      teacherStroke,
    ]);
    expect(student.canUndo()).toBe(false);
    expect(student.redoLast()).toBe(true);
    syncBoth(teacherDoc, studentDoc);
    expect(teacher.strokes(1)).toHaveLength(2);

    expectCode(
      () => student.eraseOwnStroke(1, teacherStroke),
      "stroke_not_owned",
    );
    expectCode(
      () => student.eraseOwnStroke(1, "missingstroke01"),
      "stroke_not_found",
    );
    student.eraseOwnStroke(1, studentStroke);
    syncBoth(teacherDoc, studentDoc);
    expect(teacher.strokes(1).map((stroke) => stroke.id)).toEqual([
      teacherStroke,
    ]);

    const second = student.addStroke(1, line(5));
    syncBoth(teacherDoc, studentDoc);
    teacher.eraseOwnStroke(1, second);
    expect(teacher.undoLast()).toBe(true);
    expect(
      teacher
        .strokes(1)
        .map((stroke) => stroke.id)
        .sort(),
    ).toEqual([teacherStroke, second].sort());
    expectCode(() => student.clearPageStrokes(1), "authority_not_presenter");
    expect(teacher.clearPageStrokes(1)).toBe(2);
    expect(teacher.strokes(1)).toEqual([]);
  });

  it("never emits a transaction from a view client", () => {
    const { teacherDoc } = presenterSetup();
    const viewerDoc = new Y.Doc();
    sync(teacherDoc, viewerDoc);
    const viewer = newAuthority(viewerDoc, STUDENT, "view");
    let updates = 0;
    viewerDoc.on("update", () => {
      updates += 1;
    });
    expectCode(() => viewer.addStroke(1, line()), "authority_read_only");
    expectCode(
      () => viewer.eraseOwnStroke(1, "anystrokeid01"),
      "authority_read_only",
    );
    expectCode(() => viewer.clearPageStrokes(1), "authority_read_only");
    expectCode(() => viewer.setPresenterPage(2), "authority_read_only");
    expectCode(() => viewer.undoLast(), "authority_read_only");
    expect(viewer.canUndo()).toBe(false);
    expect(updates).toBe(0);
    expect(viewer.metaState().pageCount).toBe(6);
  });

  it("enforces 400 strokes per page and 2,000 strokes per document", () => {
    const document = new Y.Doc();
    const teacher = newAuthority(document, TEACHER, "present");
    teacher.initialize({ ...BINDING, pageCount: 6 });
    teacher.addStrokes(
      1,
      Array.from({ length: 400 }, () => line(2)),
    );
    expectCode(() => teacher.addStroke(1, line(2)), "page_stroke_limit");
    for (const page of [2, 3, 4, 5]) {
      teacher.addStrokes(
        page,
        Array.from({ length: 400 }, () => line(2)),
      );
    }
    expect(teacher.usage().strokes).toBe(2_000);
    expectCode(() => teacher.addStroke(6, line(2)), "document_stroke_limit");
    expect(teacher.violation()).toBeNull();
    expect(Y.encodeStateAsUpdate(document).byteLength).toBeLessThan(
      1024 * 1024,
    );
    expectCode(() => teacher.addStroke(7, line(2)), "page_invalid");
    expectCode(
      () => teacher.addStroke(1, { ...line(2), tone: 8 }),
      "stroke_invalid",
    );
  });

  it("restricts presenter meta to present capability and normalizes hidden pages", () => {
    const { teacher, teacherDoc } = presenterSetup();
    teacher.setPresenterPage(4);
    teacher.setFollowLock(true);
    teacher.setHiddenPages([5, 2, 5]);
    expectCode(() => teacher.setPresenterPage(7), "page_invalid");
    expectCode(() => teacher.setHiddenPages([0]), "page_invalid");
    expect(teacher.metaState()).toEqual({
      followLock: true,
      hiddenPages: [2, 5],
      pageCount: 6,
      presenterPage: 4,
    });
    expect(teacher.canUndo()).toBe(false);

    const studentDoc = new Y.Doc();
    sync(teacherDoc, studentDoc);
    const student = newAuthority(studentDoc, STUDENT, "edit");
    expectCode(() => student.setPresenterPage(1), "authority_not_presenter");
    expectCode(() => student.setFollowLock(false), "authority_not_presenter");
    expect(student.metaState().presenterPage).toBe(4);

    // A forged out-of-range peer value is clamped on read, never trusted.
    studentDoc.getMap("meta").set("presenterPage", 99);
    expect(student.metaState().presenterPage).toBe(1);
  });

  it("ignores malformed peer strokes and reports a violation", () => {
    const { teacherDoc } = presenterSetup();
    const studentDoc = new Y.Doc();
    sync(teacherDoc, studentDoc);
    const student = newAuthority(studentDoc, STUDENT, "edit");
    const violations: PdfAnnotationErrorCode[] = [];
    student.onViolation((code) => violations.push(code));
    const page = teacherDoc.getMap("pages").get("p:1") as Y.Map<string>;
    teacherDoc.transact(() => page.set("forgedstroke01", "not-a-stroke"));
    sync(teacherDoc, studentDoc);
    expect(student.strokes(1)).toEqual([]);
    expect(violations).toEqual(["stroke_invalid"]);
    expect(() =>
      student.assertBinding({ ...BINDING, versionId: "other" }),
    ).toThrowError(
      expect.objectContaining({
        code: "document_mismatch",
      }) as unknown as Error,
    );
  });

  it("trusts presenter awareness only when the runtime stamped present", () => {
    expect(
      isTrustedPresenterAwareness({ tutorhub: { capability: "present" } }),
    ).toBe(true);
    expect(
      isTrustedPresenterAwareness({ tutorhub: { capability: "edit" } }),
    ).toBe(false);
    expect(isTrustedPresenterAwareness({ capability: "present" })).toBe(false);
    expect(isTrustedPresenterAwareness(null)).toBe(false);
  });
});
