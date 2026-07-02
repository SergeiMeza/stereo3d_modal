package pricing

import "time"

// maxTime keeps the cached defaults from being refetched during tests.
func maxTime() time.Time { return time.Now().Add(24 * time.Hour) }
