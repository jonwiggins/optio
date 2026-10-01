# Contributing to Optio

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

### Prerequisites

- **Node.js 22+**
- **pnpm 10+** (`npm install -g pnpm`)
- **Docker Desktop** with Kubernetes enabled

### Quick Start

```bash
git clone https://github.com/jonwiggins/optio.git
cd optio
pnpm install

# Start Kubernetes infrastructure
./scripts/setup-local.sh

# Start dev servers (API + Web)
pnpm dev
```

The API runs on http://localhost:4000 and the web UI on http://localhost:3000.

### Building the Agent Image

```bash
docker build -t optio-agent:latest -f Dockerfile.agent .
# Load into K8s containerd (Docker Desktop)
docker save optio-agent:latest | docker exec -i desktop-control-plane ctr -n k8s.io image import --digests -
```

## Project Structure

```
apps/api/     Fastify API server + BullMQ workers
apps/web/     Next.js web UI
packages/     Shared libraries (types, runtime, adapters, providers)
helm/         Production Helm charts
images/       Agent container Dockerfiles
k8s/          Local dev K8s manifests
```

## Development Workflow

### Commands

```bash
pnpm dev              # Start API + Web with hot reload
pnpm turbo typecheck  # Typecheck all packages
pnpm turbo test       # Run tests
pnpm format           # Format with Prettier
pnpm lint             # Lint with ESLint
```

### Database Changes

```bash
# Edit apps/api/src/db/schema.ts, then write the SQL in a new
# apps/api/src/db/migrations/<unix-timestamp>_<name>.sql and add it to
# migrations/meta/_journal.json (the drizzle-kit snapshots stopped at 0012).
cd apps/api && pnpm db:migrate           # Apply migrations (the same migrator the API runs at boot)
```

### Adding a New API Route

1. Create the route handler in `apps/api/src/routes/`
2. Register it in `apps/api/src/server.ts`
3. Add the API client method in `apps/web/src/lib/api-client.ts`

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/). Commit messages are enforced by commitlint.

```
feat: add new feature
fix: fix a bug
docs: documentation changes
style: formatting, no code change
refactor: code change that neither fixes nor adds
perf: performance improvement
test: add or update tests
build: build system or dependencies
ci: CI configuration
chore: maintenance
```

## Pull Requests

1. Fork the repo and create a feature branch
2. Make your changes with tests
3. Ensure `pnpm turbo typecheck` and `pnpm turbo test` pass
4. Submit a PR using the template
5. Wait for CI to pass and a maintainer review

## Code Style

- TypeScript with strict mode
- ESM modules (`.js` extensions in imports)
- Prettier for formatting (runs on commit via Husky)
- Tailwind CSS v4 for styling
- Zustand for client state
- Zod for API validation
- Drizzle ORM for database

## License

MIT — see [LICENSE](./LICENSE)
