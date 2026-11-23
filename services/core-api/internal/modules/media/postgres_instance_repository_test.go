package media

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
)

func TestPostgresInstanceRepositoryCredentialLimiterUsesOpaqueBucket(t *testing.T) {
	t.Parallel()

	if mediaCredentialRatePurpose != "media.join_credential" {
		t.Fatalf("credential limiter purpose = %q", mediaCredentialRatePurpose)
	}
	if mediaCredentialRateLimit != 30 {
		t.Fatalf("credential limiter limit = %d, want 30", mediaCredentialRateLimit)
	}
	if mediaCredentialRateWindow != 10*time.Minute {
		t.Fatalf("credential limiter window = %s, want 10m", mediaCredentialRateWindow)
	}

	source := postgresInstanceRepositorySource(t)
	section := postgresInstanceRepositorySection(
		t,
		source,
		"func consumeMediaCredentialRateLimit(",
		"type providerRoomBinding struct",
	)
	for _, fragment := range []string{
		"sha256.Sum256([]byte(",
		"mediaCredentialRatePurpose + \"\\x00\" + tenantID.String() + \"\\x00\" +",
		"actorID.String() + \"\\x00\" + sessionID.String()",
		"purpose, bucket_hash, window_started_at, window_ends_at, used_count, updated_at",
		"ON CONFLICT (purpose, bucket_hash, window_started_at)",
		"WHERE tutorhub.rate_limit_windows.used_count < $6",
		"mediaCredentialRatePurpose, bucketHash[:], windowStartedAt, windowEndsAt",
		"now, mediaCredentialRateLimit",
	} {
		if !strings.Contains(section, fragment) {
			t.Fatalf("credential limiter is missing %q", fragment)
		}
	}
	for _, forbidden := range []string{
		"mediaCredentialRatePurpose + tenantID.String()",
		"mediaCredentialRatePurpose + actorID.String()",
		"mediaCredentialRatePurpose + sessionID.String()",
		"tenantID, bucketHash[:]",
		"actorID, bucketHash[:]",
		"sessionID, bucketHash[:]",
	} {
		if strings.Contains(section, forbidden) {
			t.Fatalf("credential limiter risks persisting a raw identifier via %q", forbidden)
		}
	}
}

func TestPostgresInstanceIntegrationMigrationFailureDoesNotLogDriverError(t *testing.T) {
	t.Parallel()

	contents, err := os.ReadFile("postgres_instance_integration_test.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(contents)
	if !strings.Contains(source, `t.Fatal("apply room-instance binding migrations")`) {
		t.Fatal("room-instance migration failure must use a stable redacted message")
	}
	if strings.Contains(source, `apply room-instance binding migrations: %v`) {
		t.Fatal("room-instance migration failure must not render the driver error")
	}
}

func TestOpaqueParticipantIdentityUsesIndependentProviderIdentifier(t *testing.T) {
	t.Parallel()

	applicationID := uuid.MustParse("c74d5a18-7b36-4b98-9a14-cf1c4bb9f9cf")
	identity := opaqueParticipantIdentity(applicationID)
	if !regexp.MustCompile(`^p_[0-9a-f]{32}$`).MatchString(identity) {
		t.Fatalf("provider participant identity %q is not opaque provider format", identity)
	}
	if identity == applicationID.String() || strings.Contains(identity, "-") {
		t.Fatalf("provider participant identity exposes raw application UUID %q", identity)
	}

	source := postgresInstanceRepositorySource(t)
	creation := postgresInstanceRepositorySection(
		t,
		source,
		"participant := participantRow{",
		"if participant.ID == uuid.Nil",
	)
	if !strings.Contains(
		creation,
		"ProviderIdentity: opaqueParticipantIdentity(repository.newID())",
	) {
		t.Fatal("participant identity must be generated from an independent opaque ID")
	}
	for _, rawID := range []string{
		"scope.TenantID",
		"scope.ActorID",
		"access.ActorID",
		"space.ID",
		"room.ID",
		"joinAttemptID",
	} {
		if strings.Contains(creation, "opaqueParticipantIdentity("+rawID+")") {
			t.Fatalf("participant identity derives from application identifier %s", rawID)
		}
	}
}

func TestRoomActivationReauthorizesStartCapability(t *testing.T) {
	t.Parallel()

	source := postgresInstanceRepositorySource(t)
	activation := postgresInstanceRepositorySection(
		t,
		source,
		"func (repository *PostgresInstanceRepository) ActivateRoomInstance(",
		"func (repository *PostgresInstanceRepository) ProviderRoomName(",
	)
	if !strings.Contains(
		activation,
		"space, policy.ActionSessionStart, true, false",
	) {
		t.Fatal("provider activation must reload the actor's session-start authority")
	}
	if strings.Contains(activation, "space, policy.ActionClassView, false, false") {
		t.Fatal("provider activation must not reconcile using view-only authority")
	}
}

func TestInstanceControlLockPrecedesRowsWhileSpaceConcealsFeature(t *testing.T) {
	t.Parallel()

	source := postgresInstanceRepositorySource(t)
	tests := []struct {
		name  string
		start string
		end   string
	}{
		{
			name:  "provider activation",
			start: "func (repository *PostgresInstanceRepository) ActivateRoomInstance(",
			end:   "func (repository *PostgresInstanceRepository) ProviderRoomName(",
		},
		{
			name:  "join credential",
			start: "func (repository *PostgresInstanceRepository) PrepareCredential(",
			end:   "func (repository *PostgresInstanceRepository) CreateOrReuseJoinAttempt(",
		},
		{
			name:  "join attempt",
			start: "func (repository *PostgresInstanceRepository) CreateOrReuseJoinAttempt(",
			end:   "func (repository *PostgresInstanceRepository) requireParticipantCapacity(",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			section := postgresInstanceRepositorySection(t, source, test.start, test.end)
			controlLock := strings.Index(section, "repository.lifecycle.acquireTenantControlLock(")
			activeScope := strings.Index(section, "repository.lifecycle.requireActiveScope(")
			spaceLookup := strings.Index(section, "space, err := loadSpace(")
			featureGate := strings.Index(section, "controls.RequireFeature(")
			if controlLock < 0 || activeScope < 0 || spaceLookup < 0 || featureGate < 0 {
				t.Fatal("room-instance transaction is missing a required lock or feature boundary")
			}
			if controlLock > activeScope || controlLock > spaceLookup {
				t.Fatal("tenant feature-control lock must precede membership and space row locks")
			}
			if spaceLookup > featureGate {
				t.Fatal("exact tenant space lookup must conceal foreign spaces before feature evaluation")
			}
		})
	}
}

func TestJoinAttemptOwnsParticipantCreationBeforeCredentialMint(t *testing.T) {
	t.Parallel()

	source := postgresInstanceRepositorySource(t)
	credential := postgresInstanceRepositorySection(
		t,
		source,
		"func (repository *PostgresInstanceRepository) PrepareCredential(",
		"func (repository *PostgresInstanceRepository) CreateOrReuseJoinAttempt(",
	)
	if strings.Contains(credential, "INSERT INTO tutorhub.media_participant_sessions") {
		t.Fatal("credential issuance must not create a participant session")
	}
	for _, fragment := range []string{
		`existing.Status == string(JoinAttemptWaiting)`,
		`existing.Status != string(JoinAttemptAdmitted)`,
		`existing.Status != string(JoinAttemptJoining)`,
		"SET status = 'joining'",
		"joining_at = $6",
	} {
		if !strings.Contains(credential, fragment) {
			t.Fatalf("credential issuance is missing existing-attempt boundary %q", fragment)
		}
	}

	attempt := postgresInstanceRepositorySection(
		t,
		source,
		"func (repository *PostgresInstanceRepository) CreateOrReuseJoinAttempt(",
		"func (repository *PostgresInstanceRepository) requireParticipantCapacity(",
	)
	for _, fragment := range []string{
		"space.Version != input.ExpectedSpaceVersion",
		"room.ID != input.ExpectedRoomInstanceID",
		"INSERT INTO tutorhub.media_admission_requests",
		"INSERT INTO tutorhub.media_participant_sessions",
		"space.LobbyEnabled && source.InstanceRole == InstanceRoleAttendee",
		"participant.Status = string(JoinAttemptWaiting)",
	} {
		if !strings.Contains(attempt, fragment) {
			t.Fatalf("join-attempt authority is missing %q", fragment)
		}
	}
}

func TestJoinAttemptRequiresExplicitRestoreAfterRemoval(t *testing.T) {
	t.Parallel()

	source := postgresInstanceRepositorySource(t)
	attempt := postgresInstanceRepositorySection(
		t,
		source,
		"func (repository *PostgresInstanceRepository) CreateOrReuseJoinAttempt(",
		"func (repository *PostgresInstanceRepository) requireParticipantCapacity(",
	)
	activeCheck := strings.Index(attempt, "hasActiveParticipant(")
	restoreBarrier := strings.Index(attempt, "hasUnrestoredRemovalBarrier(")
	capacityLock := strings.Index(attempt, "media-participant-capacity:")
	admissionInsert := strings.Index(attempt, "INSERT INTO tutorhub.media_admission_requests")
	if activeCheck < 0 || restoreBarrier <= activeCheck || capacityLock <= restoreBarrier ||
		admissionInsert <= capacityLock {
		t.Fatal("join attempt does not enforce the removal restore barrier before capacity/admission creation")
	}
	barrier := postgresInstanceRepositorySection(
		t,
		source,
		"func hasUnrestoredRemovalBarrier(",
		"func activeParticipantStatus(",
	)
	for _, fragment := range []string{
		"tenant_id = $1 AND space_id = $2 AND room_instance_id = $3",
		"user_id = $4 AND status = 'removed'",
		"rejoin_restored_at IS NULL",
	} {
		if !strings.Contains(barrier, fragment) {
			t.Fatalf("restore barrier is missing %q", fragment)
		}
	}
}

func TestCredentialLockBlocksAdmittedAttemptBeforeMint(t *testing.T) {
	t.Parallel()

	credential := postgresInstanceRepositorySection(
		t,
		postgresInstanceRepositorySource(t),
		"func (repository *PostgresInstanceRepository) PrepareCredential(",
		"func (repository *PostgresInstanceRepository) CreateOrReuseJoinAttempt(",
	)
	lockCheck := strings.Index(credential, "if space.Locked {")
	participantLookup := strings.Index(credential, "loadParticipantByAttempt(")
	rateLimit := strings.Index(credential, "consumeMediaCredentialRateLimit(")
	if lockCheck < 0 || participantLookup < 0 || rateLimit < 0 {
		t.Fatal("credential issuance is missing the lock, admitted-attempt, or rate-limit boundary")
	}
	if lockCheck > participantLookup || lockCheck > rateLimit {
		t.Fatal("space lock must reject every new credential before admitted-attempt lookup or mint rate consumption")
	}
}

func TestJoinBoundariesAuthorizeAndConcealSourceBeforeObservableState(t *testing.T) {
	t.Parallel()

	source := postgresInstanceRepositorySource(t)
	for _, test := range []struct {
		name       string
		start      string
		end        string
		observable []string
	}{
		{
			name:  "credential",
			start: "func (repository *PostgresInstanceRepository) PrepareCredential(",
			end:   "func (repository *PostgresInstanceRepository) CreateOrReuseJoinAttempt(",
			observable: []string{
				"controls.RequireFeature(", "if space.Status !=", "if space.Locked {",
			},
		},
		{
			name:  "join attempt",
			start: "func (repository *PostgresInstanceRepository) CreateOrReuseJoinAttempt(",
			end:   "func (repository *PostgresInstanceRepository) requireParticipantCapacity(",
			observable: []string{
				"controls.RequireFeature(", "if space.Version !=", "if space.Status !=", "if space.Locked {",
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			section := postgresInstanceRepositorySection(t, source, test.start, test.end)
			authorization := strings.Index(section, "repository.lifecycle.authorizeSource(")
			concealment := strings.Index(section, "concealJoinSourceError(err)")
			if authorization < 0 || concealment < authorization {
				t.Fatal("join boundary must authorize and conceal the source before exposing state")
			}
			for _, fragment := range test.observable {
				observable := strings.Index(section, fragment)
				if observable < 0 || authorization > observable {
					t.Fatalf("source authorization must precede observable boundary %q", fragment)
				}
			}
		})
	}

	if !errors.Is(concealJoinSourceError(ErrSpaceAccessDenied), ErrSpaceNotFound) {
		t.Fatal("join source access denial must be concealed as not found")
	}
	if !errors.Is(concealJoinSourceError(ErrSourceUnavailable), ErrSourceUnavailable) {
		t.Fatal("join source unavailable error must retain its concealed class")
	}
}

func TestCredentialRechecksCurrentLobbyBypassAuthority(t *testing.T) {
	t.Parallel()

	credential := postgresInstanceRepositorySection(
		t,
		postgresInstanceRepositorySource(t),
		"func (repository *PostgresInstanceRepository) PrepareCredential(",
		"func (repository *PostgresInstanceRepository) CreateOrReuseJoinAttempt(",
	)
	roleCheck := strings.Index(
		credential,
		"space.LobbyEnabled && source.InstanceRole == InstanceRoleAttendee",
	)
	admissionCheck := strings.Index(credential, "requireAdmittedAdmission(")
	rateLimit := strings.Index(credential, "consumeMediaCredentialRateLimit(")
	if roleCheck < 0 || admissionCheck < roleCheck || rateLimit < admissionCheck {
		t.Fatal("credential must recheck current lobby admission before rate-limit or mint")
	}
}

func TestProviderRoomNameControlLockPrecedesAuthorizationRows(t *testing.T) {
	t.Parallel()

	section := postgresInstanceRepositorySection(
		t,
		postgresInstanceRepositorySource(t),
		"func (repository *PostgresInstanceRepository) ProviderRoomName(",
		"func (repository *PostgresInstanceRepository) PrepareCredential(",
	)
	controlLock := strings.Index(section, "repository.lifecycle.acquireTenantControlLock(")
	activeScope := strings.Index(section, "repository.lifecycle.requireActiveScope(")
	spaceLookup := strings.Index(section, "space, err := loadSpace(")
	if controlLock < 0 || activeScope < 0 || spaceLookup < 0 ||
		controlLock > activeScope || controlLock > spaceLookup {
		t.Fatal("provider room lookup must acquire the tenant control lock before authorization rows")
	}
}

func TestProviderWebhookClassifierSupportsBoundLifecycleTransitions(t *testing.T) {
	t.Parallel()

	receivedAt := time.Date(2026, time.August, 9, 10, 0, 0, 0, time.UTC)
	createdAt := receivedAt.Add(-time.Hour)
	transitionAt := receivedAt.Add(-time.Minute)
	base := providerRoomBinding{
		TenantID:       uuid.MustParse("b16dd520-65d5-4ea0-a7ca-62e43a35bbfb"),
		SpaceID:        uuid.MustParse("f6808028-e785-41d3-8cb6-bf027018ba41"),
		RoomInstanceID: uuid.MustParse("e97d4164-a66c-49dc-9bf3-28d694f565e7"),
		ProviderName:   "rm_opaque_01HZXZ9QGJQXZJ6J2T7S",
		CreatedAt:      createdAt,
	}
	active := base
	active.Status = RoomInstanceActive
	active.ProviderSID = sql.NullString{String: "RM_provider_sid", Valid: true}
	active.ActivatedAt = sql.NullTime{Time: createdAt.Add(10 * time.Minute), Valid: true}
	provisioning := base
	provisioning.Status = RoomInstanceProvisioning
	joining := &participantRow{
		ID:        uuid.MustParse("cb94435d-e0c8-451a-bfe4-bb669525d836"),
		Status:    "joining",
		CreatedAt: createdAt.Add(20 * time.Minute),
	}
	connected := *joining
	connected.Status = "connected"
	connected.ConnectedAt = sql.NullTime{Time: transitionAt.Add(-time.Minute), Valid: true}
	staleConnected := connected
	staleConnected.ConnectedAt = sql.NullTime{Time: transitionAt.Add(time.Second), Valid: true}
	sameSecondJoining := *joining
	sameSecondJoining.CreatedAt = transitionAt.Add(750 * time.Millisecond)
	sameSecondConnected := connected
	sameSecondConnected.ConnectedAt = sql.NullTime{
		Time: transitionAt.Add(750 * time.Millisecond), Valid: true,
	}
	recentlyLeft := connected
	recentlyLeft.Status = "left"
	recentlyLeft.AdmittedAt = sql.NullTime{Time: joining.CreatedAt, Valid: true}
	recentlyLeft.JoiningAt = sql.NullTime{Time: joining.CreatedAt, Valid: true}
	recentlyLeft.TerminalAt = sql.NullTime{Time: transitionAt.Add(-10 * time.Second), Valid: true}
	leftAfterJoin := recentlyLeft
	leftAfterJoin.TerminalAt = sql.NullTime{Time: transitionAt.Add(time.Second), Valid: true}
	removed := recentlyLeft
	removed.Status = "removed"

	tests := []struct {
		name         string
		binding      providerRoomBinding
		participant  *participantRow
		event        WebhookEvent
		resume       bool
		want         string
		wantMutation bool
	}{
		{
			name:        "transient same-identity rejoin resumes a re-authorized left participant",
			binding:     active,
			participant: &recentlyLeft,
			event: WebhookEvent{
				EventType: "participant_joined", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, ParticipantIdentity: "p_opaque",
				OccurredAt: transitionAt,
			},
			resume: true,
			want:   "applied", wantMutation: true,
		},
		{
			name:        "left participant stays terminal without re-proven resume authority",
			binding:     active,
			participant: &recentlyLeft,
			event: WebhookEvent{
				EventType: "participant_joined", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, ParticipantIdentity: "p_opaque",
				OccurredAt: transitionAt,
			},
			want: "ignored_terminal",
		},
		{
			name:        "joined older than the recorded left stays stale even with resume authority",
			binding:     active,
			participant: &leftAfterJoin,
			event: WebhookEvent{
				EventType: "participant_joined", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, ParticipantIdentity: "p_opaque",
				OccurredAt: transitionAt,
			},
			resume: true,
			want:   "ignored_stale",
		},
		{
			name:        "removed participant never resumes",
			binding:     active,
			participant: &removed,
			event: WebhookEvent{
				EventType: "participant_joined", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, ParticipantIdentity: "p_opaque",
				OccurredAt: transitionAt,
			},
			resume: true,
			want:   "ignored_terminal",
		},
		{
			name:        "resume authority never reopens a non-active room",
			binding:     provisioning,
			participant: &recentlyLeft,
			event: WebhookEvent{
				EventType: "participant_joined", RoomName: base.ProviderName,
				RoomSID: "RM_provider_sid", ParticipantIdentity: "p_opaque",
				OccurredAt: transitionAt,
			},
			resume: true,
			want:   "ignored_terminal",
		},
		{
			name:    "room started activates provisioning instance",
			binding: provisioning,
			event: WebhookEvent{
				EventType: "room_started", RoomName: base.ProviderName,
				RoomSID: "RM_provider_sid", OccurredAt: transitionAt,
			},
			want: "applied", wantMutation: true,
		},
		{
			name:    "room finished closes active instance",
			binding: active,
			event: WebhookEvent{
				EventType: "room_finished", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, OccurredAt: transitionAt,
			},
			want: "applied", wantMutation: true,
		},
		{
			name:    "room finished fails provisioning instance",
			binding: provisioning,
			event: WebhookEvent{
				EventType: "room_finished", RoomName: base.ProviderName,
				RoomSID: "RM_provider_sid", OccurredAt: transitionAt,
			},
			want: "applied", wantMutation: true,
		},
		{
			name:        "participant joined connects joining participant",
			binding:     active,
			participant: joining,
			event: WebhookEvent{
				EventType: "participant_joined", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, ParticipantIdentity: "p_opaque",
				OccurredAt: transitionAt,
			},
			want: "applied", wantMutation: true,
		},
		{
			name:        "participant left releases connected participant",
			binding:     active,
			participant: &connected,
			event: WebhookEvent{
				EventType: "participant_left", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, ParticipantIdentity: "p_opaque",
				OccurredAt: transitionAt,
			},
			want: "applied", wantMutation: true,
		},
		{
			name:        "same-second participant joined respects provider precision",
			binding:     active,
			participant: &sameSecondJoining,
			event: WebhookEvent{
				EventType: "participant_joined", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, ParticipantIdentity: "p_opaque",
				OccurredAt: transitionAt,
			},
			want: "applied", wantMutation: true,
		},
		{
			name:        "same-second participant left respects provider precision",
			binding:     active,
			participant: &sameSecondConnected,
			event: WebhookEvent{
				EventType: "participant_left", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, ParticipantIdentity: "p_opaque",
				OccurredAt: transitionAt,
			},
			want: "applied", wantMutation: true,
		},
		{
			name:        "out of order participant left is stale",
			binding:     active,
			participant: &staleConnected,
			event: WebhookEvent{
				EventType: "participant_left", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, ParticipantIdentity: "p_opaque",
				OccurredAt: transitionAt,
			},
			want: "ignored_stale",
		},
		{
			name:    "unknown participant is private no-op",
			binding: active,
			event: WebhookEvent{
				EventType: "participant_joined", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, ParticipantIdentity: "p_unknown",
				OccurredAt: transitionAt,
			},
			want: "ignored_unknown_participant",
		},
		{
			name:    "provider binding mismatch is ignored",
			binding: active,
			event: WebhookEvent{
				EventType: "room_finished", RoomName: "different_opaque_room",
				RoomSID: active.ProviderSID.String, OccurredAt: transitionAt,
			},
			want: "ignored_mismatch",
		},
		{
			name:    "unsupported provider event is receipt only",
			binding: active,
			event: WebhookEvent{
				EventType: "track_published", RoomName: base.ProviderName,
				RoomSID: active.ProviderSID.String, OccurredAt: transitionAt,
			},
			want: "ignored_unsupported_event",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			disposition, mutation := classifyProviderWebhook(
				test.binding,
				test.participant,
				test.event,
				receivedAt,
				test.resume,
			)
			if disposition != test.want {
				t.Fatalf("disposition = %q, want %q", disposition, test.want)
			}
			if (mutation != nil) != test.wantMutation {
				t.Fatalf("mutation present = %t, want %t", mutation != nil, test.wantMutation)
			}
		})
	}
}

func TestProviderTransitionTimePreservesDatabaseLifecycleConstraints(t *testing.T) {
	t.Parallel()

	stateAt := time.Date(2026, time.August, 9, 10, 0, 0, int(750*time.Millisecond), time.UTC)
	providerSameSecond := stateAt.Truncate(time.Second)
	if actual := providerTransitionTime(providerSameSecond, stateAt); !actual.Equal(stateAt) {
		t.Fatalf("same-second provider transition = %s, want clamped %s", actual, stateAt)
	}
	providerLater := stateAt.Add(time.Second).Truncate(time.Second)
	if actual := providerTransitionTime(providerLater, stateAt); !actual.Equal(providerLater) {
		t.Fatalf("later provider transition = %s, want %s", actual, providerLater)
	}
}

func TestPostgresInstanceRepositoryWebhookSQLUsesExactOpaqueBindings(t *testing.T) {
	t.Parallel()

	source := postgresInstanceRepositorySource(t)
	if strings.Contains(source, "ParseRoomName") {
		t.Fatal("room-instance webhook repository must not derive authority by parsing a room name")
	}

	discovery := postgresInstanceRepositorySection(
		t,
		source,
		"func discoverProviderRoomTenant(",
		"func loadProviderRoomBinding(",
	)
	for _, fragment := range []string{
		"SELECT tenant_id",
		"WHERE provider_kind = 'livekit'",
		"($1 <> '' AND provider_room_sid = $1)",
		"($2 <> '' AND provider_room_name = $2)",
		"ORDER BY CASE WHEN provider_room_sid = $1 THEN 0 ELSE 1 END",
		"LIMIT 1",
		"roomSID, roomName",
	} {
		if !strings.Contains(discovery, fragment) {
			t.Fatalf("provider room tenant discovery is missing %q", fragment)
		}
	}
	if strings.Contains(discovery, "FOR UPDATE") {
		t.Fatal("provider tenant discovery must not lock a room before the tenant advisory lock")
	}

	binding := postgresInstanceRepositorySection(
		t,
		source,
		"func loadProviderRoomBinding(",
		"type webhookMutation func",
	)
	for _, fragment := range []string{
		"roomSID := strings.TrimSpace(event.RoomSID)",
		"roomName := strings.TrimSpace(event.RoomName)",
		"WHERE tenant_id = $1",
		"AND provider_kind = 'livekit'",
		"($2 <> '' AND provider_room_sid = $2)",
		"($3 <> '' AND provider_room_name = $3)",
		"ORDER BY CASE WHEN provider_room_sid = $2 THEN 0 ELSE 1 END",
		"LIMIT 1",
		"FOR UPDATE",
		"tenantID, roomSID, roomName",
	} {
		if !strings.Contains(binding, fragment) {
			t.Fatalf("provider room binding lookup is missing %q", fragment)
		}
	}

	record := postgresInstanceRepositorySection(
		t,
		source,
		"func (repository *PostgresInstanceRepository) RecordProviderWebhook(",
		"type participantRow struct",
	)
	discoveryAt := strings.Index(record, "discoverProviderRoomTenant(")
	controlLockAt := strings.Index(record, "repository.lifecycle.acquireTenantControlLock(")
	bindingAt := strings.Index(record, "loadProviderRoomBinding(")
	if discoveryAt < 0 || controlLockAt < 0 || bindingAt < 0 ||
		discoveryAt > controlLockAt || controlLockAt > bindingAt {
		t.Fatal("provider webhook must discover tenant, acquire its advisory lock, then lock the exact binding")
	}

	participant := postgresInstanceRepositorySection(
		t,
		source,
		"func loadWebhookParticipant(",
		"func insertProviderWebhookReceipt(",
	)
	for _, fragment := range []string{
		"WHERE tenant_id = $1 AND space_id = $2 AND room_instance_id = $3",
		"AND provider_participant_identity = $4",
		"binding.TenantID, binding.SpaceID, binding.RoomInstanceID, identity",
	} {
		if !strings.Contains(participant, fragment) {
			t.Fatalf("provider participant binding lookup is missing %q", fragment)
		}
	}

	receipt := postgresInstanceRepositorySection(
		t,
		source,
		"func insertProviderWebhookReceipt(",
		"func validProviderIdentifier(",
	)
	for _, fragment := range []string{
		"provider_kind, event_id, tenant_id, space_id, room_instance_id",
		"participant_session_id, event_type, disposition, occurred_at",
		"received_at, retention_until",
		"VALUES ('livekit', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
		"ON CONFLICT (provider_kind, event_id) DO NOTHING",
		"receivedAt.Add(providerReceiptRetention)",
	} {
		if !strings.Contains(receipt, fragment) {
			t.Fatalf("provider receipt SQL is missing %q", fragment)
		}
	}
	for _, forbidden := range []string{
		"raw_payload",
		"payload",
		"room_name",
		"provider_room_name",
		"participant_identity",
		"provider_participant_identity",
		"participant_sid",
		"access_token",
		"api_key",
		"api_secret",
	} {
		if strings.Contains(strings.ToLower(receipt), forbidden) {
			t.Fatalf("provider receipt SQL persists forbidden field %q", forbidden)
		}
	}
}

func TestRoomTerminationReleasesParticipantCapacity(t *testing.T) {
	t.Parallel()

	instanceSource := postgresInstanceRepositorySource(t)
	roomFinished := postgresInstanceRepositorySection(
		t,
		instanceSource,
		`case "room_finished":`,
		`case "participant_joined", "participant_left":`,
	)
	if !strings.Contains(roomFinished, "return failRoomParticipants(") {
		t.Fatal("provider room-finished transition must fail participants and release capacity")
	}

	lifecycleContents, err := os.ReadFile("postgres_lifecycle_repository.go")
	if err != nil {
		t.Fatal(err)
	}
	lifecycleSource := string(lifecycleContents)
	endSection := postgresInstanceRepositorySection(
		t,
		lifecycleSource,
		"func (repository *PostgresLifecycleRepository) endSpace(",
		"func (repository *PostgresLifecycleRepository) cancelSpace(",
	)
	if !strings.Contains(endSection, "terminateRoomParticipants(") {
		t.Fatal("authorized media-space end must release active participant capacity")
	}
	if !strings.Contains(endSection, "loadRoomForTermination(") {
		t.Fatal("authorized media-space end must recover a provider-failed room intent")
	}
	terminationLookup := postgresInstanceRepositorySection(
		t,
		lifecycleSource,
		"func loadRoomForTermination(",
		"func (room roomRow) project(",
	)
	for _, fragment := range []string{
		"status IN ('provisioning', 'active', 'closing', 'failed')",
		"ORDER BY attempt_number DESC",
		"LIMIT 1",
		"FOR UPDATE",
	} {
		if !strings.Contains(terminationLookup, fragment) {
			t.Fatalf("room termination recovery lookup is missing %q", fragment)
		}
	}
	termination := postgresInstanceRepositorySection(
		t,
		lifecycleSource,
		"func terminateRoomParticipants(",
		"func insertTransitionReceipt(",
	)
	for _, fragment := range []string{
		"SET status = 'left', version = version + 1, capacity_reserved = false",
		"terminal_at = $4, reconnecting_at = NULL, updated_at = $4",
		"WHERE tenant_id = $1 AND space_id = $2 AND room_instance_id = $3",
		"status IN ('waiting', 'admitted', 'joining', 'connected', 'reconnecting')",
	} {
		if !strings.Contains(termination, fragment) {
			t.Fatalf("participant termination is missing %q", fragment)
		}
	}
}

func TestRoomSyncFixBoundsAreExact(t *testing.T) {
	t.Parallel()

	if transientParticipantReconnectGrace != 2*time.Minute {
		t.Fatalf("transient reconnect grace = %s, want 2m", transientParticipantReconnectGrace)
	}
	if abandonedPreconnectParticipantTTL != 90*time.Second {
		t.Fatalf("abandoned pre-connect TTL = %s, want 90s", abandonedPreconnectParticipantTTL)
	}
}

// The window checks run before any database access, so a nil transaction
// proves that out-of-window or incomplete rows never reach authority lookups.
func TestWebhookResumeRejectsOutOfWindowLeftParticipantBeforeDatabaseAccess(t *testing.T) {
	t.Parallel()

	terminalAt := time.Date(2026, time.November, 23, 9, 0, 0, int(250*time.Millisecond), time.UTC)
	binding := providerRoomBinding{
		TenantID:       uuid.MustParse("b16dd520-65d5-4ea0-a7ca-62e43a35bbfb"),
		SpaceID:        uuid.MustParse("f6808028-e785-41d3-8cb6-bf027018ba41"),
		RoomInstanceID: uuid.MustParse("e97d4164-a66c-49dc-9bf3-28d694f565e7"),
		Status:         RoomInstanceActive,
	}
	left := participantRow{
		ID:         uuid.MustParse("cb94435d-e0c8-451a-bfe4-bb669525d836"),
		UserID:     uuid.MustParse("1d7d65eb-904e-4a0d-bd24-a8ec1b453d64"),
		Status:     "left",
		AdmittedAt: sql.NullTime{Time: terminalAt.Add(-time.Minute), Valid: true},
		JoiningAt:  sql.NullTime{Time: terminalAt.Add(-time.Minute), Valid: true},
		TerminalAt: sql.NullTime{Time: terminalAt, Valid: true},
	}
	inactive := binding
	inactive.Status = RoomInstanceFailed
	neverJoined := left
	neverJoined.JoiningAt = sql.NullTime{}
	unknownUser := left
	unknownUser.UserID = uuid.Nil
	notLeft := left
	notLeft.Status = "removed"

	for _, test := range []struct {
		name        string
		binding     providerRoomBinding
		participant participantRow
		occurredAt  time.Time
		receivedAt  time.Time
	}{
		{
			name: "outside grace", binding: binding, participant: left,
			occurredAt: terminalAt.Add(transientParticipantReconnectGrace),
			receivedAt: terminalAt.Add(transientParticipantReconnectGrace + time.Second),
		},
		{
			name: "received before terminal", binding: binding, participant: left,
			occurredAt: terminalAt, receivedAt: terminalAt.Add(-time.Second),
		},
		{
			name: "event before terminal second", binding: binding, participant: left,
			occurredAt: terminalAt.Add(-2 * time.Second), receivedAt: terminalAt.Add(time.Second),
		},
		{
			name: "room not active", binding: inactive, participant: left,
			occurredAt: terminalAt, receivedAt: terminalAt.Add(time.Second),
		},
		{
			name: "never reached joining", binding: binding, participant: neverJoined,
			occurredAt: terminalAt, receivedAt: terminalAt.Add(time.Second),
		},
		{
			name: "missing user binding", binding: binding, participant: unknownUser,
			occurredAt: terminalAt, receivedAt: terminalAt.Add(time.Second),
		},
		{
			name: "not a left session", binding: binding, participant: notLeft,
			occurredAt: terminalAt, receivedAt: terminalAt.Add(time.Second),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			allowed, err := (&PostgresInstanceRepository{}).canResumeLeftWebhookParticipant(
				context.Background(), nil, test.binding, test.participant,
				WebhookEvent{EventType: "participant_joined", OccurredAt: test.occurredAt},
				test.receivedAt,
			)
			if err != nil || allowed {
				t.Fatalf("resume allowed = %t error = %v, want false/nil", allowed, err)
			}
		})
	}
}

func TestWebhookResumeReprovesAuthorityBeforeRestoringLeftParticipant(t *testing.T) {
	t.Parallel()

	source := postgresInstanceRepositorySource(t)
	record := postgresInstanceRepositorySection(
		t,
		source,
		"func (repository *PostgresInstanceRepository) RecordProviderWebhook(",
		"type participantRow struct",
	)
	requireOrderedRepositoryFragments(t, record, []string{
		"loadWebhookParticipant(",
		`event.EventType == "participant_joined"`,
		`participant.Status == "left"`,
		"repository.canResumeLeftWebhookParticipant(",
		"classifyProviderWebhook(",
		"binding, participant, event, receivedAt, allowLeftResume,",
		"insertProviderWebhookReceipt(",
	})

	eligibility := postgresInstanceRepositorySection(
		t,
		source,
		"func (repository *PostgresInstanceRepository) canResumeLeftWebhookParticipant(",
		"func (repository *PostgresInstanceRepository) hasWebhookResumeAuthority(",
	)
	requireOrderedRepositoryFragments(t, eligibility, []string{
		"binding.Status != RoomInstanceActive",
		"!participant.JoiningAt.Valid || !participant.TerminalAt.Valid",
		"receivedAt.Sub(terminalAt) > transientParticipantReconnectGrace",
		"loadSpace(ctx, transaction, binding.TenantID, binding.SpaceID, false)",
		"space.Status != SpaceStatusOpen",
		"hasUnrestoredRemovalBarrier(",
		"hasActiveParticipant(",
		"repository.hasWebhookResumeAuthority(",
		`"media-participant-capacity:"+binding.TenantID.String()`,
		"repository.requireParticipantCapacity(",
	})
	if strings.Contains(eligibility, "space.Locked") {
		t.Fatal("a room lock must not block resuming an already-issued credential")
	}

	authority := postgresInstanceRepositorySection(
		t,
		source,
		"func (repository *PostgresInstanceRepository) hasWebhookResumeAuthority(",
		"func webhookResumeDenied(",
	)
	requireOrderedRepositoryFragments(t, authority, []string{
		"repository.lifecycle.requireActiveScope(",
		"AccessContext{TenantID: binding.TenantID, ActorID: participant.UserID}",
		"featurecontrol.FeatureClassroomMediaRooms",
		"repository.lifecycle.authorizeSource(",
		"policy.ActionSessionJoin, false, false",
		"sourceAvailableForJoin(source)",
		"resolveEffectiveCredentialSource(",
		"source.InstanceRole == participant.InstanceRole",
	})

	classifier := postgresInstanceRepositorySection(
		t,
		source,
		"func classifyParticipantWebhook(",
		"func advanceMediaRosterProjection(",
	)
	requireOrderedRepositoryFragments(t, classifier, []string{
		"providerEventBefore(transitionAt, lastTransitionAt)",
		`case "left":`,
		"if !allowLeftResume {",
		`return "ignored_terminal", nil`,
		"SET status = 'connected', capacity_reserved = true, version = version + 1",
		"connected_at = COALESCE(connected_at, GREATEST($5::timestamptz, joining_at))",
		"reconnecting_at = NULL, terminal_at = NULL",
		"WHERE tenant_id = $1 AND space_id = $2 AND room_instance_id = $3",
		"AND id = $4 AND status = 'left'",
		"AND admitted_at IS NOT NULL AND joining_at IS NOT NULL",
		"advanceMediaRosterProjection(",
		`case "removed", "failed":`,
	})
	if !strings.Contains(
		classifier,
		"connected_at = COALESCE(connected_at, GREATEST($5::timestamptz, joining_at)),\n    reconnecting_at = NULL,\n    updated_at = GREATEST($5::timestamptz, joining_at)",
	) {
		t.Fatal("joining -> connected must never record connected_at before joining_at")
	}

	for _, err := range []error{
		ErrSpaceAccessDenied, ErrSpaceNotFound, ErrSourceUnavailable,
		&featurecontrol.FeatureDisabledError{Feature: featurecontrol.FeatureClassroomMediaRooms},
		&featurecontrol.QuotaExceededError{Quota: featurecontrol.QuotaActiveMediaParticipants},
	} {
		if !webhookResumeDenied(err) {
			t.Fatalf("authorization denial %v must keep the left session terminal", err)
		}
	}
	for _, err := range []error{ErrLifecycleUnavailable, errors.New("driver failure")} {
		if webhookResumeDenied(err) {
			t.Fatalf("infrastructure failure %v must not be treated as a denial", err)
		}
	}
}

func TestJoinAttemptRetiresOnlyAbandonedOwnPreconnectSessions(t *testing.T) {
	t.Parallel()

	source := postgresInstanceRepositorySource(t)
	attempt := postgresInstanceRepositorySection(
		t,
		source,
		"func (repository *PostgresInstanceRepository) CreateOrReuseJoinAttempt(",
		"func (repository *PostgresInstanceRepository) requireParticipantCapacity(",
	)
	requireOrderedRepositoryFragments(t, attempt, []string{
		"loadParticipantByAttempt(",
		"retireAbandonedPreconnectParticipants(",
		"scope.TenantID, space.ID, room.ID,",
		"scope.ActorID, input.JoinAttemptID, now,",
		"hasActiveParticipant(",
		"hasUnrestoredRemovalBarrier(",
		"media-participant-capacity:",
		"INSERT INTO tutorhub.media_admission_requests",
		"INSERT INTO tutorhub.media_participant_sessions",
	})

	retire := postgresInstanceRepositorySection(
		t,
		source,
		"func retireAbandonedPreconnectParticipants(",
		"func (repository *PostgresInstanceRepository) canResumeLeftWebhookParticipant(",
	)
	requireOrderedRepositoryFragments(t, retire, []string{
		"SET status = 'left', capacity_reserved = false, version = version + 1",
		"terminal_at = GREATEST($6::timestamptz, updated_at), reconnecting_at = NULL",
		"updated_at = GREATEST($6::timestamptz, updated_at)",
		"WHERE tenant_id = $1 AND space_id = $2 AND room_instance_id = $3",
		"AND user_id = $4 AND join_attempt_id <> $5",
		"AND status IN ('admitted', 'joining') AND connected_at IS NULL",
		"updated_at <= $7::timestamptz",
		"FROM tutorhub.media_join_diagnostics AS diag",
		"WHERE diag.tenant_id = $1 AND diag.space_id = $2",
		"AND diag.room_instance_id = $3",
		"AND diag.participant_session_id = tutorhub.media_participant_sessions.id",
		"AND diag.stage IN ('disconnected', 'leave')",
		"now.Add(-abandonedPreconnectParticipantTTL)",
		"UPDATE tutorhub.media_participant_hand_states",
		"SET is_raised = false",
		"advanceMediaRosterProjection(",
	})
	for _, forbidden := range []string{
		"'waiting'", "'connected'", "'reconnecting'", "DELETE FROM",
	} {
		if strings.Contains(retire, forbidden) {
			t.Fatalf("pre-connect retire touches forbidden state %q", forbidden)
		}
	}
}

func requireOrderedRepositoryFragments(t *testing.T, section string, fragments []string) {
	t.Helper()
	offset := 0
	for _, fragment := range fragments {
		index := strings.Index(section[offset:], fragment)
		if index < 0 {
			t.Fatalf("repository section is missing ordered fragment %q", fragment)
		}
		offset += index + len(fragment)
	}
}

func postgresInstanceRepositorySource(t *testing.T) string {
	t.Helper()
	contents, err := os.ReadFile("postgres_instance_repository.go")
	if err != nil {
		t.Fatal(err)
	}
	return string(contents)
}

func postgresInstanceRepositorySection(
	t *testing.T,
	source string,
	startMarker string,
	endMarker string,
) string {
	t.Helper()
	start := strings.Index(source, startMarker)
	if start < 0 {
		t.Fatalf("repository source is missing start marker %q", startMarker)
	}
	endOffset := strings.Index(source[start:], endMarker)
	if endOffset < 0 {
		t.Fatalf("repository source is missing end marker %q", endMarker)
	}
	return source[start : start+endOffset]
}
