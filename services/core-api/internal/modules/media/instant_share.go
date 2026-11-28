package media

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/tutorhub-v2/core-api/internal/platform/tenancy"
)

// MaximumInstantShareRecipients bounds one conversation share. Larger
// conversations must use the owner invitation flow instead.
const MaximumInstantShareRecipients = 500

// ErrInstantShareUnavailable conceals why a space cannot be shared (missing,
// not an instant StudyMeeting, not owned by the sender, ended or expired).
var ErrInstantShareUnavailable = errors.New("instant study space cannot be shared")

// InstantSpaceShare is the projection a conversation card needs.
type InstantSpaceShare struct {
	Title  string
	Status SpaceStatus
	EndsAt time.Time
}

// ShareInstantStudySpace (MSG-COMPOSER-TOOLS-01) runs inside the caller's
// transaction, after the caller authorized posting into the conversation and
// enforced the instant-room feature controls. The owner of an instant
// (classless) StudyMeeting space shares it with the conversation's current
// readers: each becomes an active explicit member exactly as an owner
// invitation would make them, so join visibility, lobby admission and
// moderation keep their existing rules. Members the host revoked stay
// revoked, and existing members are left untouched.
func ShareInstantStudySpace(
	ctx context.Context,
	transaction pgx.Tx,
	tenantID, spaceID, ownerID uuid.UUID,
	recipientIDs []uuid.UUID,
	now time.Time,
) (InstantSpaceShare, error) {
	if transaction == nil || tenantID == uuid.Nil || spaceID == uuid.Nil ||
		ownerID == uuid.Nil || len(recipientIDs) > MaximumInstantShareRecipients {
		return InstantSpaceShare{}, ErrInstantShareUnavailable
	}
	now = now.UTC()
	space, err := loadSpace(ctx, transaction, tenantID, spaceID, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return InstantSpaceShare{}, ErrInstantShareUnavailable
	}
	if err != nil {
		return InstantSpaceShare{}, fmt.Errorf("load shared instant space: %w", err)
	}
	if space.Source.Kind != SourceStudyMeeting || space.Source.StudyMeetingID == nil ||
		(space.Status != SpaceStatusScheduled && space.Status != SpaceStatusOpen) {
		return InstantSpaceShare{}, ErrInstantShareUnavailable
	}
	meetingID := *space.Source.StudyMeetingID
	meeting, err := loadStudyMeeting(ctx, transaction, tenantID, meetingID, true)
	if errors.Is(err, pgx.ErrNoRows) {
		return InstantSpaceShare{}, ErrInstantShareUnavailable
	}
	if err != nil {
		return InstantSpaceShare{}, fmt.Errorf("load shared instant meeting: %w", err)
	}
	// Class-bound meetings keep class authorization; only classless instant
	// meetings owned by the sender can be shared from a conversation.
	if meeting.OwnerUserID != ownerID || meeting.ClassID != nil || meeting.Status != "scheduled" {
		return InstantSpaceShare{}, ErrInstantShareUnavailable
	}
	share := InstantSpaceShare{Status: space.Status}
	if err := transaction.QueryRow(
		ctx,
		`SELECT title, ends_at FROM tutorhub.study_meetings WHERE tenant_id = $1 AND id = $2`,
		tenantID, meetingID,
	).Scan(&share.Title, &share.EndsAt); err != nil {
		return InstantSpaceShare{}, fmt.Errorf("load shared instant meeting window: %w", err)
	}
	share.EndsAt = share.EndsAt.UTC()
	if !share.EndsAt.After(now) {
		return InstantSpaceShare{}, ErrInstantShareUnavailable
	}
	scope := tenancy.Context{TenantID: tenantID, ActorID: ownerID}
	seen := make(map[uuid.UUID]struct{}, len(recipientIDs))
	for _, userID := range recipientIDs {
		if userID == uuid.Nil || userID == ownerID {
			continue
		}
		if _, duplicate := seen[userID]; duplicate {
			continue
		}
		seen[userID] = struct{}{}
		tag, err := transaction.Exec(
			ctx,
			`INSERT INTO tutorhub.media_space_members (
    tenant_id, space_id, user_id, status, version, invited_by, created_at, updated_at
)
SELECT $1, $2, $3, 'active', 1, $4, $5, $5
WHERE EXISTS (
    SELECT 1
    FROM tutorhub.memberships AS member
    JOIN tutorhub.users AS target ON target.id = member.user_id
    WHERE member.tenant_id = $1 AND member.user_id = $3
      AND member.status = 'active' AND target.status = 'active'
)
ON CONFLICT (tenant_id, space_id, user_id) DO NOTHING`,
			tenantID, spaceID, userID, ownerID, now,
		)
		if err != nil {
			return InstantSpaceShare{}, fmt.Errorf("grant shared instant space member: %w", err)
		}
		if tag.RowsAffected() != 1 {
			continue
		}
		if err := appendLobbyMemberEvent(
			ctx, transaction, scope, spaceID,
			LobbyMember{UserID: userID, Status: LobbyMemberActive, Version: 1},
			"media_space_member.invited.v1", "", now,
		); err != nil {
			return InstantSpaceShare{}, err
		}
	}
	return share, nil
}
