import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CanonicalCodeWorkspaceAuthority,
  CODE_WORKSPACE_LANGUAGES,
  CODE_WORKSPACE_LIMITS,
} from "./codeWorkspaceAuthority.js";
import {
  PORTABLE_CODE_WORKSPACE_FORMAT,
  PORTABLE_CODE_WORKSPACE_LANGUAGES,
  PORTABLE_CODE_WORKSPACE_LIMITS,
  PortableCodeWorkspaceError,
  exportPortableCodeWorkspace,
  importPortableCodeWorkspace,
  type PortableCodeWorkspaceErrorCode,
  type PortableCodeWorkspaceSnapshot,
} from "./portableCodeWorkspace.js";

const exportedAt = "2030-08-03T00:00:00.000Z";

const snapshot: PortableCodeWorkspaceSnapshot = {
  activeIndex: 1,
  files: [
    { content: "print(input())\n", language: "python", name: "main.py" },
    {
      content: '<b class="x">Xin chào & tạm biệt</b>\n',
      language: "html",
      name: "index.html",
    },
  ],
  stdin: "42\n",
};

async function expectCode(
  promise: Promise<unknown>,
  code: PortableCodeWorkspaceErrorCode,
): Promise<void> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(PortableCodeWorkspaceError);
  expect((failure as PortableCodeWorkspaceError).code).toBe(code);
}

async function exportedJson(): Promise<string> {
  return (
    await exportPortableCodeWorkspace(snapshot, {
      exportedAt,
      title: "Bài 1",
    })
  ).json;
}

function mutate(
  json: string,
  change: (envelope: Record<string, unknown>) => void,
): string {
  const envelope = JSON.parse(json) as Record<string, unknown>;
  change(envelope);
  return JSON.stringify(envelope);
}

describe("ROOM-TOOLS-CODE-03A portable code workspace", () => {
  it("stays aligned with the code.workspace.v1 authority bounds", () => {
    expect(PORTABLE_CODE_WORKSPACE_LANGUAGES).toEqual(CODE_WORKSPACE_LANGUAGES);
    expect(PORTABLE_CODE_WORKSPACE_LIMITS.maxFiles).toBe(
      CODE_WORKSPACE_LIMITS.maxFiles,
    );
    expect(PORTABLE_CODE_WORKSPACE_LIMITS.maxFileBytes).toBe(
      CODE_WORKSPACE_LIMITS.maxFileBytes,
    );
    expect(PORTABLE_CODE_WORKSPACE_LIMITS.maxTotalBytes).toBe(
      CODE_WORKSPACE_LIMITS.maxTotalBytes,
    );
    expect(PORTABLE_CODE_WORKSPACE_LIMITS.maxFileNameLength).toBe(
      CODE_WORKSPACE_LIMITS.maxFileNameLength,
    );
  });

  it("round-trips with a canonical, deterministic SHA-256 seal", async () => {
    const first = await exportPortableCodeWorkspace(snapshot, {
      exportedAt,
      title: "Bài 1",
    });
    expect(first.contentSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(JSON.parse(first.json) as object)).toEqual([
      "contentSha256",
      "exportedAt",
      "format",
      "schemaVersion",
      "title",
      "workspace",
    ]);
    expect(first.json).not.toMatch(/\n\s/);
    expect(first.json).toContain(
      `"format":"${PORTABLE_CODE_WORKSPACE_FORMAT}"`,
    );
    expect(new TextDecoder().decode(first.bytes)).toBe(first.json);

    const later = await exportPortableCodeWorkspace(snapshot, {
      exportedAt: "2031-01-01T00:00:00.000Z",
      title: "Bài 1",
    });
    expect(later.contentSha256).toBe(first.contentSha256);

    for (const raw of [first.json, first.bytes, first.bytes.slice().buffer]) {
      const imported = await importPortableCodeWorkspace(raw);
      expect(imported.snapshot).toEqual(snapshot);
      expect(imported.title).toBe("Bài 1");
      expect(imported.exportedAt).toBe(exportedAt);
      expect(imported.contentSha256).toBe(first.contentSha256);
      expect(Object.isFrozen(imported.snapshot.files)).toBe(true);
    }
  });

  it("exports the live Yjs authority snapshot unchanged", async () => {
    const document = new Y.Doc();
    const authority = new CanonicalCodeWorkspaceAuthority(
      document,
      {
        documentId: "8c40ee79-5d4a-4d53-8845-6d295958dd42",
        generation: 1,
        tenantId: "tenant-a",
      },
      "teacher-actor-0001",
    );
    authority.initialize([
      { content: "SELECT 1;", language: "sql", name: "query.sql" },
    ]);
    const live = authority.snapshot();
    const exported = await exportPortableCodeWorkspace(live, { exportedAt });
    const imported = await importPortableCodeWorkspace(exported.bytes);
    expect(imported.snapshot).toEqual(live);
    authority.destroy();
    document.destroy();
  });

  it("detects a single changed character as checksum_mismatch", async () => {
    const json = await exportedJson();
    const tampered = json.replace("print(input())", "print(inputs)");
    expect(tampered).not.toBe(json);
    await expectCode(
      importPortableCodeWorkspace(tampered),
      "checksum_mismatch",
    );
    await expectCode(
      importPortableCodeWorkspace(
        mutate(json, (envelope) => {
          envelope.title = "Bài 2";
        }),
      ),
      "checksum_mismatch",
    );
    await expectCode(
      importPortableCodeWorkspace(
        mutate(json, (envelope) => {
          (envelope.workspace as Record<string, unknown>).activeIndex = 0;
        }),
      ),
      "checksum_mismatch",
    );
    await expectCode(
      importPortableCodeWorkspace(
        mutate(json, (envelope) => {
          envelope.contentSha256 = `sha256:${"0".repeat(64)}`;
        }),
      ),
      "checksum_mismatch",
    );
  });

  it("rejects junk, foreign formats and prototype-polluting keys fail-closed", async () => {
    const json = await exportedJson();
    await expectCode(importPortableCodeWorkspace(""), "portable_corrupt");
    await expectCode(
      importPortableCodeWorkspace("{not json"),
      "portable_corrupt",
    );
    await expectCode(importPortableCodeWorkspace("[]"), "portable_corrupt");
    await expectCode(importPortableCodeWorkspace("null"), "portable_corrupt");
    await expectCode(
      importPortableCodeWorkspace(new Uint8Array([0xff, 0xfe, 0x7b])),
      "portable_corrupt",
    );
    await expectCode(
      importPortableCodeWorkspace(
        mutate(json, (envelope) => {
          envelope.format = "tutorhub.excalidraw.portable-scene";
        }),
      ),
      "portable_format_unsupported",
    );
    await expectCode(
      importPortableCodeWorkspace(
        mutate(json, (envelope) => {
          envelope.schemaVersion = 2;
        }),
      ),
      "portable_format_unsupported",
    );
    await expectCode(
      importPortableCodeWorkspace(
        mutate(json, (envelope) => {
          envelope.extra = true;
        }),
      ),
      "portable_corrupt",
    );
    await expectCode(
      importPortableCodeWorkspace(
        json.replace('"title":', '"__proto__":{"polluted":true},"title":'),
      ),
      "portable_unsafe_key",
    );
    await expectCode(
      importPortableCodeWorkspace(
        json.replace('"stdin":', '"constructor":{"prototype":{}},"stdin":'),
      ),
      "portable_unsafe_key",
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await expectCode(
      importPortableCodeWorkspace(
        mutate(json, (envelope) => {
          envelope.exportedAt = "yesterday";
        }),
      ),
      "portable_corrupt",
    );
  });

  it("enforces the envelope, file count, name, language and byte ceilings", async () => {
    await expectCode(
      importPortableCodeWorkspace(
        " ".repeat(PORTABLE_CODE_WORKSPACE_LIMITS.maxEnvelopeBytes + 1),
      ),
      "portable_too_large",
    );
    await expectCode(
      importPortableCodeWorkspace(
        new Uint8Array(PORTABLE_CODE_WORKSPACE_LIMITS.maxEnvelopeBytes + 1),
      ),
      "portable_too_large",
    );
    await expectCode(
      importPortableCodeWorkspace(
        "é".repeat(PORTABLE_CODE_WORKSPACE_LIMITS.maxEnvelopeBytes / 2 + 1),
      ),
      "portable_too_large",
    );

    const file = (name: string, content = "") => ({
      content,
      language: "python" as const,
      name,
    });
    const cases: [
      PortableCodeWorkspaceSnapshot,
      PortableCodeWorkspaceErrorCode,
    ][] = [
      [{ activeIndex: 0, files: [], stdin: "" }, "file_limit"],
      [
        {
          activeIndex: 0,
          files: Array.from({ length: 9 }, (_, index) => file(`f${index}.py`)),
          stdin: "",
        },
        "file_limit",
      ],
      [{ activeIndex: 0, files: [file("..")], stdin: "" }, "file_name_invalid"],
      [
        { activeIndex: 0, files: [file("../x.py")], stdin: "" },
        "file_name_invalid",
      ],
      [
        { activeIndex: 0, files: [file("a".repeat(65))], stdin: "" },
        "file_name_invalid",
      ],
      [
        {
          activeIndex: 0,
          files: [file("Main.py"), file("main.PY")],
          stdin: "",
        },
        "file_duplicate_name",
      ],
      [
        {
          activeIndex: 0,
          files: [{ content: "", language: "ruby" as never, name: "a.rb" }],
          stdin: "",
        },
        "file_language_unsupported",
      ],
      [
        {
          activeIndex: 0,
          files: [
            file(
              "a.py",
              "x".repeat(PORTABLE_CODE_WORKSPACE_LIMITS.maxFileBytes + 1),
            ),
          ],
          stdin: "",
        },
        "file_too_large",
      ],
      [
        {
          activeIndex: 0,
          files: Array.from({ length: 5 }, (_, index) =>
            file(
              `f${index}.py`,
              "x".repeat(PORTABLE_CODE_WORKSPACE_LIMITS.maxFileBytes),
            ),
          ),
          stdin: "",
        },
        "workspace_too_large",
      ],
      [
        {
          activeIndex: 0,
          files: [file("a.py")],
          stdin: "s".repeat(PORTABLE_CODE_WORKSPACE_LIMITS.maxStdinBytes + 1),
        },
        "stdin_too_large",
      ],
      [
        { activeIndex: 1, files: [file("a.py")], stdin: "" },
        "active_index_invalid",
      ],
      [
        { activeIndex: 0.5, files: [file("a.py")], stdin: "" },
        "active_index_invalid",
      ],
      [
        { activeIndex: 0, files: [file("a.py", "a\u0000b")], stdin: "" },
        "file_content_invalid",
      ],
      [
        { activeIndex: 0, files: [file("a.py", "\ud800")], stdin: "" },
        "file_content_invalid",
      ],
    ];
    for (const [candidate, code] of cases) {
      await expectCode(
        exportPortableCodeWorkspace(candidate, { exportedAt }),
        code,
      );
    }
    await expectCode(
      exportPortableCodeWorkspace(snapshot, { exportedAt, title: "a\nb" }),
      "title_invalid",
    );
    await expectCode(
      exportPortableCodeWorkspace(snapshot, { exportedAt: "not-a-date" }),
      "portable_corrupt",
    );

    const json = await exportedJson();
    await expectCode(
      importPortableCodeWorkspace(
        mutate(json, (envelope) => {
          const workspace = envelope.workspace as { files: { name: string }[] };
          workspace.files[0]!.name = "../../etc/passwd";
        }),
      ),
      "file_name_invalid",
    );
    await expectCode(
      importPortableCodeWorkspace(
        mutate(json, (envelope) => {
          const workspace = envelope.workspace as {
            files: Record<string, unknown>[];
          };
          workspace.files[0]!.path = "/tmp/x";
        }),
      ),
      "portable_corrupt",
    );

    const full = await exportPortableCodeWorkspace(
      {
        activeIndex: 3,
        files: Array.from({ length: 4 }, (_, index) =>
          file(
            `f${index}.py`,
            "x".repeat(PORTABLE_CODE_WORKSPACE_LIMITS.maxFileBytes),
          ),
        ),
        stdin: "s".repeat(PORTABLE_CODE_WORKSPACE_LIMITS.maxStdinBytes),
      },
      { exportedAt },
    );
    await expect(
      importPortableCodeWorkspace(full.bytes),
    ).resolves.toMatchObject({
      contentSha256: full.contentSha256,
    });
  });
});
