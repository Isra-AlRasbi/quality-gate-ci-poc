# Multi-stage build for the sample frontend.
#
# Stage 1 builds with Node; stage 2 serves static files with nginx. Neither the
# Node toolchain nor node_modules reaches the final image.
#
# The CI container-verification job builds exactly this file with push=false
# (requirement 6).
FROM node:22.21.1-alpine@sha256:eefb407f08684593068a61d76c3336fb418bdfd184357ccfe448aadfa1147b3e AS build

WORKDIR /app

# npm ci from the lockfile, so the image is built from the dependency graph under review
# rather than a freshly resolved one. What that does and does not guarantee, measured on
# npm 10.9.8 rather than assumed: it refuses when package.json needs a version the lockfile
# lacks, when the lockfile is missing or truncated, and when a stored integrity hash does
# not match the downloaded tarball. It does NOT reject a bogus `lockfileVersion`.
#
# It *does* obey the `resolved` URL, though, and npm's default policy will fetch from a host
# a tampered lockfile names. `.npmrc` sets replace-registry-host=always to close that, and
# must therefore be copied BEFORE this run -- a config file arriving with `COPY . .` two
# lines later would be present for the build and absent for the install, which is the worst
# order: the protected step is the unprotected one. Full measurement in
# docs/security-baseline.md.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

COPY . .

# Build provenance for traceability (requirement 10). Defaults keep a plain local
# `docker build .` working; the release workflow overrides both. These are baked
# into the bundle, so `view-source` on a deployed page names its commit.
ARG APP_VERSION=0.0.0-local
ARG GIT_SHA=unknown
ENV VITE_APP_VERSION=${APP_VERSION}
ENV VITE_GIT_SHA=${GIT_SHA}

# `npm run build` runs only Vite. Lint, type checking and tests have already run
# as their own CI steps; repeating them here would double the job time and make it
# unclear which stage failed.
RUN npm run build

FROM nginx:1.29.8-alpine@sha256:3bcf852aed06467cf075c6105892e4d5a6ebbbafa0ce22d35062db9e90ddef4c AS runtime

# The nginx entrypoint runs envsubst over /etc/nginx/templates/*.template into
# /etc/nginx/conf.d/, which is the supported way to make the config depend on a
# run-time value. It also deletes the stock default.conf, so this image has exactly
# one server block.
COPY --chown=nginx:nginx nginx.conf.template /etc/nginx/templates/default.conf.template

COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html

# Default backend hostname on a Docker user-defined network. Override at run time
# with -e API_UPSTREAM=<host> to point the same image at a different backend.
ENV API_UPSTREAM=backend

EXPOSE 8080

# KNOWN LIMITATION, deliberately not half-fixed here.
# The upstream nginx image runs its master process as root and drops privileges for
# workers. Making this fully rootless means switching to nginxinc/nginx-unprivileged
# and adjusting the pid/temp paths; doing it as a side effect of a CI-focused PR is
# how you ship a subtly broken web server. Tracked in docs/extending-the-gate.md.
CMD ["nginx", "-g", "daemon off;"]
