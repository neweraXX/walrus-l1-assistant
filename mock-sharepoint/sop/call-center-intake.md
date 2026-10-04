# SOP — Nhận cuộc gọi hotline

Áp dụng: mọi cuộc gọi vào hotline L1 FieldGo (`1900 0000 01`, giả lập).

## Checklist bắt buộc hỏi khách

1. Mã người gọi: mã SR (vd `SR-1042`) hoặc mã NPP (vd `NPP-HCM-01`).
2. Mã outlet đang gặp lỗi (nếu có), vd `OUT-0007`.
3. Version app FieldGo (Cài đặt → Thông tin ứng dụng).
4. Lỗi xảy ra lúc nào, thao tác gì, có ảnh chụp màn hình không.
5. Lỗi ảnh hưởng 1 người hay nhiều người cùng route/NPP.

## Log case

- Tạo case trên hệ thống ticket, ghi mã case dạng `CS-<ngày>-<số>`, vd `CS-0924-003`.
- Trước khi xử lý: **kiểm tra lịch sử khách** (đã gọi lần nào chưa, lần trước xử lý gì).
- Xử lý theo runbook tương ứng trong `00-INDEX.md`.
- Không xử lý được trong 15 phút → escalate theo `reference/escalation-matrix.md`.

## Kết thúc cuộc gọi

- Tóm tắt lại cho khách: lỗi gì, đã làm gì, bước tiếp theo, khi nào có phản hồi.
- Case chưa đóng → ghi vào bàn giao ca (`sop/shift-handover.md`).
