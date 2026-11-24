package gate

import (
	"errors"
	"testing"
	"time"
)

func newTestService() *Service {
	return NewService("main", "1.2.3", "abc1234")
}

func check(id string, component Component, status Status) Check {
	return Check{ID: id, Name: id, Component: component, Status: status, DurationSeconds: 1}
}

func TestEvaluate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		checks  []Check
		want    Status
		wantErr error
	}{
		{
			name:   "all checks succeed",
			checks: []Check{check("a", ComponentBackend, StatusSuccess), check("b", ComponentFrontend, StatusSuccess)},
			want:   StatusSuccess,
		},
		{
			name:   "one failure dominates",
			checks: []Check{check("a", ComponentBackend, StatusSuccess), check("b", ComponentBackend, StatusFailure)},
			want:   StatusFailure,
		},
		{
			name:   "pending beats success",
			checks: []Check{check("a", ComponentBackend, StatusSuccess), check("b", ComponentBackend, StatusPending)},
			want:   StatusPending,
		},
		{
			name:   "failure beats pending",
			checks: []Check{check("a", ComponentBackend, StatusPending), check("b", ComponentBackend, StatusFailure)},
			want:   StatusFailure,
		},
		{
			name:   "skipped checks are harmless",
			checks: []Check{check("a", ComponentBackend, StatusSuccess), check("b", ComponentFrontend, StatusSkipped)},
			want:   StatusSuccess,
		},
		{
			name:   "all skipped is still a pass",
			checks: []Check{check("a", ComponentFrontend, StatusSkipped)},
			want:   StatusSuccess,
		},
		{
			name:   "unknown status is never treated as success",
			checks: []Check{check("a", ComponentBackend, Status("exploded"))},
			want:   StatusPending,
		},
		{
			name:    "an empty report is an error, not a green tick",
			checks:  nil,
			wantErr: ErrEmptyReport,
		},
	}

	service := newTestService()

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got, err := service.Evaluate(tc.checks)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("Evaluate() error = %v, want %v", err, tc.wantErr)
			}
			if got != tc.want {
				t.Errorf("Evaluate() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBuildReport(t *testing.T) {
	t.Parallel()

	service := newTestService()
	checkedAt := time.Date(2026, time.November, 24, 9, 30, 0, 0, time.FixedZone("UTC+3", 3*60*60))

	checks := []Check{
		check("frontend-build", ComponentFrontend, StatusSuccess),
		check("backend-lint", ComponentBackend, StatusFailure),
		check("backend-test", ComponentBackend, StatusSuccess),
	}

	report, err := service.BuildReport(checks, checkedAt)
	if err != nil {
		t.Fatalf("BuildReport() unexpected error: %v", err)
	}

	if report.Overall != StatusFailure {
		t.Errorf("Overall = %q, want %q", report.Overall, StatusFailure)
	}
	if report.Version != "1.2.3" || report.Commit != "abc1234" {
		t.Errorf("identity = %q/%q, want 1.2.3/abc1234", report.Version, report.Commit)
	}
	if !report.CheckedAt.Equal(checkedAt) {
		t.Errorf("CheckedAt = %v, want %v", report.CheckedAt, checkedAt)
	}
	if report.CheckedAt.Location() != time.UTC {
		t.Errorf("CheckedAt should be normalised to UTC, got %v", report.CheckedAt.Location())
	}

	gotIDs := make([]string, 0, len(report.Checks))
	for _, c := range report.Checks {
		gotIDs = append(gotIDs, c.ID)
	}
	wantIDs := []string{"backend-lint", "backend-test", "frontend-build"}
	if len(gotIDs) != len(wantIDs) {
		t.Fatalf("check count = %d, want %d", len(gotIDs), len(wantIDs))
	}
	for i := range wantIDs {
		if gotIDs[i] != wantIDs[i] {
			t.Errorf("checks[%d].ID = %q, want %q", i, gotIDs[i], wantIDs[i])
		}
	}
}

func TestBuildReportDoesNotMutateInput(t *testing.T) {
	t.Parallel()

	service := newTestService()
	checks := []Check{
		check("frontend-build", ComponentFrontend, StatusSuccess),
		check("backend-lint", ComponentBackend, StatusSuccess),
	}

	if _, err := service.BuildReport(checks, time.Now()); err != nil {
		t.Fatalf("BuildReport() unexpected error: %v", err)
	}

	if checks[0].ID != "frontend-build" || checks[1].ID != "backend-lint" {
		t.Errorf("BuildReport() mutated the caller's slice: %v", checks)
	}
}

func TestBuildReportRejectsEmptyCheckSet(t *testing.T) {
	t.Parallel()

	service := newTestService()
	if _, err := service.BuildReport(nil, time.Now()); !errors.Is(err, ErrEmptyReport) {
		t.Fatalf("BuildReport() error = %v, want %v", err, ErrEmptyReport)
	}
}

func TestNewServiceNormalisesBlankIdentity(t *testing.T) {
	t.Parallel()

	service := NewService("  ", "", "")

	if service.DefaultBranch() != "main" {
		t.Errorf("DefaultBranch() = %q, want main", service.DefaultBranch())
	}
	if service.Version() != "0.0.0-local" {
		t.Errorf("Version() = %q, want 0.0.0-local", service.Version())
	}
	if service.Commit() != "unknown" {
		t.Errorf("Commit() = %q, want unknown", service.Commit())
	}
}

func TestParseCheckIDs(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  string
		want []string
	}{
		{name: "empty", raw: "", want: nil},
		{name: "whitespace only", raw: "   ", want: nil},
		{name: "single", raw: "backend-test", want: []string{"backend-test"}},
		{name: "trims and drops blanks", raw: " a , , b ,, c ", want: []string{"a", "b", "c"}},
		{name: "commas only", raw: ",,,", want: nil},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := ParseCheckIDs(tc.raw)
			if len(got) != len(tc.want) {
				t.Fatalf("ParseCheckIDs(%q) = %v, want %v", tc.raw, got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("ParseCheckIDs(%q)[%d] = %q, want %q", tc.raw, i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestFilterByComponent(t *testing.T) {
	t.Parallel()

	all := []Check{
		check("a", ComponentFrontend, StatusSuccess),
		check("b", ComponentBackend, StatusSuccess),
		check("c", ComponentShared, StatusSuccess),
	}

	t.Run("empty component returns everything", func(t *testing.T) {
		t.Parallel()
		if got := FilterByComponent(all, ""); len(got) != 3 {
			t.Errorf("FilterByComponent(_, \"\") returned %d checks, want 3", len(got))
		}
	})

	t.Run("filters to one component", func(t *testing.T) {
		t.Parallel()
		got := FilterByComponent(all, ComponentBackend)
		if len(got) != 1 || got[0].ID != "b" {
			t.Errorf("FilterByComponent(_, backend) = %v, want [b]", got)
		}
	})

	t.Run("unknown component returns empty", func(t *testing.T) {
		t.Parallel()
		if got := FilterByComponent(all, Component("mobile")); len(got) != 0 {
			t.Errorf("FilterByComponent(_, mobile) = %v, want none", got)
		}
	})

	t.Run("does not mutate the source slice", func(t *testing.T) {
		t.Parallel()
		_ = FilterByComponent(all, ComponentFrontend)
		if len(all) != 3 {
			t.Errorf("source slice changed length to %d, want 3", len(all))
		}
	})
}

func TestDefaultChecksProduceAValidReport(t *testing.T) {
	t.Parallel()

	service := newTestService()
	report, err := service.BuildReport(service.DefaultChecks(), time.Unix(1764000000, 0))
	if err != nil {
		t.Fatalf("BuildReport() unexpected error: %v", err)
	}

	// The sample dataset intentionally contains a pending check, so the
	// aggregated verdict must not be a premature success.
	if report.Overall == StatusSuccess {
		t.Error("DefaultChecks() includes a pending check; overall must not be success")
	}
	if report.Overall != StatusPending {
		t.Errorf("Overall = %q, want %q", report.Overall, StatusPending)
	}
}
