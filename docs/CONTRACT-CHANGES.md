# Contract change requests

Agents never edit shared contracts, the DB schema, lockfiles or `src/core`/`src/app`/`src/api`/`src/shared`.
When one is wrong or incomplete, add an entry under your module heading and work around it locally.
The integrator applies accepted entries after the parallel phase.

Entry format:

```
### <short title>
- File: src/contracts/jobs.ts (or schema, api-types, ...)
- Change: exact proposed signature / column / type
- Why: what breaks or is impossible without it
- Workaround in place: yes/no, where
```

## probe-scan

## rules-ffmpeg

## jobs

## integrations

## bdmv

## web-ui

## platform
