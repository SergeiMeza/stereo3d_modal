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
	"net/url"
	"path"
	"strings"
	"time"

	"cloud.google.com/go/storage"
)

type Client struct {
	gcs    *storage.Client
	bucket string
	prefix string // "stereo3d/{env}/"
}

func New(ctx context.Context, bucket, prefix string) (*Client, error) {
	gcs, err := storage.NewClient(ctx)
	if err != nil {
		return nil, err
	}
	return &Client{gcs: gcs, bucket: bucket, prefix: prefix}, nil
}

func (c *Client) Close() error { return c.gcs.Close() }

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
	return c.gcs.Bucket(c.bucket).SignedURL(key, &storage.SignedURLOptions{
		Scheme:      storage.SigningSchemeV4,
		Method:      "PUT",
		Expires:     time.Now().Add(expires),
		ContentType: contentType,
	})
}

func (c *Client) SignedGetURL(key string, expires time.Duration) (string, error) {
	return c.gcs.Bucket(c.bucket).SignedURL(key, &storage.SignedURLOptions{
		Scheme:  storage.SigningSchemeV4,
		Method:  "GET",
		Expires: time.Now().Add(expires),
	})
}

// Stat returns object size, or an error if the upload doesn't exist yet.
func (c *Client) Stat(ctx context.Context, key string) (int64, error) {
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
