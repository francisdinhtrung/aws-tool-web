# DynamoDB Studio

[![CI](https://github.com/francisdinhtrung/aws-tool-web/actions/workflows/ci.yml/badge.svg)](https://github.com/francisdinhtrung/aws-tool-web/actions/workflows/ci.yml)
[![Docker Image Version](https://img.shields.io/docker/v/francisdinhtrung/aws-tool-web?sort=semver&label=docker)](https://hub.docker.com/r/francisdinhtrung/aws-tool-web)
[![Docker Pulls](https://img.shields.io/docker/pulls/francisdinhtrung/aws-tool-web)](https://hub.docker.com/r/francisdinhtrung/aws-tool-web)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Web app chạy bằng Docker, thay thế Amazon DynamoDB NoSQL Workbench: quản lý AWS profile, duyệt và sửa dữ liệu, Operation builder kèm sinh code, PartiQL, Data modeler (tương thích file model của Workbench). Kèm **S3 browser** dùng như trình quản lý file (giống S3 Browser), **CloudWatch Logs** để tìm, live tail và query log, **SQS** và **Lambda console**.

## Chạy nhanh

```bash
docker compose up -d --build
```

Mở http://localhost:8080

- `~/.aws` được mount vào container ở chế độ đọc-ghi, nên profile tạo/sửa trên web sẽ được ghi thẳng vào `~/.aws/config` và `~/.aws/credentials`. Trước mỗi lần ghi, file cũ được sao lưu thành `*.bak`.
- Compose có sẵn service DynamoDB Local (`http://dynamodb-local:8000`), lần đầu chạy kết nối này được tạo tự động.
- Chỉ chạy Studio, không kèm DynamoDB Local: `docker compose up -d dynamodb-studio`

Nếu không dùng compose:

```bash
docker build -t dynamodb-studio .
docker run -d -p 127.0.0.1:8080:8080 -v ~/.aws:/root/.aws -v dynamodb-studio-data:/data dynamodb-studio
```

## Tính năng

| Nhóm | Chức năng |
|---|---|
| Connections | Liệt kê, tạo, sửa, đổi tên, xoá AWS profile: access key, SSO, assume role, credential_process, thêm setting tuỳ ý. Comment và block lồng nhau trong file config được giữ nguyên. Endpoint tuỳ chỉnh (DynamoDB Local, LocalStack). Default credential chain (biến môi trường / IAM role của EC2, ECS). Nút test kết nối (STS GetCallerIdentity + ListTables). Chọn region. |
| Tables | Liệt kê, lọc, tạo bảng (GSI, LSI, on-demand hoặc provisioned, table class, streams, deletion protection). Xoá bảng. Xem tổng quan. |
| Explore items | Scan và Query (trên bảng, GSI, LSI); điều kiện sort key; bộ lọc (=, ≠, <, between, begins_with, contains, exists, IN, attribute_type, size); projection; phân trang; strongly consistent; hiển thị RCU tiêu thụ. Tạo, sửa, nhân bản, xoá item (nhập bằng form theo kiểu dữ liệu, DynamoDB JSON hoặc plain JSON). Xoá hàng loạt. Xem dạng bảng hoặc JSON. Export CSV/JSON. Sinh code. |
| Indexes | Tạo và xoá GSI trên bảng có sẵn. |
| Settings | Đổi capacity mode, RCU/WCU, TTL, Streams, PITR, deletion protection, table class, tags, on-demand backup (tạo, restore, xoá). |
| Visualizer | Aggregate view như Workbench: nhóm theo partition key, xem theo GSI, tô màu theo entity type (prefix của sort key hoặc theo attribute), xem theo facet. |
| Import / Export | Export toàn bảng ra CSV, JSON, DynamoDB JSON, JSON lines. Import từ CSV (header có thể kèm kiểu, ví dụ `price (N)`) hoặc JSON; batch write có retry. Xoá toàn bộ item. |
| Operation builder | GetItem, PutItem, UpdateItem (SET, REMOVE, ADD, DELETE, increment, list_append, if_not_exists), DeleteItem, Query, Scan, BatchGetItem, BatchWriteItem, TransactGetItems, TransactWriteItems, ExecuteStatement, BatchExecuteStatement, ExecuteTransaction. Có condition expression và ReturnValues; sửa thẳng request JSON được. Sinh code **Python (boto3)**, **JavaScript (SDK v3)**, **AWS CLI**. |
| PartiQL editor | Chạy lệnh đơn, batch hoặc transaction; phân trang qua NextToken; lưu lịch sử; export kết quả. |
| S3 browser | Danh sách bucket ở sidebar; tạo bucket (chọn region, bật versioning), xoá bucket (tuỳ chọn xoá sạch object và version trước). Duyệt object như file manager: breadcrumb, gõ thẳng đường dẫn `s3://bucket/prefix`, sắp xếp, lọc, phân trang (Load more / Load all). Upload file và cả thư mục (nút hoặc kéo thả), multipart cho file lớn, hàng đợi Tasks có tiến độ và huỷ. Download (nhiều file, cả thư mục), tạo folder, tạo file text, copy / move / rename (đệ quy, sang bucket khác), copy/cut/paste, xoá (đệ quy). Panel chi tiết: preview ảnh, video, audio, PDF, text (sửa và lưu file text), properties, sửa metadata và storage class, tags, versions (tải, khôi phục, xoá version). Pre-signed URL. Bucket properties: versioning, block public access, tags, policy, CORS, lifecycle. Menu chuột phải và phím tắt (Del, F2, Enter, Backspace, Ctrl+A/C/X/V). |
| CloudWatch Logs | Danh sách log group (lọc, sắp xếp, favorite, retention, dung lượng). Log viewer: chọn thời gian nhanh (5m…1w, tự gõ `45m`) hoặc tuyệt đối, giờ local/UTC; filter pattern của CloudWatch kèm ví dụ bấm là dùng; lọc theo log stream; histogram số event theo thời gian (bấm cột để zoom); tô màu theo level, lọc nhanh ERROR/WARN/INFO/DEBUG, tìm trong kết quả, highlight từ khoá; log JSON hiển thị gọn (message + key=value), mở ra xem cây JSON; xem các dòng xung quanh một event; live tail; export JSON/CSV/.log; URL giữ nguyên bộ lọc để chia sẻ. Logs Insights: chọn nhiều log group, mẫu query (cả Lambda), field gợi ý, lưu query, lịch sử, huỷ query, thống kê bytes scanned, biểu đồ cho kết quả `bin()`. |
| SQS | Danh sách queue (số message available / in flight / delayed, DLQ, mã hoá), tạo queue Standard/FIFO (cấu hình, mã hoá, DLQ, tags), purge, xoá. Gửi message (attributes, delay, group/dedup ID cho FIFO, gửi N bản). Poll message (số lượng, thời gian, visibility timeout; 0 = peek), xem body/attributes, xoá, trả về queue, export JSON, copy sang form gửi. Sửa settings, redrive policy, redrive allow policy, DLQ redrive (`StartMessageMoveTask`), access policy, tags. |
| Lambda | Danh sách function (runtime, memory, timeout, code size, arch, lọc theo tên/runtime, sắp xếp), quota tài khoản. Tạo function: viết từ đầu (code mẫu Node.js / Python / Ruby / custom runtime), upload .zip, từ S3, container image; chọn role có sẵn, nhập ARN hoặc tự tạo role kèm `AWSLambdaBasicExecutionRole`. **Code**: duyệt file trong package, sửa trực tiếp, thêm / đổi tên / xoá file, deploy (Ctrl+S, giữ quyền file, chặn ghi đè nếu code đã bị đổi), publish version, upload .zip / S3, tải .zip, đổi image. **Test**: event mẫu (API Gateway, SQS, S3, SNS, EventBridge, schedule, DynamoDB stream, Kinesis, ALB…), lưu event, invoke sync / async / dry run theo version hoặc alias, xem response, log tail, duration / billed / memory / cold start, lịch sử trong phiên. **Monitor**: biểu đồ Invocations, Errors, Throttles, Duration, Concurrency (CloudWatch), danh sách invocation gần đây từ dòng REPORT (p95, cold start), link sang log viewer và Logs Insights. **Configuration**: memory, timeout, /tmp, runtime, handler, role, X-Ray, log format/level/log group, DLQ, KMS, SnapStart, layers (chọn từ tài khoản hoặc dán ARN, sắp thứ tự), VPC. Biến môi trường (ẩn/hiện, import/export .env, kiểm tra giới hạn 4 KB và tên reserved). **Triggers**: event source mapping SQS / Kinesis / DynamoDB stream / MSK (batch, window, filter, partial batch failure, max concurrency, bật/tắt), push trigger suy ra từ resource policy. **Permissions**: execution role và policy đính kèm (attach managed policy hay dùng), resource-based policy (thêm theo preset API Gateway / S3 / SNS / EventBridge…, xoá statement). **Versions & aliases**: publish, xoá version, alias kèm weighted routing (canary). **Function URL**: tạo / sửa / xoá, auth IAM hoặc public, CORS, response streaming. **Concurrency & async**: reserved concurrency, throttle, provisioned concurrency, retry / max event age / destination. Tags. **Layers**: danh sách, các version, function đang dùng, publish version mới từ .zip. |
| Data modeler | Nhiều model, mỗi model nhiều bảng: key, non-key attribute, GSI, facet, sample data (thêm bằng form, import CSV/JSON). Import và export file model của NoSQL Workbench (.json). Import model từ bảng DynamoDB có sẵn. Commit lên DynamoDB (tạo bảng và ghi sample data). Export CloudFormation. |

## S3 browser

- Chuyển giữa **DynamoDB** và **S3** bằng nút gạt trên thanh trên cùng. Ở chế độ S3 chỉ còn giao diện S3 (bucket ở sidebar, màu xanh S3); trang Connections test kết nối bằng `ListBuckets`. Bucket chỉ được liệt kê ở chế độ S3.
- Mọi thao tác đi qua server (proxy), nên dùng được cả endpoint chỉ truy cập được từ container. Upload được stream thẳng lên S3 (multipart với file lớn), không lưu tạm trên đĩa.
- Mỗi bucket được gọi đúng region của nó (tự dò bằng `HeadBucket`), nên pre-signed URL và bucket ở region khác region đang chọn vẫn chạy.
- **LocalStack / MinIO**: tạo custom endpoint, chọn credentials *Access keys* và điền ô *S3 endpoint URL* nếu S3 chạy ở cổng khác endpoint DynamoDB (ví dụ MinIO `http://host.docker.internal:9000`). Dùng path-style addressing.
- Quyền IAM cần cho đầy đủ tính năng: `s3:ListAllMyBuckets`, `s3:ListBucket`, `s3:ListBucketVersions`, `s3:GetObject*`, `s3:PutObject*`, `s3:DeleteObject*`, `s3:GetBucket*`, `s3:PutBucket*`, `s3:CreateBucket`, `s3:DeleteBucket`. Thiếu quyền nào thì chỉ tính năng đó báo lỗi.
- S3 không có rename / move thật: app copy sang key mới rồi xoá bản gốc. `CopyObject` không copy được object lớn hơn 5 GB.
- Preview chạy trong sandbox (`Content-Security-Policy: sandbox`, `nosniff`); chỉ ảnh, video, audio, text thuần và PDF được hiển thị inline, còn lại (HTML, JS…) luôn bị ép tải xuống, nên nội dung trong bucket không chạy được script trên origin của app.

## CloudWatch Logs

- Chọn **CloudWatch** trên thanh trên cùng. Sidebar liệt kê log group (favorite ở đầu); gõ để lọc, nếu tài khoản có hơn 1000 group thì ô lọc tìm thêm trên server (phân biệt hoa thường).
- **Log viewer** (`#/logs/group/<tên>`): gõ filter pattern rồi Enter. Pattern phân biệt hoa thường: `ERROR`, `"exact phrase"`, `?ERROR ?WARN` (một trong các từ), `ERROR -Timeout` (loại trừ), `{ $.level = "error" }` (JSON), `%regex%`. Phím `/` để focus ô tìm. Mỗi lần tìm lấy tối đa 1000 event (Load more để lấy tiếp, tối đa 20.000); thu hẹp khoảng thời gian nếu log nhiều.
- **Live tail** poll `FilterLogEvents` mỗi 2,5 giây (không dùng `StartLiveTail` nên không tính phí theo phút), giữ 5000 dòng mới nhất.
- **Logs Insights** tính phí theo GB dữ liệu scan; app cảnh báo khi khoảng thời gian dài hơn 7 ngày. Query đang chạy sẽ được dừng (`StopQuery`) khi rời trang.
- **LocalStack**: tạo custom endpoint (mặc định `http://localhost:4566`). Nếu CloudWatch Logs chạy ở URL khác, điền ô *CloudWatch Logs endpoint URL*.
- Quyền IAM: `logs:DescribeLogGroups`, `logs:DescribeLogStreams`, `logs:FilterLogEvents`, `logs:GetLogEvents`, `logs:GetLogGroupFields`, `logs:StartQuery`, `logs:GetQueryResults`, `logs:StopQuery`; thêm `logs:PutRetentionPolicy` và `logs:DeleteRetentionPolicy` nếu muốn đổi retention. App không xoá log group hay log stream.

## SQS

- Chọn **SQS** trên thanh trên cùng. Queue được gọi theo tên (`#/sqs/queue/<tên>`).
- Poll message làm message bị ẩn trong visibility timeout và tăng receive count (có thể đẩy sang DLQ). Đặt visibility timeout 0 để chỉ xem.
- **LocalStack / ElasticMQ**: tạo custom endpoint; nếu SQS chạy ở URL khác, điền ô *SQS endpoint URL* (ElasticMQ `http://localhost:9324`). Request luôn gửi tới endpoint, không theo host trong queue URL.
- Quyền IAM: `sqs:ListQueues`, `sqs:GetQueueUrl`, `sqs:GetQueueAttributes`, `sqs:SetQueueAttributes`, `sqs:CreateQueue`, `sqs:DeleteQueue`, `sqs:PurgeQueue`, `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility`, `sqs:ListQueueTags`, `sqs:TagQueue`, `sqs:UntagQueue`, `sqs:ListDeadLetterSourceQueues`, `sqs:StartMessageMoveTask`, `sqs:ListMessageMoveTasks`, `sqs:CancelMessageMoveTask`.

## Lambda

- Chọn **Lambda** trên thanh trên cùng. Function được mở theo tên (`#/lambda/function/<tên>`); ô *Version* ở đầu trang chọn `$LATEST`, alias hoặc version cho tab Code (chỉ đọc), Test, Monitor, Function URL, Permissions và async config.
- **Sửa code**: server tải package (`GetFunction` → `Code.Location`), giải nén và trả về file text (tối đa 1 MB mỗi file, 10 MB tổng); file binary hoặc lớn chỉ được liệt kê và vẫn giữ nguyên khi deploy. Khi deploy, server tải lại package hiện tại, áp các thay đổi, nén lại (giữ quyền thực thi, ví dụ `bootstrap`) rồi gọi `UpdateFunctionCode`. Nếu code đã bị người khác đổi kể từ lúc mở (`CodeSha256` khác), deploy bị từ chối. Package tối đa 50 MB (giới hạn upload trực tiếp); lớn hơn thì dùng S3. Function dạng container image chỉ đổi được image URI.
- **Test event** được lưu trong trình duyệt (localStorage) theo từng function. Log tail chỉ có 4 KB cuối; bấm *Open in CloudWatch Logs* để xem đủ log của request đó.
- **Monitor** dùng CloudWatch `GetMetricData` (namespace `AWS/Lambda`) và `FilterLogEvents` trên log group của function để đọc các dòng `REPORT`.
- **Function URL** với auth `NONE` tự thêm 2 statement public vào resource policy (`lambda:InvokeFunctionUrl` và `lambda:InvokeFunction` qua URL), giống console; xoá URL thì gỡ 2 statement đó.
- **LocalStack**: tạo custom endpoint (mặc định `http://localhost:4566`). Nếu Lambda chạy ở URL khác, điền ô *Lambda endpoint URL* (dùng cho cả IAM và CloudWatch metrics). Khi URL tải code trỏ tới host chỉ có trong mạng của emulator, server thử lại trên endpoint.
- Quyền IAM: `lambda:List*`, `lambda:Get*`, `lambda:CreateFunction`, `lambda:DeleteFunction`, `lambda:UpdateFunctionCode`, `lambda:UpdateFunctionConfiguration`, `lambda:InvokeFunction`, `lambda:PublishVersion`, `lambda:CreateAlias`, `lambda:UpdateAlias`, `lambda:DeleteAlias`, `lambda:*EventSourceMapping`, `lambda:AddPermission`, `lambda:RemovePermission`, `lambda:*FunctionUrlConfig`, `lambda:PutFunctionConcurrency`, `lambda:DeleteFunctionConcurrency`, `lambda:*ProvisionedConcurrencyConfig`, `lambda:*FunctionEventInvokeConfig`, `lambda:TagResource`, `lambda:UntagResource`, `lambda:PublishLayerVersion`; `cloudwatch:GetMetricData`; `logs:FilterLogEvents`; `iam:ListRoles`, `iam:GetRole`, `iam:ListAttachedRolePolicies`, `iam:ListRolePolicies`, cộng `iam:CreateRole`, `iam:AttachRolePolicy` và `iam:PassRole` nếu muốn tạo role / gán role. Thiếu quyền nào thì chỉ tính năng đó báo lỗi. App không xoá layer version.

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `8080` | Cổng HTTP |
| `AWS_DIR` | `~/.aws` | Thư mục chứa `config` và `credentials` (cũng có thể đặt riêng `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`) |
| `DATA_DIR` | `./data` (`/data` trong Docker) | Nơi lưu endpoint connection và data model |
| `DEFAULT_ENDPOINTS` | | Danh sách `Tên=URL`, cách nhau bằng dấu phẩy; chỉ được tạo ở lần chạy đầu tiên |
| `APP_USERNAME` / `APP_PASSWORD` | `admin` / (trống) | Đặt `APP_PASSWORD` để bật đăng nhập HTTP Basic Auth |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Hostname được phép truy cập (chống DNS rebinding). `*` = cho phép tất cả |

## Bảo mật

Ai mở được app này thì có toàn quyền của các AWS credential mà nó đọc được.

- Mặc định chỉ bind `127.0.0.1`. Nếu đưa lên server, hãy đặt `APP_PASSWORD`, thêm hostname vào `ALLOWED_HOSTS` và chạy sau HTTPS (reverse proxy).
- Secret key không bao giờ gửi xuống trình duyệt. Muốn giữ secret cũ khi sửa profile thì để trống ô đó.
- Mọi API thay đổi dữ liệu đều yêu cầu header `X-Requested-With` để chống CSRF.
- Muốn profile chỉ đọc thì mount `~/.aws:/root/.aws:ro`.

## Ghi chú

- **SSO**: container không mở được trình duyệt để đăng nhập. Chạy `aws sso login --profile <tên>` trên máy host; container dùng lại token trong `~/.aws/sso/cache`.
- **MFA** (`mfa_serial`) và `credential_process` trỏ tới binary không có trong container sẽ không chạy được. Nên dùng temporary credentials hoặc SSO.
- **DynamoDB Local trên máy host**: dùng endpoint `http://host.docker.internal:8000`.
- **Kiểu Number**: số được giữ nguyên dạng chuỗi (DynamoDB JSON) nên không mất độ chính xác. Chế độ plain JSON chuyển sang number của JS khi không bị mất độ chính xác.

## Phát triển

```bash
cd server && npm install && npm run dev      # API ở :8080
cd web && npm install && npm run dev         # UI ở :5173 (proxy /api tới :8080)
```

Test (Vitest):

```bash
cd server && npm test                 # parser INI, profile, store, API, S3 routes (supertest + aws-sdk-client-mock)
cd web && npm test                    # lib, component, page (Testing Library + jsdom, mock fetch)
npm run test:coverage                 # chạy ở từng thư mục, báo cáo HTML nằm trong coverage/
```

Cấu trúc:

```
server/src/app.js       Express: bảo mật, connection, proxy DynamoDB API, model
server/src/lambda.js    Proxy Lambda / CloudWatch metrics / IAM role, invoke, đọc và sửa package .zip
server/src/index.js     Khởi động server
server/src/profiles.js  Đọc/ghi ~/.aws/config và credentials
server/src/ini.js       Parser INI giữ nguyên comment
web/src/lib/dynamo.js   Marshalling, expression builder, CloudFormation, sinh code, CSV
web/src/pages/          Connections, TableView, ItemExplorer, OperationBuilder, PartiQL, Modeler
web/src/components/     ItemEditor, QueryScanForm, Visualizer, ResultsGrid, TableDefEditor...
```

## Publish lên Docker Hub

Xem [docs/PUBLISH.md](docs/PUBLISH.md): lưu token trong Keychain, build multi-arch bằng Podman, push và cập nhật description.

## Đóng góp

Xem [CONTRIBUTING.md](CONTRIBUTING.md). Báo lỗ hổng bảo mật: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Trung.Vu

---

Developed by Trung.Vu
