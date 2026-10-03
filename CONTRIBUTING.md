# Contributing

Thanks for your interest in the project. Issues and pull requests are welcome.

## Development setup

Requirements: Node.js 22+, and Docker (or Podman) to build the image.

```bash
# Backend (Express) – http://localhost:8080
cd server && npm install && npm run dev

# Frontend (Vite + React) – http://localhost:5173, proxies /api to 8080
cd web && npm install && npm run dev
```

You can run DynamoDB Local / LocalStack / MinIO to try things without a real AWS account.

## Workflow

1. Fork the repo and create a branch from `main`: `feat/...`, `fix/...`, `docs/...`.
2. Add tests for your change (Vitest; the server uses `supertest` + `aws-sdk-client-mock`, the web app uses Testing Library).
3. Run the tests before opening a PR:

   ```bash
   (cd server && npm test) && (cd web && npm test && npm run build)
   ```

4. Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(s3): ...`, `fix(lambda): ...`, `docs: ...`.
5. Open a pull request and fill in the template checklist. CI must pass.

## Guidelines

- Never commit credentials, the `data/` directory or `.env` files.
- Keep the UI consistent with existing pages; document new features in `README.md` and `DOCKERHUB.md`.
- Security issues: see [SECURITY.md](SECURITY.md).
