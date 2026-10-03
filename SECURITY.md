# Security Policy

AWS Tool Web chạy với quyền của AWS credential bạn mount vào container, nên mọi lỗ hổng đều có thể ảnh hưởng tới tài khoản AWS.

## Báo lỗ hổng

**Không tạo issue công khai.** Dùng [GitHub private vulnerability reporting](https://github.com/francisdinhtrung/aws-tool-web/security/advisories/new) và mô tả:

- Phiên bản / image tag
- Các bước tái hiện, ảnh hưởng
- Đề xuất khắc phục (nếu có)

Bạn sẽ nhận phản hồi trong vòng 7 ngày.

## Phiên bản được hỗ trợ

Chỉ bản mới nhất (`latest`) nhận bản vá bảo mật.

## Khuyến nghị khi triển khai

- Bind cổng vào `127.0.0.1` (mặc định trong `docker-compose.yml`), không mở ra Internet.
- Khi cần truy cập từ máy khác: bật `APP_USERNAME` / `APP_PASSWORD`, đặt `ALLOWED_HOSTS` và đặt sau reverse proxy có HTTPS.
- Dùng IAM user/role với quyền tối thiểu; mount `~/.aws` chế độ `:ro` nếu không cần sửa profile.
