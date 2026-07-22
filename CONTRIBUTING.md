# Contributing

Thanks for helping improve Docket.

## Local setup

```bash
npm install
npm run check
pi --no-extensions -e ./extensions/docket.ts --mode json --no-session "/docket help"
```

Interactive development:

```bash
pi --no-extensions -e ./extensions/docket.ts
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

Docket domain terms:

- **Artifact** — structured object derived from session activity
- **Artifact Catalog** — owns artifact extraction, identity, lookup, references, and search
- **Reference** — compact prompt-safe pointer to an artifact
- **Deliverable** — immutable body plus outcome, evidence, refs, approval, review history, and source provenance
- **Deliverable Store** — owns atomic durable records under `~/.pi/agent/docket/deliverables`; it never mutates a claimed version
- **Deliverable Lifecycle** — owns approved-worker copying and explicit parent authoring; legacy bundle code is compatibility-only and cannot create or convert bundles
- **Navigator** — interactive artifact browser

## PR expectations

- Keep changes surgical.
- Prefer deepening existing modules over adding shallow helpers.
- Add or update smoke tests when command behavior changes.
- Update README when commands, flags, config, or storage changes.
- If introducing a new Docket term, update docs/architecture.md.

## Release checklist

1. `npm run check`
2. `npm run smoke:help`
3. `npm run pack:dry`
4. Update `CHANGELOG.md`
5. For releases with dedicated notes, add `docs/releases/<version>.md`
6. Tag release: `git tag v0.4.x`
7. Publish if stable: `npm publish --access public`
