package stickers

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestEmbeddedCatalogIsValidCuratedAndBacked(t *testing.T) {
	t.Parallel()
	catalog, err := Default()
	if err != nil {
		t.Fatalf("embedded catalog: %v", err)
	}
	published := catalog.Published()
	if published.CatalogVersion == "" || published.CatalogVersion != catalog.Version() {
		t.Fatalf("catalog version = %q / %q", published.CatalogVersion, catalog.Version())
	}
	if len(published.Packs) != 1 || published.Packs[0].ID != "noto_animated" ||
		published.Packs[0].Version != "v1" {
		t.Fatalf("unexpected packs: %+v", published.Packs)
	}
	pack := published.Packs[0]
	if count := len(pack.Stickers); count < 80 || count > 120 {
		t.Fatalf("curated sticker count = %d, want 80-120 (ADR-0047 Q3)", count)
	}
	attribution := pack.Attribution
	if attribution.License != "CC BY 4.0" ||
		attribution.URL != "https://creativecommons.org/licenses/by/4.0/" ||
		attribution.NoticesPath != "/THIRD_PARTY_NOTICES.txt" ||
		!strings.Contains(attribution.Text, "Noto Emoji Animation") {
		t.Fatalf("pack must carry the CC BY 4.0 attribution: %+v", attribution)
	}
	animated := regexp.MustCompile(`^/stickers/noto_animated/v1/[a-z0-9_-]{1,64}\.webp$`)
	still := regexp.MustCompile(`^/stickers/noto_animated/v1/[a-z0-9_-]{1,64}\.static\.webp$`)
	root := filepath.Join("..", "..", "..", "..", "..", "..", "apps", "web", "public")
	for _, sticker := range pack.Stickers {
		if !ValidID(sticker.ID) || !strings.HasPrefix(sticker.ID, "noto_animated:") {
			t.Fatalf("invalid sticker id %q", sticker.ID)
		}
		if sticker.Labels.VI == "" || sticker.Labels.EN == "" ||
			len(sticker.Keywords.VI) == 0 || len(sticker.Keywords.EN) == 0 {
			t.Fatalf("sticker %q needs bilingual labels and keywords", sticker.ID)
		}
		asset := sticker.Asset
		if !animated.MatchString(asset.AnimatedURL) || !still.MatchString(asset.StaticURL) ||
			asset.Width != 160 || asset.Height != 160 || !sticker.Animated {
			t.Fatalf("sticker %q asset = %+v", sticker.ID, asset)
		}
		// The generator writes catalog.json and the WebP files together.
		for _, url := range []string{asset.AnimatedURL, asset.StaticURL} {
			info, err := os.Stat(filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(url, "/"))))
			if err != nil || info.Size() == 0 {
				t.Fatalf("sticker %q asset %s is missing: %v", sticker.ID, url, err)
			}
		}
		if !catalog.Sendable(sticker.ID) {
			t.Fatalf("published sticker %q must be sendable", sticker.ID)
		}
	}
	if etag := catalog.ETag(); !regexp.MustCompile(`^"stickers-[0-9a-f]{32}"$`).MatchString(etag) {
		t.Fatalf("etag = %q", etag)
	}
	again, err := Parse(catalogJSON)
	if err != nil || again.ETag() != catalog.ETag() {
		t.Fatalf("etag must be deterministic: %v", err)
	}
}

func TestValidIDMatchesTheStoredShape(t *testing.T) {
	t.Parallel()
	for _, id := range []string{"noto_animated:1f602", "a:b", "p_1:x-y_z", strings.Repeat("a", 32) + ":" + strings.Repeat("b", 64)} {
		if !ValidID(id) {
			t.Fatalf("ValidID(%q) = false", id)
		}
	}
	for _, id := range []string{
		"", "a:", ":b", "ab", "noto_animated", "Noto:1f602", "noto:1F602", "noto:1f602.webp",
		"noto:../x", "noto:a/b", "a:b:c", strings.Repeat("a", 33) + ":b", "a:" + strings.Repeat("b", 65),
	} {
		if ValidID(id) {
			t.Fatalf("ValidID(%q) = true", id)
		}
	}
}

func lifecycleManifest(statuses map[string]Status) []byte {
	entries := []Sticker{}
	for _, name := range []string{"a", "b", "c"} {
		entries = append(entries, Sticker{
			ID: "pack:" + name, Labels: LocalizedText{VI: "Nhãn " + name, EN: "Label " + name},
			Keywords: LocalizedKeywords{VI: []string{"từ"}, EN: []string{"word"}},
			Width:    160, Height: 160, Animated: true, Status: statuses[name],
		})
	}
	document := manifest{CatalogVersion: "test.1", Packs: []Pack{{
		ID: "pack", Version: "v2", Title: LocalizedText{VI: "Bộ", EN: "Pack"},
		Attribution: Attribution{
			Text: "Test art, CC BY 4.0", License: "CC BY 4.0",
			URL: "https://creativecommons.org/licenses/by/4.0/", NoticesPath: "/THIRD_PARTY_NOTICES.txt",
		},
		Stickers: entries,
	}}}
	data, _ := json.Marshal(document)
	return data
}

func TestLifecycleControlsPickerSendAndProjection(t *testing.T) {
	t.Parallel()
	catalog, err := Parse(lifecycleManifest(map[string]Status{
		"a": StatusActive, "b": StatusRetired, "c": StatusRemoved,
	}))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	published := catalog.Published()
	if len(published.Packs) != 1 || len(published.Packs[0].Stickers) != 1 ||
		published.Packs[0].Stickers[0].ID != "pack:a" {
		t.Fatalf("only active stickers are published: %+v", published)
	}
	if got := published.Packs[0].Stickers[0].Asset; got.AnimatedURL != "/stickers/pack/v2/a.webp" ||
		got.StaticURL != "/stickers/pack/v2/a.static.webp" {
		t.Fatalf("asset urls = %+v", got)
	}
	if !catalog.Sendable("pack:a") || catalog.Sendable("pack:b") ||
		catalog.Sendable("pack:c") || catalog.Sendable("pack:z") {
		t.Fatal("only active stickers are sendable")
	}
	for _, id := range []string{"pack:b", "pack:c"} {
		if _, ok := catalog.Lookup(id); !ok {
			t.Fatalf("%s must stay resolvable for history", id)
		}
	}

	retiredOnly, err := Parse(lifecycleManifest(map[string]Status{
		"a": StatusRetired, "b": StatusRemoved, "c": StatusRetired,
	}))
	if err != nil {
		t.Fatalf("parse retired pack: %v", err)
	}
	if packs := retiredOnly.Published().Packs; len(packs) != 0 {
		t.Fatalf("a pack without active stickers must be hidden: %+v", packs)
	}

	var nilCatalog *Catalog
	if _, ok := nilCatalog.Lookup("pack:a"); ok || nilCatalog.Sendable("pack:a") ||
		nilCatalog.ETag() != "" || len(nilCatalog.Published().Packs) != 0 {
		t.Fatal("a nil catalog resolves nothing")
	}
}

func TestParseRejectsMalformedCatalogs(t *testing.T) {
	t.Parallel()
	valid := string(lifecycleManifest(map[string]Status{"a": StatusActive, "b": StatusActive, "c": StatusActive}))
	cases := map[string]string{
		"unknown field":    strings.Replace(valid, `"catalog_version"`, `"extra":1,"catalog_version"`, 1),
		"duplicate id":     strings.Replace(valid, `"pack:b"`, `"pack:a"`, 1),
		"foreign prefix":   strings.Replace(valid, `"pack:b"`, `"other:b"`, 1),
		"bad status":       strings.Replace(valid, `"status":"active"`, `"status":"hidden"`, 1),
		"empty label":      strings.Replace(valid, `"Label a"`, `""`, 1),
		"bad version":      strings.Replace(valid, `"v2"`, `"2"`, 1),
		"plain http terms": strings.Replace(valid, `"https://creativecommons.org/licenses/by/4.0/"`, `"http://example.test"`, 1),
		"trailing data":    valid + `{}`,
		"no packs":         `{"catalog_version":"x","packs":[]}`,
		"oversized":        strings.Replace(valid, `"width":160`, `"width":4096`, 1),
	}
	for name, body := range cases {
		if _, err := Parse([]byte(body)); !errors.Is(err, ErrInvalidCatalog) {
			t.Fatalf("%s: err = %v, want ErrInvalidCatalog", name, err)
		}
	}
}
