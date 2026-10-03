# Publish image lên Docker Hub

Image: [`francisdinhtrung/aws-tool-web`](https://hub.docker.com/r/francisdinhtrung/aws-tool-web), multi-arch `linux/amd64` + `linux/arm64`.

Máy dev dùng **Podman** (không có Docker Desktop). Token Docker Hub lưu trong **macOS Keychain**, [scripts/publish.sh](../scripts/publish.sh) tự đọc ra.

## Chuẩn bị (làm một lần)

1. Tạo Personal Access Token trên Docker Hub: *Account settings → Personal access tokens → Generate*, quyền **Read & Write**.
2. Lưu token vào Keychain (lệnh sẽ hỏi token, dán vào, không hiện ra màn hình):

   ```bash
   security add-generic-password -U -a francisdinhtrung -s dockerhub-token -w
   ```

   Lần đầu script đọc token, macOS có thể hỏi quyền truy cập Keychain: chọn **Always Allow**.

3. Cần có `podman` và `jq` (`brew install podman jq`), và đã tạo VM: `podman machine init`.

## Các bước mỗi lần release

### 1. Chọn version (semver)

| Thay đổi | Ví dụ |
|---|---|
| Sửa lỗi | `1.1.0` → `1.1.1` |
| Thêm tính năng (ví dụ thêm Lambda) | `1.0.0` → `1.1.0` |
| Thay đổi không tương thích (env, volume, API…) | `1.1.0` → `2.0.0` |

Xem các tag đã có:

```bash
curl -s https://hub.docker.com/v2/repositories/francisdinhtrung/aws-tool-web/tags | jq -r '.results[].name'
```

### 2. Chạy test

```bash
cd server && npx vitest run && cd ../web && npx vitest run
```

### 3. Bump version

```bash
VERSION=1.2.0
(cd server && npm version $VERSION --no-git-tag-version)
(cd web && npm version $VERSION --no-git-tag-version)
```

Cập nhật [DOCKERHUB.md](../DOCKERHUB.md) (nội dung trang Overview trên Docker Hub):

- Tag trong ví dụ `docker run` và compose (`aws-tool-web:<version>`).
- Mục **Features** nếu có tính năng mới.
- Mục **Tags**: thêm dòng cho version mới, ghi ngắn gọn thay đổi.

Nếu có tính năng lớn, sửa thêm `SHORT_DESC` trong [scripts/publish.sh](../scripts/publish.sh) (tối đa 100 ký tự).

### 4. Build image multi-arch

```bash
podman machine start          # bỏ qua nếu VM đang chạy
VERSION=$(jq -r .version server/package.json)
IMG=docker.io/francisdinhtrung/aws-tool-web:$VERSION
podman manifest rm $IMG 2>/dev/null
podman build --format docker --platform linux/amd64,linux/arm64 --manifest $IMG \
  --label org.opencontainers.image.title="AWS Tool Web" \
  --label org.opencontainers.image.version="$VERSION" \
  --label org.opencontainers.image.description="Self-hosted web UI for AWS: DynamoDB studio, S3 browser, CloudWatch Logs, SQS, Lambda console" \
  --label org.opencontainers.image.authors="Trung.Vu" \
  .
```

- `--format docker` là bắt buộc: format OCI (mặc định của podman) bỏ mất `HEALTHCHECK`.
- `--manifest` gom 2 kiến trúc vào một tag. Build amd64 trên Mac M chạy qua emulation nên chậm hơn.

### 5. Chạy thử

```bash
podman run -d --rm --name awt-test -p 127.0.0.1:18080:8080 $IMG
curl -s http://127.0.0.1:18080/api/health     # {"ok":true}
podman stop awt-test
```

### 6. Push và cập nhật description

```bash
./scripts/publish.sh
```

Script sẽ:

1. Lấy version từ `server/package.json` (hoặc truyền vào: `./scripts/publish.sh 1.2.0`).
2. Lấy token từ biến `DOCKERHUB_TOKEN`, nếu không có thì từ Keychain.
3. `podman login`, push manifest lên tag `<version>` và `latest`.
4. Gọi Docker Hub API cập nhật short description (`SHORT_DESC`) và overview (nội dung `DOCKERHUB.md`).

Script **không build**: phải làm bước 4 trước, nếu không sẽ lỗi vì chưa có manifest.

### 7. Kiểm tra

```bash
curl -s https://hub.docker.com/v2/repositories/francisdinhtrung/aws-tool-web/tags \
  | jq -r '.results[] | "\(.name) \(.digest) \([.images[].architecture]|join(","))"'
```

`latest` và version mới phải cùng digest, có cả `amd64,arm64`.

## Quản lý token

| Việc | Lệnh |
|---|---|
| Đổi token | `security add-generic-password -U -a francisdinhtrung -s dockerhub-token -w` |
| Xem token có trong Keychain chưa | `security find-generic-password -a francisdinhtrung -s dockerhub-token >/dev/null && echo ok` |
| Xoá token | `security delete-generic-password -a francisdinhtrung -s dockerhub-token` |

`podman login` lưu credential trong `~/.config/containers/auth.json` dạng base64 (gần như plaintext). Muốn an toàn thì chạy `podman logout docker.io` sau khi push; lần sau script tự login lại từ Keychain.

## Lỗi thường gặp

| Lỗi | Cách xử lý |
|---|---|
| `Cannot connect to Podman` | `podman machine start` |
| `No token: set DOCKERHUB_TOKEN…` | Chưa lưu token, làm bước Chuẩn bị 2 |
| `unauthorized` khi push / 401 khi gọi API | Token hết hạn, bị thu hồi hoặc thiếu quyền Write: tạo token mới rồi lưu lại |
| `HEALTHCHECK is not supported for OCI image format` | Thiếu `--format docker` khi build |
| Push báo không tìm thấy image | Chưa build bước 4, hoặc version trong `package.json` khác tag đã build |
