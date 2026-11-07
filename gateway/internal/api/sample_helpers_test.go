package api

import "time"

// sampleSince is when onboarding shipped (2026-11-04 03:00 UTC); the
// sample no longer depends on it (owner 2026-11-07), tests keep it for
// accounts' ages.
var sampleSince = time.Date(2026, 11, 4, 3, 0, 0, 0, time.UTC)
