// Package gate holds the domain logic for evaluating quality-gate checks.
//
// It has no HTTP, database or filesystem dependencies, which is what keeps the
// unit tests fast and deterministic.
package gate

import (
	"errors"
	"sort"
	"strings"
	"time"
)

// Status is the outcome of a single CI check.
type Status string

const (
	StatusSuccess Status = "success"
	StatusFailure Status = "failure"
	StatusSkipped Status = "skipped"
	StatusPending Status = "pending"
)

// Component is the part of the repository a check belongs to. It mirrors the
// path filters used by the CI workflows.
type Component string

const (
	ComponentFrontend Component = "frontend"
	ComponentBackend  Component = "backend"
	ComponentShared   Component = "shared"
)

// Check is one CI validation as reported to the frontend dashboard.
type Check struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Component       Component `json:"component"`
	Status          Status    `json:"status"`
	DurationSeconds float64   `json:"durationSeconds"`
}

// Report is the payload served by GET /api/checks.
type Report struct {
	Overall   Status    `json:"overall"`
	Service   string    `json:"service"`
	Version   string    `json:"version"`
	Commit    string    `json:"commit"`
	CheckedAt time.Time `json:"checkedAt"`
	Checks    []Check   `json:"checks"`
}

// ErrEmptyReport guards against reporting a confident result for nothing.
var ErrEmptyReport = errors.New("gate: report contains no checks")

// Service evaluates checks. It is constructed with NewService.
type Service struct {
	defaultBranch string
	version       string
	commit        string
}

// NewService builds a Service. Blank inputs are normalised so callers cannot
// produce a report with empty identity fields.
func NewService(defaultBranch, version, commit string) *Service {
	return &Service{
		defaultBranch: orDefault(defaultBranch, "main"),
		version:       orDefault(version, "0.0.0-local"),
		commit:        orDefault(commit, "unknown"),
	}
}

// DefaultBranch is the branch merges are gated on.
func (s *Service) DefaultBranch() string { return s.defaultBranch }

// Version is the semantic version (or fallback) built into the binary.
func (s *Service) Version() string { return s.version }

// Commit is the git SHA built into the binary.
func (s *Service) Commit() string { return s.commit }

// Evaluate returns the report's overall status, mirroring the rule the
// frontend uses:
//
//	any failure -> failure
//	any pending -> pending
//	otherwise   -> success (skipped checks ran nothing and broke nothing)
//
// An empty set is an error rather than "success": silence is not a green tick.
func (s *Service) Evaluate(checks []Check) (Status, error) {
	if len(checks) == 0 {
		return "", ErrEmptyReport
	}

	overall := StatusSuccess
	for _, check := range checks {
		switch check.Status {
		case StatusFailure:
			return StatusFailure, nil
		case StatusPending:
			overall = StatusPending
		case StatusSuccess, StatusSkipped:
			// Keep the current verdict.
		default:
			// An unrecognised status is treated as pending, never as success.
			overall = StatusPending
		}
	}
	return overall, nil
}

// BuildReport assembles the API payload, including the aggregated verdict.
func (s *Service) BuildReport(checks []Check, checkedAt time.Time) (Report, error) {
	overall, err := s.Evaluate(checks)
	if err != nil {
		return Report{}, err
	}

	normalised := make([]Check, len(checks))
	copy(normalised, checks)
	sortChecks(normalised)

	return Report{
		Overall:   overall,
		Service:   "quality-gate-backend",
		Version:   s.version,
		Commit:    s.commit,
		CheckedAt: checkedAt.UTC(),
		Checks:    normalised,
	}, nil
}

// DefaultChecks is the sample dataset the service serves when it is run
// without a real CI data source.
func (s *Service) DefaultChecks() []Check {
	checks := []Check{
		{ID: "backend-lint", Name: "Vet / static analysis", Component: ComponentBackend, Status: StatusSuccess, DurationSeconds: 6},
		{ID: "backend-test", Name: "Unit tests", Component: ComponentBackend, Status: StatusSuccess, DurationSeconds: 14},
		{ID: "backend-build", Name: "Build", Component: ComponentBackend, Status: StatusSuccess, DurationSeconds: 18},
		{ID: "frontend-lint", Name: "Lint", Component: ComponentFrontend, Status: StatusSuccess, DurationSeconds: 11},
		{ID: "frontend-typecheck", Name: "Type check", Component: ComponentFrontend, Status: StatusPending, DurationSeconds: 0},
		{ID: "security-audit", Name: "Dependency audit", Component: ComponentShared, Status: StatusSuccess, DurationSeconds: 9},
	}
	sortChecks(checks)
	return checks
}

// ParseCheckIDs splits a comma-separated list, trimming whitespace and
// dropping blanks. Returns nil for empty input.
func ParseCheckIDs(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	parts := strings.Split(raw, ",")
	ids := make([]string, 0, len(parts))
	for _, part := range parts {
		if id := strings.TrimSpace(part); id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	return ids
}

// FilterByComponent narrows a check set to one component. An empty component
// returns everything, which is what a shared-config change needs.
func FilterByComponent(checks []Check, component Component) []Check {
	if component == "" {
		out := make([]Check, len(checks))
		copy(out, checks)
		return out
	}

	out := make([]Check, 0, len(checks))
	for _, check := range checks {
		if check.Component == component {
			out = append(out, check)
		}
	}
	return out
}

// sortChecks orders by component then ID so API responses are byte-stable and
// diffs stay readable.
func sortChecks(checks []Check) {
	sort.SliceStable(checks, func(i, j int) bool {
		if checks[i].Component != checks[j].Component {
			return checks[i].Component < checks[j].Component
		}
		return checks[i].ID < checks[j].ID
	})
}

func orDefault(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
