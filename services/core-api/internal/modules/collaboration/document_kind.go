package collaboration

import (
	"context"
	"strings"
)

// DocumentKind is the typed collaboration document contract shared by the
// control plane, the grant broker and the collaboration runtime (ADR-0043 §4).
// The opaque provider document name prefix is bound to exactly one kind so a
// credential for one kind can never be consumed against the other.
type DocumentKind string

const (
	DocumentKindWhiteboard    DocumentKind = "whiteboard.excalidraw.v1"
	DocumentKindCodeWorkspace DocumentKind = "code.workspace.v1"

	whiteboardProviderPrefix    = "wb_"
	codeWorkspaceProviderPrefix = "cw_"
)

// NormalizeDocumentKind maps the legacy empty value to the whiteboard kind so
// pre-Slice-2 runtimes and leases stay compatible. Unknown kinds are rejected.
func NormalizeDocumentKind(kind DocumentKind) (DocumentKind, bool) {
	switch kind {
	case "", DocumentKindWhiteboard:
		return DocumentKindWhiteboard, true
	case DocumentKindCodeWorkspace:
		return DocumentKindCodeWorkspace, true
	default:
		return "", false
	}
}

// DocumentKindForProviderName derives the only kind an opaque provider
// document name may belong to.
func DocumentKindForProviderName(name string) (DocumentKind, bool) {
	switch {
	case strings.HasPrefix(name, whiteboardProviderPrefix):
		return DocumentKindWhiteboard, true
	case strings.HasPrefix(name, codeWorkspaceProviderPrefix):
		return DocumentKindCodeWorkspace, true
	default:
		return "", false
	}
}

func providerNameMatchesKind(name string, kind DocumentKind) bool {
	derived, ok := DocumentKindForProviderName(strings.TrimSpace(name))
	normalized, known := NormalizeDocumentKind(kind)
	return ok && known && derived == normalized
}

// InternalKindRouter dispatches authenticated runtime grant calls to the
// control plane that owns the requested document kind. A missing kind keeps
// the legacy whiteboard behaviour; a kind that disagrees with the provider
// name prefix fails closed before any credential is consumed.
type InternalKindRouter struct {
	whiteboard InternalServiceAPI
	code       InternalServiceAPI
}

func NewInternalKindRouter(whiteboard, code InternalServiceAPI) *InternalKindRouter {
	return &InternalKindRouter{whiteboard: whiteboard, code: code}
}

func (router *InternalKindRouter) ConsumeGrant(
	ctx context.Context,
	input GrantConsumeInput,
) (GrantScope, error) {
	kind, ok := NormalizeDocumentKind(input.DocumentKind)
	if router == nil || !ok || !providerNameMatchesKind(input.ProviderDocumentName, kind) {
		return GrantScope{}, ErrGrantDenied
	}
	input.DocumentKind = kind
	target := router.target(kind)
	if target == nil {
		return GrantScope{}, ErrGrantDenied
	}
	return target.ConsumeGrant(ctx, input)
}

func (router *InternalKindRouter) ValidateGrant(
	ctx context.Context,
	input GrantValidationInput,
) (bool, error) {
	kind, ok := NormalizeDocumentKind(input.Scope.DocumentKind)
	if router == nil || !ok || !providerNameMatchesKind(input.Scope.ProviderDocumentName, kind) {
		return false, ErrGrantDenied
	}
	input.Scope.DocumentKind = kind
	target := router.target(kind)
	if target == nil {
		return false, ErrGrantDenied
	}
	return target.ValidateGrant(ctx, input)
}

func (router *InternalKindRouter) target(kind DocumentKind) InternalServiceAPI {
	if kind == DocumentKindCodeWorkspace {
		return router.code
	}
	return router.whiteboard
}
