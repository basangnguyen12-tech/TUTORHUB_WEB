package content

import (
	"bytes"
	"compress/zlib"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
)

// The PDF inspector is a deliberately small, bounded lexer/parser (ISO
// 32000-2 §7.2–7.5) that reads object dictionaries, trailers, xref stream
// dictionaries and FlateDecode object streams. It never interprets content
// streams, fonts, images or JavaScript; it only extracts page metadata and
// flags active-content name tokens.
const (
	pdfHeaderWindow           = 1024
	pdfTrailerWindow          = 1024
	pdfMaximumDepth           = 64
	pdfMaximumObjects         = 500_000
	pdfMaximumContainerItems  = 200_000
	pdfMaximumObjectStreamN   = 100_000
	pdfMaximumInflatedStream  = int64(16 << 20)
	pdfMaximumInflatedTotal   = int64(64 << 20)
	pdfMaximumPageTreeDepth   = 64
	pdfMaximumReferenceChains = 8
	pdfDictionaryCountGuard   = ViewerMaxPages
)

var (
	errPDFTooDeep     = errors.New("pdf nesting exceeds bound")
	errPDFTooLarge    = errors.New("pdf object count exceeds bound")
	errPDFInflateBomb = errors.New("pdf object stream decompression exceeds bound")
)

var pdfActiveContentNames = map[string]bool{
	"JavaScript": true, "JS": true, "OpenAction": true, "AA": true,
	"XFA": true, "Launch": true, "EmbeddedFile": true, "EmbeddedFiles": true,
}

type (
	pdfValue  any
	pdfDict   map[string]pdfValue
	pdfArray  []pdfValue
	pdfName   string
	pdfString struct{}
	pdfBool   bool
	pdfNull   struct{}
	pdfNumber struct {
		value   float64
		integer bool
	}
	pdfRef struct {
		number     int
		generation int
	}
)

type pdfInspector struct {
	objects        map[int]pdfValue
	trailers       []pdfDict
	active         bool
	inflatedBudget int64
	err            error
}

func inspectPDF(data []byte) VerificationResult {
	if !hasPDFHeader(data) || !pdfPrefixIsNotPolyglot(data) {
		return rejected(RejectMediaTypeMismatch)
	}
	tail := data
	if len(tail) > pdfTrailerWindow {
		tail = tail[len(tail)-pdfTrailerWindow:]
	}
	if !bytes.Contains(tail, []byte("%%EOF")) {
		return rejected(RejectPDFInvalid)
	}
	inspector := &pdfInspector{
		objects: make(map[int]pdfValue), inflatedBudget: pdfMaximumInflatedTotal,
	}
	(&pdfLexer{data: data, inspector: inspector}).scanFile()
	if inspector.err != nil {
		return rejected(RejectPDFInvalid)
	}
	for _, trailer := range inspector.trailers {
		if _, encrypted := trailer["Encrypt"]; encrypted {
			return rejected(RejectPDFEncrypted)
		}
	}
	pagesRoot := inspector.pagesRoot()
	rootCount := 0
	if pagesRoot != nil {
		rootCount = pdfInt(inspector.resolve(pagesRoot["Count"]))
	}
	dictionaryCount := 0
	for _, value := range inspector.objects {
		if dict, ok := value.(pdfDict); ok && pdfDictType(dict) == "Page" {
			dictionaryCount++
		}
	}
	if rootCount > ViewerMaxPages || dictionaryCount > pdfDictionaryCountGuard {
		return rejected(RejectPDFTooManyPages)
	}
	pageCount := rootCount
	if pageCount < 1 {
		pageCount = dictionaryCount
	}
	if pageCount < 1 {
		return rejected(RejectPDFInvalid)
	}
	return VerificationResult{
		Ready: true, PageCount: pageCount,
		FirstPageAspect: inspector.firstPageAspect(pagesRoot),
		ActiveContent:   inspector.active,
	}
}

func hasPDFHeader(data []byte) bool {
	head := data
	if len(head) > pdfHeaderWindow {
		head = head[:pdfHeaderWindow]
	}
	index := bytes.Index(head, []byte("%PDF-"))
	if index < 0 || index+8 > len(data) {
		return false
	}
	version := data[index+5 : index+8]
	return (version[0] == '1' || version[0] == '2') && version[1] == '.' &&
		version[2] >= '0' && version[2] <= '9'
}

// pdfPrefixIsNotPolyglot rejects files whose leading bytes sniff as another
// active or binary format (HTML, images, archives) even though a PDF header
// appears within the first kilobyte.
func pdfPrefixIsNotPolyglot(data []byte) bool {
	sample := data
	if len(sample) > 512 {
		sample = sample[:512]
	}
	contentType := http.DetectContentType(sample)
	return contentType == MediaTypePDF || contentType == "application/octet-stream" ||
		strings.HasPrefix(contentType, "text/plain")
}

func (inspector *pdfInspector) fail(err error) {
	if inspector.err == nil {
		inspector.err = err
	}
}

func (inspector *pdfInspector) define(number int, value pdfValue) {
	if number < 0 || value == nil {
		return
	}
	if _, exists := inspector.objects[number]; !exists && len(inspector.objects) >= pdfMaximumObjects {
		inspector.fail(errPDFTooLarge)
		return
	}
	inspector.objects[number] = value
}

func (inspector *pdfInspector) resolve(value pdfValue) pdfValue {
	for index := 0; index < pdfMaximumReferenceChains; index++ {
		reference, ok := value.(pdfRef)
		if !ok {
			return value
		}
		value = inspector.objects[reference.number]
	}
	return nil
}

func (inspector *pdfInspector) resolveDict(value pdfValue) pdfDict {
	dict, _ := inspector.resolve(value).(pdfDict)
	return dict
}

func (inspector *pdfInspector) pagesRoot() pdfDict {
	var catalog pdfDict
	for index := len(inspector.trailers) - 1; index >= 0 && catalog == nil; index-- {
		catalog = inspector.resolveDict(inspector.trailers[index]["Root"])
	}
	if catalog == nil {
		highest := -1
		for number, value := range inspector.objects {
			if dict, ok := value.(pdfDict); ok && pdfDictType(dict) == "Catalog" && number > highest {
				highest, catalog = number, dict
			}
		}
	}
	if catalog == nil {
		return nil
	}
	return inspector.resolveDict(catalog["Pages"])
}

// firstPageAspect walks /Kids[0] with inherited MediaBox/CropBox/Rotate and
// falls back to A4 portrait when the tree or box is unusable.
func (inspector *pdfInspector) firstPageAspect(node pdfDict) float64 {
	var mediaBox, cropBox pdfValue
	rotate := 0
	for depth := 0; node != nil && depth < pdfMaximumPageTreeDepth; depth++ {
		if value, ok := node["MediaBox"]; ok {
			mediaBox = value
		}
		if value, ok := node["CropBox"]; ok {
			cropBox = value
		}
		if value, ok := node["Rotate"]; ok {
			rotate = pdfInt(inspector.resolve(value))
		}
		if pdfDictType(node) == "Page" || node["Kids"] == nil {
			break
		}
		kids, ok := inspector.resolve(node["Kids"]).(pdfArray)
		if !ok || len(kids) == 0 {
			return defaultFirstPageAspect
		}
		node = inspector.resolveDict(kids[0])
	}
	width, height, ok := inspector.boxSize(cropBox)
	if !ok {
		width, height, ok = inspector.boxSize(mediaBox)
	}
	if !ok {
		return defaultFirstPageAspect
	}
	rotate = ((rotate % 360) + 360) % 360
	if rotate == 90 || rotate == 270 {
		width, height = height, width
	}
	return clampAspect(width / height)
}

func (inspector *pdfInspector) boxSize(value pdfValue) (float64, float64, bool) {
	box, ok := inspector.resolve(value).(pdfArray)
	if !ok || len(box) != 4 {
		return 0, 0, false
	}
	var coordinates [4]float64
	for index, item := range box {
		number, ok := inspector.resolve(item).(pdfNumber)
		if !ok || math.IsNaN(number.value) || math.IsInf(number.value, 0) {
			return 0, 0, false
		}
		coordinates[index] = number.value
	}
	width := math.Abs(coordinates[2] - coordinates[0])
	height := math.Abs(coordinates[3] - coordinates[1])
	return width, height, width > 0 && height > 0
}

func (inspector *pdfInspector) handleStream(dict pdfDict, raw []byte) {
	switch pdfDictType(dict) {
	case "XRef":
		inspector.trailers = append(inspector.trailers, dict)
	case "ObjStm":
		inspector.expandObjectStream(dict, raw)
	}
}

func (inspector *pdfInspector) expandObjectStream(dict pdfDict, raw []byte) {
	count := pdfInt(inspector.resolve(dict["N"]))
	first := pdfInt(inspector.resolve(dict["First"]))
	if count < 1 || count > pdfMaximumObjectStreamN || first < 0 || !pdfIsFlateOnly(inspector, dict) {
		return
	}
	decoded, err := inspector.inflate(raw)
	if err != nil {
		if errors.Is(err, errPDFInflateBomb) {
			inspector.fail(err)
		}
		return
	}
	if first > len(decoded) {
		return
	}
	header := &pdfLexer{data: decoded[:first], inspector: inspector}
	numbers := make([]int, 0, count)
	offsets := make([]int, 0, count)
	for index := 0; index < count; index++ {
		number, okNumber := header.readInteger()
		offset, okOffset := header.readInteger()
		if !okNumber || !okOffset || offset < 0 || first+offset > len(decoded) ||
			(len(offsets) > 0 && offset < offsets[len(offsets)-1]) {
			return
		}
		numbers = append(numbers, number)
		offsets = append(offsets, offset)
	}
	for index := range numbers {
		start := first + offsets[index]
		end := len(decoded)
		if index+1 < len(offsets) {
			end = first + offsets[index+1]
		}
		lexer := &pdfLexer{data: decoded[start:end], inspector: inspector}
		inspector.define(numbers[index], lexer.parseValue(0))
		if inspector.err != nil {
			return
		}
	}
}

func pdfIsFlateOnly(inspector *pdfInspector, dict pdfDict) bool {
	if parameters := inspector.resolveDict(dict["DecodeParms"]); parameters != nil &&
		pdfInt(inspector.resolve(parameters["Predictor"])) > 1 {
		return false
	}
	switch filter := inspector.resolve(dict["Filter"]).(type) {
	case pdfName:
		return filter == "FlateDecode"
	case pdfArray:
		if len(filter) != 1 {
			return false
		}
		name, ok := inspector.resolve(filter[0]).(pdfName)
		return ok && name == "FlateDecode"
	default:
		return false
	}
}

func (inspector *pdfInspector) inflate(raw []byte) ([]byte, error) {
	reader, err := zlib.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	limit := min(pdfMaximumInflatedStream, inspector.inflatedBudget)
	decoded, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if int64(len(decoded)) > limit {
		return nil, errPDFInflateBomb
	}
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}
	inspector.inflatedBudget -= int64(len(decoded))
	return decoded, nil
}

func pdfDictType(dict pdfDict) string {
	name, _ := dict["Type"].(pdfName)
	return string(name)
}

func pdfInt(value pdfValue) int {
	number, ok := value.(pdfNumber)
	if !ok || !number.integer || number.value < math.MinInt32 || number.value > math.MaxInt32 {
		return 0
	}
	return int(number.value)
}

type pdfLexer struct {
	data      []byte
	pos       int
	inspector *pdfInspector
}

func isPDFWhitespace(character byte) bool {
	switch character {
	case 0, '\t', '\n', '\f', '\r', ' ':
		return true
	}
	return false
}

func isPDFDelimiter(character byte) bool {
	switch character {
	case '(', ')', '<', '>', '[', ']', '{', '}', '/', '%':
		return true
	}
	return false
}

func isPDFRegular(character byte) bool {
	return !isPDFWhitespace(character) && !isPDFDelimiter(character)
}

func (lexer *pdfLexer) skipWhitespace() {
	for lexer.pos < len(lexer.data) {
		character := lexer.data[lexer.pos]
		if isPDFWhitespace(character) {
			lexer.pos++
			continue
		}
		if character == '%' {
			for lexer.pos < len(lexer.data) && lexer.data[lexer.pos] != '\n' && lexer.data[lexer.pos] != '\r' {
				lexer.pos++
			}
			continue
		}
		return
	}
}

func (lexer *pdfLexer) readRegular() string {
	start := lexer.pos
	for lexer.pos < len(lexer.data) && isPDFRegular(lexer.data[lexer.pos]) {
		lexer.pos++
	}
	return string(lexer.data[start:lexer.pos])
}

// scanFile walks the top level: "N G obj ... endobj", "trailer <<...>>" and
// stray dictionaries; stream bodies are skipped, never tokenized.
func (lexer *pdfLexer) scanFile() {
	integers := make([]int, 0, 2)
	for lexer.inspector.err == nil {
		lexer.skipWhitespace()
		if lexer.pos >= len(lexer.data) {
			return
		}
		character := lexer.data[lexer.pos]
		switch {
		case character >= '0' && character <= '9':
			token := lexer.readRegular()
			value, err := strconv.Atoi(token)
			if err != nil {
				integers = integers[:0]
				continue
			}
			if len(integers) == 2 {
				integers[0], integers = integers[1], integers[:1]
			}
			integers = append(integers, value)
		case isPDFRegular(character):
			keyword := lexer.readRegular()
			switch {
			case keyword == "obj" && len(integers) == 2:
				lexer.scanObject(integers[0])
			case keyword == "trailer":
				if dict, ok := lexer.parseValue(0).(pdfDict); ok {
					lexer.inspector.trailers = append(lexer.inspector.trailers, dict)
				}
			}
			integers = integers[:0]
		case character == '<' || character == '[' || character == '(' || character == '/':
			before := lexer.pos
			_ = lexer.parseValue(0)
			if lexer.pos == before {
				lexer.pos++
			}
			integers = integers[:0]
		default:
			lexer.pos++
			integers = integers[:0]
		}
	}
}

func (lexer *pdfLexer) scanObject(number int) {
	value := lexer.parseValue(0)
	if lexer.inspector.err != nil {
		return
	}
	lexer.skipWhitespace()
	if bytes.HasPrefix(lexer.data[lexer.pos:], []byte("stream")) {
		lexer.pos += len("stream")
		if lexer.pos < len(lexer.data) && lexer.data[lexer.pos] == '\r' {
			lexer.pos++
		}
		if lexer.pos < len(lexer.data) && lexer.data[lexer.pos] == '\n' {
			lexer.pos++
		}
		start := lexer.pos
		dict, _ := value.(pdfDict)
		end := -1
		if length := pdfInt(dict["Length"]); length >= 0 && dict["Length"] != nil &&
			start+length <= len(lexer.data) {
			after := &pdfLexer{data: lexer.data, pos: start + length, inspector: lexer.inspector}
			after.skipWhitespace()
			if bytes.HasPrefix(lexer.data[after.pos:], []byte("endstream")) {
				end = start + length
			}
		}
		if end < 0 {
			index := bytes.Index(lexer.data[start:], []byte("endstream"))
			if index < 0 {
				end = len(lexer.data)
			} else {
				end = start + index
			}
		}
		if dict != nil {
			lexer.inspector.handleStream(dict, lexer.data[start:end])
		}
		lexer.pos = end
		if bytes.HasPrefix(lexer.data[lexer.pos:], []byte("endstream")) {
			lexer.pos += len("endstream")
		}
	}
	lexer.inspector.define(number, value)
}

func (lexer *pdfLexer) readInteger() (int, bool) {
	lexer.skipWhitespace()
	start := lexer.pos
	for lexer.pos < len(lexer.data) && lexer.data[lexer.pos] >= '0' && lexer.data[lexer.pos] <= '9' {
		lexer.pos++
	}
	if lexer.pos == start || lexer.pos-start > 10 {
		return 0, false
	}
	value, err := strconv.Atoi(string(lexer.data[start:lexer.pos]))
	return value, err == nil
}

// parseValue returns nil when the next token is not a value (for example an
// "endobj"/"stream" keyword or a stray closing delimiter), leaving pos at the
// keyword so callers can resynchronize.
func (lexer *pdfLexer) parseValue(depth int) pdfValue {
	if depth > pdfMaximumDepth {
		lexer.inspector.fail(errPDFTooDeep)
		return nil
	}
	lexer.skipWhitespace()
	if lexer.pos >= len(lexer.data) {
		return nil
	}
	character := lexer.data[lexer.pos]
	switch {
	case character == '<' && lexer.pos+1 < len(lexer.data) && lexer.data[lexer.pos+1] == '<':
		lexer.pos += 2
		return lexer.parseDict(depth)
	case character == '<':
		lexer.skipHexString()
		return pdfString{}
	case character == '[':
		lexer.pos++
		return lexer.parseArray(depth)
	case character == '(':
		lexer.skipLiteralString()
		return pdfString{}
	case character == '/':
		return lexer.readName()
	case character == '+' || character == '-' || character == '.' || (character >= '0' && character <= '9'):
		return lexer.readNumberOrReference()
	case isPDFRegular(character):
		start := lexer.pos
		switch lexer.readRegular() {
		case "true":
			return pdfBool(true)
		case "false":
			return pdfBool(false)
		case "null":
			return pdfNull{}
		}
		lexer.pos = start
		return nil
	default:
		return nil
	}
}

func (lexer *pdfLexer) parseDict(depth int) pdfValue {
	dict := pdfDict{}
	for items := 0; lexer.inspector.err == nil; items++ {
		lexer.skipWhitespace()
		if lexer.pos >= len(lexer.data) || items > pdfMaximumContainerItems {
			return dict
		}
		if lexer.data[lexer.pos] == '>' {
			if lexer.pos+1 < len(lexer.data) && lexer.data[lexer.pos+1] == '>' {
				lexer.pos += 2
			} else {
				lexer.pos++
			}
			return dict
		}
		if lexer.data[lexer.pos] != '/' {
			before := lexer.pos
			if lexer.parseValue(depth+1) == nil && lexer.pos == before {
				if isPDFRegular(lexer.data[lexer.pos]) {
					return dict
				}
				lexer.pos++
			}
			continue
		}
		key := lexer.readName()
		before := lexer.pos
		value := lexer.parseValue(depth + 1)
		if value == nil && lexer.pos == before {
			return dict
		}
		dict[string(key)] = value
	}
	return dict
}

func (lexer *pdfLexer) parseArray(depth int) pdfValue {
	array := pdfArray{}
	for items := 0; lexer.inspector.err == nil; items++ {
		lexer.skipWhitespace()
		if lexer.pos >= len(lexer.data) || items > pdfMaximumContainerItems {
			return array
		}
		if lexer.data[lexer.pos] == ']' {
			lexer.pos++
			return array
		}
		before := lexer.pos
		value := lexer.parseValue(depth + 1)
		if value == nil {
			if lexer.pos == before {
				if isPDFRegular(lexer.data[lexer.pos]) {
					return array
				}
				lexer.pos++
			}
			continue
		}
		array = append(array, value)
	}
	return array
}

// readName decodes #xx escapes so obfuscated names such as /J#53 are matched
// against the active-content allowlist exactly like /JS.
func (lexer *pdfLexer) readName() pdfName {
	lexer.pos++
	var name strings.Builder
	for lexer.pos < len(lexer.data) && isPDFRegular(lexer.data[lexer.pos]) {
		character := lexer.data[lexer.pos]
		if character == '#' && lexer.pos+2 < len(lexer.data) {
			if decoded, err := strconv.ParseUint(string(lexer.data[lexer.pos+1:lexer.pos+3]), 16, 8); err == nil {
				name.WriteByte(byte(decoded))
				lexer.pos += 3
				continue
			}
		}
		name.WriteByte(character)
		lexer.pos++
	}
	value := name.String()
	if pdfActiveContentNames[value] {
		lexer.inspector.active = true
	}
	return pdfName(value)
}

func (lexer *pdfLexer) readNumberOrReference() pdfValue {
	token := lexer.readRegular()
	if token == "" {
		lexer.pos++
		return nil
	}
	integer, err := strconv.ParseInt(token, 10, 64)
	if err != nil {
		real, realErr := strconv.ParseFloat(token, 64)
		if realErr != nil {
			return pdfNull{}
		}
		return pdfNumber{value: real}
	}
	saved := lexer.pos
	if generation, ok := lexer.readInteger(); ok {
		lexer.skipWhitespace()
		if lexer.pos < len(lexer.data) && lexer.data[lexer.pos] == 'R' &&
			(lexer.pos+1 == len(lexer.data) || !isPDFRegular(lexer.data[lexer.pos+1])) &&
			integer >= 0 && integer <= math.MaxInt32 {
			lexer.pos++
			return pdfRef{number: int(integer), generation: generation}
		}
	}
	lexer.pos = saved
	return pdfNumber{value: float64(integer), integer: true}
}

func (lexer *pdfLexer) skipLiteralString() {
	lexer.pos++
	depth := 1
	for lexer.pos < len(lexer.data) && depth > 0 {
		switch lexer.data[lexer.pos] {
		case '\\':
			lexer.pos++
		case '(':
			depth++
		case ')':
			depth--
		}
		lexer.pos++
	}
}

func (lexer *pdfLexer) skipHexString() {
	lexer.pos++
	for lexer.pos < len(lexer.data) && lexer.data[lexer.pos] != '>' {
		lexer.pos++
	}
	if lexer.pos < len(lexer.data) {
		lexer.pos++
	}
}
