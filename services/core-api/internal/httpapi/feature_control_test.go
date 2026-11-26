package httpapi

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
)

func TestMapTenantCapabilitiesProjectsEveryCatalogFeatureAndQuota(t *testing.T) {
	t.Parallel()

	catalog := featurecontrol.NewDefaultCatalog()
	capabilities := featurecontrol.Capabilities{TenantID: uuid.New(), Version: 1}
	for _, definition := range catalog.Features() {
		capabilities.Features = append(capabilities.Features, featurecontrol.FeatureCapability{
			EffectiveFeature: featurecontrol.EffectiveFeature{Key: definition.Key, Enabled: true},
		})
	}
	for _, definition := range catalog.Quotas() {
		capabilities.Quotas = append(capabilities.Quotas, featurecontrol.QuotaCapability{
			EffectiveQuota: featurecontrol.EffectiveQuota{Key: definition.Key, Limit: definition.DefaultLimit},
		})
	}

	response, err := mapTenantCapabilities(capabilities)
	if err != nil {
		t.Fatalf("map tenant capabilities: %v", err)
	}
	rawFeatures, err := json.Marshal(response.Features)
	if err != nil {
		t.Fatalf("marshal projected features: %v", err)
	}
	var projectedFeatures map[string]any
	if err := json.Unmarshal(rawFeatures, &projectedFeatures); err != nil {
		t.Fatalf("unmarshal projected features: %v", err)
	}
	for _, definition := range catalog.Features() {
		if _, ok := projectedFeatures[string(definition.Key)]; !ok {
			t.Fatalf("catalog feature %q is missing from HTTP capabilities response", definition.Key)
		}
	}
	if len(projectedFeatures) != len(catalog.Features()) {
		t.Fatalf("projected features count = %d, catalog = %d", len(projectedFeatures), len(catalog.Features()))
	}

	rawQuotas, err := json.Marshal(response.Quotas)
	if err != nil {
		t.Fatalf("marshal projected quotas: %v", err)
	}
	var projectedQuotas map[string]any
	if err := json.Unmarshal(rawQuotas, &projectedQuotas); err != nil {
		t.Fatalf("unmarshal projected quotas: %v", err)
	}
	for _, definition := range catalog.Quotas() {
		if _, ok := projectedQuotas[string(definition.Key)]; !ok {
			t.Fatalf("catalog quota %q is missing from HTTP capabilities response", definition.Key)
		}
	}
	if len(projectedQuotas) != len(catalog.Quotas()) {
		t.Fatalf("projected quotas count = %d, catalog = %d", len(projectedQuotas), len(catalog.Quotas()))
	}
}

func TestMapTenantCapabilitiesIncludesAvailabilityPollProfile(t *testing.T) {
	t.Parallel()

	capabilities := featurecontrol.Capabilities{
		TenantID: uuid.New(),
		Version:  7,
		AllowedAction: featurecontrol.AllowedActions{
			ManageControls: true,
		},
	}
	for _, definition := range featurecontrol.NewDefaultCatalog().Features() {
		capabilities.Features = append(capabilities.Features, featurecontrol.FeatureCapability{
			EffectiveFeature:  featurecontrol.EffectiveFeature{Key: definition.Key, Enabled: true},
			ConfiguredEnabled: true,
		})
	}
	for _, definition := range featurecontrol.NewDefaultCatalog().Quotas() {
		capabilities.Quotas = append(capabilities.Quotas, featurecontrol.QuotaCapability{
			EffectiveQuota:  featurecontrol.EffectiveQuota{Key: definition.Key, Limit: definition.DefaultLimit},
			ConfiguredLimit: definition.DefaultLimit,
			Used:            0,
		})
	}

	response, err := mapTenantCapabilities(capabilities)
	if err != nil {
		t.Fatalf("map tenant capabilities: %v", err)
	}
	if !response.Features.AvailabilityPolls.Enabled {
		t.Fatal("availability poll feature is missing from capability projection")
	}
	if !response.Features.Conversations.Enabled || !response.Operations.CreateConversation.Available {
		t.Fatal("conversation feature is missing from capability projection")
	}
	if !response.Features.ClassroomMediaRooms.Enabled || !response.Features.InstantStudyRooms.Enabled {
		t.Fatal("media features are missing from capability projection")
	}
	if response.Quotas.ActiveAvailabilityPolls.Limit != 20 ||
		response.Quotas.AvailabilityPollRangeDays.Limit != 31 ||
		response.Quotas.AvailabilityPollSlots.Limit != 336 ||
		response.Quotas.AvailabilityPollParticipants.Limit != 100 ||
		response.Quotas.AvailabilityPollCreationsPerHour.Limit != 20 ||
		response.Quotas.AvailabilityPollCapabilityCreationsPerHour.Limit != 60 ||
		response.Quotas.ActiveStudyMeetings.Limit != 20 ||
		response.Quotas.StudyMeetingCreationsPerHour.Limit != 20 ||
		response.Quotas.ActiveMediaSpaces.Limit != 10 ||
		response.Quotas.MediaParticipantsPerSpace.Limit != 50 ||
		response.Quotas.ActiveMediaParticipants.Limit != 100 ||
		response.Quotas.MediaSpaceStartsPerHour.Limit != 20 {
		t.Fatalf("unexpected availability poll quota projection: %+v", response.Quotas)
	}
	if !response.Operations.CreateAvailabilityPoll.Available ||
		!response.Operations.CreateAvailabilityPollCapability.Available ||
		!response.Operations.ScheduleStudyMeeting.Available {
		t.Fatalf("unexpected availability poll operation projection: %+v", response.Operations)
	}
}

func TestMapTenantCapabilitiesRejectsIncompleteMediaProfile(t *testing.T) {
	t.Parallel()

	capabilities := featurecontrol.Capabilities{}
	for _, definition := range featurecontrol.NewDefaultCatalog().Features() {
		if definition.Key == featurecontrol.FeatureClassroomMediaRooms {
			continue
		}
		capabilities.Features = append(capabilities.Features, featurecontrol.FeatureCapability{
			EffectiveFeature: featurecontrol.EffectiveFeature{Key: definition.Key, Enabled: definition.DefaultEnabled},
		})
	}
	for _, definition := range featurecontrol.NewDefaultCatalog().Quotas() {
		capabilities.Quotas = append(capabilities.Quotas, featurecontrol.QuotaCapability{
			EffectiveQuota: featurecontrol.EffectiveQuota{Key: definition.Key, Limit: definition.DefaultLimit},
		})
	}
	if _, err := mapTenantCapabilities(capabilities); err == nil {
		t.Fatal("incomplete media capability snapshot unexpectedly mapped")
	}
}

func TestMapTenantCapabilitiesStudyMeetingQuotaReasons(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		exhausted  featurecontrol.QuotaKey
		wantReason string
	}{
		{
			name:       "active capacity has precedence",
			exhausted:  featurecontrol.QuotaActiveStudyMeetings,
			wantReason: "quota_exhausted",
		},
		{
			name:       "creation window is rate limited",
			exhausted:  featurecontrol.QuotaStudyMeetingCreationsPerHour,
			wantReason: "rate_limited",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			capabilities := featurecontrol.Capabilities{}
			for _, definition := range featurecontrol.NewDefaultCatalog().Features() {
				capabilities.Features = append(capabilities.Features, featurecontrol.FeatureCapability{
					EffectiveFeature: featurecontrol.EffectiveFeature{Key: definition.Key, Enabled: true},
				})
			}
			for _, definition := range featurecontrol.NewDefaultCatalog().Quotas() {
				used := int64(0)
				if definition.Key == test.exhausted {
					used = definition.DefaultLimit
				}
				capabilities.Quotas = append(capabilities.Quotas, featurecontrol.QuotaCapability{
					EffectiveQuota: featurecontrol.EffectiveQuota{
						Key: definition.Key, Limit: definition.DefaultLimit,
					},
					Used: used,
				})
			}
			response, err := mapTenantCapabilities(capabilities)
			if err != nil {
				t.Fatalf("map tenant capabilities: %v", err)
			}
			if response.Operations.ScheduleStudyMeeting.Available ||
				response.Operations.ScheduleStudyMeeting.Reason != test.wantReason {
				t.Fatalf("study meeting operation = %+v", response.Operations.ScheduleStudyMeeting)
			}
		})
	}
}

func TestMapTenantCapabilitiesAvailabilityPollOperationReasons(t *testing.T) {
	t.Parallel()

	capabilities := featurecontrol.Capabilities{}
	for _, definition := range featurecontrol.NewDefaultCatalog().Features() {
		capabilities.Features = append(capabilities.Features, featurecontrol.FeatureCapability{
			EffectiveFeature:  featurecontrol.EffectiveFeature{Key: definition.Key, Enabled: definition.Key != featurecontrol.FeatureAvailabilityPolls},
			ConfiguredEnabled: true,
		})
	}
	for _, definition := range featurecontrol.NewDefaultCatalog().Quotas() {
		used := int64(0)
		if definition.Key == featurecontrol.QuotaActiveAvailabilityPolls {
			used = definition.DefaultLimit
		}
		capabilities.Quotas = append(capabilities.Quotas, featurecontrol.QuotaCapability{
			EffectiveQuota:  featurecontrol.EffectiveQuota{Key: definition.Key, Limit: definition.DefaultLimit},
			ConfiguredLimit: definition.DefaultLimit,
			Used:            used,
		})
	}
	response, err := mapTenantCapabilities(capabilities)
	if err != nil {
		t.Fatalf("map tenant capabilities: %v", err)
	}
	if response.Operations.CreateAvailabilityPoll.Reason != "feature_disabled" ||
		response.Operations.CreateAvailabilityPollCapability.Reason != "feature_disabled" ||
		response.Operations.ScheduleStudyMeeting.Reason != "feature_disabled" {
		t.Fatalf("feature-disabled operation reasons = %+v", response.Operations)
	}
}

func TestMapTenantCapabilitiesRejectsIncompleteAvailabilityPollProfile(t *testing.T) {
	t.Parallel()

	capabilities := featurecontrol.Capabilities{}
	for _, definition := range featurecontrol.NewDefaultCatalog().Features() {
		if definition.Key == featurecontrol.FeatureAvailabilityPolls {
			continue
		}
		capabilities.Features = append(capabilities.Features, featurecontrol.FeatureCapability{
			EffectiveFeature: featurecontrol.EffectiveFeature{Key: definition.Key, Enabled: true},
		})
	}
	if _, err := mapTenantCapabilities(capabilities); err == nil {
		t.Fatal("incomplete availability poll capability snapshot unexpectedly mapped")
	}
}

func TestMapTenantCapabilitiesConversationFeatureReason(t *testing.T) {
	t.Parallel()

	capabilities := featurecontrol.Capabilities{}
	for _, definition := range featurecontrol.NewDefaultCatalog().Features() {
		capabilities.Features = append(capabilities.Features, featurecontrol.FeatureCapability{
			EffectiveFeature: featurecontrol.EffectiveFeature{
				Key: definition.Key, Enabled: definition.Key != featurecontrol.FeatureConversations,
			},
		})
	}
	for _, definition := range featurecontrol.NewDefaultCatalog().Quotas() {
		capabilities.Quotas = append(capabilities.Quotas, featurecontrol.QuotaCapability{
			EffectiveQuota: featurecontrol.EffectiveQuota{Key: definition.Key, Limit: definition.DefaultLimit},
		})
	}
	response, err := mapTenantCapabilities(capabilities)
	if err != nil {
		t.Fatalf("map tenant capabilities: %v", err)
	}
	if response.Operations.CreateConversation.Available ||
		response.Operations.CreateConversation.Reason != "feature_disabled" {
		t.Fatalf("conversation operation = %+v", response.Operations.CreateConversation)
	}
}
