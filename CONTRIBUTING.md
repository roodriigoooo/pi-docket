# Contributing

Thanks for helping improve Trail.

## Local setup

```bash
npm install
npm run check
pi --no-extensions -e ./extensions/trail.ts --mode json --no-session "/trail help"
```

Interactive development:

```bash
pi --no-extensions -e ./extensions/trail.ts
```

## Architecture language

Use these terms in issues and PRs:

- **Module** — anything with an interface and implementation
- **Interface** — everything callers must know to use the module correctly
- **Depth** — leverage at the interface
- **Seam** — where an interface lives
- **Adapter** — concrete thing satisfying an interface at a seam
- **Leverage** — what callers get from depth
- **Locality** — what maintainers get from depth

Trail domain terms:

- **Artifact** — structured object derived from session activity
- **Artifact Catalog** — owns artifact extraction, identity, lookup, references, search, and checkpoint payloads
- **Reference** — compact prompt-safe pointer to an artifact
- **Checkpoint** — distilled continuation package for a fresh session
- **Checkpoint Lifecycle** — owns checkpoint creation flow
- **Navigator** — interactive artifact browser

## PR expectations

- Keep changes surgical.
- Prefer deepening existing modules over adding shallow helpers.
- Add or update smoke tests when command behavior changes.
- Update README when commands, flags, config, or storage changes.
- If introducing a new Trail term, update docs/architecture.md.

## Release checklist

1. `npm run check`
2. `npm run smoke:help`
3. `npm run pack:dry`
4. Update `CHANGELOG.md`
5. Tag release: `git tag v0.1.x`
6. Publish if stable: `npm publish --access public`
