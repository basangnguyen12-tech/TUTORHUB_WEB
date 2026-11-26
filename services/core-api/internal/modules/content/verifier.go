package content

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"math"
)

// ROOM-TOOLS-FILES-01A (ADR-0045 §2): narrow pure-Go P3-10-PDF/Image readiness
// verifier. It uses only the Go standard library (no CGo, no third-party
// parser), reads at most expected_size_bytes+1 from the exact stored version,
// never decodes pixels and never renders PDF content.
const (
	MediaTypePDF  = "application/pdf"
	MediaTypePNG  = "image/png"
	MediaTypeJPEG = "image/jpeg"
	MediaTypeWebP = "image/webp"

	ViewerPDFMaxBytes   int64 = 52_428_800
	ViewerImageMaxBytes int64 = 10_485_760
	ViewerMaxPages            = 300
	ViewerMaxPixels     int64 = 50_000_000

	defaultFirstPageAspect = 0.7071
	minimumPageAspect      = 0.1
	maximumPageAspect      = 10.0
)

type RejectionReason string

const (
	RejectChecksumMismatch        RejectionReason = "checksum_mismatch"
	RejectMediaTypeMismatch       RejectionReason = "media_type_mismatch"
	RejectFileTooLargeForViewer   RejectionReason = "file_too_large_for_viewer"
	RejectPDFEncrypted            RejectionReason = "pdf_encrypted"
	RejectPDFTooManyPages         RejectionReason = "pdf_too_many_pages"
	RejectPDFInvalid              RejectionReason = "pdf_invalid"
	RejectImageDimensionsExceeded RejectionReason = "image_dimensions_exceeded"
	RejectImageInvalid            RejectionReason = "image_invalid"
)

var errNotViewerMediaType = errors.New("media type is not verified by the document viewer")

// VerificationResult is the bounded verifier outcome persisted on the file.
// StoredChecksum is set only for ready files, where it equals the expected
// digest required by content_files_storage_proof_consistent.
type VerificationResult struct {
	Ready           bool
	RejectionReason RejectionReason
	StoredChecksum  []byte
	PageCount       int
	FirstPageAspect float64
	ActiveContent   bool
}

func rejected(reason RejectionReason) VerificationResult {
	return VerificationResult{RejectionReason: reason}
}

// IsViewerMediaType reports whether the classroom Documents tool renders the
// media type and therefore whether finalize runs the readiness verifier.
func IsViewerMediaType(mediaType string) bool {
	_, ok := viewerSizeLimit(mediaType)
	return ok
}

func viewerSizeLimit(mediaType string) (int64, bool) {
	switch mediaType {
	case MediaTypePDF:
		return ViewerPDFMaxBytes, true
	case MediaTypePNG, MediaTypeJPEG, MediaTypeWebP:
		return ViewerImageMaxBytes, true
	default:
		return 0, false
	}
}

// VerifyViewerDocument streams one object version and classifies it. A
// returned error is transient (I/O); every content problem is a rejection.
func VerifyViewerDocument(
	reader io.Reader,
	declaredMediaType string,
	expectedSize int64,
	expectedChecksum []byte,
) (VerificationResult, error) {
	limit, ok := viewerSizeLimit(declaredMediaType)
	if !ok {
		return VerificationResult{}, errNotViewerMediaType
	}
	if expectedSize < 1 || len(expectedChecksum) != sha256.Size {
		return rejected(RejectChecksumMismatch), nil
	}
	if expectedSize > limit {
		return rejected(RejectFileTooLargeForViewer), nil
	}
	if reader == nil {
		return VerificationResult{}, fmt.Errorf("verify document: object body is unavailable")
	}
	digest := sha256.New()
	data, err := io.ReadAll(io.TeeReader(io.LimitReader(reader, expectedSize+1), digest))
	if err != nil {
		return VerificationResult{}, fmt.Errorf("verify document: read object version: %w", err)
	}
	sum := digest.Sum(nil)
	if int64(len(data)) != expectedSize || subtle.ConstantTimeCompare(sum, expectedChecksum) != 1 {
		return rejected(RejectChecksumMismatch), nil
	}
	var result VerificationResult
	if declaredMediaType == MediaTypePDF {
		result = inspectPDF(data)
	} else {
		result = inspectImage(data, declaredMediaType)
	}
	if result.Ready {
		result.StoredChecksum = sum
	}
	return result, nil
}

func inspectImage(data []byte, declaredMediaType string) VerificationResult {
	if sniffImageMediaType(data) != declaredMediaType {
		return rejected(RejectMediaTypeMismatch)
	}
	var width, height int
	var err error
	switch declaredMediaType {
	case MediaTypePNG:
		var config image.Config
		config, err = png.DecodeConfig(bytes.NewReader(data))
		width, height = config.Width, config.Height
	case MediaTypeJPEG:
		var config image.Config
		config, err = jpeg.DecodeConfig(bytes.NewReader(data))
		width, height = config.Width, config.Height
	case MediaTypeWebP:
		width, height, err = webpDimensions(data)
	default:
		return rejected(RejectMediaTypeMismatch)
	}
	if err != nil || width < 1 || height < 1 {
		return rejected(RejectImageInvalid)
	}
	if int64(width)*int64(height) > ViewerMaxPixels {
		return rejected(RejectImageDimensionsExceeded)
	}
	return VerificationResult{
		Ready: true, PageCount: 1,
		FirstPageAspect: clampAspect(float64(width) / float64(height)),
	}
}

var (
	pngSignature  = []byte("\x89PNG\r\n\x1a\n")
	jpegSignature = []byte{0xFF, 0xD8, 0xFF}
)

// sniffImageMediaType trusts only canonical magic bytes at offset zero.
func sniffImageMediaType(data []byte) string {
	switch {
	case bytes.HasPrefix(data, pngSignature):
		return MediaTypePNG
	case bytes.HasPrefix(data, jpegSignature):
		return MediaTypeJPEG
	case len(data) >= 12 && bytes.Equal(data[0:4], []byte("RIFF")) &&
		bytes.Equal(data[8:12], []byte("WEBP")):
		return MediaTypeWebP
	default:
		return ""
	}
}

var errInvalidWebP = errors.New("invalid webp header")

// webpDimensions parses the RIFF container and the first VP8, VP8L or VP8X
// chunk header (RFC 9649) without decoding image data.
func webpDimensions(data []byte) (int, int, error) {
	if len(data) < 30 {
		return 0, 0, errInvalidWebP
	}
	riffSize := uint64(binary.LittleEndian.Uint32(data[4:8]))
	if riffSize < 4 || riffSize+8 != uint64(len(data)) {
		return 0, 0, errInvalidWebP
	}
	chunk := string(data[12:16])
	chunkSize := uint64(binary.LittleEndian.Uint32(data[16:20]))
	payload := data[20:]
	if chunkSize > uint64(len(payload)) {
		return 0, 0, errInvalidWebP
	}
	payload = payload[:chunkSize]
	switch chunk {
	case "VP8 ":
		if len(payload) < 10 || payload[0]&0x01 != 0 ||
			payload[3] != 0x9d || payload[4] != 0x01 || payload[5] != 0x2a {
			return 0, 0, errInvalidWebP
		}
		width := int(binary.LittleEndian.Uint16(payload[6:8]) & 0x3fff)
		height := int(binary.LittleEndian.Uint16(payload[8:10]) & 0x3fff)
		return width, height, nil
	case "VP8L":
		if len(payload) < 5 || payload[0] != 0x2f {
			return 0, 0, errInvalidWebP
		}
		bits := binary.LittleEndian.Uint32(payload[1:5])
		return int(bits&0x3fff) + 1, int((bits>>14)&0x3fff) + 1, nil
	case "VP8X":
		if len(payload) < 10 {
			return 0, 0, errInvalidWebP
		}
		width := int(uint32(payload[4])|uint32(payload[5])<<8|uint32(payload[6])<<16) + 1
		height := int(uint32(payload[7])|uint32(payload[8])<<8|uint32(payload[9])<<16) + 1
		return width, height, nil
	default:
		return 0, 0, errInvalidWebP
	}
}

func clampAspect(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return defaultFirstPageAspect
	}
	return math.Min(maximumPageAspect, math.Max(minimumPageAspect, value))
}
