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
- **Kêu liên tục vĩnh viễn cho đến khi tắt**: Chuông báo thức reo liên tục không bao giờ tự dừng cho đến khi người dùng chủ động bấm `🔕 Tắt Báo Thức` hoặc `⏳ Báo lại sau 5 phút (Snooze)`.
- **Banner Báo thức**: Tích hợp nút `🔕 Tắt Báo Thức` và nút `⏳ Báo lại sau 5 phút (Snooze)`.

### 3. Gán Gmail & Tự động Gửi Thư Báo Cháy Về Gmail Đã Lưu
- **Tự động gửi email tức thì khi có cháy**: Khi nhiệt độ cảm biến LM35 vượt ngưỡng cài đặt (hoặc khi bấm `🚨 Test Báo Cháy`), hệ thống sẽ **tự động gửi ngay lập tức** báo cáo khẩn cấp về địa chỉ Gmail đã lưu.
- **Đồng bộ thời gian thực cho tất cả các máy**: Khi bất kỳ ai nhập và bấm `💾 Lưu Gmail`, địa chỉ này lập tức được lưu vào máy chủ và tự động đồng bộ tức thời đến toàn bộ các máy tính / điện thoại đang mở Dashboard.
- **Báo cáo sự cố hỏa hoạn khẩn cấp chuẩn PCCC**: Thư cảnh báo gồm: Mã sự cố, Mốc thời gian RTC DS3231, Nhiệt độ tức thời, Ngưỡng kích hoạt, Trạng thái còi hú liên tục, Ảnh hiện trường và Quy trình ứng phó 5 bước chuẩn Cục Cảnh sát PCCC.
- **Tích hợp gửi SMTP thực tế**: Có thể cấu hình `GMAIL_USER` và `GMAIL_APP_PASSWORD` trong file `.env` để máy chủ tự động gửi thẳng vào hòm thư Inbox của người nhận.
- **Tích hợp Cooldown chống spam**: Chống gửi dồn dập nhiều email trong thời gian ngắn và ghi nhận trạng thái vào Nhật ký PCCC.

### 4. Cảm biến nhiệt độ LM35 & Còi Báo Cháy PCCC (Kêu liên tục vĩnh viễn cho đến khi tắt)
- Giám sát nhiệt độ môi trường thời gian thực.
- **Thanh trượt tùy chỉnh ngưỡng báo cháy**: Cài đặt ngưỡng từ `35°C` đến `80°C`.
- **Còi hú báo cháy đa tần số (Wail Siren)**: Tự động kích hoạt khi có cháy, kêu liên tục vĩnh viễn (kèm đếm thời gian trực quan) cho đến khi người dùng bấm nút `🔕 Tắt Báo Động & Đặt Lại` hoặc đưa nhiệt độ về mức an toàn.
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

### 7. Phần cứng Thực tế (Firmware C++ & Web Serial API USB)
- **Mã nguồn Firmware hoàn thiện**:
  - `firmware/SmartFireClock_Arduino.ino`: Code Arduino Uno đọc RTC DS3231 (I2C), lọc trung bình trượt LM35 (A0), LCD 16x2, Active Buzzer và giao tiếp Serial 115200 bps.
  - `firmware/ESP32_CAM_FireMonitor.ino`: Code ESP32-CAM phát video stream MJPEG và telemetry qua WiFi.
  - `firmware/README.md`: Bảng sơ đồ đấu nối dây (Pinout Table) chi tiết từng chân.
- **Nút "🛠️ Code Firmware & Sơ Đồ"**: Cho phép xem, chọn tab và sao chép mã nguồn C++ trực tiếp ngay trên Dashboard Web.
- **Web Serial API**: Nhấn **"📡 Kết Nối Serial USB"** trên Chrome/Edge để kết nối trực tiếp với Arduino Uno thật qua cáp USB, hiển thị nhiệt độ thực tế của phòng lên Dashboard.

### 8. Lưu Trữ Bền Vững (LocalStorage) & Xuất File Báo Cáo CSV (Excel)
- **Tự động lưu lịch sử**: Toàn bộ chuỗi dữ liệu đo nhiệt độ và thư viện ảnh chụp hiện trường được tự động lưu vào `localStorage`. Khi bấm F5 hoặc mở lại trình duyệt, dữ liệu vẫn được bảo toàn nguyên vẹn.
- **Xuất Báo Cáo CSV**: Bấm nút **"📥 Xuất CSV"** để tải file báo cáo lịch sử đo nhiệt độ PCCC (tương thích mở ngay bằng Microsoft Excel).
- **Cooldown Chống Spam**: Nút gửi thử Gmail tự động kích hoạt đếm ngược 45 giây chống spam hòm thư, đảm bảo hoạt động an toàn theo chính sách Google SMTP.

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
