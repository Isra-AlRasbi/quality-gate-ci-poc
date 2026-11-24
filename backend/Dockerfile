# Multi-stage build for the sample backend.
#
# Stage 1 compiles; stage 2 is a `scratch` image containing nothing but the
# static binary — no shell, no package manager, no compiler, so there is almost
# nothing to scan and almost nothing to attack.
#
# The CI container-verification job builds exactly this file with push=false
# (requirement 6).
FROM golang:1.26.11-alpine@sha256:f496f8c537ed506626ee1a6913afb32c45068a48697163c088f604cc775a0c38 AS build

WORKDIR /src

# Dependencies first. This module currently has no third-party requirements, so
# there is no go.sum yet; `go mod download` stays here so that adding one later
# caches correctly instead of busting the layer on every source edit.
COPY go.mod ./
RUN go mod download

COPY . .

# Static build so the final image needs no libc. Version and commit are injected
# by the release workflow for traceability (requirement 10); the defaults keep a
# plain local `docker build .` working.
ARG APP_VERSION=0.0.0-local
ARG GIT_SHA=unknown

RUN CGO_ENABLED=0 GOOS=linux go build \
      -trimpath \
      -ldflags "-s -w -X main.version=${APP_VERSION} -X main.commitSHA=${GIT_SHA}" \
      -o /out/api ./cmd/api

FROM scratch AS runtime

COPY --from=build /out/api /api

# Run as an explicit numeric non-root user. `scratch` has no /etc/passwd entry,
# so the numeric form is the only one that works.
USER 65534:65534

EXPOSE 8080

ENV ADDR=":8080"

# No HEALTHCHECK instruction on purpose: `scratch` has no shell and the binary
# does not implement a -healthcheck flag, so an instruction here would either
# fail to run or report a false "unhealthy". Liveness/readiness is the
# orchestrator's job and is served by GET /healthz and GET /readyz.
ENTRYPOINT ["/api"]
