# Đóng góp

Cảm ơn bạn quan tâm tới dự án. Mọi issue và pull request đều được hoan nghênh.

## Môi trường phát triển

Yêu cầu: Node.js 22+, Docker (hoặc Podman) nếu muốn build image.

```bash
# Backend (Express) – http://localhost:8080
cd server && npm install && npm run dev

# Frontend (Vite + React) – http://localhost:5173, proxy /api sang 8080
cd web && npm install && npm run dev
```

Có thể chạy DynamoDB Local / LocalStack / MinIO để thử mà không cần tài khoản AWS thật.

## Quy trình

1. Fork repo, tạo branch từ `main`: `feat/...`, `fix/...`, `docs/...`.
2. Viết test cho thay đổi (Vitest; server dùng `supertest` + `aws-sdk-client-mock`, web dùng Testing Library).
3. Chạy test trước khi mở PR:

   ```bash
   (cd server && npm test) && (cd web && npm test && npm run build)
   ```

4. Commit theo [Conventional Commits](https://www.conventionalcommits.org/): `feat(s3): ...`, `fix(lambda): ...`, `docs: ...`.
5. Mở pull request, điền checklist trong template. CI phải xanh.

## Quy ước

- Không commit credential, file `data/`, hay `.env`.
- Giữ giao diện nhất quán với các trang hiện có; tính năng mới nên ghi vào README và `DOCKERHUB.md`.
- Lỗ hổng bảo mật: xem [SECURITY.md](SECURITY.md).
