package conversation

import (
	"context"
	"fmt"

	"github.com/tutorhub-v2/core-api/internal/modules/conversation/stickers"
)

// StickerPacks is the picker catalog (active stickers only) with its strong
// HTTP validator (MSG-STICKER-01, ADR-0047).
type StickerPacks struct {
	Catalog stickers.PublishedCatalog
	ETag    string
}

// ListStickerPacks returns the embedded sticker catalog to an active member
// of a tenant where both conversations and chat_stickers are enabled.
func (service *Service) ListStickerPacks(
	ctx context.Context,
	access AccessContext,
) (StickerPacks, error) {
	if service == nil {
		return StickerPacks{}, fmt.Errorf("list sticker packs: service is unavailable")
	}
	if !validAccess(access) {
		return StickerPacks{}, ErrAccessDenied
	}
	catalog, err := stickers.Default()
	if err != nil {
		return StickerPacks{}, fmt.Errorf("load sticker catalog: %w", err)
	}
	if err := service.repository.AuthorizeStickerCatalog(ctx, access); err != nil {
		return StickerPacks{}, err
	}
	return StickerPacks{Catalog: catalog.Published(), ETag: catalog.ETag()}, nil
}
