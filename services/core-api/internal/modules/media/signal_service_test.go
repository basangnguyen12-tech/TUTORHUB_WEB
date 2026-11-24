package media

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestMediaSignalServiceValidatesTypedCommandsAndReturnsPrivacySafeSnapshot(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 12, 9, 0, 0, 0, time.UTC)
	roomID := uuid.New()
	participantKey := uuid.New()
	acknowledged := testMediaParticipantSnapshot(roomID, participantKey, now)
	acknowledged.ParticipantReactions = []ParticipantReaction{{
		ParticipantKey: participantKey, Reaction: MediaReactionClap,
		SignalSequence: acknowledged.LastSignalSequence,
		AcceptedAt:     now, ExpiresAt: now.Add(mediaReactionTTL),
	}}
	repository := &fakeMediaSignalRepository{snapshot: acknowledged}
	service, err := NewMediaSignalService(repository)
	if err != nil {
		t.Fatal(err)
	}
	access := AccessContext{TenantID: uuid.New(), ActorID: uuid.New(), SessionID: uuid.New()}
	spaceID := uuid.New()
	validNonce := "p406-signal-request-0001"
	invalidReactionNonce := "p406-signal-request-0002"
	invalidTargetNonce := "p406-signal-request-0003"

	result, err := service.SendSignal(context.Background(), access, spaceID, SendMediaSignalInput{
		ExpectedSpaceVersion: 3, ExpectedRoomInstanceID: roomID,
		ExpectedRoomInstanceVersion: 4, ExpectedProjectionVersion: 8,
		IdempotencyKey: validNonce, Kind: MediaSignalReaction,
		Reaction: MediaReactionClap,
	})
	if err != nil {
		t.Fatalf("send valid signal: %v", err)
	}
	if len(result.ParticipantReactions) != 1 ||
		result.ParticipantReactions[0].ParticipantKey != participantKey ||
		result.ParticipantReactions[0].Reaction != MediaReactionClap {
		t.Fatalf("valid participant reaction was not returned: %+v", result.ParticipantReactions)
	}
	if result.SelfParticipantKey != participantKey || repository.command.Kind != MediaSignalReaction ||
		repository.command.Reaction != MediaReactionClap || len(repository.command.Fingerprint) != 32 ||
		repository.command.SpaceID != spaceID {
		t.Fatalf("unexpected typed command/result: command=%+v result=%+v", repository.command, result)
	}

	invalid := []SendMediaSignalInput{
		{ExpectedSpaceVersion: 3, ExpectedRoomInstanceID: roomID, ExpectedRoomInstanceVersion: 4,
			ExpectedProjectionVersion: 8, IdempotencyKey: invalidReactionNonce,
			Kind: MediaSignalReaction, Reaction: "fire"},
		{ExpectedSpaceVersion: 3, ExpectedRoomInstanceID: roomID, ExpectedRoomInstanceVersion: 4,
			ExpectedProjectionVersion: 8, IdempotencyKey: invalidTargetNonce,
			Kind: MediaSignalHandRaise, TargetParticipantKey: uuid.New()},
		{ExpectedSpaceVersion: 3, ExpectedRoomInstanceID: roomID, ExpectedRoomInstanceVersion: 4,
			ExpectedProjectionVersion: 8, IdempotencyKey: "short", Kind: MediaSignalHandLower},
	}
	for _, input := range invalid {
		if _, err := service.SendSignal(context.Background(), access, spaceID, input); !errors.Is(
			err, ErrInvalidMediaSignalRequest,
		) {
			t.Fatalf("invalid command error = %v", err)
		}
	}
}

func TestGroupMediaReactionEventsIsSequenceOrderedWindowedAndBounded(t *testing.T) {
	t.Parallel()

	base := time.Date(2026, time.August, 12, 10, 0, 0, 0, time.UTC)
	events := []mediaReactionEvent{
		{Reaction: MediaReactionHeart, SignalSequence: 7, AcceptedAt: base.Add(2 * time.Second), ExpiresAt: base.Add(12 * time.Second)},
		{Reaction: MediaReactionClap, SignalSequence: 2, AcceptedAt: base.Add(200 * time.Millisecond), ExpiresAt: base.Add(10200 * time.Millisecond)},
		{Reaction: MediaReactionClap, SignalSequence: 1, AcceptedAt: base, ExpiresAt: base.Add(10 * time.Second)},
		{Reaction: MediaReactionThumbsUp, SignalSequence: 5, AcceptedAt: base.Add(time.Second), ExpiresAt: base.Add(11 * time.Second)},
		{Reaction: MediaReactionCelebrate, SignalSequence: 9, AcceptedAt: base.Add(3 * time.Second), ExpiresAt: base.Add(13 * time.Second)},
	}
	clusters := groupMediaReactionEvents(events)
	if len(clusters) != 4 {
		t.Fatalf("clusters = %d, want 4 bounded summary clusters: %+v", len(clusters), clusters)
	}
	// The server keeps all four bounded summary clusters. The client chooses at
	// most three for animation without losing the older clap summary/count.
	if clusters[0].Reaction != MediaReactionClap || clusters[0].Count != 2 ||
		clusters[1].Reaction != MediaReactionThumbsUp ||
		clusters[2].Reaction != MediaReactionHeart ||
		clusters[3].Reaction != MediaReactionCelebrate {
		t.Fatalf("unexpected bounded summary cluster order: %+v", clusters)
	}

	// A lower sequence can be committed before a request whose server timestamp
	// is older. Never treat that negative timestamp delta as the same fixed window.
	reversedTimes := []mediaReactionEvent{
		{Reaction: MediaReactionClap, SignalSequence: 1, AcceptedAt: base.Add(time.Second), ExpiresAt: base.Add(11 * time.Second)},
		{Reaction: MediaReactionClap, SignalSequence: 2, AcceptedAt: base, ExpiresAt: base.Add(10 * time.Second)},
	}
	clusters = groupMediaReactionEvents(reversedTimes)
	if len(clusters) != 2 {
		t.Fatalf("negative timestamp delta was grouped: %+v", clusters)
	}

	many := make([]mediaReactionEvent, 0, 120)
	for index := 0; index < 120; index++ {
		many = append(many, mediaReactionEvent{
			Reaction: MediaReactionClap, SignalSequence: int64(index + 1),
			AcceptedAt: base.Add(time.Duration(index) * time.Millisecond),
			ExpiresAt:  base.Add(10*time.Second + time.Duration(index)*time.Millisecond),
		})
	}
	clusters = groupMediaReactionEvents(many)
	if len(clusters) != 1 || clusters[0].Count != maximumReactionClusterCount ||
		clusters[0].LastSignalSequence != 120 {
		t.Fatalf("storm was not bounded: %+v", clusters)
	}

	distinct := make([]mediaReactionEvent, 0, maximumReactionSnapshotClusters+7)
	for index := 0; index < maximumReactionSnapshotClusters+7; index++ {
		distinct = append(distinct, mediaReactionEvent{
			Reaction: MediaReactionThumbsUp, SignalSequence: int64(index + 1),
			AcceptedAt: base.Add(time.Duration(index) * time.Second),
			ExpiresAt:  base.Add(time.Duration(index)*time.Second + mediaReactionTTL),
		})
	}
	// Replace the synthetic numeric reactions with exact allowlisted values while
	// keeping each adjacent event outside the fixed grouping window.
	allowlist := []MediaReaction{
		MediaReactionThumbsUp, MediaReactionClap, MediaReactionHeart,
		MediaReactionCelebrate, MediaReactionLaugh, MediaReactionSurprised,
	}
	for index := range distinct {
		distinct[index].Reaction = allowlist[index%len(allowlist)]
	}
	clusters = groupMediaReactionEvents(distinct)
	if len(clusters) != maximumReactionSnapshotClusters ||
		clusters[0].FirstSignalSequence != 8 ||
		clusters[len(clusters)-1].LastSignalSequence != int64(len(distinct)) {
		t.Fatalf("server summary cluster cap was not deterministic: len=%d first=%+v last=%+v", len(clusters), clusters[0], clusters[len(clusters)-1])
	}
}

func TestLatestParticipantReactionsKeepsNewestActiveReactionPerParticipant(t *testing.T) {
	t.Parallel()

	base := time.Date(2026, time.November, 24, 9, 0, 0, 0, time.UTC)
	teacher := uuid.MustParse("018f4c7b-9b0a-7a34-8a4c-96d26cb87221")
	student := uuid.MustParse("018f4c7b-9b0a-7a34-8a4c-96d26cb87222")
	other := uuid.MustParse("018f4c7b-9b0a-7a34-8a4c-96d26cb87223")
	departed := uuid.MustParse("018f4c7b-9b0a-7a34-8a4c-96d26cb87299")
	roster := []MediaParticipant{
		{ParticipantKey: teacher, RosterSequence: 1},
		{ParticipantKey: student, RosterSequence: 2},
		{ParticipantKey: other, RosterSequence: 3},
	}
	event := func(key uuid.UUID, reaction MediaReaction, sequence int64) mediaReactionEvent {
		accepted := base.Add(time.Duration(sequence) * 100 * time.Millisecond)
		return mediaReactionEvent{
			Reaction: reaction, SignalSequence: sequence, AcceptedAt: accepted,
			ExpiresAt: accepted.Add(mediaReactionTTL), ParticipantKey: key,
		}
	}
	events := []mediaReactionEvent{
		event(student, MediaReactionClap, 4),
		event(teacher, MediaReactionThumbsUp, 2),
		event(student, MediaReactionHeart, 7),
		event(uuid.Nil, MediaReactionLaugh, 8),
		event(departed, MediaReactionCelebrate, 9),
		event(other, "fire", 10),
		event(student, MediaReactionSurprised, 5),
	}

	reactions := latestParticipantReactions(events, roster)
	if len(reactions) != 2 {
		t.Fatalf("participant reactions = %+v, want student then teacher", reactions)
	}
	if reactions[0].ParticipantKey != student || reactions[0].Reaction != MediaReactionHeart ||
		reactions[0].SignalSequence != 7 ||
		reactions[1].ParticipantKey != teacher || reactions[1].Reaction != MediaReactionThumbsUp ||
		reactions[1].SignalSequence != 2 {
		t.Fatalf("unexpected newest-per-participant order: %+v", reactions)
	}

	// Room-level clusters stay a pure function of the same events: senders who
	// left or are unknown still count toward the bounded summary (only the
	// non-allowlisted event is dropped, exactly as before).
	clusters := groupMediaReactionEvents(events)
	total := 0
	for _, cluster := range clusters {
		total += cluster.Count
	}
	if total != len(events)-1 {
		t.Fatalf("clusters lost events: total=%d clusters=%+v", total, clusters)
	}

	storm := make([]MediaParticipant, 0, maximumMediaRosterParticipants+5)
	stormEvents := make([]mediaReactionEvent, 0, maximumMediaRosterParticipants+5)
	for index := 0; index < maximumMediaRosterParticipants+5; index++ {
		key := uuid.New()
		storm = append(storm, MediaParticipant{ParticipantKey: key, RosterSequence: int64(index + 1)})
		stormEvents = append(stormEvents, event(key, MediaReactionClap, int64(index+1)))
	}
	bounded := latestParticipantReactions(stormEvents, storm)
	if len(bounded) != maximumParticipantReactions ||
		bounded[0].SignalSequence != int64(len(stormEvents)) {
		t.Fatalf("participant reactions were not bounded newest first: len=%d first=%+v", len(bounded), bounded[0])
	}
}

func TestMediaParticipantSnapshotAlwaysSerializesParticipantReactionsArray(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.November, 24, 9, 0, 0, 0, time.UTC)
	snapshot := testMediaParticipantSnapshot(uuid.New(), uuid.New(), now)
	snapshot.ParticipantReactions = nil
	body, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"participant_reactions":[]`) ||
		!strings.Contains(string(body), `"reaction_clusters":[]`) {
		t.Fatalf("participant_reactions must serialize as an array: %s", body)
	}
	for _, forbidden := range []string{"participant_session", "user_id", "email", "provider"} {
		if strings.Contains(string(body), forbidden) {
			t.Fatalf("snapshot leaked %q: %s", forbidden, body)
		}
	}
}

func TestMediaSignalServiceRejectsMalformedRepositoryProjection(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	roomID := uuid.New()
	repository := &fakeMediaSignalRepository{snapshot: MediaParticipantSnapshot{
		RoomInstanceID: roomID, ProjectionVersion: 1, SelfParticipantKey: uuid.New(),
		Participants: []MediaParticipant{}, RaisedHands: []RaisedHand{},
		ReactionClusters: []ReactionCluster{}, ServerTime: now,
	}}
	service, err := NewMediaSignalService(repository)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.GetParticipantSnapshot(
		context.Background(),
		AccessContext{TenantID: uuid.New(), ActorID: uuid.New(), SessionID: uuid.New()},
		uuid.New(),
		GetMediaParticipantSnapshotInput{
			ExpectedSpaceVersion: 1, ExpectedRoomInstanceID: roomID,
			ExpectedRoomInstanceVersion: 1,
		},
	)
	if !errors.Is(err, ErrMediaSignalUnavailable) {
		t.Fatalf("malformed projection error = %v", err)
	}
}

func TestMediaSignalServiceRejectsUnboundedOrDuplicateSignalProjection(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.August, 12, 11, 0, 0, 0, time.UTC)
	roomID, participantKey := uuid.New(), uuid.New()
	valid := testMediaParticipantSnapshot(roomID, participantKey, now)

	tests := []struct {
		name   string
		mutate func(*MediaParticipantSnapshot)
	}{
		{
			name: "duplicate active hand",
			mutate: func(snapshot *MediaParticipantSnapshot) {
				snapshot.RaisedHands = []RaisedHand{
					{ParticipantKey: participantKey, SignalSequence: 1, RaisedAt: now},
					{ParticipantKey: participantKey, SignalSequence: 2, RaisedAt: now.Add(time.Second)},
				}
			},
		},
		{
			name: "reaction cluster exceeds bounded event lifetime",
			mutate: func(snapshot *MediaParticipantSnapshot) {
				snapshot.ReactionClusters = []ReactionCluster{{
					Reaction: MediaReactionClap, Count: 1,
					FirstSignalSequence: 1, LastSignalSequence: 1,
					AcceptedAt: now, ExpiresAt: now.Add(mediaReactionTTL + mediaReactionGroupingWindow + time.Nanosecond),
				}}
			},
		},
	}

	participantReaction := func(key uuid.UUID, sequence int64) ParticipantReaction {
		return ParticipantReaction{
			ParticipantKey: key, Reaction: MediaReactionHeart, SignalSequence: sequence,
			AcceptedAt: now, ExpiresAt: now.Add(mediaReactionTTL),
		}
	}
	type projectionCase = struct {
		name   string
		mutate func(*MediaParticipantSnapshot)
	}
	tests = append(tests,
		projectionCase{
			name: "participant reaction outside the roster",
			mutate: func(snapshot *MediaParticipantSnapshot) {
				snapshot.ParticipantReactions = []ParticipantReaction{participantReaction(uuid.New(), 3)}
			},
		},
		projectionCase{
			name: "duplicate participant reaction",
			mutate: func(snapshot *MediaParticipantSnapshot) {
				snapshot.ParticipantReactions = []ParticipantReaction{
					participantReaction(participantKey, 4), participantReaction(participantKey, 3),
				}
			},
		},
		projectionCase{
			name: "participant reaction outlives one event TTL",
			mutate: func(snapshot *MediaParticipantSnapshot) {
				reaction := participantReaction(participantKey, 4)
				reaction.ExpiresAt = now.Add(mediaReactionTTL + time.Nanosecond)
				snapshot.ParticipantReactions = []ParticipantReaction{reaction}
			},
		},
		projectionCase{
			name: "participant reaction after last signal sequence",
			mutate: func(snapshot *MediaParticipantSnapshot) {
				snapshot.ParticipantReactions = []ParticipantReaction{
					participantReaction(participantKey, snapshot.LastSignalSequence+1),
				}
			},
		},
		projectionCase{
			name: "participant reaction outside the allowlist",
			mutate: func(snapshot *MediaParticipantSnapshot) {
				reaction := participantReaction(participantKey, 4)
				reaction.Reaction = "fire"
				snapshot.ParticipantReactions = []ParticipantReaction{reaction}
			},
		},
	)

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			snapshot := valid
			test.mutate(&snapshot)
			repository := &fakeMediaSignalRepository{snapshot: snapshot}
			service, err := NewMediaSignalService(repository)
			if err != nil {
				t.Fatal(err)
			}
			_, err = service.GetParticipantSnapshot(
				context.Background(),
				AccessContext{TenantID: uuid.New(), ActorID: uuid.New(), SessionID: uuid.New()},
				uuid.New(),
				GetMediaParticipantSnapshotInput{
					ExpectedSpaceVersion: 1, ExpectedRoomInstanceID: roomID,
					ExpectedRoomInstanceVersion: 1,
				},
			)
			if !errors.Is(err, ErrMediaSignalUnavailable) {
				t.Fatalf("malformed projection error = %v", err)
			}
		})
	}
}

func testMediaParticipantSnapshot(
	roomID uuid.UUID,
	participantKey uuid.UUID,
	now time.Time,
) MediaParticipantSnapshot {
	return MediaParticipantSnapshot{
		RoomInstanceID: roomID, ProjectionVersion: 8, LastSignalSequence: 12,
		SelfParticipantKey: participantKey,
		ViewerOperations: MediaSignalViewerOperations{
			CanRaiseHand: true, CanSendReaction: true,
		},
		Participants: []MediaParticipant{{
			ParticipantKey: participantKey, RosterSequence: 1, DisplayName: "Teacher",
			InstanceRole: InstanceRoleHost, Connection: ParticipantConnectionConnected,
		}},
		RaisedHands: []RaisedHand{}, ReactionClusters: []ReactionCluster{}, ServerTime: now,
	}
}

type fakeMediaSignalRepository struct {
	snapshot MediaParticipantSnapshot
	command  SendMediaSignalCommand
	err      error
}

func (repository *fakeMediaSignalRepository) GetParticipantSnapshot(
	context.Context,
	AccessContext,
	uuid.UUID,
	GetMediaParticipantSnapshotInput,
) (MediaParticipantSnapshot, error) {
	return repository.snapshot, repository.err
}

func (repository *fakeMediaSignalRepository) SendSignal(
	_ context.Context,
	_ AccessContext,
	command SendMediaSignalCommand,
) (MediaParticipantSnapshot, error) {
	repository.command = command
	return repository.snapshot, repository.err
}
