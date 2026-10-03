# Quota auto-ping trên Appwrite

Codex Plus được kiểm tra riêng theo từng tài khoản OAuth đang bật, vào 06h, 11h,
16h và 21h (Asia/Ho_Chi_Minh). Mỗi giờ có các lượt kiểm tra ở phút 00, 05, 10,
15, 20, 25. Không dùng credit reset quota.

## Cấu hình triển khai

- Function `quota-autoping`: root `appwrite/functions/quota-autoping`, entrypoint
  `index.js`, timeout 60 giây, cron UTC `0,5,10,15,20,25 23,4,9,14 * * *`.
- Site: timeout 60 giây; biến `QUOTA_AUTOPING_EXTERNAL_SCHEDULER=true` để cron
  quản lý lịch, tránh timer của tiến trình SSR chạy trùng.
- Function dùng `QUOTA_AUTOPING_TARGET_URL` và secret khớp với Site
  (`QUOTA_AUTOPING_SECRET_V2`, hoặc biến cũ `QUOTA_AUTOPING_SECRET`).

## Điều kiện hoàn thành

HTTP 200 chưa chứng minh quota được kích. Stream phải có sự kiện hoàn thành;
usage đọc bằng cùng `ChatGPT-Account-ID` phải có mức sử dụng lớn hơn 0 và mốc
reset thuộc cửa sổ 5 giờ bắt đầu từ giờ hẹn hoặc muộn hơn. Chỉ khi đó mới lưu
`lastAutoPingSlot`. Usage được kiểm tra lại ở các lượt sau, kể cả khi có marker
từ phiên bản cũ.

Nếu cửa sổ trước chưa hết (ví dụ ping lúc 06:01, reset lúc 11:01), tài khoản
được giữ `pending` đến lượt kiểm tra sau. Nếu quota vẫn đầy sau ping, lượt sau
sẽ thử lại. Usage có thể làm tròn request rất nhỏ về 0%; khi đó hệ thống tiếp
tục giữ pending, không tuyên bố đã xác nhận kích quota.

Các tài khoản được xử lý đồng thời, mỗi tài khoản có giới hạn 25 giây. Lỗi một
tài khoản không bỏ qua các tài khoản còn lại. Weekly của Codex thường có thể
chặn ping; quota Review/Spark không chặn request Luna thường.

## Đọc kết quả

Response và log Function có `summary.accounts` với `connectionId`, `slot`,
`status`, `reason`, `resetAt`, `remaining`. Các bộ đếm:

- `sent`: request đã hoàn thành stream.
- `verified`: usage đã xác nhận cửa sổ cho giờ hẹn (có thể đã mở từ request khác).
- `pending`: cần đợi reset, cập nhật usage hoặc lượt thử lại.
- `failed`: lỗi provider/auth/network; kiểm tra `accounts[].reason`.

Token OAuth bị thu hồi hoặc refresh token không còn hợp lệ cần đăng nhập lại
đúng tài khoản; hệ thống ghi lỗi thay vì báo đã kích thành công. Sau lượt phút
25, tài khoản vẫn pending/failed sẽ được kiểm tra ở giờ hẹn tiếp theo hoặc có
thể kích bù qua Function với body `{"catchUp":"codex"}`.
