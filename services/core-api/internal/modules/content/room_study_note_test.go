package content

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestNormalizeStudyNote(t *testing.T) {
	entries := []StudyNoteEntry{{3, "  ý\r\n2\r3  \t"}, {0, " \n"}, {1, "<x>"}, {3, ""}}
	want := []StudyNoteEntry{{1, "<x>"}, {3, "  ý\n2\n3"}}
	got, encoded, n, err := normalizeStudyNote(entries, 3)
	if err != nil || !reflect.DeepEqual(got, want) || n != len(want[0].Text)+len(want[1].Text) ||
		encoded != `[{"page":1,"text":"<x>"},{"page":3,"text":"  ý\n2\n3"}]` {
		t.Fatalf("normalized=%+v encoded=%q bytes=%d err=%v", got, encoded, n, err)
	}
	got, encoded, n, err = normalizeStudyNote([]StudyNoteEntry{{7, "\t\r\n"}}, 1)
	if err != nil || got == nil || len(got) != 0 || n != 0 || encoded != "[]" {
		t.Fatalf("empty=%+v encoded=%q bytes=%d err=%v", got, encoded, n, err)
	}
}

func TestNormalizeStudyNoteBounds(t *testing.T) {
	multiPage := func(count int, text string) []StudyNoteEntry {
		entries := make([]StudyNoteEntry, count)
		for i := range entries {
			entries[i] = StudyNoteEntry{i + 1, text}
		}
		return entries
	}
	chunk := strings.Repeat("🎓", 1024)
	if _, _, n, err := normalizeStudyNote(multiPage(16, chunk), 16); err != nil || n != 65536 {
		t.Fatalf("64 KiB boundary: bytes=%d err=%v", n, err)
	}
	for name, entries := range map[string][]StudyNoteEntry{
		"missing":                     nil,
		"zero page":                   {{0, "x"}},
		"past last page":              {{18, "x"}},
		"duplicate page":              {{1, "A"}, {1, "B"}},
		"NUL":                         {{1, "x\x00"}},
		"invalid UTF-8":               {{1, string([]byte{0xff})}},
		"too many runes":              {{1, strings.Repeat("a", 2001)}},
		"too many page bytes":         {{1, chunk + "A"}},
		"too many total bytes":        append(multiPage(16, chunk), StudyNoteEntry{17, "A"}),
		"encoded JSON exceeds column": multiPage(10, strings.Repeat("\x01", 2000)),
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, _, err := normalizeStudyNote(entries, 17); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("err=%v, want invalid input", err)
			}
		})
	}
}
