# Kịch bản demo before / after

Dùng để test bot và làm bằng chứng cho bài viết. Toàn bộ dữ liệu hư cấu.

## 1. Tra cứu tài liệu

- **Before**: "Lỗi check-in ngoài phạm vi thì làm sao, escalate ai?" → lục SharePoint hoặc hỏi người khác.
- **After**: bot trả lời theo `runbooks/gps-checkin-out-of-range.md` + nhắc "không phải lỗi app,
  đừng chuyển L2" + dẫn link file.
- **Memory**: lần sau An hỏi lại, bot nhớ An đã hỏi lỗi này hôm thứ 2 và outlet liên quan.

## 2. Khách gọi lại, người khác nghe máy (xuyên người)

- Thứ 2, An nghe SR-1042 gọi: đơn không vào DMS, outlet OUT-0007 chưa map, đã escalate DMS team.
  An báo bot: "SR-1042 lỗi đơn OUT-0007, đã chuyển DMS team, hẹn phản hồi thứ 3".
- Thứ 3, Chi nghe SR-1042 gọi lại.
- **Before**: Chi hỏi lại từ đầu, SR bực vì phải kể lại.
- **After**: Chi hỏi bot "SR-1042 có lịch sử gì?" → bot trả về case hôm qua, đang chờ DMS team.

## 3. Bàn giao ca (xuyên phiên)

- 14:50, Binh báo bot: "bàn giao: CS-0924-003 chờ L2 NovaSoft, hứa gọi lại SR-1077 lúc 16:00".
- 15:05, Dung (ca chiều) hỏi: "ca sáng bàn giao gì?"
- **Before**: bàn giao miệng, Dung quên gọi lại → SR phàn nàn.
- **After**: bot liệt kê case + việc đã hứa, và nhắc Dung lúc 15:55.

## 4. Team dạy bot (tri thức tích luỹ)

- Dung phát hiện (tài liệu CHƯA có): SR báo "Phiên đăng nhập hết hạn" liên tục ngay sau khi đổi
  mật khẩu → đăng xuất hẳn, xoá cache app rồi đăng nhập lại; không cần mở khoá, không cần escalate.
- Dung dạy bot → lưu vào `team:knowledge`.
- Sau đó An hỏi đúng lỗi đó → bot trả lời bằng kiến thức Dung đã dạy, ghi rõ ai dạy, khi nào.
  Không có memory thì bot chỉ có runbook khoá tài khoản → trả lời sai hướng.

## Số liệu nên ghi lại cho bài viết

- Số câu hỏi bot trả lời đúng từ tài liệu / từ memory.
- Số lần khách không phải kể lại lịch sử.
- Số việc bàn giao được nhắc đúng giờ.
