# Runbook — Check-in báo ngoài phạm vi GPS

## Triệu chứng

- SR đứng tại cửa hàng nhưng app báo "Bạn đang ở ngoài phạm vi outlet (> 200m)".

## Nguyên nhân thường gặp

1. Toạ độ outlet lưu sai trên hệ thống (outlet chuyển địa điểm, nhập nhầm).
2. GPS thiết bị chưa bắt chính xác (trong nhà, vừa bật định vị).
3. SR tắt chế độ định vị chính xác cao.

## L1 xử lý

1. Hướng dẫn SR bật định vị "Độ chính xác cao", ra chỗ thoáng, đợi 1 phút, thử lại.
2. Vẫn lỗi → hỏi outlet có chuyển địa điểm không.
3. Outlet chuyển chỗ / toạ độ sai → gửi yêu cầu cập nhật toạ độ cho team Master Data
   (kèm mã outlet + ảnh chụp vị trí thực tế).

## Lưu ý

- Đây **không phải** lỗi app → không escalate L2 NovaSoft, tránh chuyển nhầm.
