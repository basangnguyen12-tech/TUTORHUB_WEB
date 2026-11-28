package conversation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tutorhub-v2/core-api/internal/modules/conversation/stickers"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
)

// maximumInstantClassRecipients bounds one instant-class share (it matches
// the media module's own bound for conversation shares).
const maximumInstantClassRecipients = 500

// prepareMessageEmbed validates a card inside the send transaction, after
// posting authority and the conversation lock were acquired. An instant
// class also grants the conversation's current readers access to the space.
func (repository *PostgresRepository) prepareMessageEmbed(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	conversationID uuid.UUID,
	embed MessageEmbedInput,
	now time.Time,
) error {
	switch embed.Kind {
	case EmbedKindContactCard:
		// Shareable: the sender, or the other member of one of the sender's
		// direct conversations; either way an active member of this tenant.
		var shareable bool
		if err := transaction.QueryRow(
			ctx,
			`SELECT EXISTS (
    SELECT 1
    FROM tutorhub.memberships AS member
    JOIN tutorhub.users AS target ON target.id = member.user_id
    WHERE member.tenant_id = $1 AND member.user_id = $2
      AND member.status = 'active' AND target.status = 'active'
) AND (
    $2 = $3 OR EXISTS (
        SELECT 1
        FROM tutorhub.conversations AS direct
        WHERE direct.tenant_id = $1
          AND direct.kind = 'direct'
          AND (
              (direct.direct_user_low_id = $2 AND direct.direct_user_high_id = $3)
              OR (direct.direct_user_low_id = $3 AND direct.direct_user_high_id = $2)
          )
    )
)`,
			access.TenantID, embed.UserID, access.ActorID,
		).Scan(&shareable); err != nil {
			return fmt.Errorf("authorize contact card: %w", err)
		}
		if !shareable {
			return ErrEmbedUnavailable
		}
		return nil
	case EmbedKindInstantClass:
		return repository.shareInstantClass(ctx, transaction, access, conversationID, embed.MediaSpaceID, now)
	case EmbedKindSticker:
		// ADR-0047: direct, class and room conversations alike; posting
		// authority (archived class, paused room chat) was already enforced.
		if err := repository.controls.RequireFeature(
			ctx, transaction, access.TenantID, featurecontrol.FeatureChatStickers,
		); err != nil {
			return err
		}
		if !repository.stickerCatalog().Sendable(embed.StickerID) {
			// Unknown, retired and removed stickers are indistinguishable.
			return ErrEmbedUnavailable
		}
		return nil
	default:
		return ErrInvalidInput
	}
}

func (repository *PostgresRepository) shareInstantClass(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	conversationID, mediaSpaceID uuid.UUID,
	now time.Time,
) error {
	if repository.instantSharer == nil {
		return ErrEmbedUnavailable
	}
	for _, feature := range []featurecontrol.FeatureKey{
		featurecontrol.FeatureClassroomMediaRooms,
		featurecontrol.FeatureInstantStudyRooms,
	} {
		if err := repository.controls.RequireFeature(ctx, transaction, access.TenantID, feature); err != nil {
			return err
		}
	}
	var kind Kind
	var classID, lowID, highID uuid.NullUUID
	if err := transaction.QueryRow(
		ctx,
		`SELECT kind, class_id, direct_user_low_id, direct_user_high_id
FROM tutorhub.conversations
WHERE tenant_id = $1 AND id = $2`,
		access.TenantID, conversationID,
	).Scan(&kind, &classID, &lowID, &highID); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return fmt.Errorf("load instant class conversation: %w", err)
	}
	var recipients []uuid.UUID
	switch kind {
	case KindDirect:
		if !lowID.Valid || !highID.Valid {
			return ErrNotFound
		}
		recipients = []uuid.UUID{lowID.UUID, highID.UUID}
	case KindClass:
		if !classID.Valid {
			return ErrNotFound
		}
		rows, err := transaction.Query(
			ctx,
			`SELECT readers.user_id
FROM (
    SELECT owner_user_id AS user_id
    FROM tutorhub.classes
    WHERE tenant_id = $1 AND id = $2
    UNION
    SELECT user_id
    FROM tutorhub.class_enrollments
    WHERE tenant_id = $1 AND class_id = $2 AND status = 'active'
) AS readers
LIMIT $3`,
			access.TenantID, classID.UUID, maximumInstantClassRecipients+1,
		)
		if err != nil {
			return fmt.Errorf("query instant class readers: %w", err)
		}
		recipients, err = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			return fmt.Errorf("collect instant class readers: %w", err)
		}
		if len(recipients) > maximumInstantClassRecipients {
			return ErrEmbedUnavailable
		}
	default:
		// A classroom room already is the live class.
		return ErrEmbedUnavailable
	}
	return repository.instantSharer(
		ctx, transaction, access.TenantID, mediaSpaceID, access.ActorID, recipients, now,
	)
}

func insertMessageEmbed(
	ctx context.Context,
	transaction pgx.Tx,
	tenantID, conversationID, messageID uuid.UUID,
	embed MessageEmbedInput,
	now time.Time,
) error {
	var targetUserID, mediaSpaceID, stickerID any
	switch embed.Kind {
	case EmbedKindContactCard:
		targetUserID = embed.UserID
	case EmbedKindInstantClass:
		mediaSpaceID = embed.MediaSpaceID
	case EmbedKindSticker:
		stickerID = embed.StickerID
	default:
		return ErrInvalidInput
	}
	if _, err := transaction.Exec(
		ctx,
		`INSERT INTO tutorhub.message_embeds (
    tenant_id, conversation_id, message_id, kind, target_user_id, media_space_id,
    sticker_id, created_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		tenantID, conversationID, messageID, string(embed.Kind), targetUserID, mediaSpaceID,
		stickerID, now,
	); err != nil {
		return safeMessageStoreError("insert message embed", err)
	}
	return nil
}

// loadMessageEmbeds batches the card projection for one page of active
// messages in a single query, resolved for viewerID.
func loadMessageEmbeds(
	ctx context.Context,
	transaction pgx.Tx,
	tenantID, conversationID, viewerID uuid.UUID,
	items []Message,
) error {
	activeIDs := make([]uuid.UUID, 0, len(items))
	for index := range items {
		items[index].Embed = nil
		if items[index].State == MessageStateActive {
			activeIDs = append(activeIDs, items[index].ID)
		}
	}
	if len(activeIDs) == 0 {
		return nil
	}
	rows, err := transaction.Query(
		ctx,
		`SELECT
    embed.message_id,
    embed.kind,
    embed.target_user_id,
    target.display_name,
    coalesce(member.status = 'active' AND target.status = 'active', false),
    embed.media_space_id,
    meeting.title,
    space.status,
    meeting.ends_at,
    greatest(0, floor(extract(epoch FROM meeting.ends_at - clock_timestamp())))::bigint,
    coalesce(
        meeting.owner_user_id = $4 OR EXISTS (
            SELECT 1
            FROM tutorhub.media_space_members AS space_member
            WHERE space_member.tenant_id = embed.tenant_id
              AND space_member.space_id = embed.media_space_id
              AND space_member.user_id = $4
              AND space_member.status = 'active'
        ),
        false
    ),
    embed.sticker_id
FROM tutorhub.message_embeds AS embed
LEFT JOIN tutorhub.memberships AS member
  ON member.tenant_id = embed.tenant_id AND member.user_id = embed.target_user_id
LEFT JOIN tutorhub.users AS target ON target.id = embed.target_user_id
LEFT JOIN tutorhub.media_spaces AS space
  ON space.tenant_id = embed.tenant_id AND space.id = embed.media_space_id
LEFT JOIN tutorhub.study_meetings AS meeting
  ON meeting.tenant_id = space.tenant_id AND meeting.id = space.source_study_meeting_id
WHERE embed.tenant_id = $1
  AND embed.conversation_id = $2
  AND embed.message_id = ANY($3::uuid[])`,
		tenantID, conversationID, activeIDs, viewerID,
	)
	if err != nil {
		return fmt.Errorf("query message embeds: %w", err)
	}
	defer rows.Close()
	catalog, _ := stickers.Default()
	byMessage := make(map[uuid.UUID]*MessageEmbed, len(activeIDs))
	for rows.Next() {
		var messageID uuid.UUID
		var kind string
		var targetUserID, mediaSpaceID uuid.NullUUID
		var displayName, title, status sql.NullString
		var endsAt sql.NullTime
		var remaining sql.NullInt64
		var stickerID sql.NullString
		var available, canJoin bool
		if err := rows.Scan(
			&messageID, &kind, &targetUserID, &displayName, &available,
			&mediaSpaceID, &title, &status, &endsAt, &remaining, &canJoin, &stickerID,
		); err != nil {
			return safeMessageStoreError("scan message embed", err)
		}
		embed := &MessageEmbed{Kind: EmbedKind(kind)}
		switch embed.Kind {
		case EmbedKindContactCard:
			visible := available && targetUserID.Valid && displayName.Valid
			embed.Available = &visible
			if visible {
				userID, name := targetUserID.UUID, displayName.String
				embed.UserID, embed.DisplayName = &userID, &name
			}
		case EmbedKindInstantClass:
			if !mediaSpaceID.Valid || !title.Valid || !status.Valid || !endsAt.Valid {
				continue
			}
			spaceID, name, state := mediaSpaceID.UUID, title.String, status.String
			end := endsAt.Time.UTC()
			seconds := remaining.Int64
			embed.MediaSpaceID, embed.Title, embed.Status = &spaceID, &name, &state
			embed.EndsAt, embed.RemainingSeconds, embed.ViewerCanJoin = &end, &seconds, &canJoin
		case EmbedKindSticker:
			embed = projectStickerEmbed(catalog, stickerID.String)
		default:
			continue
		}
		byMessage[messageID] = embed
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate message embeds: %w", err)
	}
	for index := range items {
		if embed, ok := byMessage[items[index].ID]; ok {
			items[index].Embed = embed
		}
	}
	return nil
}

// projectStickerEmbed resolves a sticker against the embedded catalog:
// active and retired stickers stay visible; removed or unknown ones expose
// nothing but available=false (ADR-0047 §4).
func projectStickerEmbed(catalog *stickers.Catalog, stickerID string) *MessageEmbed {
	embed := &MessageEmbed{Kind: EmbedKindSticker}
	entry, ok := catalog.Lookup(stickerID)
	visible := ok && (entry.Status == stickers.StatusActive || entry.Status == stickers.StatusRetired)
	embed.Available = &visible
	if visible {
		id, packID := entry.ID, entry.PackID
		labels, asset := entry.Labels, entry.Asset
		embed.StickerID, embed.PackID = &id, &packID
		embed.Labels, embed.Asset = &labels, &asset
	}
	return embed
}

// withMessageExtras projects attachments and the viewer's card for one
// message.
func withMessageExtras(
	ctx context.Context,
	transaction pgx.Tx,
	access AccessContext,
	conversationID uuid.UUID,
	item Message,
) (Message, error) {
	items := []Message{item}
	if err := loadMessageAttachments(ctx, transaction, access.TenantID, conversationID, items); err != nil {
		return Message{}, err
	}
	if err := loadMessageEmbeds(
		ctx, transaction, access.TenantID, conversationID, access.ActorID, items,
	); err != nil {
		return Message{}, err
	}
	return items[0], nil
}

func messageHasEmbed(
	ctx context.Context,
	transaction pgx.Tx,
	tenantID, messageID uuid.UUID,
) (bool, error) {
	var exists bool
	if err := transaction.QueryRow(
		ctx,
		`SELECT EXISTS (
    SELECT 1 FROM tutorhub.message_embeds WHERE tenant_id = $1 AND message_id = $2
)`,
		tenantID, messageID,
	).Scan(&exists); err != nil {
		return false, fmt.Errorf("load message embed presence: %w", err)
	}
	return exists, nil
}

// CreateDirectFromContactCard opens (or reuses) the direct conversation with
// the member named on a contact card the actor can read. Only cards make a
// member reachable this way, so raw user IDs cannot be enumerated.
func (repository *PostgresRepository) CreateDirectFromContactCard(
	ctx context.Context,
	access AccessContext,
	sourceMessageID uuid.UUID,
) (CreateResult, error) {
	queryContext, cancel := context.WithTimeout(ctx, repository.queryTimeout)
	defer cancel()
	transaction, err := repository.database.Begin(queryContext)
	if err != nil {
		return CreateResult{}, fmt.Errorf("begin contact card conversation: %w", err)
	}
	defer rollback(transaction)
	if err := repository.controls.RequireFeature(
		queryContext, transaction, access.TenantID, featurecontrol.FeatureConversations,
	); err != nil {
		return CreateResult{}, err
	}
	if err := lockActiveTenant(queryContext, transaction, access.TenantID); err != nil {
		return CreateResult{}, err
	}
	var conversationID, targetUserID uuid.UUID
	if err := transaction.QueryRow(
		queryContext,
		`SELECT embed.conversation_id, embed.target_user_id
FROM tutorhub.message_embeds AS embed
JOIN tutorhub.messages AS message
  ON message.tenant_id = embed.tenant_id
 AND message.conversation_id = embed.conversation_id
 AND message.id = embed.message_id
WHERE embed.tenant_id = $1
  AND embed.message_id = $2
  AND embed.kind = 'contact_card'
  AND message.state = 'active'`,
		access.TenantID, sourceMessageID,
	).Scan(&conversationID, &targetUserID); errors.Is(err, pgx.ErrNoRows) {
		return CreateResult{}, ErrNotFound
	} else if err != nil {
		return CreateResult{}, fmt.Errorf("resolve contact card: %w", err)
	}
	access, err = repository.authorizeMessageRead(queryContext, transaction, access, conversationID)
	if errors.Is(err, ErrAccessDenied) {
		// A card the actor cannot read is indistinguishable from no card.
		return CreateResult{}, ErrNotFound
	}
	if err != nil {
		return CreateResult{}, err
	}
	if targetUserID == access.ActorID {
		return CreateResult{}, ErrUnavailable
	}
	return repository.createDirectWithTarget(queryContext, transaction, access, targetUserID)
}
