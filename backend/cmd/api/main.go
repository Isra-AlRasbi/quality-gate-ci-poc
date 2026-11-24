// Package main is a deliberately small HTTP service. Its only job is to give
// the CI pipeline something real to build, vet, unit test and containerise.
package main

import (
	"log"
	"os"

	"github.com/rihal/quality-gate-poc/backend/internal/gate"
	"github.com/rihal/quality-gate-poc/backend/internal/httpapi"
)

// Build identity. Both values are overridden by the release workflow with
// -ldflags so a running container can name the exact commit it came from
// (requirement 10: traceability).
var (
	version   = "0.0.0-local"
	commitSHA = "unknown"
)

func main() {
	addr := getenv("ADDR", ":8080")
	defaultBranch := getenv("DEFAULT_BRANCH", "main")

	service := gate.NewService(defaultBranch, version, commitSHA)

	log.Printf("quality-gate backend %s (commit %s) listening on %s", version, commitSHA, addr)
	if err := httpapi.Listen(addr, service); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func getenv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok && value != "" {
		return value
	}
	return fallback
}
