# Security Policy

AWS Tool Web runs with the permissions of the AWS credentials mounted into the container, so any vulnerability can affect your AWS account.

## Reporting a vulnerability

**Please do not open a public issue.** Use [GitHub private vulnerability reporting](https://github.com/francisdinhtrung/aws-tool-web/security/advisories/new) and include:

- Version / image tag
- Steps to reproduce and impact
- Suggested fix (if any)

You will get a response within 7 days.

## Supported versions

Only the latest release (`latest`) receives security fixes.

## Deployment recommendations

- Bind the port to `127.0.0.1` (the default in `docker-compose.yml`); do not expose it to the Internet.
- If you need access from other machines: set `APP_USERNAME` / `APP_PASSWORD` and `ALLOWED_HOSTS`, and put the app behind a reverse proxy with HTTPS.
- Use an IAM user/role with least privilege; mount `~/.aws` with `:ro` if you don't need to edit profiles.
