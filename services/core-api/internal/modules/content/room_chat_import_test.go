package content

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/tutorhub-v2/core-api/internal/platform/objectstorage"
)

// Simulates immutable provider versions, including a PUT whose response is
// lost after the object has been durably stored.
type chatImportTestStore struct {
	ObjectStorage
	mu            sync.Mutex
	metadata      map[string]objectstorage.Metadata
	versions      map[string][]byte
	source        []byte
	headErr       error
	loseResponse  bool
	reads, writes int
	onPut         func()
	onDelete      func(string, string) error
}

func (s *chatImportTestStore) Head(_ context.Context, key string) (objectstorage.Metadata, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.headErr != nil {
		return objectstorage.Metadata{}, s.headErr
	}
	head, found := s.metadata[key]
	if !found {
		return objectstorage.Metadata{}, objectstorage.ErrObjectNotFound
	}
	return head, nil
}

func (s *chatImportTestStore) Get(context.Context, string) (objectstorage.Object, error) {
	return objectstorage.Object{Body: io.NopCloser(bytes.NewReader(s.source)), ContentLength: int64(len(s.source))}, nil
}

func (s *chatImportTestStore) GetVersion(_ context.Context, _, version string) (objectstorage.Object, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads++
	return objectstorage.Object{Body: io.NopCloser(bytes.NewReader(s.versions[version])), VersionID: version}, nil
}

func (s *chatImportTestStore) PutVersioned(_ context.Context, key string, body io.Reader, size int64, mediaType string) (objectstorage.PutResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writes++
	if _, exists := s.metadata[key]; exists {
		return objectstorage.PutResult{}, errors.New("destination already exists")
	}
	if s.metadata == nil {
		s.metadata = make(map[string]objectstorage.Metadata)
		s.versions = make(map[string][]byte)
	}
	data, err := io.ReadAll(body)
	if err != nil {
		return objectstorage.PutResult{}, err
	}
	proof := objectstorage.PutResult{ETag: "etag", VersionID: uuid.NewString()}
	s.metadata[key] = objectstorage.Metadata{ETag: proof.ETag, VersionID: proof.VersionID, ContentLength: size, ContentType: mediaType}
	s.versions[proof.VersionID] = data
	if s.onPut != nil {
		s.onPut()
	}
	if s.loseResponse {
		s.loseResponse = false
		return objectstorage.PutResult{}, errors.New("connection lost")
	}
	return proof, nil
}

func (s *chatImportTestStore) DeleteVersion(_ context.Context, key, version string) error {
	if s.onDelete != nil {
		return s.onDelete(key, version)
	}
	return nil
}

func TestChatImportRecoversExactVersionWithoutRewriting(t *testing.T) {
	data := []byte("stored payload")
	sum := sha256.Sum256(data)
	ctx := context.Background()
	store := &chatImportTestStore{loseResponse: true}
	if _, err := ensureChatImportObject(ctx, store, "k", MediaTypePDF, data, sum[:]); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("lost PUT response: %v", err)
	}
	proof, err := ensureChatImportObject(ctx, store, "k", MediaTypePDF, data, sum[:])
	if err != nil || proof.VersionID != store.metadata["k"].VersionID || store.reads != 1 || store.writes != 1 {
		t.Fatalf("recovery proof=%+v err=%v reads=%d writes=%d", proof, err, store.reads, store.writes)
	}
	store.versions[proof.VersionID][0] ^= 1
	if _, err := ensureChatImportObject(ctx, store, "k", MediaTypePDF, data, sum[:]); !errors.Is(err, ErrStorageMismatch) {
		t.Fatalf("mismatched recovery digest accepted: %v", err)
	}
	store.headErr = errors.New("network")
	if _, err := ensureChatImportObject(ctx, store, "k", MediaTypePDF, data, sum[:]); !errors.Is(err, ErrStorageUnavailable) || store.writes != 1 {
		t.Fatalf("inconclusive HEAD: err=%v writes=%d", err, store.writes)
	}
}

func TestChatImportFingerprintBindsScopeAndSource(t *testing.T) {
	space := uuid.New()
	input := SaveRoomChatAttachmentInput{Scope: OwnerKindMediaSpace, ConversationID: uuid.New(), AttachmentID: uuid.New()}
	original := input.fingerprint(space)
	for _, mutate := range []func(*SaveRoomChatAttachmentInput){
		func(i *SaveRoomChatAttachmentInput) { i.Scope = OwnerKindClass },
		func(i *SaveRoomChatAttachmentInput) { i.ConversationID = uuid.New() },
		func(i *SaveRoomChatAttachmentInput) { i.AttachmentID = uuid.New() },
		func(i *SaveRoomChatAttachmentInput) { yes := true; i.AllowStudentDownload = &yes },
	} {
		changed := input
		mutate(&changed)
		if bytes.Equal(changed.fingerprint(space), original) {
			t.Fatal("changed import fingerprint was reused")
		}
	}
	if bytes.Equal(input.fingerprint(uuid.New()), original) {
		t.Fatal("fingerprint is not bound to room")
	}
}
