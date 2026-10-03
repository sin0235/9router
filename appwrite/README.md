# Quota auto-ping trên Appwrite

Codex Plus được kiểm tra riêng theo từng tài khoản OAuth đang bật, vào 06h, 11h,
16h và 21h (Asia/Ho_Chi_Minh). Kiểm tra mỗi 5 phút cho giờ hẹn gần nhất đến khi
từng tài khoản được xác nhận. Tài khoản đã xác nhận không gọi usage hoặc ping
tiếp trong cùng giờ hẹn. Lượt 21h còn chờ được tiếp tục xử lý qua nửa đêm.
Không dùng credit reset quota.

## Cấu hình triển khai

- Function `quota-autoping`: root `appwrite/functions/quota-autoping`, entrypoint
  `index.js`, timeout 60 giây, cron UTC `*/5 * * * *`.
- Site: timeout 60 giây; biến `QUOTA_AUTOPING_EXTERNAL_SCHEDULER=true` để cron
  quản lý lịch, tránh timer của tiến trình SSR chạy trùng.
- Function dùng `QUOTA_AUTOPING_TARGET_URL` và secret khớp với Site
  (`QUOTA_AUTOPING_SECRET_V2`, hoặc biến cũ `QUOTA_AUTOPING_SECRET`).

## Điều kiện hoàn thành

HTTP 200 chưa chứng minh quota được kích. Stream phải có sự kiện hoàn thành;
usage đọc bằng cùng `ChatGPT-Account-ID` phải có mốc reset thuộc cửa sổ 5 giờ
bắt đầu từ giờ hẹn hoặc muộn hơn. Nếu mức sử dụng lớn hơn 0 thì xác nhận ngay.
Nếu usage làm tròn về 0%, phải chờ ít nhất hai phút rồi kiểm tra deadline còn
neo ở thời điểm ping trước đó (cho phép lệch tối đa một phút); cửa sổ chưa mở
sẽ trượt deadline theo thời gian hiện tại và không vượt qua kiểm tra này.
Chỉ sau khi xác nhận mới lưu `lastAutoPingSlot`, `lastAutoPingVerifiedAt` và
`lastAutoPingVerifiedResetAt`. Marker chỉ ghi "đã gửi" từ phiên bản cũ không
chặn bước kiểm tra và thử lại.

Nếu cửa sổ trước chưa hết (ví dụ ping lúc 06:01, reset lúc 11:01), tài khoản
được giữ `pending` đến lượt kiểm tra sau. Nếu quota vẫn đầy sau ping, lượt sau
sẽ thử lại nếu deadline vẫn trượt, hoặc xác nhận `window-reset-fixed` khi
deadline đã cố định dù phần trăm sử dụng vẫn là 0%.

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
đúng tài khoản; hệ thống ghi lỗi thay vì báo đã kích thành công. Tài khoản còn
pending/failed được kiểm tra lại mỗi 5 phút; khi đến giờ hẹn tiếp theo, mục tiêu
chuyển sang cửa sổ của giờ mới. Có thể kiểm tra ngay qua Function với body
`{"catchUp":"codex"}`.
