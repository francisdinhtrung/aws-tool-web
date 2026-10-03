# Publishing the image to Docker Hub

Image: [`francisdinhtrung/aws-tool-web`](https://hub.docker.com/r/francisdinhtrung/aws-tool-web), multi-arch `linux/amd64` + `linux/arm64`.

The dev machine uses **Podman** (no Docker Desktop). The Docker Hub token is stored in the **macOS Keychain** and read by [scripts/publish.sh](../scripts/publish.sh).

## One-time setup

1. Create a Personal Access Token on Docker Hub: *Account settings → Personal access tokens → Generate*, with **Read & Write** scope.
2. Save the token to the Keychain (the command prompts for the token and does not echo it):

   ```bash
   security add-generic-password -U -a francisdinhtrung -s dockerhub-token -w
   ```

   The first time the script reads the token, macOS may ask for Keychain access: choose **Always Allow**.

3. Install `podman` and `jq` (`brew install podman jq`) and create the VM: `podman machine init`.

## Release steps

### 1. Pick a version (semver)

| Change | Example |
|---|---|
| Bug fix | `1.1.0` → `1.1.1` |
| New feature (e.g. Lambda support) | `1.0.0` → `1.1.0` |
| Breaking change (env, volume, API…) | `1.1.0` → `2.0.0` |

Existing tags:

```bash
curl -s https://hub.docker.com/v2/repositories/francisdinhtrung/aws-tool-web/tags | jq -r '.results[].name'
```

### 2. Run the tests

```bash
cd server && npx vitest run && cd ../web && npx vitest run
```

### 3. Bump the version

```bash
VERSION=1.2.0
(cd server && npm version $VERSION --no-git-tag-version)
(cd web && npm version $VERSION --no-git-tag-version)
```

Update [DOCKERHUB.md](../DOCKERHUB.md) (the Overview page on Docker Hub):

- The tag in the `docker run` and compose examples (`aws-tool-web:<version>`).
- The **Features** section for new features.
- The **Tags** section: add a line for the new version with a short summary.

For major features, also update `SHORT_DESC` in [scripts/publish.sh](../scripts/publish.sh) (100 characters max).

### 4. Build the multi-arch image

```bash
podman machine start          # skip if the VM is already running
VERSION=$(jq -r .version server/package.json)
IMG=docker.io/francisdinhtrung/aws-tool-web:$VERSION
podman manifest rm $IMG 2>/dev/null
podman build --format docker --platform linux/amd64,linux/arm64 --manifest $IMG \
  --label org.opencontainers.image.title="AWS Tool Web" \
  --label org.opencontainers.image.version="$VERSION" \
  --label org.opencontainers.image.description="Self-hosted web UI for AWS: DynamoDB Studio, S3 browser, CloudWatch Logs, SQS, Lambda console" \
  --label org.opencontainers.image.source="https://github.com/francisdinhtrung/aws-tool-web" \
  --label org.opencontainers.image.licenses="MIT" \
  --label org.opencontainers.image.authors="Trung.Vu" \
  .
```

- `--format docker` is required: the OCI format (Podman's default) drops `HEALTHCHECK`.
- `--manifest` combines both architectures under one tag. Building amd64 on Apple silicon runs under emulation, so it is slower.

### 5. Smoke test

```bash
podman run -d --rm --name awt-test -p 127.0.0.1:18080:8080 $IMG
curl -s http://127.0.0.1:18080/api/health     # {"ok":true}
podman stop awt-test
```

### 6. Push and update the description

```bash
./scripts/publish.sh
```

The script:

1. Reads the version from `server/package.json` (or pass it in: `./scripts/publish.sh 1.2.0`).
2. Reads the token from `DOCKERHUB_TOKEN`, falling back to the Keychain.
3. Runs `podman login` and pushes the manifest to the `<version>` and `latest` tags.
4. Calls the Docker Hub API to update the short description (`SHORT_DESC`) and the overview (contents of `DOCKERHUB.md`).

The script **does not build**: run step 4 first, otherwise it fails because the manifest does not exist.

### 7. Verify

```bash
curl -s https://hub.docker.com/v2/repositories/francisdinhtrung/aws-tool-web/tags \
  | jq -r '.results[] | "\(.name) \(.digest) \([.images[].architecture]|join(","))"'
```

`latest` and the new version must share the same digest and include both `amd64,arm64`.

### 8. Tag the release on GitHub

```bash
git tag -a v$VERSION -m "v$VERSION" && git push origin v$VERSION
gh release create v$VERSION --generate-notes
```

## Token management

| Task | Command |
|---|---|
| Replace the token | `security add-generic-password -U -a francisdinhtrung -s dockerhub-token -w` |
| Check the token is in the Keychain | `security find-generic-password -a francisdinhtrung -s dockerhub-token >/dev/null && echo ok` |
| Delete the token | `security delete-generic-password -a francisdinhtrung -s dockerhub-token` |

`podman login` stores credentials in `~/.config/containers/auth.json` as base64 (practically plaintext). For better safety, run `podman logout docker.io` after pushing; the script logs in again from the Keychain next time.

## Troubleshooting

| Error | Fix |
|---|---|
| `Cannot connect to Podman` | `podman machine start` |
| `No token: set DOCKERHUB_TOKEN…` | Token not saved yet: see setup step 2 |
| `unauthorized` on push / 401 from the API | Token expired, revoked or missing Write scope: create a new token and save it again |
| `HEALTHCHECK is not supported for OCI image format` | Missing `--format docker` in the build |
| Push cannot find the image | Step 4 was skipped, or the version in `package.json` differs from the built tag |
