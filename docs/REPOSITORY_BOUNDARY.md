# Repository boundary: map facts

`dota-map-coordinates` owns immutable, build-bound map facts. It produces, validates, and publishes map artifacts; it does not expose product APIs, parse replays, or decide player-facing vision results.

## Owned outputs

- `MapManifest` and its hashes: Dota build, VPK/GridNav hashes, renderer revision, world bounds, and coordinate transform.
- Static map facts: terrain, GridNav, compiled FoW blockers, placement triggers, and tile pyramid manifests.
- Reproducible extraction/render/validation commands.

## Consumers

- `dota2Assistance` stores `mapVersion` alongside match analysis records.
- `dota2Assistance_dataMetrix` validates map inputs before running offline prediction or an engine oracle.

## Rules

1. `mapVersion` is the SHA-256 of the canonical JSON form of `MapManifest`.
2. A changed build or input hash creates a new map version; consumers must not silently use `latest`.
3. Game assets and generated tiles are published as versioned artifacts, not copied into consumer repositories.
4. Placement constraints (`trigger_no_wards`) are map facts only. Product legality decisions remain a separate consumer concern.

The initial contract lives in `contracts/v1/map-manifest.schema.json`. Breaking changes require a new `vN` directory.
