// Package httpapi exposes the gate service over HTTP using only the standard
// library. Zero third-party dependencies keeps `go vet`, `go test` and the
// dependency audit cheap and easy to reason about.
package httpapi

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/rihal/quality-gate-poc/backend/internal/gate"
)

// NewRouter wires the endpoints and returns a plain *http.Handler so tests can
// exercise it with httptest and no network access.
func NewRouter(service *gate.Service) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// Readiness is deliberately separate from liveness: a process can be up
	// and still not be able to answer the question callers care about.
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if _, err := service.Evaluate(service.DefaultChecks()); err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	mux.HandleFunc("GET /api/checks", func(w http.ResponseWriter, r *http.Request) {
		component := gate.Component(r.URL.Query().Get("component"))

		known := map[gate.Component]bool{
			"":                     true,
			gate.ComponentFrontend: true,
			gate.ComponentBackend:  true,
			gate.ComponentShared:   true,
		}
		if !known[component] {
			writeError(w, http.StatusBadRequest, "unknown component: use frontend, backend or shared")
			return
		}

		checks := gate.FilterByComponent(service.DefaultChecks(), component)
		report, err := service.BuildReport(checks, time.Now())
		if err != nil {
			// No checks matched the filter: a 404 with a reason beats a
			// fabricated "success".
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, report)
	})

	mux.HandleFunc("GET /api/version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"service": "quality-gate-backend",
			"version": service.Version(),
			"commit":  service.Commit(),
		})
	})

	return withCommonMiddleware(mux)
}

// Listen starts the server and blocks until it fails or is shut down.
func Listen(addr string, service *gate.Service) error {
	server := &http.Server{
		Addr:              addr,
		Handler:           NewRouter(service),
		ReadHeaderTimeout: 5 * time.Second,
	}
	return server.ListenAndServe()
}

func withCommonMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)

		// Health probes are hit constantly by containers and by the frontend
		// dev proxy; logging them would drown out the requests that matter.
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			return
		}

		// Structured enough to grep, cheap enough to leave on in CI.
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Microsecond))
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("failed to encode response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
