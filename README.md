# AWS Tool Web

[![CI](https://github.com/francisdinhtrung/aws-tool-web/actions/workflows/ci.yml/badge.svg)](https://github.com/francisdinhtrung/aws-tool-web/actions/workflows/ci.yml)
[![Docker Image Version](https://img.shields.io/docker/v/francisdinhtrung/aws-tool-web?sort=semver&label=docker)](https://hub.docker.com/r/francisdinhtrung/aws-tool-web)
[![Docker Pulls](https://img.shields.io/docker/pulls/francisdinhtrung/aws-tool-web)](https://hub.docker.com/r/francisdinhtrung/aws-tool-web)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A self-hosted web console for everyday AWS work, running in a single Docker container:

- **DynamoDB Studio** – a browser-based replacement for Amazon DynamoDB NoSQL Workbench: explore and edit data, Operation builder with code generation, PartiQL, Data modeler (compatible with Workbench model files)
- **S3 browser** – file-manager style bucket and object explorer
- **CloudWatch Logs** – search, live tail and Logs Insights
- **SQS** – queue manager (send, poll, DLQ redrive)
- **Lambda** – function console (inline code editor, test events, metrics, configuration, triggers, versions and aliases, function URLs)
- **Step Functions** – workflow console (definition editor with a live graph, executions with a state-by-state view, single-state testing, versions and aliases)
- **AWS profile manager** – edit `~/.aws/config` and `~/.aws/credentials` from the UI

Works with real AWS accounts as well as DynamoDB Local, LocalStack, MinIO, ElasticMQ and Step Functions Local.

## Quick start

From Docker Hub:

```bash
docker run -d --name aws-tool-web \
  -p 127.0.0.1:8080:8080 \
  -v ~/.aws:/root/.aws \
  -v aws-tool-web-data:/data \
  francisdinhtrung/aws-tool-web:latest
```

From source, with DynamoDB Local:

```bash
docker compose up -d --build
```

Open http://localhost:8080

- `~/.aws` is mounted read-write, so profiles created or edited in the UI are written straight to `~/.aws/config` and `~/.aws/credentials`. The previous file is backed up as `*.bak` before every write. Mount it with `:ro` to keep profiles read-only.
- The compose file includes a DynamoDB Local service (`http://dynamodb-local:8000`); a connection to it is created on first start.
- Run the app without DynamoDB Local: `docker compose up -d aws-tool-web`

### Windows portable (no Docker, no install)

Download `aws-tool-web-<version>-win-x64.zip` from [Releases](https://github.com/francisdinhtrung/aws-tool-web/releases), extract it anywhere (a USB drive works too) and double-click `AWS Tool Web.cmd`. Node.js is bundled, so nothing has to be installed.

- The app listens on `127.0.0.1:8080` and opens in the default browser; close the console window to stop it.
- Profiles are read from and written to `%USERPROFILE%\.aws`; connections and data models live in the `data` folder next to the launcher.
- Change settings by setting [environment variables](#environment-variables) before starting, e.g. `set PORT=9090`.
- Build the zip yourself (macOS, Linux or Git Bash): `./scripts/build-windows-portable.sh` writes it to `release/`.

## Features

| Area | What you can do |
|---|---|
| Connections | List, create, edit, rename and delete AWS profiles: access keys, SSO, assume role, credential_process, arbitrary extra settings. Comments and nested blocks in the config file are preserved. Custom endpoints (DynamoDB Local, LocalStack). Default credential chain (environment variables / EC2 or ECS IAM role). Connection test (STS GetCallerIdentity + ListTables). Region picker. |
| Tables | List, filter and create tables (GSI, LSI, on-demand or provisioned, table class, streams, deletion protection). Delete tables. Table overview. |
| Explore items | Scan and Query (on the table, a GSI or an LSI); sort key conditions; filters (=, ≠, <, between, begins_with, contains, exists, IN, attribute_type, size); projection; pagination; strongly consistent reads; consumed RCU. Create, edit, duplicate and delete items (typed form, DynamoDB JSON or plain JSON). Bulk delete. Table or JSON view. Export CSV/JSON. Code generation. |
| Indexes | Create and delete GSIs on existing tables. |
| Settings | Capacity mode, RCU/WCU, TTL, Streams, PITR, deletion protection, table class, tags, on-demand backups (create, restore, delete). |
| Visualizer | Workbench-style aggregate view: group by partition key, view by GSI, color by entity type (sort key prefix or an attribute), facet views. |
| Import / Export | Export a whole table to CSV, JSON, DynamoDB JSON or JSON lines. Import from CSV (headers may carry a type, e.g. `price (N)`) or JSON; batch writes with retry. Delete all items. |
| Operation builder | GetItem, PutItem, UpdateItem (SET, REMOVE, ADD, DELETE, increment, list_append, if_not_exists), DeleteItem, Query, Scan, BatchGetItem, BatchWriteItem, TransactGetItems, TransactWriteItems, ExecuteStatement, BatchExecuteStatement, ExecuteTransaction. Condition expressions and ReturnValues; edit the request JSON directly. Generates **Python (boto3)**, **JavaScript (SDK v3)** and **AWS CLI** code. |
| PartiQL editor | Run single statements, batches or transactions; NextToken pagination; history; export results. |
| S3 browser | Buckets in the sidebar; create buckets (region, versioning) and delete them (optionally emptying objects and versions first). Browse objects like a file manager: breadcrumbs, type an `s3://bucket/prefix` path, sort, filter, paginate (Load more / Load all). Upload files and whole folders (button or drag and drop), multipart for large files, a Tasks queue with progress and cancel. Download (multiple files, whole folders), create folders and text files, copy / move / rename (recursive, across buckets), copy/cut/paste, delete (recursive). Detail panel: preview images, video, audio, PDF and text (edit and save text files), properties, edit metadata and storage class, tags, versions (download, restore, delete). Pre-signed URLs. Bucket properties: versioning, block public access, tags, policy, CORS, lifecycle. Context menu and keyboard shortcuts (Del, F2, Enter, Backspace, Ctrl+A/C/X/V). |
| CloudWatch Logs | Log group list (filter, sort, favorites, retention, stored bytes). Log viewer: quick ranges (5m…1w, or type `45m`) or absolute time, local/UTC; CloudWatch filter patterns with clickable examples; filter by log stream; event histogram over time (click a bar to zoom); level coloring, quick ERROR/WARN/INFO/DEBUG filters, search within results, keyword highlighting; compact JSON log rendering (message + key=value) with an expandable JSON tree; surrounding lines for an event; live tail; export JSON/CSV/.log; shareable URLs that keep the filters. Logs Insights: multiple log groups, query templates (including Lambda), field suggestions, saved queries, history, cancel, bytes-scanned statistics, charts for `bin()` results. |
| SQS | Queue list (available / in flight / delayed messages, DLQ, encryption), create Standard/FIFO queues (settings, encryption, DLQ, tags), purge, delete. Send messages (attributes, delay, group/dedup ID for FIFO, send N copies). Poll messages (count, wait time, visibility timeout; 0 = peek), view body/attributes, delete, return to queue, export JSON, copy into the send form. Edit settings, redrive policy, redrive allow policy, DLQ redrive (`StartMessageMoveTask`), access policy, tags. |
| Lambda | Function list (runtime, memory, timeout, code size, architecture, filter by name/runtime, sort), account quotas. Create functions: author from scratch (Node.js / Python / Ruby / custom runtime templates), upload a .zip, from S3, container image; pick an existing role, enter an ARN or create a role with `AWSLambdaBasicExecutionRole`. **Code**: browse the package, edit in place, add / rename / delete files, deploy (Ctrl+S, keeps file modes, refuses to overwrite code changed by someone else), publish a version, upload .zip / S3, download .zip, change image. **Test**: sample events (API Gateway, SQS, S3, SNS, EventBridge, schedule, DynamoDB stream, Kinesis, ALB…), saved events, sync / async / dry-run invoke by version or alias, response, log tail, duration / billed / memory / cold start, session history. **Monitor**: Invocations, Errors, Throttles, Duration and Concurrency charts (CloudWatch), recent invocations from `REPORT` lines (p95, cold starts), links to the log viewer and Logs Insights. **Configuration**: memory, timeout, /tmp, runtime, handler, role, X-Ray, log format/level/log group, DLQ, KMS, SnapStart, layers (pick from the account or paste an ARN, reorder), VPC. Environment variables (show/hide, import/export .env, 4 KB limit and reserved-name checks). **Triggers**: SQS / Kinesis / DynamoDB stream / MSK event source mappings (batch, window, filter, partial batch failure, max concurrency, enable/disable), push triggers inferred from the resource policy. **Permissions**: execution role and attached policies (attach common managed policies), resource-based policy (add from API Gateway / S3 / SNS / EventBridge… presets, remove statements). **Versions & aliases**: publish, delete versions, aliases with weighted routing (canary). **Function URL**: create / edit / delete, IAM or public auth, CORS, response streaming. **Concurrency & async**: reserved concurrency, throttle, provisioned concurrency, retries / max event age / destinations. Tags. **Layers**: list, versions, functions using them, publish a new version from a .zip. |
| Step Functions | State machine list (filter by name and type, sort). Create Standard or Express state machines from templates (Hello world, Lambda with retry/catch, Map, SQS callback) with a live graph preview and static checks (unknown targets, missing `Next`/`End`, unreachable states); pick an existing role, enter an ARN or create one trusted by `states.amazonaws.com`; logging, X-Ray, tags. **Executions**: list with status filter and paging, start (generated or custom name, JSON input, recent inputs, run `$LATEST`, a version or an alias; synchronous Express executions show the output inline), stop, redrive, re-run with the same input. **Execution view**: the graph colored per state (succeeded, failed, caught, running, cancelled) from the execution history, auto-refresh while running, per-state input/output/error/events, steps table, filterable event history with expandable details, input & output, Map runs with item counts, export as JSON. **Definition**: JSON editor next to the graph (Parallel and Map drawn as nested containers, Choice rules and Catch transitions labelled), format, validate (`ValidateStateMachineDefinition` + static checks), save (Ctrl+S) and optionally publish a version. **Test state**: run one state with `TestState` (custom input, role, INFO/DEBUG/TRACE inspection data). **Versions & aliases**: publish and delete versions, aliases with weighted routing (canary). **Configuration**: role, logging level and log group, X-Ray. Tags. **Activities**: list, create, delete. |
| Data modeler | Multiple models, each with multiple tables: keys, non-key attributes, GSIs, facets, sample data (form entry, CSV/JSON import). Import and export NoSQL Workbench model files (.json). Import a model from existing DynamoDB tables. Commit to DynamoDB (create tables and write sample data). Export CloudFormation. |

## S3 browser

- Switch between services with the toggle in the top bar. In S3 mode only the S3 UI is shown (buckets in the sidebar); the Connections page tests connections with `ListBuckets`. Buckets are only listed in S3 mode.
- Every operation is proxied through the server, so endpoints only reachable from the container work too. Uploads are streamed straight to S3 (multipart for large files) without temporary files on disk.
- Each bucket is called in its own region (detected with `HeadBucket`), so pre-signed URLs and buckets outside the selected region still work.
- **LocalStack / MinIO**: create a custom endpoint, choose *Access keys* credentials and fill in *S3 endpoint URL* if S3 runs on a different port than the DynamoDB endpoint (e.g. MinIO `http://host.docker.internal:9000`). Path-style addressing is used.
- IAM permissions for the full feature set: `s3:ListAllMyBuckets`, `s3:ListBucket`, `s3:ListBucketVersions`, `s3:GetObject*`, `s3:PutObject*`, `s3:DeleteObject*`, `s3:GetBucket*`, `s3:PutBucket*`, `s3:CreateBucket`, `s3:DeleteBucket`. A missing permission only breaks the feature that needs it.
- S3 has no real rename / move: the app copies to the new key and deletes the original. `CopyObject` cannot copy objects larger than 5 GB.
- Previews are sandboxed (`Content-Security-Policy: sandbox`, `nosniff`); only images, video, audio, plain text and PDF are shown inline. Everything else (HTML, JS…) is always forced to download, so bucket content can never run scripts on the app's origin.

## CloudWatch Logs

- Choose **CloudWatch** in the top bar. The sidebar lists log groups (favorites first); type to filter. With more than 1000 groups, the filter also searches on the server (case-sensitive).
- **Log viewer** (`#/logs/group/<name>`): type a filter pattern and press Enter. Patterns are case-sensitive: `ERROR`, `"exact phrase"`, `?ERROR ?WARN` (any of), `ERROR -Timeout` (exclude), `{ $.level = "error" }` (JSON), `%regex%`. Press `/` to focus the search box. Each search fetches up to 1000 events (Load more for the next batch, up to 20,000); narrow the time range for busy logs.
- **Live tail** polls `FilterLogEvents` every 2.5 seconds (not `StartLiveTail`, so there is no per-minute charge) and keeps the latest 5000 lines.
- **Logs Insights** is billed per GB scanned; the app warns when the range exceeds 7 days. A running query is stopped (`StopQuery`) when you leave the page.
- **LocalStack**: create a custom endpoint (default `http://localhost:4566`). If CloudWatch Logs runs at a different URL, fill in *CloudWatch Logs endpoint URL*.
- IAM permissions: `logs:DescribeLogGroups`, `logs:DescribeLogStreams`, `logs:FilterLogEvents`, `logs:GetLogEvents`, `logs:GetLogGroupFields`, `logs:StartQuery`, `logs:GetQueryResults`, `logs:StopQuery`; plus `logs:PutRetentionPolicy` and `logs:DeleteRetentionPolicy` to change retention. The app never deletes log groups or log streams.

## SQS

- Choose **SQS** in the top bar. Queues are addressed by name (`#/sqs/queue/<name>`).
- Polling hides messages for the visibility timeout and increases their receive count (which can move them to a DLQ). Set the visibility timeout to 0 to only peek.
- **LocalStack / ElasticMQ**: create a custom endpoint; if SQS runs at a different URL, fill in *SQS endpoint URL* (ElasticMQ `http://localhost:9324`). Requests always go to the endpoint, not to the host in the queue URL.
- IAM permissions: `sqs:ListQueues`, `sqs:GetQueueUrl`, `sqs:GetQueueAttributes`, `sqs:SetQueueAttributes`, `sqs:CreateQueue`, `sqs:DeleteQueue`, `sqs:PurgeQueue`, `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, `sqs:ListQueueTags`, `sqs:TagQueue`, `sqs:UntagQueue`, `sqs:ListDeadLetterSourceQueues`, `sqs:StartMessageMoveTask`, `sqs:ListMessageMoveTasks`, `sqs:CancelMessageMoveTask`.

## Lambda

- Choose **Lambda** in the top bar. Functions are opened by name (`#/lambda/function/<name>`); the *Version* selector at the top picks `$LATEST`, an alias or a version for the Code (read-only), Test, Monitor, Function URL, Permissions and async config tabs.
- **Code editing**: the server downloads the package (`GetFunction` → `Code.Location`), unzips it and returns the text files (up to 1 MB each, 10 MB total); binary or large files are listed only and kept unchanged on deploy. On deploy the server downloads the current package again, applies your changes, re-zips it (keeping executable bits, e.g. `bootstrap`) and calls `UpdateFunctionCode`. If the code changed since you opened it (`CodeSha256` differs), the deploy is refused. Packages are limited to 50 MB (the direct upload limit); use S3 for larger ones. Container image functions can only change the image URI.
- **Test events** are saved in the browser (localStorage) per function. The log tail only contains the last 4 KB; use *Open in CloudWatch Logs* for the full log of that request.
- **Monitor** uses CloudWatch `GetMetricData` (namespace `AWS/Lambda`) and `FilterLogEvents` on the function's log group to read `REPORT` lines.
- **Function URL** with `NONE` auth adds the two public statements to the resource policy (`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` via the URL), like the AWS console; deleting the URL removes them.
- **LocalStack**: create a custom endpoint (default `http://localhost:4566`). If Lambda runs at a different URL, fill in *Lambda endpoint URL* (also used for IAM and CloudWatch metrics). When the code download URL points to a host only reachable inside the emulator's network, the server retries through the endpoint.
- IAM permissions: `lambda:List*`, `lambda:Get*`, `lambda:CreateFunction`, `lambda:DeleteFunction`, `lambda:UpdateFunctionCode`, `lambda:UpdateFunctionConfiguration`, `lambda:InvokeFunction`, `lambda:PublishVersion`, `lambda:CreateAlias`, `lambda:UpdateAlias`, `lambda:DeleteAlias`, `lambda:*EventSourceMapping`, `lambda:AddPermission`, `lambda:RemovePermission`, `lambda:*FunctionUrlConfig`, `lambda:PutFunctionConcurrency`, `lambda:DeleteFunctionConcurrency`, `lambda:*ProvisionedConcurrencyConfig`, `lambda:*FunctionEventInvokeConfig`, `lambda:TagResource`, `lambda:UntagResource`, `lambda:PublishLayerVersion`; `cloudwatch:GetMetricData`; `logs:FilterLogEvents`; `iam:ListRoles`, `iam:GetRole`, `iam:ListAttachedRolePolicies`, `iam:ListRolePolicies`, plus `iam:CreateRole`, `iam:AttachRolePolicy` and `iam:PassRole` to create or assign roles. A missing permission only breaks the feature that needs it. The app never deletes layer versions.

## Step Functions

- Choose **Step Functions** in the top bar. State machines are opened by name (`#/sfn/machine/<name>`), executions by ARN (`#/sfn/execution/<arn>`).
- The execution view reads the whole history (`GetExecutionHistory`, up to 25,000 events) and uses the definition the execution actually ran (`DescribeStateMachineForExecution`), so the graph stays right after the definition changes. Running executions refresh every 3 seconds.
- **Express** state machines have no execution history in Step Functions: the Executions tab links to the log group of the logging configuration instead. Synchronous runs (`StartSyncExecution`) show the output, error and billed duration right away.
- **Test state** calls `TestState` with the state's JSON (editable, the saved definition is not changed) and the role you choose; the role needs the permissions of the services the state calls.
- Recent execution inputs are kept in the browser (localStorage), per state machine.
- **LocalStack / Step Functions Local**: create a custom endpoint; if Step Functions runs at a different URL, fill in *Step Functions endpoint URL* (Step Functions Local `http://localhost:8083`). The `sync-` host prefix of `StartSyncExecution` / `TestState` is disabled for custom endpoints.
- IAM permissions: `states:List*`, `states:Describe*`, `states:GetExecutionHistory`, `states:CreateStateMachine`, `states:UpdateStateMachine`, `states:DeleteStateMachine`, `states:ValidateStateMachineDefinition`, `states:StartExecution`, `states:StartSyncExecution`, `states:StopExecution`, `states:RedriveExecution`, `states:TestState`, `states:PublishStateMachineVersion`, `states:DeleteStateMachineVersion`, `states:*StateMachineAlias`, `states:CreateActivity`, `states:DeleteActivity`, `states:TagResource`, `states:UntagResource`; `iam:ListRoles` to pick a role, plus `iam:CreateRole`, `iam:AttachRolePolicy` and `iam:PassRole` to create or assign one. A missing permission only breaks the feature that needs it.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `AWS_DIR` | `~/.aws` | Directory holding `config` and `credentials` (`AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` can also be set individually) |
| `DATA_DIR` | `./data` (`/data` in Docker) | Where endpoint connections and data models are stored |
| `DEFAULT_ENDPOINTS` | | Comma-separated `Name=URL` list; only created on first start |
| `APP_USERNAME` / `APP_PASSWORD` | `admin` / (empty) | Set `APP_PASSWORD` to enable HTTP Basic Auth |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Host names allowed to reach the app (DNS-rebinding protection). `*` allows all |

## Security

Anyone who can open this app has the full power of every AWS credential it can read.

- By default it only binds to `127.0.0.1`. When deploying to a server, set `APP_PASSWORD`, add your host name to `ALLOWED_HOSTS` and put it behind HTTPS (reverse proxy).
- Secret keys are never sent to the browser. Leave the field empty when editing a profile to keep the existing secret.
- Every mutating API requires an `X-Requested-With` header (CSRF protection).
- Mount `~/.aws:/root/.aws:ro` for read-only profiles.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Notes

- **SSO**: the container cannot open a browser to sign in. Run `aws sso login --profile <name>` on the host; the container reuses the token in `~/.aws/sso/cache`.
- **MFA** (`mfa_serial`) and `credential_process` pointing to a binary that is not in the container will not work. Use temporary credentials or SSO instead.
- **DynamoDB Local on the host**: use the endpoint `http://host.docker.internal:8000`.
- **Number type**: numbers are kept as strings (DynamoDB JSON), so no precision is lost. Plain JSON mode converts to JavaScript numbers only when that is lossless.

## Development

```bash
cd server && npm install && npm run dev      # API on :8080
cd web && npm install && npm run dev         # UI on :5173 (proxies /api to :8080)
```

Tests (Vitest):

```bash
cd server && npm test                 # INI parser, profiles, store, API, S3 routes (supertest + aws-sdk-client-mock)
cd web && npm test                    # lib, components, pages (Testing Library + jsdom, mocked fetch)
npm run test:coverage                 # in either directory; HTML report in coverage/
```

Project layout:

```
server/src/app.js       Express: security, connections, DynamoDB API proxy, models
server/src/s3.js        S3 proxy: buckets, objects, uploads, previews, pre-signed URLs
server/src/logs.js      CloudWatch Logs proxy: search, live tail, Logs Insights
server/src/sqs.js       SQS proxy
server/src/lambda.js    Lambda / CloudWatch metrics / IAM role proxy, invoke, read and patch .zip packages
server/src/index.js     Server entry point
server/src/profiles.js  Read/write ~/.aws/config and credentials
server/src/ini.js       Comment-preserving INI parser
web/src/lib/dynamo.js   Marshalling, expression builder, CloudFormation, code generation, CSV
web/src/pages/          Connections, TableView, ItemExplorer, OperationBuilder, PartiQL, Modeler, S3, Logs, SQS, Lambda
web/src/components/     ItemEditor, QueryScanForm, Visualizer, ResultsGrid, TableDefEditor...
```

## Publishing to Docker Hub

See [docs/PUBLISH.md](docs/PUBLISH.md): token stored in the Keychain, multi-arch build with Podman, push and description update.

Pushing a `v*` tag also runs the *Windows portable* workflow, which builds the win-x64 zip and attaches it to the GitHub release.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Trung.Vu
