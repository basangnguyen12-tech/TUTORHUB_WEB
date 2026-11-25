package collaboration

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/modules/featurecontrol"
	"github.com/tutorhub-v2/core-api/internal/modules/media"
	"github.com/tutorhub-v2/core-api/internal/policy"
)

func TestCodeSnippetPolicyMatrix(t *testing.T) {
	t.Parallel()
	tenantID, ownerID, otherID, classID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	owner := codeLibraryAccess(tenantID, ownerID, policy.OrganizationRoleTeacher)
	other := codeLibraryAccess(tenantID, otherID, policy.OrganizationRoleStudent)
	admin := codeLibraryAccess(tenantID, otherID, policy.OrganizationRoleAdmin)
	personal := CodeSnippetRecord{ID: uuid.New(), OwnerUserID: ownerID, Visibility: CodeSnippetPersonal, Version: 1}
	class := CodeSnippetRecord{ID: uuid.New(), OwnerUserID: ownerID, Visibility: CodeSnippetClass, ClassID: classID, Version: 1}
	none := CodeLibraryClassRelation{Exists: true}
	student := CodeLibraryClassRelation{Exists: true, Member: true}
	staff := CodeLibraryClassRelation{Exists: true, Member: true, Staff: true}
	missing := CodeLibraryClassRelation{}

	for name, test := range map[string]struct {
		access   AccessContext
		record   CodeSnippetRecord
		relation CodeLibraryClassRelation
		read     bool
		manage   bool
	}{
		"personal owner":               {owner, personal, missing, true, true},
		"personal other member":        {other, personal, missing, false, false},
		"personal organization admin":  {admin, personal, missing, false, false},
		"class student member":         {other, class, student, true, false},
		"class staff":                  {other, class, staff, true, true},
		"class outsider":               {other, class, none, false, false},
		"class organization admin":     {admin, class, none, true, true},
		"class admin of foreign class": {admin, class, missing, false, false},
		"class owner still member":     {owner, class, student, true, true},
		"class owner who left":         {owner, class, none, false, false},
	} {
		if got := codeSnippetReadable(test.access, test.record, test.relation); got != test.read {
			t.Fatalf("%s: readable=%t want %t", name, got, test.read)
		}
		capabilities := codeSnippetCapabilities(test.access, test.record, test.relation)
		if capabilities.CanEdit != test.manage || capabilities.CanDelete != test.manage {
			t.Fatalf("%s: capabilities=%+v want manage=%t", name, capabilities, test.manage)
		}
	}
	deleted := personal
	deleted.Deleted = true
	if codeSnippetReadable(owner, deleted, missing) || codeSnippetCapabilities(owner, deleted, missing).CanEdit {
		t.Fatal("a soft-deleted snippet must never be readable or editable")
	}

	for name, test := range map[string]struct {
		access     AccessContext
		visibility CodeSnippetVisibility
		relation   CodeLibraryClassRelation
		want       error
	}{
		"personal by student":       {other, CodeSnippetPersonal, missing, nil},
		"class by student member":   {other, CodeSnippetClass, student, ErrCodeLibraryForbidden},
		"class by outsider":         {other, CodeSnippetClass, none, ErrNotFound},
		"class in foreign tenant":   {admin, CodeSnippetClass, missing, ErrNotFound},
		"class by staff":            {other, CodeSnippetClass, staff, nil},
		"class by organization adm": {admin, CodeSnippetClass, none, nil},
		"unknown visibility":        {other, CodeSnippetVisibility("tenant"), staff, ErrInvalidRequest},
	} {
		if err := codeSnippetCreateDecision(test.access, test.visibility, test.relation); !errors.Is(err, test.want) && !(err == nil && test.want == nil) {
			t.Fatalf("%s: create decision=%v want %v", name, err, test.want)
		}
	}

	if err := authorizeCodeSnippetUpdate(other, class, student, 1); !errors.Is(err, ErrCodeLibraryForbidden) {
		t.Fatalf("readable but not editable class snippet must be 403, got %v", err)
	}
	if err := authorizeCodeSnippetUpdate(other, personal, missing, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unreadable snippet must be concealed, got %v", err)
	}
	if err := authorizeCodeSnippetUpdate(owner, personal, missing, 2); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale version must be a CAS conflict, got %v", err)
	}
	if err := authorizeCodeSnippetDelete(other, class, student); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete without permission must be concealed as 404, got %v", err)
	}
}

func TestCodeScratchpadCASAndStorageGrowthRules(t *testing.T) {
	t.Parallel()
	for name, test := range map[string]struct {
		live     bool
		current  int64
		expected int64
		want     error
	}{
		"first draft":                 {false, 0, 0, nil},
		"first draft asserts version": {false, 0, 3, ErrCodeScratchpadVersionConflict},
		"live exact version":          {true, 4, 4, nil},
		"live stale version":          {true, 4, 3, ErrCodeScratchpadVersionConflict},
		"live blind overwrite":        {true, 4, 0, ErrCodeScratchpadVersionConflict},
	} {
		if err := authorizeCodeScratchpadWrite(test.live, test.current, test.expected); !errors.Is(err, test.want) && !(err == nil && test.want == nil) {
			t.Fatalf("%s: %v want %v", name, err, test.want)
		}
	}
	if _, enforce := codeStorageRequested(1_000, 500, 400); enforce {
		t.Fatal("shrinking content must never be blocked by the storage quota")
	}
	if requested, enforce := codeStorageRequested(1_000, 500, 900); !enforce || requested != 1_900 {
		t.Fatalf("growth must request used+next bytes, got %d %t", requested, enforce)
	}
	if err := classifyCodeLibraryControlError(&featurecontrol.QuotaExceededError{Quota: featurecontrol.QuotaCodeSnippetsPerMember}); !errors.Is(err, ErrCodeSnippetQuotaExceeded) {
		t.Fatalf("snippet quota mapped to %v", err)
	}
	if err := classifyCodeLibraryControlError(&featurecontrol.QuotaExceededError{Quota: featurecontrol.QuotaCodeStorageBytesPerTenant}); !errors.Is(err, ErrCodeStorageQuotaExceeded) {
		t.Fatalf("storage quota mapped to %v", err)
	}
	if err := classifyCodeLibraryControlError(&featurecontrol.FeatureDisabledError{Feature: featurecontrol.FeatureCodeSnippetLibrary}); !errors.Is(err, ErrFeatureDisabled) {
		t.Fatalf("disabled library mapped to %v", err)
	}
	if err := classifyCodeLibraryControlError(featurecontrol.ErrTenantNotFound); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign tenant mapped to %v", err)
	}
}

func TestCodeSnippetCrossTenantAndCrossClassConcealment(t *testing.T) {
	t.Parallel()
	store := newFakeCodeLibraryStore()
	tenantID, foreignTenantID := uuid.New(), uuid.New()
	teacherID, studentID, outsiderID := uuid.New(), uuid.New(), uuid.New()
	classID, otherClassID := uuid.New(), uuid.New()
	store.addClass(tenantID, classID)
	store.addClass(tenantID, otherClassID)
	store.relate(tenantID, classID, teacherID, CodeLibraryClassRelation{Exists: true, Member: true, Staff: true})
	store.relate(tenantID, classID, studentID, CodeLibraryClassRelation{Exists: true, Member: true})
	service := newTestCodeLibraryService(t, store, nil)
	teacher := codeLibraryAccess(tenantID, teacherID, policy.OrganizationRoleTeacher)
	student := codeLibraryAccess(tenantID, studentID, policy.OrganizationRoleStudent)
	outsider := codeLibraryAccess(tenantID, outsiderID, policy.OrganizationRoleStudent)
	foreign := codeLibraryAccess(foreignTenantID, teacherID, policy.OrganizationRoleAdmin)

	personal := mustCreateSnippet(t, service, student, codeSnippetInput("personal-0000000001", CodeSnippetPersonal, uuid.Nil))
	classSnippet := mustCreateSnippet(t, service, teacher, codeSnippetInput("class-snippet-00001", CodeSnippetClass, classID))

	if _, err := service.CreateSnippet(context.Background(), student, codeSnippetInput("class-by-student-01", CodeSnippetClass, classID)); !errors.Is(err, ErrCodeLibraryForbidden) {
		t.Fatalf("student class snippet must be 403, got %v", err)
	}
	if _, err := service.CreateSnippet(context.Background(), outsider, codeSnippetInput("class-by-outsider01", CodeSnippetClass, classID)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider class snippet must be concealed, got %v", err)
	}
	if _, err := service.CreateSnippet(context.Background(), teacher, codeSnippetInput("class-other-class01", CodeSnippetClass, otherClassID)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("teacher of another class must be concealed, got %v", err)
	}

	for name, attempt := range map[string]func() error{
		"teacher reads student personal": func() error { _, err := service.GetSnippet(context.Background(), teacher, personal.ID); return err },
		"outsider reads class snippet": func() error {
			_, err := service.GetSnippet(context.Background(), outsider, classSnippet.ID)
			return err
		},
		"foreign tenant reads personal": func() error { _, err := service.GetSnippet(context.Background(), foreign, personal.ID); return err },
		"foreign tenant lists class": func() error {
			_, err := service.ListSnippets(context.Background(), foreign, CodeSnippetListInput{Scope: CodeSnippetClass, ClassID: classID})
			return err
		},
		"outsider lists class": func() error {
			_, err := service.ListSnippets(context.Background(), outsider, CodeSnippetListInput{Scope: CodeSnippetClass, ClassID: classID})
			return err
		},
		"outsider patches class snippet": func() error {
			title := "hijack"
			_, err := service.UpdateSnippet(context.Background(), outsider, classSnippet.ID, CodeSnippetUpdateInput{ExpectedVersion: 1, Title: &title})
			return err
		},
		"student deletes class snippet":  func() error { return service.DeleteSnippet(context.Background(), student, classSnippet.ID) },
		"foreign tenant deletes snippet": func() error { return service.DeleteSnippet(context.Background(), foreign, personal.ID) },
	} {
		if err := attempt(); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s must be a uniform 404, got %v", name, err)
		}
	}

	read, err := service.GetSnippet(context.Background(), student, classSnippet.ID)
	if err != nil || read.Viewer.CanEdit || read.Viewer.CanDelete || read.Content == "" {
		t.Fatalf("student class read=%+v err=%v", read.Viewer, err)
	}
	title := "student rename"
	if _, err := service.UpdateSnippet(context.Background(), student, classSnippet.ID, CodeSnippetUpdateInput{ExpectedVersion: 1, Title: &title}); !errors.Is(err, ErrCodeLibraryForbidden) {
		t.Fatalf("student edit of readable class snippet must be 403, got %v", err)
	}
	list, err := service.ListSnippets(context.Background(), student, CodeSnippetListInput{Scope: CodeSnippetClass, ClassID: classID})
	if err != nil || len(list.Items) != 1 || list.Items[0].ID != classSnippet.ID {
		t.Fatalf("student class list=%+v err=%v", list, err)
	}
	encoded, _ := json.Marshal(list)
	if strings.Contains(string(encoded), teacherID.String()) || strings.Contains(string(encoded), "owner_user_id") {
		t.Fatalf("list leaked the raw owner identifier: %s", encoded)
	}
	personalList, err := service.ListSnippets(context.Background(), teacher, CodeSnippetListInput{Scope: CodeSnippetPersonal})
	if err != nil || len(personalList.Items) != 0 {
		t.Fatalf("teacher personal list must not include the student's snippet: %+v err=%v", personalList, err)
	}
}

func TestCodeSnippetSoftDeleteReleasesQuotaAndConceals(t *testing.T) {
	t.Parallel()
	store := newFakeCodeLibraryStore()
	store.snippetLimit = 2
	tenantID, actorID := uuid.New(), uuid.New()
	service := newTestCodeLibraryService(t, store, nil)
	actor := codeLibraryAccess(tenantID, actorID, policy.OrganizationRoleStudent)

	first := mustCreateSnippet(t, service, actor, codeSnippetInput("quota-snippet-00001", CodeSnippetPersonal, uuid.Nil))
	mustCreateSnippet(t, service, actor, codeSnippetInput("quota-snippet-00002", CodeSnippetPersonal, uuid.Nil))
	if _, err := service.CreateSnippet(context.Background(), actor, codeSnippetInput("quota-snippet-00003", CodeSnippetPersonal, uuid.Nil)); !errors.Is(err, ErrCodeSnippetQuotaExceeded) {
		t.Fatalf("third snippet must exceed code_snippets_per_member, got %v", err)
	}
	if err := service.DeleteSnippet(context.Background(), actor, first.ID); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	if !store.snippets[first.ID].record.Deleted || store.snippets[first.ID].record.Version != 2 {
		t.Fatalf("delete must be a soft delete with a version bump: %+v", store.snippets[first.ID].record)
	}
	if _, err := service.GetSnippet(context.Background(), actor, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted snippet must be 404, got %v", err)
	}
	if err := service.DeleteSnippet(context.Background(), actor, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete must be 404, got %v", err)
	}
	if _, err := service.CreateSnippet(context.Background(), actor, codeSnippetInput("quota-snippet-00003", CodeSnippetPersonal, uuid.Nil)); err != nil {
		t.Fatalf("soft delete must release the member quota: %v", err)
	}
}

func TestCodeSnippetStorageQuotaCASAndIdempotency(t *testing.T) {
	t.Parallel()
	store := newFakeCodeLibraryStore()
	store.storageLimit = 40
	tenantID, actorID := uuid.New(), uuid.New()
	service := newTestCodeLibraryService(t, store, nil)
	actor := codeLibraryAccess(tenantID, actorID, policy.OrganizationRoleStudent)

	input := codeSnippetInput("storage-snippet-001", CodeSnippetPersonal, uuid.Nil)
	input.Content = strings.Repeat("a", 30)
	created, err := service.CreateSnippet(context.Background(), actor, input)
	if err != nil || !created.Created || created.Snippet.ByteLength != 30 ||
		!strings.HasPrefix(created.Snippet.ContentSHA256, "sha256:") || len(created.Snippet.ContentSHA256) != 71 {
		t.Fatalf("create=%+v err=%v", created, err)
	}
	replay, err := service.CreateSnippet(context.Background(), actor, input)
	if err != nil || replay.Created || replay.Snippet.ID != created.Snippet.ID {
		t.Fatalf("idempotent replay=%+v err=%v", replay, err)
	}
	changed := input
	changed.Title = "Different"
	if _, err := service.CreateSnippet(context.Background(), actor, changed); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("changed command with the same key must conflict, got %v", err)
	}
	second := codeSnippetInput("storage-snippet-002", CodeSnippetPersonal, uuid.Nil)
	second.Content = strings.Repeat("b", 11)
	if _, err := service.CreateSnippet(context.Background(), actor, second); !errors.Is(err, ErrCodeStorageQuotaExceeded) {
		t.Fatalf("41 bytes must exceed code_storage_bytes_per_tenant=40, got %v", err)
	}
	grow := strings.Repeat("c", 41)
	if _, err := service.UpdateSnippet(context.Background(), actor, created.Snippet.ID, CodeSnippetUpdateInput{ExpectedVersion: 1, Content: &grow}); !errors.Is(err, ErrCodeStorageQuotaExceeded) {
		t.Fatalf("growing past the storage quota must fail, got %v", err)
	}
	store.storageLimit = 10 // the tenant is now over quota; shrinking must still work
	shrink := strings.Repeat("d", 20)
	updated, err := service.UpdateSnippet(context.Background(), actor, created.Snippet.ID, CodeSnippetUpdateInput{ExpectedVersion: 1, Content: &shrink})
	if err != nil || updated.Version != 2 || updated.ByteLength != 20 {
		t.Fatalf("shrinking update=%+v err=%v", updated, err)
	}
	if _, err := service.UpdateSnippet(context.Background(), actor, created.Snippet.ID, CodeSnippetUpdateInput{ExpectedVersion: 1, Content: &shrink}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale expected_version must be 409, got %v", err)
	}
	if _, err := service.UpdateSnippet(context.Background(), actor, created.Snippet.ID, CodeSnippetUpdateInput{ExpectedVersion: 2}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("an empty patch must be rejected, got %v", err)
	}
}

func TestCodeSnippetSearchIsLiteralAndCursorIsFilterBound(t *testing.T) {
	t.Parallel()
	if got := escapeCodeSnippetSearch(`50%_off\`); got != `%50\%\_off\\%` {
		t.Fatalf("escaped pattern = %q", got)
	}
	store := newFakeCodeLibraryStore()
	tenantID, actorID := uuid.New(), uuid.New()
	service := newTestCodeLibraryService(t, store, nil)
	actor := codeLibraryAccess(tenantID, actorID, policy.OrganizationRoleStudent)
	for index, title := range []string{"Sale 50% off", "Sale 50x off", "snake_case", "snakeXcase", "Plain"} {
		input := codeSnippetInput("search-snippet-"+strings.Repeat("0", 4)+string(rune('a'+index)), CodeSnippetPersonal, uuid.Nil)
		input.Title = title
		mustCreateSnippet(t, service, actor, input)
	}
	for query, want := range map[string][]string{
		"50%":   {"Sale 50% off"},
		"_case": {"snake_case"},
		"%":     {"Sale 50% off"},
		"_":     {"snake_case"},
		"SALE":  {"Sale 50% off", "Sale 50x off"},
	} {
		list, err := service.ListSnippets(context.Background(), actor, CodeSnippetListInput{Scope: CodeSnippetPersonal, Query: query})
		if err != nil {
			t.Fatalf("search %q: %v", query, err)
		}
		got := make([]string, 0, len(list.Items))
		for _, item := range list.Items {
			got = append(got, item.Title)
		}
		sort.Strings(got)
		sort.Strings(want)
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Fatalf("search %q leaked wildcard results %v, want %v", query, got, want)
		}
	}

	first, err := service.ListSnippets(context.Background(), actor, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 2})
	if err != nil || len(first.Items) != 2 || first.NextCursor == nil {
		t.Fatalf("first page=%+v err=%v", first, err)
	}
	second, err := service.ListSnippets(context.Background(), actor, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 2, Cursor: *first.NextCursor})
	if err != nil || len(second.Items) != 2 || second.Items[0].ID == first.Items[1].ID {
		t.Fatalf("second page=%+v err=%v", second, err)
	}
	other := codeLibraryAccess(tenantID, uuid.New(), policy.OrganizationRoleStudent)
	payload, _ := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(*first.NextCursor, codeSnippetCursorPrefix))
	tamperedPayload := strings.Replace(string(payload), `"id":"`, `"id":"0`, 1)
	for name, attempt := range map[string]struct {
		access AccessContext
		input  CodeSnippetListInput
	}{
		"changed search":   {actor, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 2, Query: "Sale", Cursor: *first.NextCursor}},
		"changed language": {actor, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 2, Language: "python", Cursor: *first.NextCursor}},
		"changed limit":    {actor, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 3, Cursor: *first.NextCursor}},
		"other actor":      {other, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 2, Cursor: *first.NextCursor}},
		"garbage":          {actor, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 2, Cursor: "thcsv1_!!!"}},
		"wrong prefix":     {actor, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 2, Cursor: "thwbsv1_" + strings.TrimPrefix(*first.NextCursor, codeSnippetCursorPrefix)}},
		"tampered id":      {actor, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 2, Cursor: codeSnippetCursorPrefix + base64.RawURLEncoding.EncodeToString([]byte(tamperedPayload))}},
		"oversized":        {actor, CodeSnippetListInput{Scope: CodeSnippetPersonal, Limit: 2, Cursor: codeSnippetCursorPrefix + strings.Repeat("A", 600)}},
	} {
		if _, err := service.ListSnippets(context.Background(), attempt.access, attempt.input); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("%s cursor must be 400, got %v", name, err)
		}
	}
	for name, input := range map[string]CodeSnippetListInput{
		"class without class id":  {Scope: CodeSnippetClass},
		"personal with class id":  {Scope: CodeSnippetPersonal, ClassID: uuid.New()},
		"missing scope":           {},
		"limit above maximum":     {Scope: CodeSnippetPersonal, Limit: 51},
		"unknown language":        {Scope: CodeSnippetPersonal, Language: "ruby"},
		"control character query": {Scope: CodeSnippetPersonal, Query: "a\x00b"},
	} {
		if _, err := service.ListSnippets(context.Background(), actor, input); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("%s must be 400, got %v", name, err)
		}
	}
}

func TestCodeSnippetInputValidationFailsClosed(t *testing.T) {
	t.Parallel()
	store := newFakeCodeLibraryStore()
	service := newTestCodeLibraryService(t, store, nil)
	actor := codeLibraryAccess(uuid.New(), uuid.New(), policy.OrganizationRoleStudent)
	for name, mutate := range map[string]func(*CodeSnippetCreateInput){
		"short idempotency key":   func(input *CodeSnippetCreateInput) { input.IdempotencyKey = "short" },
		"empty title":             func(input *CodeSnippetCreateInput) { input.Title = "   " },
		"long title":              func(input *CodeSnippetCreateInput) { input.Title = strings.Repeat("t", 121) },
		"long description":        func(input *CodeSnippetCreateInput) { input.Description = strings.Repeat("d", 281) },
		"dot file name":           func(input *CodeSnippetCreateInput) { input.FileName = ".." },
		"path file name":          func(input *CodeSnippetCreateInput) { input.FileName = "../etc/passwd" },
		"unknown language":        func(input *CodeSnippetCreateInput) { input.Language = "ruby" },
		"oversized content":       func(input *CodeSnippetCreateInput) { input.Content = strings.Repeat("x", CodeSnippetMaxContentBytes+1) },
		"nul content":             func(input *CodeSnippetCreateInput) { input.Content = "print(1)\x00" },
		"class without class id":  func(input *CodeSnippetCreateInput) { input.Visibility = CodeSnippetClass },
		"personal with class id":  func(input *CodeSnippetCreateInput) { input.ClassID = uuid.New() },
		"control character title": func(input *CodeSnippetCreateInput) { input.Title = "a\u0007b" },
	} {
		input := codeSnippetInput("validation-key-0001", CodeSnippetPersonal, uuid.Nil)
		mutate(&input)
		if _, err := service.CreateSnippet(context.Background(), actor, input); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("%s must be 400, got %v", name, err)
		}
	}
	if len(store.snippets) != 0 {
		t.Fatal("invalid input must never reach the repository")
	}
	exact := codeSnippetInput("validation-key-0002", CodeSnippetPersonal, uuid.Nil)
	exact.Content = strings.Repeat("x", CodeSnippetMaxContentBytes)
	if _, err := service.CreateSnippet(context.Background(), actor, exact); err != nil {
		t.Fatalf("exactly 64 KiB must be accepted: %v", err)
	}
}

func TestCodeLibraryFeatureDisabledFailsClosed(t *testing.T) {
	t.Parallel()
	store := newFakeCodeLibraryStore()
	store.featureDisabled = true
	spaceID := uuid.New()
	spaces := &codeLibrarySpaces{spaces: map[uuid.UUID]media.MediaSpace{}}
	service := newTestCodeLibraryService(t, store, spaces)
	actor := codeLibraryAccess(uuid.New(), uuid.New(), policy.OrganizationRoleStudent)
	spaces.spaces[actor.ActorID] = media.MediaSpace{ID: spaceID, ViewerRole: media.InstanceRoleAttendee}
	if _, err := service.CreateSnippet(context.Background(), actor, codeSnippetInput("disabled-snippet-01", CodeSnippetPersonal, uuid.Nil)); !errors.Is(err, ErrFeatureDisabled) {
		t.Fatalf("disabled create = %v", err)
	}
	if _, err := service.GetScratchpad(context.Background(), actor, spaceID); !errors.Is(err, ErrFeatureDisabled) {
		t.Fatalf("disabled scratchpad = %v", err)
	}
}

func TestCodeScratchpadCASExpiryAndCanonicalBounds(t *testing.T) {
	t.Parallel()
	store := newFakeCodeLibraryStore()
	store.storageLimit = 1_000
	tenantID, studentID, spaceID := uuid.New(), uuid.New(), uuid.New()
	spaces := &codeLibrarySpaces{spaces: map[uuid.UUID]media.MediaSpace{
		studentID: {ID: spaceID, ViewerRole: media.InstanceRoleAttendee},
	}}
	service := newTestCodeLibraryService(t, store, spaces)
	student := codeLibraryAccess(tenantID, studentID, policy.OrganizationRoleStudent)
	draft := CodeScratchpadPutInput{Files: []CodeScratchpadFile{
		{Name: "main.py", Language: "python", Content: "print(input())"},
		{Name: "page.html", Language: "html", Content: "<b>&</b>"},
	}, ActiveIndex: 1, Stdin: "42"}

	empty, err := service.GetScratchpad(context.Background(), student, spaceID)
	if err != nil || empty.Scratchpad != nil {
		t.Fatalf("no draft yet = %+v err=%v", empty, err)
	}
	first, err := service.PutScratchpad(context.Background(), student, spaceID, draft)
	if err != nil || first.Version != 1 || first.ByteLength != len("print(input())")+len("<b>&</b>")+2 ||
		!first.ExpiresAt.Equal(store.now.Add(CodeScratchpadTTL)) {
		t.Fatalf("first draft=%+v err=%v", first, err)
	}
	if !strings.Contains(store.scratchpads[codeScratchKey{tenantID, studentID, spaceID}].filesJSON, `"<b>&</b>"`) {
		t.Fatal("canonical files JSON must not HTML-escape source code")
	}
	if _, err := service.PutScratchpad(context.Background(), student, spaceID, draft); !errors.Is(err, ErrCodeScratchpadVersionConflict) {
		t.Fatalf("blind overwrite of a live draft must conflict, got %v", err)
	}
	draft.ExpectedVersion = 1
	second, err := service.PutScratchpad(context.Background(), student, spaceID, draft)
	if err != nil || second.Version != 2 {
		t.Fatalf("CAS update=%+v err=%v", second, err)
	}
	if _, err := service.PutScratchpad(context.Background(), student, spaceID, draft); !errors.Is(err, ErrCodeScratchpadVersionConflict) {
		t.Fatalf("stale expected_version must conflict, got %v", err)
	}
	if _, err := service.ShareScratchpad(context.Background(), student, spaceID, true); err != nil {
		t.Fatalf("share: %v", err)
	}
	store.now = store.now.Add(CodeScratchpadTTL + time.Hour)
	expired, err := service.GetScratchpad(context.Background(), student, spaceID)
	if err != nil || expired.Scratchpad != nil {
		t.Fatalf("expired draft must read as null: %+v err=%v", expired, err)
	}
	if _, err := service.PutScratchpad(context.Background(), student, spaceID, draft); !errors.Is(err, ErrCodeScratchpadVersionConflict) {
		t.Fatalf("an expired draft cannot be CAS-updated, got %v", err)
	}
	draft.ExpectedVersion = 0
	reborn, err := service.PutScratchpad(context.Background(), student, spaceID, draft)
	if err != nil || reborn.Version != 3 || reborn.SharedWithStaff || reborn.SharedAt != nil {
		t.Fatalf("overwrite after expiry must reset consent: %+v err=%v", reborn, err)
	}

	big := CodeScratchpadPutInput{Files: []CodeScratchpadFile{{Name: "a.py", Language: "python", Content: strings.Repeat("x", 2_000)}}, ExpectedVersion: 3}
	if _, err := service.PutScratchpad(context.Background(), student, spaceID, big); !errors.Is(err, ErrCodeStorageQuotaExceeded) {
		t.Fatalf("scratchpad growth past code_storage_bytes_per_tenant must fail, got %v", err)
	}

	tooMany := make([]CodeScratchpadFile, CodeScratchpadMaxFiles+1)
	for index := range tooMany {
		tooMany[index] = CodeScratchpadFile{Name: "f" + string(rune('a'+index)) + ".py", Language: "python"}
	}
	for name, input := range map[string]CodeScratchpadPutInput{
		"no files":             {},
		"nine files":           {Files: tooMany},
		"duplicate case names": {Files: []CodeScratchpadFile{{Name: "Main.py", Language: "python"}, {Name: "main.PY", Language: "python"}}},
		"dot name":             {Files: []CodeScratchpadFile{{Name: "...", Language: "python"}}},
		"bad language":         {Files: []CodeScratchpadFile{{Name: "a.rb", Language: "ruby"}}},
		"active out of range":  {Files: []CodeScratchpadFile{{Name: "a.py", Language: "python"}}, ActiveIndex: 1},
		"negative active":      {Files: []CodeScratchpadFile{{Name: "a.py", Language: "python"}}, ActiveIndex: -1},
		"file over 64 KiB":     {Files: []CodeScratchpadFile{{Name: "a.py", Language: "python", Content: strings.Repeat("x", CodeScratchpadMaxFileBytes+1)}}},
		"total over 256 KiB":   {Files: fiveFullFiles()},
		"stdin over 16 KiB":    {Files: []CodeScratchpadFile{{Name: "a.py", Language: "python"}}, Stdin: strings.Repeat("s", CodeScratchpadMaxStdinBytes+1)},
		"nul in content":       {Files: []CodeScratchpadFile{{Name: "a.py", Language: "python", Content: "\x00"}}},
		"negative version":     {Files: []CodeScratchpadFile{{Name: "a.py", Language: "python"}}, ExpectedVersion: -1},
	} {
		if _, err := service.PutScratchpad(context.Background(), student, spaceID, input); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("%s must be 400, got %v", name, err)
		}
	}
	escaped := CodeScratchpadPutInput{Files: []CodeScratchpadFile{
		{Name: "a.py", Language: "python", Content: strings.Repeat("\x01", CodeScratchpadMaxFileBytes)},
	}}
	if _, _, err := canonicalCodeScratchpad(escaped); !errors.Is(err, ErrCodeScratchpadTooLarge) {
		t.Fatalf("an escaped payload above the 300000-byte JSON bound must fail closed, got %v", err)
	}
}

func TestSharedScratchpadsBlockV1StyleIDOR(t *testing.T) {
	t.Parallel()
	store := newFakeCodeLibraryStore()
	tenantID, spaceID, roomID := uuid.New(), uuid.New(), uuid.New()
	teacherID, studentID, peerID, promotedID, outsiderID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	store.names[studentID] = "Học sinh A"
	store.dynamicCoHosts[promotedID] = true
	spaces := &codeLibrarySpaces{
		spaces: map[uuid.UUID]media.MediaSpace{
			teacherID:  codeRoomSpace(spaceID, roomID, media.InstanceRoleHost),
			studentID:  codeRoomSpace(spaceID, roomID, media.InstanceRoleAttendee),
			peerID:     codeRoomSpace(spaceID, roomID, media.InstanceRoleAttendee),
			promotedID: codeRoomSpace(spaceID, roomID, media.InstanceRoleAttendee),
		},
		errors: map[uuid.UUID]error{outsiderID: media.ErrSpaceAccessDenied},
	}
	service := newTestCodeLibraryService(t, store, spaces)
	teacher := codeLibraryAccess(tenantID, teacherID, policy.OrganizationRoleTeacher)
	student := codeLibraryAccess(tenantID, studentID, policy.OrganizationRoleStudent)
	peer := codeLibraryAccess(tenantID, peerID, policy.OrganizationRoleStudent)
	promoted := codeLibraryAccess(tenantID, promotedID, policy.OrganizationRoleStudent)
	outsider := codeLibraryAccess(tenantID, outsiderID, policy.OrganizationRoleStudent)

	if _, err := service.ShareScratchpad(context.Background(), student, spaceID, true); !errors.Is(err, ErrCodeScratchpadEmpty) {
		t.Fatalf("sharing without a draft must be code_scratchpad_empty, got %v", err)
	}
	draft, err := service.PutScratchpad(context.Background(), student, spaceID, CodeScratchpadPutInput{
		Files: []CodeScratchpadFile{{Name: "main.py", Language: "python", Content: "print('secret')"}}, Stdin: "7",
	})
	if err != nil {
		t.Fatalf("put draft: %v", err)
	}
	if _, err := service.GetSharedScratchpad(context.Background(), teacher, spaceID, draft.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("teacher must not read an unshared draft, got %v", err)
	}
	if list, err := service.ListSharedScratchpads(context.Background(), teacher, spaceID); err != nil || len(list.Items) != 0 {
		t.Fatalf("unshared draft listed: %+v err=%v", list, err)
	}

	shared, err := service.ShareScratchpad(context.Background(), student, spaceID, true)
	if err != nil || shared.Scratchpad == nil || !shared.Scratchpad.SharedWithStaff || shared.Scratchpad.SharedAt == nil {
		t.Fatalf("share=%+v err=%v", shared, err)
	}
	list, err := service.ListSharedScratchpads(context.Background(), teacher, spaceID)
	if err != nil || len(list.Items) != 1 || list.Items[0].AuthorDisplayName != "Học sinh A" ||
		list.Items[0].FileCount != 1 || list.Items[0].ActiveFileName != "main.py" {
		t.Fatalf("teacher list=%+v err=%v", list, err)
	}
	encoded, _ := json.Marshal(list)
	if strings.Contains(string(encoded), studentID.String()) || strings.Contains(string(encoded), "owner_user_id") {
		t.Fatalf("shared list leaked the raw owner identifier: %s", encoded)
	}
	detail, err := service.GetSharedScratchpad(context.Background(), teacher, spaceID, draft.ID)
	if err != nil || detail.Stdin != "7" || len(detail.Files) != 1 || detail.Files[0].Content != "print('secret')" {
		t.Fatalf("teacher detail=%+v err=%v", detail, err)
	}
	if _, err := service.GetSharedScratchpad(context.Background(), promoted, spaceID, draft.ID); err != nil {
		t.Fatalf("a co-host promoted in the active RoomInstance is staff: %v", err)
	}
	for name, access := range map[string]AccessContext{
		"peer student": peer, "owner student": student, "outsider": outsider,
	} {
		if _, err := service.ListSharedScratchpads(context.Background(), access, spaceID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s listing shared drafts must be 404, got %v", name, err)
		}
		if _, err := service.GetSharedScratchpad(context.Background(), access, spaceID, draft.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s reading a shared draft must be 404, got %v", name, err)
		}
	}
	if _, err := service.GetSharedScratchpad(context.Background(), teacher, uuid.New(), draft.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a draft must not be readable through another space, got %v", err)
	}

	revoked, err := service.ShareScratchpad(context.Background(), student, spaceID, false)
	if err != nil || revoked.Scratchpad == nil || revoked.Scratchpad.SharedWithStaff || revoked.Scratchpad.SharedAt != nil {
		t.Fatalf("revoke=%+v err=%v", revoked, err)
	}
	if _, err := service.GetSharedScratchpad(context.Background(), teacher, spaceID, draft.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revocation must take effect immediately, got %v", err)
	}
}

// --- fakes -----------------------------------------------------------------

func newTestCodeLibraryService(t *testing.T, store *fakeCodeLibraryStore, spaces SpaceAuthority) *CodeLibraryService {
	t.Helper()
	if spaces == nil {
		spaces = &codeLibrarySpaces{spaces: map[uuid.UUID]media.MediaSpace{}}
	}
	service, err := NewCodeLibraryService(store, spaces)
	if err != nil {
		t.Fatalf("new code library service: %v", err)
	}
	return service
}

func codeLibraryAccess(tenantID, actorID uuid.UUID, role policy.OrganizationRole) AccessContext {
	return AccessContext{
		TenantID: tenantID, ActorID: actorID, SessionID: uuid.New(), MembershipActive: true,
		OrganizationRoles: []policy.OrganizationRole{role},
	}
}

func codeSnippetInput(key string, visibility CodeSnippetVisibility, classID uuid.UUID) CodeSnippetCreateInput {
	return CodeSnippetCreateInput{
		IdempotencyKey: key, Visibility: visibility, ClassID: classID,
		Title: "Hello loop", Description: "Vòng lặp cơ bản\nfor-range", FileName: "main.py",
		Language: "python", Content: "for i in range(3):\n    print(i)\n",
	}
}

func mustCreateSnippet(t *testing.T, service *CodeLibraryService, access AccessContext, input CodeSnippetCreateInput) CodeSnippet {
	t.Helper()
	result, err := service.CreateSnippet(context.Background(), access, input)
	if err != nil {
		t.Fatalf("create snippet %q: %v", input.IdempotencyKey, err)
	}
	return result.Snippet
}

func fiveFullFiles() []CodeScratchpadFile {
	files := make([]CodeScratchpadFile, 5)
	for index := range files {
		files[index] = CodeScratchpadFile{
			Name: "f" + string(rune('a'+index)) + ".py", Language: "python",
			Content: strings.Repeat("x", CodeScratchpadMaxFileBytes),
		}
	}
	return files
}

type codeLibrarySpaces struct {
	spaces map[uuid.UUID]media.MediaSpace
	errors map[uuid.UUID]error
}

func (spaces *codeLibrarySpaces) GetSpace(_ context.Context, access media.AccessContext, spaceID uuid.UUID) (media.MediaSpace, error) {
	if err := spaces.errors[access.ActorID]; err != nil {
		return media.MediaSpace{}, err
	}
	space, ok := spaces.spaces[access.ActorID]
	if !ok || space.ID != spaceID {
		return media.MediaSpace{}, media.ErrSpaceNotFound
	}
	return space, nil
}

type codeRelationKey struct{ tenant, class, actor uuid.UUID }
type codeScratchKey struct{ tenant, owner, space uuid.UUID }

type fakeStoredSnippet struct {
	tenantID       uuid.UUID
	idempotencyKey string
	fingerprint    []byte
	record         CodeSnippetRecord
}

type fakeStoredScratchpad struct {
	scratchpad CodeScratchpad
	owner      uuid.UUID
	tenant     uuid.UUID
	filesJSON  string
}

// fakeCodeLibraryStore is an in-memory stand-in for PostgresCodeLibraryRepository.
// It deliberately evaluates the same pure decision functions the Postgres
// repository calls inside its transactions, so the service matrix exercises
// the production policy rather than a copy of it.
type fakeCodeLibraryStore struct {
	mu              sync.Mutex
	now             time.Time
	classes         map[uuid.UUID]uuid.UUID
	relations       map[codeRelationKey]CodeLibraryClassRelation
	snippets        map[uuid.UUID]*fakeStoredSnippet
	scratchpads     map[codeScratchKey]*fakeStoredScratchpad
	dynamicCoHosts  map[uuid.UUID]bool
	names           map[uuid.UUID]string
	snippetLimit    int64
	storageLimit    int64
	featureDisabled bool
}

func newFakeCodeLibraryStore() *fakeCodeLibraryStore {
	return &fakeCodeLibraryStore{
		now:            collaborationTestTime,
		classes:        map[uuid.UUID]uuid.UUID{},
		relations:      map[codeRelationKey]CodeLibraryClassRelation{},
		snippets:       map[uuid.UUID]*fakeStoredSnippet{},
		scratchpads:    map[codeScratchKey]*fakeStoredScratchpad{},
		dynamicCoHosts: map[uuid.UUID]bool{},
		names:          map[uuid.UUID]string{},
		snippetLimit:   200,
		storageLimit:   52_428_800,
	}
}

func (store *fakeCodeLibraryStore) addClass(tenantID, classID uuid.UUID) {
	store.classes[classID] = tenantID
}

func (store *fakeCodeLibraryStore) relate(tenantID, classID, actorID uuid.UUID, relation CodeLibraryClassRelation) {
	store.relations[codeRelationKey{tenantID, classID, actorID}] = relation
}

func (store *fakeCodeLibraryStore) tick() time.Time {
	store.now = store.now.Add(time.Second)
	return store.now
}

func (store *fakeCodeLibraryStore) relation(access AccessContext, classID uuid.UUID) CodeLibraryClassRelation {
	if classID == uuid.Nil || store.classes[classID] != access.TenantID {
		return CodeLibraryClassRelation{}
	}
	relation := store.relations[codeRelationKey{access.TenantID, classID, access.ActorID}]
	relation.Exists = true
	return relation
}

func (store *fakeCodeLibraryStore) storageUsed(tenantID, excludedSnippet, excludedScratchpad uuid.UUID) int64 {
	var used int64
	for id, stored := range store.snippets {
		if stored.tenantID == tenantID && !stored.record.Deleted && id != excludedSnippet {
			used += int64(stored.record.ByteLength)
		}
	}
	for _, stored := range store.scratchpads {
		if stored.tenant == tenantID && stored.scratchpad.ExpiresAt.After(store.now) && stored.scratchpad.ID != excludedScratchpad {
			used += int64(stored.scratchpad.ByteLength)
		}
	}
	return used
}

func (store *fakeCodeLibraryStore) requireStorage(tenantID, excludedSnippet, excludedScratchpad uuid.UUID, current, next int64) error {
	requested, enforce := codeStorageRequested(store.storageUsed(tenantID, excludedSnippet, excludedScratchpad), current, next)
	if enforce && requested > store.storageLimit {
		return classifyCodeLibraryControlError(&featurecontrol.QuotaExceededError{Quota: featurecontrol.QuotaCodeStorageBytesPerTenant})
	}
	return nil
}

func (store *fakeCodeLibraryStore) gate() error {
	if store.featureDisabled {
		return classifyCodeLibraryControlError(&featurecontrol.FeatureDisabledError{Feature: featurecontrol.FeatureCodeSnippetLibrary})
	}
	return nil
}

func (store *fakeCodeLibraryStore) ListSnippets(_ context.Context, access AccessContext, query CodeSnippetListQuery) (CodeSnippetPage, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.gate(); err != nil {
		return CodeSnippetPage{}, err
	}
	page := CodeSnippetPage{}
	if query.Scope == CodeSnippetClass {
		page.Relation = store.relation(access, query.ClassID)
		if !effectiveCodeClassRelation(access, page.Relation).Member {
			return CodeSnippetPage{}, ErrNotFound
		}
	}
	matcher := sqlLikeMatcher(query.Pattern)
	for _, stored := range store.snippets {
		record := stored.record
		if stored.tenantID != access.TenantID || record.Deleted || record.Visibility != query.Scope {
			continue
		}
		if query.Scope == CodeSnippetPersonal && record.OwnerUserID != access.ActorID {
			continue
		}
		if query.Scope == CodeSnippetClass && record.ClassID != query.ClassID {
			continue
		}
		if query.Language != "" && record.Language != query.Language {
			continue
		}
		if matcher != nil && !matcher.MatchString(record.Title) && !matcher.MatchString(record.FileName) &&
			!matcher.MatchString(record.Description) {
			continue
		}
		if query.After != nil && !codeKeysetBefore(record, *query.After) {
			continue
		}
		record.Content = ""
		page.Records = append(page.Records, record)
	}
	sort.Slice(page.Records, func(left, right int) bool {
		return codeKeysetBefore(page.Records[right], CodeSnippetCursor{UpdatedAt: page.Records[left].UpdatedAt, ID: page.Records[left].ID})
	})
	if len(page.Records) > query.Fetch {
		page.Records = page.Records[:query.Fetch]
	}
	return page, nil
}

func codeKeysetBefore(record CodeSnippetRecord, cursor CodeSnippetCursor) bool {
	if !record.UpdatedAt.Equal(cursor.UpdatedAt) {
		return record.UpdatedAt.Before(cursor.UpdatedAt)
	}
	return strings.Compare(record.ID.String(), cursor.ID.String()) < 0
}

// sqlLikeMatcher mirrors PostgreSQL `ILIKE pattern ESCAPE '\'`.
func sqlLikeMatcher(pattern string) *regexp.Regexp {
	if pattern == "" {
		return nil
	}
	var expression strings.Builder
	expression.WriteString(`(?is)^`)
	runes := []rune(pattern)
	for index := 0; index < len(runes); index++ {
		switch runes[index] {
		case '\\':
			if index+1 < len(runes) {
				index++
			}
			expression.WriteString(regexp.QuoteMeta(string(runes[index])))
		case '%':
			expression.WriteString(`.*`)
		case '_':
			expression.WriteString(`.`)
		default:
			expression.WriteString(regexp.QuoteMeta(string(runes[index])))
		}
	}
	expression.WriteString(`$`)
	return regexp.MustCompile(expression.String())
}

func (store *fakeCodeLibraryStore) GetSnippet(_ context.Context, access AccessContext, snippetID uuid.UUID) (CodeSnippetRecord, CodeLibraryClassRelation, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.gate(); err != nil {
		return CodeSnippetRecord{}, CodeLibraryClassRelation{}, err
	}
	return store.readable(access, snippetID)
}

func (store *fakeCodeLibraryStore) readable(access AccessContext, snippetID uuid.UUID) (CodeSnippetRecord, CodeLibraryClassRelation, error) {
	stored, ok := store.snippets[snippetID]
	if !ok || stored.tenantID != access.TenantID {
		return CodeSnippetRecord{}, CodeLibraryClassRelation{}, ErrNotFound
	}
	relation := store.relation(access, stored.record.ClassID)
	if !codeSnippetReadable(access, stored.record, relation) {
		return CodeSnippetRecord{}, CodeLibraryClassRelation{}, ErrNotFound
	}
	return stored.record, relation, nil
}

func (store *fakeCodeLibraryStore) CreateSnippet(_ context.Context, access AccessContext, command CodeSnippetCreateCommand) (CodeSnippetStoredResult, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.gate(); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	for _, stored := range store.snippets {
		if stored.tenantID == access.TenantID && stored.record.OwnerUserID == access.ActorID &&
			stored.idempotencyKey == command.IdempotencyKey {
			if string(stored.fingerprint) != string(command.Fingerprint) || stored.record.Deleted {
				return CodeSnippetStoredResult{}, ErrIdempotencyConflict
			}
			return CodeSnippetStoredResult{Record: stored.record, Relation: store.relation(access, stored.record.ClassID)}, nil
		}
	}
	relation := store.relation(access, command.ClassID)
	if err := codeSnippetCreateDecision(access, command.Visibility, relation); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	var owned int64
	for _, stored := range store.snippets {
		if stored.tenantID == access.TenantID && stored.record.OwnerUserID == access.ActorID && !stored.record.Deleted {
			owned++
		}
	}
	if owned+1 > store.snippetLimit {
		return CodeSnippetStoredResult{}, classifyCodeLibraryControlError(&featurecontrol.QuotaExceededError{Quota: featurecontrol.QuotaCodeSnippetsPerMember})
	}
	if err := store.requireStorage(access.TenantID, uuid.Nil, uuid.Nil, 0, int64(command.ByteLength)); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	now := store.tick()
	record := CodeSnippetRecord{
		ID: command.SnippetID, OwnerUserID: access.ActorID, Visibility: command.Visibility,
		ClassID: command.ClassID, Title: command.Title, Description: command.Description,
		FileName: command.FileName, Language: command.Language, Content: command.Content,
		ByteLength: command.ByteLength, ContentSHA256: command.ContentSHA256, Version: 1,
		AuthorDisplayName: store.displayName(access.ActorID), CreatedAt: now, UpdatedAt: now,
	}
	store.snippets[record.ID] = &fakeStoredSnippet{
		tenantID: access.TenantID, idempotencyKey: command.IdempotencyKey,
		fingerprint: command.Fingerprint, record: record,
	}
	return CodeSnippetStoredResult{Record: record, Relation: relation, Created: true}, nil
}

func (store *fakeCodeLibraryStore) displayName(actorID uuid.UUID) string {
	if name, ok := store.names[actorID]; ok {
		return name
	}
	return "Thành viên"
}

func (store *fakeCodeLibraryStore) UpdateSnippet(_ context.Context, access AccessContext, command CodeSnippetUpdateCommand) (CodeSnippetStoredResult, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.gate(); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	record, relation, err := store.readable(access, command.SnippetID)
	if err != nil {
		return CodeSnippetStoredResult{}, err
	}
	if err := authorizeCodeSnippetUpdate(access, record, relation, command.ExpectedVersion); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	next := applyCodeSnippetPatch(record, command)
	if err := store.requireStorage(access.TenantID, record.ID, uuid.Nil, int64(record.ByteLength), int64(next.ByteLength)); err != nil {
		return CodeSnippetStoredResult{}, err
	}
	next.Version++
	next.UpdatedAt = store.tick()
	store.snippets[record.ID].record = next
	return CodeSnippetStoredResult{Record: next, Relation: relation}, nil
}

func (store *fakeCodeLibraryStore) DeleteSnippet(_ context.Context, access AccessContext, snippetID uuid.UUID) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.gate(); err != nil {
		return err
	}
	record, relation, err := store.readable(access, snippetID)
	if err != nil {
		return err
	}
	if err := authorizeCodeSnippetDelete(access, record, relation); err != nil {
		return err
	}
	record.Deleted = true
	record.Version++
	record.UpdatedAt = store.tick()
	store.snippets[snippetID].record = record
	return nil
}

func (store *fakeCodeLibraryStore) live(access AccessContext, spaceID uuid.UUID) (*fakeStoredScratchpad, bool) {
	stored, ok := store.scratchpads[codeScratchKey{access.TenantID, access.ActorID, spaceID}]
	if !ok {
		return nil, false
	}
	return stored, stored.scratchpad.ExpiresAt.After(store.now)
}

func (store *fakeCodeLibraryStore) GetScratchpad(_ context.Context, access AccessContext, spaceID uuid.UUID) (*CodeScratchpad, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.gate(); err != nil {
		return nil, err
	}
	stored, live := store.live(access, spaceID)
	if !live {
		return nil, nil
	}
	copied := stored.scratchpad
	return &copied, nil
}

func (store *fakeCodeLibraryStore) PutScratchpad(_ context.Context, access AccessContext, command CodeScratchpadPutCommand) (CodeScratchpad, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.gate(); err != nil {
		return CodeScratchpad{}, err
	}
	stored, live := store.live(access, command.MediaSpaceID)
	var currentVersion, currentBytes int64
	excluded := uuid.Nil
	if stored != nil {
		currentVersion, excluded = stored.scratchpad.Version, stored.scratchpad.ID
		if live {
			currentBytes = int64(stored.scratchpad.ByteLength)
		}
	}
	if err := authorizeCodeScratchpadWrite(live, currentVersion, command.ExpectedVersion); err != nil {
		return CodeScratchpad{}, err
	}
	if err := store.requireStorage(access.TenantID, uuid.Nil, excluded, currentBytes, int64(command.ByteLength)); err != nil {
		return CodeScratchpad{}, err
	}
	files, err := decodeCodeScratchpadFiles(command.FilesJSON, command.ActiveIndex)
	if err != nil {
		return CodeScratchpad{}, err
	}
	now := store.tick()
	if stored == nil {
		stored = &fakeStoredScratchpad{
			owner: access.ActorID, tenant: access.TenantID,
			scratchpad: CodeScratchpad{ID: uuid.New(), MediaSpaceID: command.MediaSpaceID, CreatedAt: now},
		}
		store.scratchpads[codeScratchKey{access.TenantID, access.ActorID, command.MediaSpaceID}] = stored
	}
	if !live {
		stored.scratchpad.SharedWithStaff, stored.scratchpad.SharedAt = false, nil
	}
	stored.filesJSON = command.FilesJSON
	stored.scratchpad.Files = files
	stored.scratchpad.ActiveIndex = command.ActiveIndex
	stored.scratchpad.Stdin = command.Stdin
	stored.scratchpad.ByteLength = command.ByteLength
	stored.scratchpad.Version++
	stored.scratchpad.UpdatedAt = now
	stored.scratchpad.ExpiresAt = now.Add(CodeScratchpadTTL)
	return stored.scratchpad, nil
}

func (store *fakeCodeLibraryStore) ShareScratchpad(_ context.Context, access AccessContext, spaceID uuid.UUID, shared bool) (*CodeScratchpad, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.gate(); err != nil {
		return nil, err
	}
	stored, live := store.live(access, spaceID)
	if shared {
		if !live {
			return nil, ErrCodeScratchpadEmpty
		}
		if stored.scratchpad.SharedAt == nil {
			now := store.now
			stored.scratchpad.SharedAt = &now
		}
		stored.scratchpad.SharedWithStaff = true
	} else if stored != nil {
		stored.scratchpad.SharedWithStaff, stored.scratchpad.SharedAt = false, nil
	}
	if !live {
		return nil, nil
	}
	copied := stored.scratchpad
	return &copied, nil
}

func (store *fakeCodeLibraryStore) DynamicCoHost(_ context.Context, access AccessContext, _ uuid.UUID, _ uuid.UUID) (bool, error) {
	if err := store.gate(); err != nil {
		return false, err
	}
	return store.dynamicCoHosts[access.ActorID], nil
}

func (store *fakeCodeLibraryStore) sharedVisible(access AccessContext, spaceID uuid.UUID, key codeScratchKey, stored *fakeStoredScratchpad) bool {
	return key.tenant == access.TenantID && key.space == spaceID && key.owner != access.ActorID &&
		stored.scratchpad.SharedWithStaff && stored.scratchpad.SharedAt != nil &&
		stored.scratchpad.ExpiresAt.After(store.now)
}

func (store *fakeCodeLibraryStore) ListSharedScratchpads(_ context.Context, access AccessContext, spaceID uuid.UUID, _ uuid.UUID, limit int) ([]CodeSharedScratchpadSummary, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.gate(); err != nil {
		return nil, err
	}
	items := []CodeSharedScratchpadSummary{}
	for key, stored := range store.scratchpads {
		if !store.sharedVisible(access, spaceID, key, stored) || len(items) == limit {
			continue
		}
		items = append(items, store.sharedSummary(key, stored))
	}
	return items, nil
}

func (store *fakeCodeLibraryStore) sharedSummary(key codeScratchKey, stored *fakeStoredScratchpad) CodeSharedScratchpadSummary {
	active := stored.scratchpad.Files[stored.scratchpad.ActiveIndex]
	return CodeSharedScratchpadSummary{
		ID: stored.scratchpad.ID, AuthorDisplayName: store.displayName(key.owner),
		FileCount: len(stored.scratchpad.Files), ActiveFileName: active.Name, ActiveLanguage: active.Language,
		ByteLength: stored.scratchpad.ByteLength, SharedAt: *stored.scratchpad.SharedAt,
		UpdatedAt: stored.scratchpad.UpdatedAt,
	}
}

func (store *fakeCodeLibraryStore) GetSharedScratchpad(_ context.Context, access AccessContext, spaceID uuid.UUID, _ uuid.UUID, scratchpadID uuid.UUID) (CodeSharedScratchpad, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.gate(); err != nil {
		return CodeSharedScratchpad{}, err
	}
	for key, stored := range store.scratchpads {
		if stored.scratchpad.ID == scratchpadID && store.sharedVisible(access, spaceID, key, stored) {
			return CodeSharedScratchpad{
				CodeSharedScratchpadSummary: store.sharedSummary(key, stored),
				Files:                       stored.scratchpad.Files, ActiveIndex: stored.scratchpad.ActiveIndex,
				Stdin: stored.scratchpad.Stdin,
			}, nil
		}
	}
	return CodeSharedScratchpad{}, ErrNotFound
}
