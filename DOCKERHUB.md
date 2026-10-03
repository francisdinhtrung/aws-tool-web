# AWS Tool Web

Self-hosted web UI for everyday AWS work, running in a single container:

- **DynamoDB Studio** – a browser-based replacement for Amazon DynamoDB NoSQL Workbench
- **S3 browser** – file-manager style bucket/object explorer
- **CloudWatch Logs** – log viewer, live tail and Logs Insights
- **SQS** – queue manager (send, poll, DLQ redrive)
- **Lambda** – function console (inline code editor, test events, metrics, configuration, triggers, versions & aliases, function URLs)
- **AWS profile manager** – edit `~/.aws/config` and `~/.aws/credentials` from the UI

Works with real AWS accounts as well as DynamoDB Local, LocalStack, MinIO and ElasticMQ.

Source code, issues and docs: https://github.com/francisdinhtrung/aws-tool-web

## Quick start

```bash
docker run -d --name aws-tool-web \
  -p 127.0.0.1:8080:8080 \
  -v ~/.aws:/root/.aws \
  -v aws-tool-web-data:/data \
  francisdinhtrung/aws-tool-web:1.1.0
```

Open http://localhost:8080

Mount `~/.aws` read-only (`-v ~/.aws:/root/.aws:ro`) if you don't want the app to edit your profiles. When it does write, the previous file is backed up as `*.bak`.

### Docker Compose (with DynamoDB Local)

```yaml
services:
  aws-tool-web:
    image: francisdinhtrung/aws-tool-web:1.1.0
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ~/.aws:/root/.aws
      - aws-tool-web-data:/data
    environment:
      DEFAULT_ENDPOINTS: "DynamoDB Local=http://dynamodb-local:8000"
  dynamodb-local:
    image: amazon/dynamodb-local
volumes:
  aws-tool-web-data:
```

## Features

| Area | What you get |
|---|---|
| Connections | Create/edit/rename/delete AWS profiles (access keys, SSO, assume role, credential_process). Custom endpoints (DynamoDB Local, LocalStack). Default credential chain (env vars, EC2/ECS role). Connection test. |
| DynamoDB tables | Create tables (GSI, LSI, on-demand/provisioned, streams, table class, deletion protection), delete, overview, settings (capacity, TTL, PITR, tags, backups). |
| Explore items | Scan/Query on table, GSI, LSI with filters, projection, paging, consumed RCU. Create/edit/clone/delete items (form, DynamoDB JSON or plain JSON). Bulk delete. Export CSV/JSON. |
| Operation builder | All item, batch, transaction and PartiQL operations, with code generation for **Python (boto3)**, **JavaScript (SDK v3)** and **AWS CLI**. |
| PartiQL editor | Single, batch and transaction statements, history, export. |
| Import / Export | CSV, JSON, DynamoDB JSON, JSON lines; batch write with retry. |
| Data modeler & Visualizer | Workbench-compatible models (import/export NoSQL Workbench `.json`), facets, sample data, commit to DynamoDB, export CloudFormation. Aggregate view by partition key / GSI. |
| S3 browser | Buckets, folders, drag & drop upload (multipart), download, copy/move/rename, preview (image, video, audio, PDF, text), edit text files, metadata, tags, versions, pre-signed URLs, bucket policy/CORS/lifecycle. |
| CloudWatch Logs | Log groups, filter patterns, time ranges, histogram, level highlighting, JSON view, context lines, live tail, export, shareable URLs, Logs Insights with saved queries and charts. |
| SQS | Standard/FIFO queues, send/poll/delete messages, purge, settings, DLQ redrive, access policy, tags. |
| Lambda | Create functions (inline starter code, .zip, S3, container image; pick or create the execution role). Browse, edit and deploy the code package in the browser. Test events with templates, sync/async invoke, response, log tail and REPORT stats. CloudWatch metrics and recent invocations. Memory, timeout, /tmp, runtime, handler, env vars, layers, VPC, logging, X-Ray, DLQ. Event source mappings, resource policy, versions, weighted aliases, function URLs (CORS), reserved/provisioned concurrency, async destinations, tags. Layers. |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `AWS_DIR` | `/root/.aws` | Directory containing `config` and `credentials` |
| `DATA_DIR` | `/data` | Where connections and data models are stored (mount a volume) |
| `DEFAULT_ENDPOINTS` | | Comma-separated `Name=URL` endpoints created on first start |
| `APP_USERNAME` / `APP_PASSWORD` | `admin` / (empty) | Set `APP_PASSWORD` to enable HTTP Basic Auth |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Allowed hostnames (DNS-rebinding protection). `*` allows all |

## Security

Anyone who can reach this app has the full permissions of the AWS credentials it can read.

- Bind to `127.0.0.1` (as in the examples above). If you expose it on a server, set `APP_PASSWORD`, add your hostname to `ALLOWED_HOSTS` and put it behind HTTPS.
- Secret keys are never sent to the browser.
- All mutating API calls require an `X-Requested-With` header (CSRF protection).

## Notes

- **SSO**: run `aws sso login --profile <name>` on the host; the container reuses the token cache in `~/.aws/sso/cache`.
- **MFA** prompts and `credential_process` binaries missing from the container are not supported; use temporary credentials or SSO.
- **DynamoDB Local on the host**: use endpoint `http://host.docker.internal:8000`.

## Tags

- `1.1.0`, `latest` – adds the Lambda console. Multi-arch: `linux/amd64`, `linux/arm64`
- `1.0.0` – DynamoDB, S3, CloudWatch Logs, SQS

License: MIT. Developed by Trung.Vu
