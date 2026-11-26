package content

import (
	"bytes"
	"compress/zlib"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"strings"
	"testing"
)

type pdfFixtureOptions struct {
	pages        int
	encrypted    bool
	catalogExtra string
	extraObjects []string
	mediaBox     string
	rotate       int
}

// buildPDF writes a small classic-xref PDF. Offsets in the xref table are
// approximate on purpose: the inspector must not depend on them.
func buildPDF(options pdfFixtureOptions) []byte {
	if options.mediaBox == "" {
		options.mediaBox = "[0 0 595 842]"
	}
	var body strings.Builder
	body.WriteString("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	kids := make([]string, 0, options.pages)
	for index := 0; index < options.pages; index++ {
		kids = append(kids, fmt.Sprintf("%d 0 R", 10+index))
	}
	fmt.Fprintf(&body, "1 0 obj\n<< /Type /Catalog /Pages 2 0 R %s >>\nendobj\n", options.catalogExtra)
	fmt.Fprintf(&body, "2 0 obj\n<< /Type /Pages /Kids [%s] /Count %d /MediaBox %s >>\nendobj\n",
		strings.Join(kids, " "), options.pages, options.mediaBox)
	for index := 0; index < options.pages; index++ {
		rotate := ""
		if options.rotate != 0 && index == 0 {
			rotate = fmt.Sprintf(" /Rotate %d", options.rotate)
		}
		fmt.Fprintf(&body, "%d 0 obj\n<< /Type /Page /Parent 2 0 R /Contents %d 0 R%s >>\nendobj\n",
			10+index, 1000+index, rotate)
		content := "BT /F1 12 Tf 72 712 Td (Page) Tj ET"
		fmt.Fprintf(&body, "%d 0 obj\n<< /Length %d >>\nstream\n%s\nendstream\nendobj\n",
			1000+index, len(content), content)
	}
	for _, object := range options.extraObjects {
		body.WriteString(object)
		body.WriteString("\n")
	}
	trailer := "<< /Size 2000 /Root 1 0 R >>"
	if options.encrypted {
		trailer = "<< /Size 2000 /Root 1 0 R /Encrypt 99 0 R /ID [<00> <00>] >>"
	}
	fmt.Fprintf(&body, "xref\n0 1\n0000000000 65535 f \ntrailer\n%s\nstartxref\n9\n%%%%EOF\n", trailer)
	return []byte(body.String())
}

// buildObjectStreamPDF hides the catalog, page tree and pages inside one
// FlateDecode object stream with an xref stream trailer, as PDF 1.5+ writers do.
func buildObjectStreamPDF(t *testing.T, pages int, extraCatalog string) []byte {
	t.Helper()
	objects := []string{
		fmt.Sprintf("<< /Type /Catalog /Pages 2 0 R %s >>", extraCatalog),
	}
	numbers := []int{1, 2}
	kids := make([]string, 0, pages)
	for index := 0; index < pages; index++ {
		kids = append(kids, fmt.Sprintf("%d 0 R", 10+index))
	}
	objects = append(objects, fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), pages))
	for index := 0; index < pages; index++ {
		numbers = append(numbers, 10+index)
		objects = append(objects, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] >>")
	}
	var header, payload strings.Builder
	for index, object := range objects {
		fmt.Fprintf(&header, "%d %d ", numbers[index], payload.Len())
		payload.WriteString(object)
		payload.WriteString("\n")
	}
	decoded := header.String() + payload.String()
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	if _, err := writer.Write([]byte(decoded)); err != nil {
		t.Fatalf("compress object stream: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close object stream: %v", err)
	}
	var file bytes.Buffer
	file.WriteString("%PDF-1.7\n")
	fmt.Fprintf(&file, "5 0 obj\n<< /Type /ObjStm /N %d /First %d /Filter /FlateDecode /Length %d >>\nstream\n",
		len(objects), header.Len(), compressed.Len())
	file.Write(compressed.Bytes())
	file.WriteString("\nendstream\nendobj\n")
	file.WriteString("6 0 obj\n<< /Type /XRef /Size 20 /Root 1 0 R /W [1 2 1] /Length 0 >>\nstream\n\nendstream\nendobj\n")
	file.WriteString("startxref\n9\n%%EOF\n")
	return file.Bytes()
}

func verifyBytes(t *testing.T, data []byte, mediaType string) VerificationResult {
	t.Helper()
	sum := sha256.Sum256(data)
	result, err := VerifyViewerDocument(bytes.NewReader(data), mediaType, int64(len(data)), sum[:])
	if err != nil {
		t.Fatalf("verify document: %v", err)
	}
	return result
}

func requireRejected(t *testing.T, result VerificationResult, reason RejectionReason) {
	t.Helper()
	if result.Ready || result.RejectionReason != reason {
		t.Fatalf("result = %+v, want rejected %s", result, reason)
	}
	if result.StoredChecksum != nil || result.PageCount != 0 {
		t.Fatalf("rejected result must not claim verified metadata: %+v", result)
	}
}

func TestVerifierAcceptsMultiPagePDFWithPageMetadata(t *testing.T) {
	t.Parallel()
	data := buildPDF(pdfFixtureOptions{pages: 3})
	result := verifyBytes(t, data, MediaTypePDF)
	if !result.Ready || result.PageCount != 3 || result.ActiveContent {
		t.Fatalf("unexpected verification: %+v", result)
	}
	if math.Abs(result.FirstPageAspect-595.0/842.0) > 1e-9 {
		t.Fatalf("first page aspect = %f", result.FirstPageAspect)
	}
	sum := sha256.Sum256(data)
	if !bytes.Equal(result.StoredChecksum, sum[:]) {
		t.Fatal("ready verification must persist the verified digest")
	}
}

func TestVerifierHonorsRotationAndFallsBackToA4(t *testing.T) {
	t.Parallel()
	rotated := verifyBytes(t, buildPDF(pdfFixtureOptions{pages: 1, rotate: 90}), MediaTypePDF)
	if !rotated.Ready || math.Abs(rotated.FirstPageAspect-842.0/595.0) > 1e-9 {
		t.Fatalf("rotated aspect = %+v", rotated)
	}
	broken := verifyBytes(t, buildPDF(pdfFixtureOptions{pages: 1, mediaBox: "[0 0 0 0]"}), MediaTypePDF)
	if !broken.Ready || broken.FirstPageAspect != defaultFirstPageAspect {
		t.Fatalf("invalid box must fall back to A4: %+v", broken)
	}
	extreme := verifyBytes(t, buildPDF(pdfFixtureOptions{pages: 1, mediaBox: "[0 0 10 5000]"}), MediaTypePDF)
	if !extreme.Ready || extreme.FirstPageAspect != minimumPageAspect {
		t.Fatalf("extreme aspect must clamp to the schema bound: %+v", extreme)
	}
}

func TestVerifierRejectsEncryptedPDF(t *testing.T) {
	t.Parallel()
	requireRejected(t, verifyBytes(t, buildPDF(pdfFixtureOptions{pages: 2, encrypted: true}), MediaTypePDF),
		RejectPDFEncrypted)
}

func TestVerifierRejectsPDFWithMoreThan300Pages(t *testing.T) {
	t.Parallel()
	requireRejected(t, verifyBytes(t, buildPDF(pdfFixtureOptions{pages: 301}), MediaTypePDF),
		RejectPDFTooManyPages)
	if result := verifyBytes(t, buildPDF(pdfFixtureOptions{pages: 300}), MediaTypePDF); !result.Ready ||
		result.PageCount != 300 {
		t.Fatalf("300 pages must stay within the viewer bound: %+v", result)
	}
}

func TestVerifierFlagsActiveContentWithoutRejecting(t *testing.T) {
	t.Parallel()
	data := buildPDF(pdfFixtureOptions{
		pages: 1, catalogExtra: "/OpenAction 50 0 R",
		extraObjects: []string{"50 0 obj\n<< /S /JavaScript /JS (app.alert\\(1\\)) >>\nendobj"},
	})
	result := verifyBytes(t, data, MediaTypePDF)
	if !result.Ready || !result.ActiveContent || result.PageCount != 1 {
		t.Fatalf("OpenAction + JS must be ready with active_content: %+v", result)
	}
	obfuscated := buildPDF(pdfFixtureOptions{
		pages: 1, extraObjects: []string{"51 0 obj\n<< /S /Foo /J#53 52 0 R >>\nendobj"},
	})
	if result := verifyBytes(t, obfuscated, MediaTypePDF); !result.Ready || !result.ActiveContent {
		t.Fatalf("hex-escaped /J#53 must be detected as /JS: %+v", result)
	}
	for _, token := range []string{"/AA << >>", "/XFA 3 0 R", "/S /Launch", "/Type /EmbeddedFile"} {
		data := buildPDF(pdfFixtureOptions{
			pages: 1, extraObjects: []string{"60 0 obj\n<< " + token + " >>\nendobj"},
		})
		if result := verifyBytes(t, data, MediaTypePDF); !result.Ready || !result.ActiveContent {
			t.Fatalf("token %q must set active_content: %+v", token, result)
		}
	}
	plain := buildPDF(pdfFixtureOptions{pages: 1, extraObjects: []string{"61 0 obj\n<< /JSX 1 /AAB 2 >>\nendobj"}})
	if result := verifyBytes(t, plain, MediaTypePDF); !result.Ready || result.ActiveContent {
		t.Fatalf("names that only share a prefix must not be flagged: %+v", result)
	}
}

func TestVerifierReadsCompressedObjectStreams(t *testing.T) {
	t.Parallel()
	result := verifyBytes(t, buildObjectStreamPDF(t, 4, "/OpenAction << /S /JavaScript >>"), MediaTypePDF)
	if !result.Ready || result.PageCount != 4 || !result.ActiveContent {
		t.Fatalf("object stream pages and actions must be visible: %+v", result)
	}
	if math.Abs(result.FirstPageAspect-842.0/595.0) > 1e-9 {
		t.Fatalf("object stream page aspect = %f", result.FirstPageAspect)
	}
	if result := verifyBytes(t, buildObjectStreamPDF(t, 301, ""), MediaTypePDF); result.Ready ||
		result.RejectionReason != RejectPDFTooManyPages {
		t.Fatalf("object stream page overflow must be rejected: %+v", result)
	}
}

func TestVerifierBoundsObjectStreamDecompression(t *testing.T) {
	t.Parallel()
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	chunk := bytes.Repeat([]byte{' '}, 1<<20)
	for index := 0; index < 20; index++ {
		if _, err := writer.Write(chunk); err != nil {
			t.Fatalf("compress bomb: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close bomb: %v", err)
	}
	var file bytes.Buffer
	file.WriteString("%PDF-1.7\n")
	fmt.Fprintf(&file, "5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length %d >>\nstream\n", compressed.Len())
	file.Write(compressed.Bytes())
	file.WriteString("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n")
	requireRejected(t, verifyBytes(t, file.Bytes(), MediaTypePDF), RejectPDFInvalid)
}

func TestVerifierRejectsDisguisedAndMalformedPDF(t *testing.T) {
	t.Parallel()
	html := []byte("<!DOCTYPE html><html><body><script>alert(1)</script>%PDF-1.4\n" +
		"1 0 obj << /Type /Catalog >> endobj\n%%EOF\n")
	requireRejected(t, verifyBytes(t, html, MediaTypePDF), RejectMediaTypeMismatch)
	requireRejected(t, verifyBytes(t, []byte("plain text pretending to be a document"), MediaTypePDF),
		RejectMediaTypeMismatch)
	png := pngBytes(t, 4, 3)
	requireRejected(t, verifyBytes(t, png, MediaTypePDF), RejectMediaTypeMismatch)
	noEOF := bytes.TrimSuffix(buildPDF(pdfFixtureOptions{pages: 1}), []byte("%%EOF\n"))
	requireRejected(t, verifyBytes(t, noEOF, MediaTypePDF), RejectPDFInvalid)
	noPages := []byte("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n")
	requireRejected(t, verifyBytes(t, noPages, MediaTypePDF), RejectPDFInvalid)
	deep := []byte("%PDF-1.7\n1 0 obj " + strings.Repeat("[", 200) + strings.Repeat("]", 200) +
		" endobj\n%%EOF\n")
	requireRejected(t, verifyBytes(t, deep, MediaTypePDF), RejectPDFInvalid)
}

func TestVerifierRejectsChecksumAndSizeMismatches(t *testing.T) {
	t.Parallel()
	data := buildPDF(pdfFixtureOptions{pages: 1})
	wrong := sha256.Sum256([]byte("different"))
	result, err := VerifyViewerDocument(bytes.NewReader(data), MediaTypePDF, int64(len(data)), wrong[:])
	if err != nil {
		t.Fatalf("verify mismatch: %v", err)
	}
	requireRejected(t, result, RejectChecksumMismatch)
	sum := sha256.Sum256(data)
	short, err := VerifyViewerDocument(bytes.NewReader(data), MediaTypePDF, int64(len(data))+5, sum[:])
	if err != nil {
		t.Fatalf("verify short object: %v", err)
	}
	requireRejected(t, short, RejectChecksumMismatch)
	longer := append(append([]byte(nil), data...), []byte("trailing bytes")...)
	extended, err := VerifyViewerDocument(bytes.NewReader(longer), MediaTypePDF, int64(len(data)), sum[:])
	if err != nil {
		t.Fatalf("verify long object: %v", err)
	}
	requireRejected(t, extended, RejectChecksumMismatch)
	tooLarge, err := VerifyViewerDocument(nil, MediaTypePDF, ViewerPDFMaxBytes+1, sum[:])
	if err != nil {
		t.Fatalf("verify oversized object: %v", err)
	}
	requireRejected(t, tooLarge, RejectFileTooLargeForViewer)
	imageLarge, err := VerifyViewerDocument(nil, MediaTypePNG, ViewerImageMaxBytes+1, sum[:])
	if err != nil {
		t.Fatalf("verify oversized image: %v", err)
	}
	requireRejected(t, imageLarge, RejectFileTooLargeForViewer)
	if _, err := VerifyViewerDocument(bytes.NewReader(data), "application/zip", int64(len(data)), sum[:]); !errors.Is(
		err, errNotViewerMediaType) {
		t.Fatalf("non-viewer media types must not be verified: %v", err)
	}
	if _, err := VerifyViewerDocument(failingReader{}, MediaTypePDF, int64(len(data)), sum[:]); err == nil {
		t.Fatal("transient storage read errors must not become rejections")
	}
}

func TestVerifierAcceptsPNGJPEGAndWebP(t *testing.T) {
	t.Parallel()
	for name, test := range map[string]struct {
		data      []byte
		mediaType string
		aspect    float64
	}{
		"png":       {data: pngBytes(t, 40, 20), mediaType: MediaTypePNG, aspect: 2},
		"jpeg":      {data: jpegBytes(t, 30, 60), mediaType: MediaTypeJPEG, aspect: 0.5},
		"webp-vp8l": {data: webpVP8L(300, 150), mediaType: MediaTypeWebP, aspect: 2},
		"webp-vp8":  {data: webpVP8(160, 320), mediaType: MediaTypeWebP, aspect: 0.5},
		"webp-vp8x": {data: webpVP8X(1000, 1000), mediaType: MediaTypeWebP, aspect: 1},
	} {
		result := verifyBytes(t, test.data, test.mediaType)
		if !result.Ready || result.PageCount != 1 || result.ActiveContent ||
			math.Abs(result.FirstPageAspect-test.aspect) > 1e-9 {
			t.Fatalf("%s verification = %+v", name, result)
		}
	}
}

func TestVerifierRejectsImageMismatchAndPixelBombs(t *testing.T) {
	t.Parallel()
	requireRejected(t, verifyBytes(t, jpegBytes(t, 8, 8), MediaTypePNG), RejectMediaTypeMismatch)
	requireRejected(t, verifyBytes(t, pngBytes(t, 8, 8), MediaTypeWebP), RejectMediaTypeMismatch)
	requireRejected(t, verifyBytes(t, buildPDF(pdfFixtureOptions{pages: 1}), MediaTypeJPEG), RejectMediaTypeMismatch)
	requireRejected(t, verifyBytes(t, pngHeaderOnly(10_000, 10_000), MediaTypePNG), RejectImageDimensionsExceeded)
	requireRejected(t, verifyBytes(t, webpVP8X(8_000, 8_000), MediaTypeWebP), RejectImageDimensionsExceeded)
	if result := verifyBytes(t, pngHeaderOnly(10_000, 5_000), MediaTypePNG); !result.Ready {
		t.Fatalf("exactly 50 megapixels must stay within the bound: %+v", result)
	}
	truncated := webpVP8L(10, 10)
	binary.LittleEndian.PutUint32(truncated[4:8], uint32(len(truncated)))
	requireRejected(t, verifyBytes(t, truncated, MediaTypeWebP), RejectImageInvalid)
	corrupt := pngHeaderOnly(10, 10)
	corrupt[len(corrupt)-1] ^= 0xff
	requireRejected(t, verifyBytes(t, corrupt, MediaTypePNG), RejectImageInvalid)
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("storage reset") }

func pngBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	canvas.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, canvas); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buffer.Bytes()
}

func jpegBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, width, height))
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, canvas, &jpeg.Options{Quality: 70}); err != nil {
		t.Fatalf("encode jpeg: %v", err)
	}
	return buffer.Bytes()
}

// pngHeaderOnly emits a signature and a CRC-valid IHDR chunk claiming the
// requested dimensions without any pixel data (a decompression-bomb probe).
func pngHeaderOnly(width, height uint32) []byte {
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], width)
	binary.BigEndian.PutUint32(ihdr[4:8], height)
	ihdr[8], ihdr[9] = 8, 2
	var buffer bytes.Buffer
	buffer.Write(pngSignature)
	_ = binary.Write(&buffer, binary.BigEndian, uint32(len(ihdr)))
	chunk := append([]byte("IHDR"), ihdr...)
	buffer.Write(chunk)
	_ = binary.Write(&buffer, binary.BigEndian, crc32.ChecksumIEEE(chunk))
	return buffer.Bytes()
}

func riff(chunk string, payload []byte) []byte {
	if len(payload)%2 == 1 {
		payload = append(payload, 0)
	}
	var buffer bytes.Buffer
	buffer.WriteString("RIFF")
	_ = binary.Write(&buffer, binary.LittleEndian, uint32(4+8+len(payload)))
	buffer.WriteString("WEBP")
	buffer.WriteString(chunk)
	_ = binary.Write(&buffer, binary.LittleEndian, uint32(len(payload)))
	buffer.Write(payload)
	return buffer.Bytes()
}

func webpVP8L(width, height int) []byte {
	payload := make([]byte, 12)
	payload[0] = 0x2f
	bits := uint32(width-1) | uint32(height-1)<<14
	binary.LittleEndian.PutUint32(payload[1:5], bits)
	return riff("VP8L", payload)
}

func webpVP8(width, height int) []byte {
	payload := make([]byte, 12)
	payload[0], payload[1], payload[2] = 0x10, 0x02, 0x00
	payload[3], payload[4], payload[5] = 0x9d, 0x01, 0x2a
	binary.LittleEndian.PutUint16(payload[6:8], uint16(width))
	binary.LittleEndian.PutUint16(payload[8:10], uint16(height))
	return riff("VP8 ", payload)
}

func webpVP8X(width, height int) []byte {
	payload := make([]byte, 10)
	w, h := uint32(width-1), uint32(height-1)
	payload[4], payload[5], payload[6] = byte(w), byte(w>>8), byte(w>>16)
	payload[7], payload[8], payload[9] = byte(h), byte(h>>8), byte(h>>16)
	return riff("VP8X", payload)
}
