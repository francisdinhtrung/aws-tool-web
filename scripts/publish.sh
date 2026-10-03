#!/usr/bin/env bash
# Push the multi-arch image to Docker Hub and update the repository description.
# Usage: ./scripts/publish.sh [version]
# The Docker Hub personal access token is read from DOCKERHUB_TOKEN, or else from the macOS Keychain:
#   security add-generic-password -U -a francisdinhtrung -s dockerhub-token -w
set -euo pipefail

REPO="francisdinhtrung/aws-tool-web"
VERSION="${1:-$(jq -r .version "$(dirname "$0")/../server/package.json")}"
SHORT_DESC="Self-hosted AWS web UI: DynamoDB Studio, S3 browser, CloudWatch Logs, SQS, Lambda, Step Functions"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="${REPO%%/*}"

if [ -z "${DOCKERHUB_TOKEN:-}" ]; then
  DOCKERHUB_TOKEN=$(security find-generic-password -a "$USER_NAME" -s dockerhub-token -w 2>/dev/null) || {
    echo "No token: set DOCKERHUB_TOKEN or run: security add-generic-password -U -a $USER_NAME -s dockerhub-token -w" >&2
    exit 1
  }
fi

echo "$DOCKERHUB_TOKEN" | podman login docker.io -u "$USER_NAME" --password-stdin

podman manifest push --all "docker.io/$REPO:$VERSION" "docker://docker.io/$REPO:$VERSION"
podman manifest push --all "docker.io/$REPO:$VERSION" "docker://docker.io/$REPO:latest"

JWT=$(curl -fsS -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "$USER_NAME" --arg p "$DOCKERHUB_TOKEN" '{username:$u, password:$p}')" \
  https://hub.docker.com/v2/users/login/ | jq -r .token)

curl -fsS -X PATCH "https://hub.docker.com/v2/repositories/$REPO/" \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg d "$SHORT_DESC" --rawfile f "$ROOT/DOCKERHUB.md" '{description:$d, full_description:$f}')" \
  | jq '{name, description, last_updated}'

echo "Done: https://hub.docker.com/r/$REPO"
