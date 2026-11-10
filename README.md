# Smart Digital Clock & Thermal Fire Alarm System
### (Hệ thống Đồng hồ Số Thông minh RTC DS3231 · Cảm biến nhiệt LM35 & Cảnh báo Gmail)

Dự án IoT kết hợp giữa **Đồng hồ thời gian thực (RTC DS3231)**, **Cài đặt Báo thức đa năng (Alarm Clock)**, **Cảm biến nhiệt độ cảnh báo cháy (LM35 / Thermal Sensor)**, **Hệ thống gửi cảnh báo khẩn cấp về Gmail cá nhân**, **Camera giám sát an ninh (ESP32-CAM / Webcam)** và **AI Smart Box** trợ lý đồng bộ thời gian thực.

---

## ✦ Các tính năng cốt lõi đã hoàn thiện 100%

### 1. Đồng hồ số thời gian thực RTC DS3231 (Chuẩn I2C Bus)
- Hiển thị chính xác giờ, phút, giây, thứ, ngày, tháng, năm.
- **Chuyển đổi định dạng giờ**: Cho phép chuyển đổi tức thì giữa định dạng **24 Giờ** và **12 Giờ (AM/PM)**.
- **Chế độ Chỉnh giờ thủ công (Manual Adjust)**: Có bảng điều khiển tăng/giảm `+1 Giờ`, `-1 Giờ`, `+1 Phút`, `-1 Phút` và nút đặt lại về giờ chuẩn.
- Gắn nhãn mốc thời gian chuẩn xác (Timestamp Watermark) lên từng ảnh chụp camera và sự kiện báo cháy.

### 2. Hệ thống Báo thức Đồng hồ (Alarm Clock)
- **Khung chọn giờ báo thức**: Đặt giờ hẹn linh hoạt (Giờ:Phút).
- **Công tắc Bật/Tắt báo thức**: Hiển thị rõ trạng thái Đang Bật / Đang Tắt trên thẻ KPI và giao diện.
- **Chuông báo thức độc lập (Web Audio Synthesizer)**: Phát tiếng chuông ngắt quãng *"Bíp - Bíp - Bíp"* đặc trưng của đồng hồ điện tử khi đến giờ hẹn.
- **Banner Báo thức**: Tích hợp nút `🔕 Tắt Báo Thức` và nút `⏳ Báo lại sau 5 phút (Snooze)`.

### 3. Gán Gmail & Tự động Báo động về Gmail khi có cháy
- **Ô nhập Gmail trực quan**: Có ô gán địa chỉ Gmail nhận cảnh báo khẩn cấp (`your_email@gmail.com`) kèm nút `💾 Lưu Gmail` (lưu tự động vào trình duyệt).
- **Tự động gửi cảnh báo khi cháy**: Khi nhiệt độ cảm biến LM35 vượt ngưỡng cài đặt (hoặc khi bấm `🚨 Test Báo Cháy`), hệ thống sẽ:
  - Tự động gửi cảnh báo khẩn cấp về hòm thư Gmail đã lưu kèm mốc thời gian, nhiệt độ tức thời và ảnh hiện trường.
  - Hiển thị nút `📧 Mở Gmail Kiểm Tra` để xem ngay thư cảnh báo được soạn sẵn trên Gmail.
  - Ghi nhận trạng thái gửi email vào Bảng Nhật ký sự kiện PCCC.

### 4. Cảm biến nhiệt độ LM35 & Còi Báo Cháy PCCC
- Giám sát nhiệt độ môi trường thời gian thực.
- **Thanh trượt tùy chỉnh ngưỡng báo cháy**: Cài đặt ngưỡng từ `35°C` đến `80°C`.
- **Còi hú báo cháy đa tần số (Wail Siren)**: Khác biệt hoàn toàn với tiếng chuông báo thức thông thường.
- Biểu đồ nhiệt độ đổi màu theo mức độ an toàn.

### 5. Camera Giám sát Hiện trường Tích hợp (ESP32-CAM / Webcam)
- Hỗ trợ xem trực tiếp qua Webcam thiết bị thật, luồng ESP32-CAM IP hoặc Radar nhiệt mô phỏng Canvas.
- **Tự động chụp ảnh chứng cứ (Evidence Log)** khi quá nhiệt và lưu vào thư viện hiện trường.

### 6. AI Smart Box - Trợ lý Thời gian thực & PCCC
- Đồng bộ dữ liệu 100% với trạng thái đồng hồ, giờ báo thức, nhiệt độ LM35 và Gmail của người dùng.
- Trả lời chuẩn xác các câu hỏi về:
  - Giờ hiện tại, định dạng 12h/24h, module RTC DS3231.
  - Trạng thái báo thức (bật/tắt, mấy giờ reo).
  - Trạng thái Gmail nhận tin và các biến cố đã ghi nhận.
  - Quy trình thoát hiểm PCCC 5 bước khẩn cấp, gọi 114.
- Hoạt động mượt mà cả khi chạy offline (Local Sync Engine) lẫn khi kết nối OpenAI GPT-4o-mini.

---

## 🚀 Hướng dẫn khởi chạy

### Cách 1: Mở trực tiếp bằng trình duyệt (Khuyên dùng - Nhanh nhất)
- Nhấp đúp chuột trực tiếp vào file `index.html` trong File Explorer (trên Chrome, Edge hoặc Cốc Cốc).
- Toàn bộ tính năng đồng hồ DS3231, báo thức, âm thanh còi/chuông, camera, radar nhiệt, ô gán Gmail và AI Smart Box đều hoạt động mượt mà 100% mà không cần cài đặt thêm phần mềm nào.

### Cách 2: Khởi chạy bằng Node.js Server
1. Mở terminal tại thư mục dự án:
   ```bash
   node server.mjs
   ```
2. Mở trình duyệt truy cập: [http://localhost:3000](http://localhost:3000)
3. *(Tùy chọn)*: Để gửi email thực tế vào Inbox Gmail qua SMTP của Google, điền `GMAIL_USER` và `GMAIL_APP_PASSWORD` vào file `.env`.
