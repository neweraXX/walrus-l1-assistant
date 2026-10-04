# Runbook — SR không đăng nhập được / tài khoản bị khoá

## Triệu chứng

- App báo "Tài khoản đã bị khoá" hoặc "Sai thông tin đăng nhập" dù SR nhập đúng.

## Nguyên nhân thường gặp

1. Nhập sai mật khẩu quá 5 lần → tự khoá 30 phút.
2. Tài khoản bị tắt do SR nghỉ phép dài / đổi route.
3. Thiết bị chưa đăng ký với tài khoản (đổi máy mới).

## L1 xử lý

1. Kiểm tra trạng thái tài khoản trên FieldGo Portal → Người dùng → tìm mã SR.
2. Bị khoá do sai mật khẩu → bấm "Mở khoá", hướng dẫn SR đăng nhập lại.
3. Tài khoản bị tắt → **không tự bật**, cần xác nhận của quản lý vùng (ASM) qua mail.
4. Đổi thiết bị → gỡ thiết bị cũ trong mục "Thiết bị", SR đăng nhập trên máy mới.

## Escalate

- Mở khoá xong vẫn báo lỗi → L2 NovaSoft (xem escalation matrix).
