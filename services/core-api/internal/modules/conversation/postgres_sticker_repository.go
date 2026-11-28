package conversation

import (
	"context"
	"fmt"

	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
)

// AuthorizeStickerCatalog lets an active member of an active tenant read the
// sticker catalog while conversations and chat_stickers are both enabled.
func (repository *PostgresRepository) AuthorizeStickerCatalog(
	ctx context.Context,
	access AccessContext,
) error {
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return fmt.Errorf("begin sticker catalog authorization: %w", err)
	}
	defer rollback(transaction)
	if _, err := repository.requireActiveScope(queryContext, transaction, access); err != nil {
		return err
	}
	for _, feature := range []featurecontrol.FeatureKey{
		featurecontrol.FeatureConversations,
		featurecontrol.FeatureChatStickers,
	} {
		if err := repository.controls.RequireFeatureForRead(
			queryContext, transaction, access.TenantID, feature,
		); err != nil {
			return err
		}
	}
	if err := transaction.Commit(queryContext); err != nil {
		return fmt.Errorf("commit sticker catalog authorization: %w", err)
	}
	return nil
}
