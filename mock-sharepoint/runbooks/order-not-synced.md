# Runbook — Đơn hàng không đẩy sang DMS

## Triệu chứng

- SR đã chốt đơn trên app, NPP không thấy đơn trên DMS.

## Nguyên nhân thường gặp

1. App chưa sync (mất mạng lúc chốt đơn) → đơn còn nằm trên máy.
2. Sync treo giữa chừng → đơn trạng thái "Đang gửi".
3. Outlet chưa được gán cho NPP trên DMS → DMS từ chối đơn.

## L1 xử lý

1. Hỏi SR: trên app đơn đang ở trạng thái gì (Nháp / Đang gửi / Đã gửi).
2. "Nháp" hoặc "Đang gửi" → hướng dẫn SR bật mạng, vào Đồng bộ → Đồng bộ ngay.
3. "Đã gửi" nhưng DMS không có → tra mã đơn trên FieldGo Portal → Đơn hàng.
   - Có lỗi "Outlet not mapped" → escalate DMS team kèm mã outlet + mã NPP.
4. Đồng bộ lại vẫn treo quá 30 phút → escalate L2 NovaSoft.

## Lưu ý

- Cuối tháng lượng đơn lớn, sync chậm 15–30 phút là bình thường, chưa cần escalate.
