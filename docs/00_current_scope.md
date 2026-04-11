# Current active product scope

This repository has been cleaned to match the currently active product surface.

## Frontend routes
- `/` — dashboard
- `/signals` — short signals page
- `/execution` — execution shell with local browser settings only

## Active frontend transports
- WebSocket `/ws` for live rows, events, stream state, and session runtime state
- HTTP only for:
  - session control (`start/stop/pause/resume`)
  - runtime config load/save
  - manual test order submit

## Backend HTTP routes kept
- `GET /health`
- `POST /api/admin/shutdown`
- `GET /api/session/status`
- `POST /api/session/start`
- `POST /api/session/stop`
- `POST /api/session/pause`
- `POST /api/session/resume`
- `GET /api/process/status`
- `GET /api/config`
- `POST /api/config`
- `POST /api/manual-test-order`

## Cleanup policy applied
- removed unreachable frontend pages, features, tests, and legacy API wrappers
- removed backend source files unreachable from `backend/src/index.ts`
- removed legacy docs and replaced them with this minimal active-scope note
- removed IDE and local helper clutter not tied to the active product
