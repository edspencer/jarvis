# Releasing

JARVIS uses [changesets](https://github.com/changesets/changesets) for versions and the changelog, the same flow as
[Paddock](https://github.com/edspencer/paddock). The package is `private` and never goes to npm. A release publishes:

- a container image, `ghcr.io/edspencer/jarvis:<version>`, also tagged `<major>.<minor>` and `latest`, for linux/amd64
  and linux/arm64: nginx serving the viewer, with the demo house as its site until you mount yours
  ([docs/deploy.md](docs/deploy.md));
- `jarvis-<version>.tgz`, the built viewer (`dist/`), with a SHA-256 checksum, on the GitHub Release `v<version>`, and
  the same as `jarvis-latest.tgz`, so `https://github.com/edspencer/jarvis/releases/latest/download/jarvis-latest.tgz`
  always gets the newest.

## How

1. Pull requests that change something users notice carry a changeset (`npx changeset`).
2. On every push to `main`, the Release workflow (`.github/workflows/release.yml`) opens or updates a pull request,
   **chore: version packages**, which bumps `package.json` and writes `CHANGELOG.md` from the changesets.
3. Merging that pull request is the release. The push changes the version, so the workflow:
   1. waits for CI to pass on that commit (it won't publish from a red commit);
   2. builds and pushes the image to GHCR;
   3. builds `dist/`, makes the tarball, and creates the GitHub Release, which creates the tag `v<version>`.

An ordinary merge to `main` changes no version and releases nothing. To retry a release that failed part-way, fix the
cause, then run the workflow by hand (Actions → Release → Run workflow): it releases the current version if it has no
tag yet.

## Repository settings this needs

- Settings → Actions → General → Workflow permissions: **Allow GitHub Actions to create and approve pull requests**
  (for the version pull request).
- The CI checks on the version pull request: GitHub may hold workflow runs on a pull request opened by
  `github-actions[bot]` for approval. The release still waits for CI on the push to `main`.
- After the first image is published, the GHCR package's visibility (Packages → jarvis → Package settings) is
  private if the repository is private; make it public once the repository is.
