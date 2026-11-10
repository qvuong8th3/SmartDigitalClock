# 🛠️ TÀI LIỆU HƯỚNG DẪN KẾT NỐI PHẦN CỨNG & NẠP FIRMWARE (IoT 102)

## 1. Sơ đồ Đấu Nối Phần Cứng (Pinout Table)

### A. Arduino Uno R3 / Nano với các Module
| Linh kiện | Chân trên Module | Chân kết nối trên Arduino | Chức năng |
| :--- | :--- | :--- | :--- |
| **RTC DS3231** | VCC | 5V | Nguồn nuôi module thời gian thực |
| | GND | GND | Nối mass chung |
| | SDA | A4 (SDA) | Đường truyền dữ liệu I2C |
| | SCL | A5 (SCL) | Xung nhịp I2C |
| **LM35 Sensor** | Chân 1 (VCC) | 5V | Nguồn cấp cho cảm biến |
| | Chân 2 (Vout) | A0 (Analog) | Tín hiệu điện áp tỷ lệ với nhiệt độ (10mV/°C) |
| | Chân 3 (GND) | GND | Nối mass chung |
| **LCD 16x2 I2C** | VCC / GND | 5V / GND | Nguồn màn hình hiển thị |
| | SDA / SCL | A4 / A5 (Chung Bus I2C) | Giao tiếp hiển thị dữ liệu |
| **Active Buzzer** | Chân dương (+) | Digital Pin 8 | Phát còi hú báo cháy & chuông báo thức |
| | Chân âm (-) | GND | Nối mass |
| **LED Báo Cháy** | Anode (+) | Digital Pin 7 (qua trở 220Ω) | Đèn LED đỏ chớp khi có cháy |
| | Cathode (-) | GND | Nối mass |
| **Nút bấm khẩn** | Chân tín hiệu | Digital Pin 4 (D4) | Tắt nhanh còi báo cháy / chuông báo thức |
| | Chân còn lại | GND | Kích hoạt mức LOW (Input Pull-up) |

---

## 2. Các Thư viện Cần cài đặt trên Arduino IDE
1. `RTClib` (by Adafruit) - Quản lý module RTC DS3231.
2. `LiquidCrystal_I2C` (by Frank de Brabander) - Điều khiển LCD 16x2 qua giao tiếp I2C.
3. `Wire` (Tích hợp sẵn trong Arduino Core).

---

## 3. Giao thức Web Serial USB (Kết nối Trực Tiếp Dashboard Web)
* Tốc độ Baud: `115200` bps.
* Sau khi cắm cáp USB nối Arduino vào máy tính, mở Dashboard trên Chrome hoặc Edge và bấm nút **"📡 Kết Nối Cổng COM Serial"**.
* Dashboard sẽ tự động nhận các gói tin JSON định kỳ 1 giây/lần:
  ```json
  {"type":"TELEMETRY","temperature":28.5,"threshold":50.0,"time":"18:50:00","isFire":false,"isAlarmRinging":false,"isAlarmSet":false}
  ```
