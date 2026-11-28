package stickers

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Status is a sticker's lifecycle state (ADR-0047 §2).
type Status string

const (
	// StatusActive stickers are listed, sendable and projected.
	StatusActive Status = "active"
	// StatusRetired stickers are hidden and unsendable but still projected
	// for historical messages.
	StatusRetired Status = "retired"
	// StatusRemoved stickers (legal takedown) project as unavailable.
	StatusRemoved Status = "removed"
)

const (
	maximumTextRunes      = 64
	maximumKeywordRunes   = 48
	maximumKeywords       = 16
	maximumDimension      = 512
	maximumStickersInPack = 500
	stickerAssetRoot      = "/stickers/"
)

var (
	// ErrInvalidCatalog reports an embedded catalog that failed validation.
	ErrInvalidCatalog = errors.New("invalid sticker catalog")

	stickerIDPattern      = regexp.MustCompile(`^[a-z0-9_]{1,32}:[a-z0-9_-]{1,64}$`)
	packIDPattern         = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)
	packVersionPattern    = regexp.MustCompile(`^v[0-9]{1,4}$`)
	catalogVersionPattern = regexp.MustCompile(`^[0-9A-Za-z._-]{1,64}$`)
)

// LocalizedText is a short Vietnamese and English label.
type LocalizedText struct {
	VI string `json:"vi"`
	EN string `json:"en"`
}

// LocalizedKeywords are search terms per language.
type LocalizedKeywords struct {
	VI []string `json:"vi"`
	EN []string `json:"en"`
}

// Attribution is the license notice a pack must show (CC BY 4.0).
type Attribution struct {
	Text        string `json:"text"`
	License     string `json:"license"`
	URL         string `json:"url"`
	NoticesPath string `json:"notices_path"`
}

// Sticker is one catalog entry.
type Sticker struct {
	ID       string            `json:"id"`
	Labels   LocalizedText     `json:"labels"`
	Keywords LocalizedKeywords `json:"keywords"`
	Width    int               `json:"width"`
	Height   int               `json:"height"`
	Animated bool              `json:"animated"`
	Status   Status            `json:"status"`
}

// Pack groups stickers that share a license and an asset directory.
type Pack struct {
	ID          string        `json:"id"`
	Version     string        `json:"version"`
	Title       LocalizedText `json:"title"`
	Attribution Attribution   `json:"attribution"`
	Stickers    []Sticker     `json:"stickers"`
}

type manifest struct {
	CatalogVersion string `json:"catalog_version"`
	Packs          []Pack `json:"packs"`
}

// Asset is the same-origin image pair the server projects for a sticker;
// clients never derive these URLs themselves.
type Asset struct {
	AnimatedURL string `json:"animated_url"`
	StaticURL   string `json:"static_url"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
}

// Entry is a resolved sticker with its pack and asset URLs.
type Entry struct {
	Sticker
	PackID string
	Asset  Asset
}

// PublishedSticker is an active sticker in the picker catalog response.
type PublishedSticker struct {
	ID       string            `json:"id"`
	Labels   LocalizedText     `json:"labels"`
	Keywords LocalizedKeywords `json:"keywords"`
	Animated bool              `json:"animated"`
	Asset    Asset             `json:"asset"`
}

// PublishedPack is a pack with at least one active sticker.
type PublishedPack struct {
	ID          string             `json:"id"`
	Version     string             `json:"version"`
	Title       LocalizedText      `json:"title"`
	Attribution Attribution        `json:"attribution"`
	Stickers    []PublishedSticker `json:"stickers"`
}

// PublishedCatalog is the GET /api/v1/conversations/sticker-packs body.
type PublishedCatalog struct {
	CatalogVersion string          `json:"catalog_version"`
	Packs          []PublishedPack `json:"packs"`
}

// Catalog is an immutable, validated sticker catalog.
type Catalog struct {
	version   string
	entries   map[string]Entry
	published PublishedCatalog
	etag      string
}

var defaultCatalog, defaultCatalogErr = Parse(catalogJSON)

// Default returns the embedded catalog, parsed and validated once at startup.
func Default() (*Catalog, error) {
	return defaultCatalog, defaultCatalogErr
}

// ValidID reports whether id has the stable sticker ID shape
// (`<pack>:<name>`, 3–97 characters).
func ValidID(id string) bool {
	return len(id) >= 3 && len(id) <= 97 && stickerIDPattern.MatchString(id)
}

// Parse strictly decodes and validates a catalog manifest.
func Parse(data []byte) (*Catalog, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var document manifest
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrInvalidCatalog, err)
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: trailing data", ErrInvalidCatalog)
	}
	if !catalogVersionPattern.MatchString(document.CatalogVersion) {
		return nil, fmt.Errorf("%w: catalog_version %q", ErrInvalidCatalog, document.CatalogVersion)
	}
	if len(document.Packs) == 0 {
		return nil, fmt.Errorf("%w: no packs", ErrInvalidCatalog)
	}
	catalog := &Catalog{
		version:   document.CatalogVersion,
		entries:   make(map[string]Entry),
		published: PublishedCatalog{CatalogVersion: document.CatalogVersion, Packs: []PublishedPack{}},
	}
	packIDs := make(map[string]struct{}, len(document.Packs))
	for _, pack := range document.Packs {
		if err := validatePack(pack); err != nil {
			return nil, err
		}
		if _, duplicate := packIDs[pack.ID]; duplicate {
			return nil, fmt.Errorf("%w: duplicate pack %q", ErrInvalidCatalog, pack.ID)
		}
		packIDs[pack.ID] = struct{}{}
		published := PublishedPack{
			ID: pack.ID, Version: pack.Version, Title: pack.Title,
			Attribution: pack.Attribution, Stickers: []PublishedSticker{},
		}
		for _, sticker := range pack.Stickers {
			if err := validateSticker(pack.ID, sticker); err != nil {
				return nil, err
			}
			if _, duplicate := catalog.entries[sticker.ID]; duplicate {
				return nil, fmt.Errorf("%w: duplicate sticker %q", ErrInvalidCatalog, sticker.ID)
			}
			name := strings.TrimPrefix(sticker.ID, pack.ID+":")
			base := stickerAssetRoot + pack.ID + "/" + pack.Version + "/" + name
			entry := Entry{
				Sticker: sticker,
				PackID:  pack.ID,
				Asset: Asset{
					AnimatedURL: base + ".webp",
					StaticURL:   base + ".static.webp",
					Width:       sticker.Width,
					Height:      sticker.Height,
				},
			}
			catalog.entries[sticker.ID] = entry
			if sticker.Status == StatusActive {
				published.Stickers = append(published.Stickers, PublishedSticker{
					ID: sticker.ID, Labels: sticker.Labels, Keywords: sticker.Keywords,
					Animated: sticker.Animated, Asset: entry.Asset,
				})
			}
		}
		if len(published.Stickers) > 0 {
			catalog.published.Packs = append(catalog.published.Packs, published)
		}
	}
	body, err := json.Marshal(catalog.published)
	if err != nil {
		return nil, fmt.Errorf("%w: encode: %v", ErrInvalidCatalog, err)
	}
	digest := sha256.Sum256(body)
	catalog.etag = `"stickers-` + hex.EncodeToString(digest[:16]) + `"`
	return catalog, nil
}

func validatePack(pack Pack) error {
	if !packIDPattern.MatchString(pack.ID) || !packVersionPattern.MatchString(pack.Version) {
		return fmt.Errorf("%w: pack %q version %q", ErrInvalidCatalog, pack.ID, pack.Version)
	}
	if !validText(pack.Title.VI) || !validText(pack.Title.EN) {
		return fmt.Errorf("%w: pack %q title", ErrInvalidCatalog, pack.ID)
	}
	attribution := pack.Attribution
	if strings.TrimSpace(attribution.Text) == "" || len(attribution.Text) > 512 ||
		strings.TrimSpace(attribution.License) == "" ||
		!strings.HasPrefix(attribution.URL, "https://") ||
		!strings.HasPrefix(attribution.NoticesPath, "/") ||
		strings.HasPrefix(attribution.NoticesPath, "//") {
		return fmt.Errorf("%w: pack %q attribution", ErrInvalidCatalog, pack.ID)
	}
	if len(pack.Stickers) == 0 || len(pack.Stickers) > maximumStickersInPack {
		return fmt.Errorf("%w: pack %q sticker count", ErrInvalidCatalog, pack.ID)
	}
	return nil
}

func validateSticker(packID string, sticker Sticker) error {
	if !ValidID(sticker.ID) || !strings.HasPrefix(sticker.ID, packID+":") {
		return fmt.Errorf("%w: sticker id %q", ErrInvalidCatalog, sticker.ID)
	}
	if !validText(sticker.Labels.VI) || !validText(sticker.Labels.EN) {
		return fmt.Errorf("%w: sticker %q labels", ErrInvalidCatalog, sticker.ID)
	}
	for _, keywords := range [][]string{sticker.Keywords.VI, sticker.Keywords.EN} {
		if len(keywords) > maximumKeywords {
			return fmt.Errorf("%w: sticker %q keywords", ErrInvalidCatalog, sticker.ID)
		}
		for _, keyword := range keywords {
			if strings.TrimSpace(keyword) == "" || !utf8.ValidString(keyword) ||
				utf8.RuneCountInString(keyword) > maximumKeywordRunes {
				return fmt.Errorf("%w: sticker %q keyword %q", ErrInvalidCatalog, sticker.ID, keyword)
			}
		}
	}
	if sticker.Width < 1 || sticker.Width > maximumDimension ||
		sticker.Height < 1 || sticker.Height > maximumDimension {
		return fmt.Errorf("%w: sticker %q dimensions", ErrInvalidCatalog, sticker.ID)
	}
	switch sticker.Status {
	case StatusActive, StatusRetired, StatusRemoved:
	default:
		return fmt.Errorf("%w: sticker %q status %q", ErrInvalidCatalog, sticker.ID, sticker.Status)
	}
	return nil
}

func validText(value string) bool {
	return strings.TrimSpace(value) != "" && utf8.ValidString(value) &&
		utf8.RuneCountInString(value) <= maximumTextRunes
}

// Version is the catalog_version of the manifest.
func (catalog *Catalog) Version() string {
	if catalog == nil {
		return ""
	}
	return catalog.version
}

// Lookup resolves any catalog sticker, whatever its status.
func (catalog *Catalog) Lookup(id string) (Entry, bool) {
	if catalog == nil {
		return Entry{}, false
	}
	entry, ok := catalog.entries[id]
	return entry, ok
}

// Sendable reports whether id names an active sticker.
func (catalog *Catalog) Sendable(id string) bool {
	entry, ok := catalog.Lookup(id)
	return ok && entry.Status == StatusActive
}

// Published returns the picker catalog: packs with active stickers only.
// Callers must treat it as read-only.
func (catalog *Catalog) Published() PublishedCatalog {
	if catalog == nil {
		return PublishedCatalog{Packs: []PublishedPack{}}
	}
	packs := make([]PublishedPack, len(catalog.published.Packs))
	for index, pack := range catalog.published.Packs {
		pack.Stickers = append([]PublishedSticker(nil), pack.Stickers...)
		packs[index] = pack
	}
	return PublishedCatalog{CatalogVersion: catalog.published.CatalogVersion, Packs: packs}
}

// ETag is a strong validator of the published catalog body.
func (catalog *Catalog) ETag() string {
	if catalog == nil {
		return ""
	}
	return catalog.etag
}
