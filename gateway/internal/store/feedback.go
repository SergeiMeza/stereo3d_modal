package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
)

// Feedback (owner 2026-11-04): the web's messages go to the same store as
// the app's, app_feedback, in the app's document shape (platform "web");
// on test app_feedback_test, so test never mixes with the app's real
// feedback. The SVS backend mails each new app_feedback document unless it
// carries mailingAt/mailedAt (its claim); the gateway claims and mails its
// own.

// FeedbackCol is the env's collection.
func FeedbackCol(env string) string {
	if env == "prod" {
		return "app_feedback"
	}
	return "app_feedback_" + env
}

// AddFeedback stores one document in coll and returns its id.
func (s *Store) AddFeedback(ctx context.Context, coll string, doc map[string]any) (string, error) {
	ref, _, err := s.fs.Collection(coll).Add(ctx, doc)
	if err != nil {
		return "", err
	}
	return ref.ID, nil
}

// MarkFeedbackMailed writes mailedAt, or mailError when the mail failed.
func (s *Store) MarkFeedbackMailed(ctx context.Context, coll, id string, mailErr error) error {
	upd := []firestore.Update{{Path: "mailedAt", Value: firestore.ServerTimestamp}}
	if mailErr != nil {
		upd = []firestore.Update{{Path: "mailError", Value: mailErr.Error()}}
	}
	_, err := s.fs.Collection(coll).Doc(id).Update(ctx, upd)
	return err
}

// ListFeedback is coll's documents since t, newest first.
func (s *Store) ListFeedback(ctx context.Context, coll string, since time.Time, limit int) ([]map[string]any, error) {
	snaps, err := s.fs.Collection(coll).Where("createdAt", ">=", since).OrderBy("createdAt", firestore.Desc).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(snaps))
	for _, sn := range snaps {
		d := sn.Data()
		d["id"], d["collection"] = sn.Ref.ID, coll
		out = append(out, d)
	}
	return out, nil
}
