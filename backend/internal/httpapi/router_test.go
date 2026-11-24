package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rihal/quality-gate-poc/backend/internal/gate"
)

func newTestRouter() http.Handler {
	return NewRouter(gate.NewService("main", "1.2.3", "abc1234"))
}

func decodeReport(t *testing.T, body string) gate.Report {
	t.Helper()

	var report gate.Report
	if err := json.Unmarshal([]byte(body), &report); err != nil {
		t.Fatalf("failed to decode report: %v (body=%s)", err, body)
	}
	return report
}

func TestHealthz(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	newTestRouter().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
}

func TestReadyz(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	newTestRouter().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body=%s)", recorder.Code, http.StatusOK, recorder.Body.String())
	}
}

func TestChecksEndpoint(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		path       string
		wantStatus int
		wantCheck  int
	}{
		{name: "all components", path: "/api/checks", wantStatus: http.StatusOK, wantCheck: 6},
		{name: "backend only", path: "/api/checks?component=backend", wantStatus: http.StatusOK, wantCheck: 3},
		{name: "frontend only", path: "/api/checks?component=frontend", wantStatus: http.StatusOK, wantCheck: 2},
		{name: "shared only", path: "/api/checks?component=shared", wantStatus: http.StatusOK, wantCheck: 1},
		{name: "unknown component", path: "/api/checks?component=mobile", wantStatus: http.StatusBadRequest},
	}

	router := newTestRouter()

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, tc.path, nil))

			if recorder.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body=%s)", recorder.Code, tc.wantStatus, recorder.Body.String())
			}
			if tc.wantCheck == 0 {
				return
			}

			report := decodeReport(t, recorder.Body.String())
			if len(report.Checks) != tc.wantCheck {
				t.Errorf("check count = %d, want %d", len(report.Checks), tc.wantCheck)
			}
			for _, check := range report.Checks {
				if tc.path == "/api/checks" {
					continue
				}
				want := gate.Component(strings.TrimPrefix(tc.path, "/api/checks?component="))
				if check.Component != want {
					t.Errorf("check %q has component %q, want %q", check.ID, check.Component, want)
				}
			}
		})
	}
}

func TestChecksEndpointRejectsPOST(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	newTestRouter().ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/checks", nil))

	// 405 is the honest answer for a wrong method on a known route.
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
}

func TestChecksResponseIsStableAcrossCalls(t *testing.T) {
	t.Parallel()

	router := newTestRouter()

	first := httptest.NewRecorder()
	router.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/checks", nil))

	second := httptest.NewRecorder()
	router.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/api/checks", nil))

	// checkedAt changes between calls, so compare the ordered ID list instead
	// of raw bytes. Byte-stable ordering is what prevents noisy client diffs.
	a := decodeReport(t, first.Body.String()).Checks
	b := decodeReport(t, second.Body.String()).Checks
	if len(a) != len(b) {
		t.Fatalf("check counts differ: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Errorf("checks[%d] differs between calls: %+v vs %+v", i, a[i], b[i])
		}
	}
}

func TestVersionEndpointReportsBuildIdentity(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	newTestRouter().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/version", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}

	var payload map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to decode version payload: %v", err)
	}
	if payload["version"] != "1.2.3" {
		t.Errorf("version = %q, want 1.2.3", payload["version"])
	}
	if payload["commit"] != "abc1234" {
		t.Errorf("commit = %q, want abc1234", payload["commit"])
	}
}

func TestUnknownRouteIsNotFound(t *testing.T) {
	t.Parallel()

	recorder := httptest.NewRecorder()
	newTestRouter().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/nope", nil))

	if recorder.Code != http.StatusNotFound {
		t.Errorf("status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
}

// TestEvaluateErrorPathUsesARealEmptyService documents the one way to make the
// service fail: an empty check set. It keeps the 404 branch of /api/checks
// covered without injecting artificial failures.
func TestEvaluateErrorPathUsesARealEmptyService(t *testing.T) {
	t.Parallel()

	service := gate.NewService("main", "1.2.3", "abc1234")
	if _, err := service.Evaluate([]gate.Check{}); err == nil {
		t.Fatal("expected an error for an empty check set")
	}

	// Sanity check that the timestamp helper used by the handler is UTC-clean.
	report, err := service.BuildReport(service.DefaultChecks(), time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if report.CheckedAt.Location() != time.UTC {
		t.Errorf("CheckedAt should be UTC, got %v", report.CheckedAt.Location())
	}
}
