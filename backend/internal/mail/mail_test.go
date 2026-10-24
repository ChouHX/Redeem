package mail

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestStripHTMLTags(t *testing.T) {
	input := `<html><head><style>.a{color:red}</style><script>alert(1)</script></head>` +
		`<body><p>Hello&nbsp;<b>World</b></p><p>a &amp; b</p></body></html>`
	got := StripHTMLTags(input)
	want := "Hello World a & b"
	if got != want {
		t.Fatalf("StripHTMLTags = %q, want %q", got, want)
	}
}

func TestStripHTMLTagsKeepsTextAfterScript(t *testing.T) {
	input := `<script type="text/javascript">var x = "<b>";</script><div>正文</div>`
	got := StripHTMLTags(input)
	if got != "正文" {
		t.Fatalf("StripHTMLTags = %q, want %q", got, "正文")
	}
}

func TestBodyPreviewTruncatesByRune(t *testing.T) {
	long := strings.Repeat("字", 200)
	got := BodyPreviewFromText(long)
	if len([]rune(got)) != 160 {
		t.Fatalf("预览长度 = %d, want 160", len([]rune(got)))
	}
}

func TestBodyPreviewCollapsesWhitespace(t *testing.T) {
	got := BodyPreviewFromText("  a \n\n  b\t c  ")
	if got != "a b c" {
		t.Fatalf("预览 = %q, want %q", got, "a b c")
	}
}

func TestNormalizeFolderKey(t *testing.T) {
	cases := map[string]string{
		"":      "inbox",
		"INBOX": "inbox",
		"junk":  "spam",
		"Spam":  "spam",
		"other": "inbox",
	}
	for input, want := range cases {
		if got := NormalizeFolderKey(input); got != want {
			t.Fatalf("NormalizeFolderKey(%q) = %q, want %q", input, got, want)
		}
	}
}

// 一封真实的 multipart/alternative 邮件：纯文本 base64，HTML quoted-printable。
func buildMultipartSample() []byte {
	textPart := base64.StdEncoding.EncodeToString([]byte("这是纯文本正文\n第二行"))
	htmlPart := `<html><body><p>&#20320;&#22909;&#65292;&#36825;&#26159; HTML &#27491;&#25991;</p></body></html>`
	htmlEncoded := "=EF=BB=BF" + strings.ReplaceAll(htmlPart, "", "")

	lines := []string{
		"From: Alice <alice@example.com>",
		"To: Bob <bob@example.com>",
		"Subject: =?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte("测试主题")) + "?=",
		"MIME-Version: 1.0",
		`Content-Type: multipart/alternative; boundary="BOUNDARY"`,
		"",
		"--BOUNDARY",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		textPart,
		"--BOUNDARY",
		"Content-Type: text/html; charset=utf-8",
		"Content-Transfer-Encoding: quoted-printable",
		"",
		htmlEncoded,
		"--BOUNDARY--",
		"",
	}
	return []byte(strings.Join(lines, "\r\n"))
}

func TestExtractBodyPrefersHTML(t *testing.T) {
	body, text := extractBody(buildMultipartSample())
	if body == nil {
		t.Fatal("正文为空")
	}
	if body.ContentType != "html" {
		t.Fatalf("正文类型 = %q, want html", body.ContentType)
	}
	if !strings.Contains(body.Content, "HTML") {
		t.Fatalf("HTML 正文未包含预期内容: %q", body.Content)
	}
	if !strings.Contains(text, "纯文本正文") {
		t.Fatalf("纯文本未解出: %q", text)
	}
}

func TestExtractBodyFallsBackToText(t *testing.T) {
	raw := []byte(strings.Join([]string{
		"From: a@b.c",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: quoted-printable",
		"",
		"hello=20world",
	}, "\r\n"))

	body, text := extractBody(raw)
	if body.ContentType != "text" {
		t.Fatalf("正文类型 = %q, want text", body.ContentType)
	}
	if body.Content != "hello world" {
		t.Fatalf("正文 = %q, want %q", body.Content, "hello world")
	}
	if text != "hello world" {
		t.Fatalf("纯文本 = %q", text)
	}
}

func TestDecodeMIMEHeader(t *testing.T) {
	encoded := "=?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte("测试主题")) + "?="
	if got := decodeMIMEHeader(encoded); got != "测试主题" {
		t.Fatalf("解码结果 = %q", got)
	}
}

func TestDetailFromRawBuildsPreview(t *testing.T) {
	raw := rawMessage{UID: 42, Source: buildMultipartSample()}
	message := detailFromRaw(raw, "inbox")
	if message.ID != "42" {
		t.Fatalf("id = %q", message.ID)
	}
	if message.Folder != "inbox" {
		t.Fatalf("folder = %q", message.Folder)
	}
	if message.Body == nil {
		t.Fatal("正文缺失")
	}
	if message.BodyPreview == "" {
		t.Fatal("预览为空")
	}
	if message.ContentType != "" {
		t.Fatalf("详情不应带 contentType，实际 %q", message.ContentType)
	}
}

func TestSummaryFromRawHasNoBody(t *testing.T) {
	message := summaryFromRaw(rawMessage{UID: 7}, "spam")
	if message.Body != nil {
		t.Fatal("列表项不应带正文")
	}
	if message.ContentType != "text" {
		t.Fatalf("列表项 contentType = %q, want text", message.ContentType)
	}
	if message.Folder != "spam" {
		t.Fatalf("folder = %q", message.Folder)
	}
	if message.Subject != "(无主题)" {
		t.Fatalf("subject = %q", message.Subject)
	}
}
