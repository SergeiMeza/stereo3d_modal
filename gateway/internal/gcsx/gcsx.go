// Package gcsx issues V4 signed URLs and object metadata for the shared
// bucket. Clients never see raw storage.googleapis.com public URLs — uploads
// and downloads both go through short-lived signed URLs.
//
// Signing uses the Cloud Run service account via IAM SignBlob (the storage
// client auto-detects this under ADC); the SA needs
// roles/iam.serviceAccountTokenCreator on itself.
package gcsx

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"cloud.google.com/go/storage"
)

// SignFunc signs a URL for one object (storage.BucketHandle.SignedURL).
type SignFunc func(key string, opts *storage.SignedURLOptions) (string, error)

type Client struct {
	gcs    *storage.Client
	bucket string
	prefix string // "stereo3d/{env}/"
	sign   SignFunc
	http   *http.Client // starts resumable sessions
	stat   func(ctx context.Context, key string) (int64, error)
}

func New(ctx context.Context, bucket, prefix string) (*Client, error) {
	gcs, err := storage.NewClient(ctx)
	if err != nil {
		return nil, err
	}
	return &Client{
		gcs: gcs, bucket: bucket, prefix: prefix,
		sign: gcs.Bucket(bucket).SignedURL,
		http: &http.Client{Timeout: sessionStartTimeout},
	}, nil
}

// NewWithSigner builds a Client without a storage connection, for tests:
// signing and session starts go through sign and hc; Stat answers through
// WithStat (else it fails).
func NewWithSigner(bucket, prefix string, sign SignFunc, hc *http.Client) *Client {
	return &Client{bucket: bucket, prefix: prefix, sign: sign, http: hc}
}

// WithStat replaces Stat (tests).
func (c *Client) WithStat(stat func(ctx context.Context, key string) (int64, error)) *Client {
	c.stat = stat
	return c
}

func (c *Client) Close() error {
	if c.gcs == nil {
		return nil
	}
	return c.gcs.Close()
}

// UploadKey builds the canonical source key for a conversion upload.
func (c *Client) UploadKey(uid, conversionID, ext string) string {
	return path.Join(c.prefix, "users", uid, conversionID, "source"+ext)
}

// InPrefix reports whether key belongs to this env's prefix (guards against
// path traversal into other envs or production user data at the bucket root).
func (c *Client) InPrefix(key string) bool {
	clean := path.Clean("/" + key)[1:]
	return clean == key && strings.HasPrefix(key, c.prefix)
}

func (c *Client) SignedPutURL(key, contentType string, expires time.Duration) (string, error) {
	return c.sign(key, &storage.SignedURLOptions{
		Scheme:      storage.SigningSchemeV4,
		Method:      "PUT",
		Expires:     time.Now().Add(expires),
		ContentType: contentType,
	})
}

func (c *Client) SignedGetURL(key string, expires time.Duration) (string, error) {
	return c.sign(key, &storage.SignedURLOptions{
		Scheme:  storage.SigningSchemeV4,
		Method:  "GET",
		Expires: time.Now().Add(expires),
	})
}

const sessionStartTimeout = 15 * time.Second

// StartResumableUpload opens an XML-API resumable upload session for key
// and returns the session URL (storage.googleapis.com/<bucket>/<key>
// ?upload_id=…), which the client PUTs chunks to with Content-Range; the
// upload id is the credential, valid for a week. The session is started
// here because the bucket's CORS (shared, not ours to change) doesn't let
// browsers POST. origin is the browser's Origin: a session answers CORS
// only for the origin that started it, so it is sent along ("" for none).
func (c *Client) StartResumableUpload(ctx context.Context, key, contentType, origin string) (string, error) {
	signed, err := c.sign(key, &storage.SignedURLOptions{
		Scheme:      storage.SigningSchemeV4,
		Method:      "POST",
		Expires:     time.Now().Add(sessionStartTimeout + time.Minute),
		ContentType: contentType,
		Headers:     []string{"x-goog-resumable:start"},
	})
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, sessionStartTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, signed, http.NoBody)
	if err != nil {
		return "", err
	}
	req.Header.Set("x-goog-resumable", "start")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	res, err := c.http.Do(req)
	if err != nil {
		// The URL carries a signature; keep it out of the error.
		return "", fmt.Errorf("start resumable upload for %s: transport failure", key)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	loc := res.Header.Get("Location")
	if res.StatusCode != http.StatusCreated || loc == "" {
		return "", fmt.Errorf("start resumable upload for %s: status %d", key, res.StatusCode)
	}
	if u, err := url.Parse(loc); err != nil || u.Scheme != "https" || u.Query().Get("upload_id") == "" {
		return "", fmt.Errorf("start resumable upload for %s: unexpected session URL", key)
	}
	return loc, nil
}

// Stat returns object size, or an error if the upload doesn't exist yet.
func (c *Client) Stat(ctx context.Context, key string) (int64, error) {
	if c.stat != nil {
		return c.stat(ctx, key)
	}
	if c.gcs == nil {
		return 0, fmt.Errorf("stat gs://%s/%s: no storage connection", c.bucket, key)
	}
	attrs, err := c.gcs.Bucket(c.bucket).Object(key).Attrs(ctx)
	if err != nil {
		return 0, fmt.Errorf("stat gs://%s/%s: %w", c.bucket, key, err)
	}
	return attrs.Size, nil
}

// KeyFromPublicURL translates the Modal API's public output URLs
// (https://storage.googleapis.com/<bucket>/<key>) back to bucket keys.
func (c *Client) KeyFromPublicURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	p := strings.TrimPrefix(u.Path, "/")
	unescaped, err := url.PathUnescape(p)
	if err != nil {
		return "", err
	}
	key, found := strings.CutPrefix(unescaped, c.bucket+"/")
	if !found {
		return "", fmt.Errorf("unexpected output URL %q", raw)
	}
	return key, nil
}
