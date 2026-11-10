/*
  =============================================================================
  DỰ ÁN: SMART DIGITAL CLOCK & THERMAL FIRE ALARM SYSTEM (IoT 102)
  FIRMWARE ARDUINO UNO R3 / NANO
  -----------------------------------------------------------------------------
  Linh kiện kết nối:
  1. Module Đồng hồ Thời gian thực RTC DS3231 (Giao tiếp I2C: SDA -> A4, SCL -> A5)
  2. Cảm biến Nhiệt độ LM35 Precision Centigrade Sensor (Chân Analog A0)
  3. Màn hình LCD 16x2 I2C (Địa chỉ 0x27 hoặc 0x3F, SDA -> A4, SCL -> A5)
  4. Còi Báo Động Active Buzzer (Chân Digital 8)
  5. Đèn LED Cảnh Báo Nguy Cơ Hỏa Hoạn (Chân Digital 7)
  6. Các nút bấm Chỉnh giờ & Tắt chuông (Chân D2, D3, D4 có lọc chống dội 50ms)
  7. Giao tiếp Web Serial USB với Dashboard Web (Baud rate 115200)
  =============================================================================
*/

#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "RTClib.h"

// Cấu hình chân phần cứng
const int PIN_LM35 = A0;
const int PIN_BUZZER = 8;
const int PIN_LED_FIRE = 7;
const int PIN_BTN_MODE = 2;
const int PIN_BTN_UP = 3;
const int PIN_BTN_STOP = 4;

// Địa chỉ màn hình LCD 16x2 I2C
LiquidCrystal_I2C lcd(0x27, 16, 2);
RTC_DS3231 rtc;

// Biến trạng thái hệ thống
float currentTemperature = 28.5;
float fireThreshold = 50.0;
bool isFireAlarmActive = false;
unsigned long fireAlarmStartTime = 0;
// Còi hú báo cháy kêu liên tục vĩnh viễn cho đến khi người dùng bấm nút tắt D4 hoặc nhiệt độ hạ

// Cấu hình báo thức
bool isAlarmSet = false;
int alarmHour = 7;
int alarmMinute = 0;
bool isAlarmRinging = false;
unsigned long alarmStartTime = 0;
// Chuông báo thức kêu liên tục vĩnh viễn cho đến khi người dùng bấm nút tắt D4

// Lọc nhiễu cảm biến LM35 (Moving Average Filter 10 mẫu)
const int NUM_SAMPLES = 10;
int tempSamples[NUM_SAMPLES];
int sampleIndex = 0;

// Bộ đếm chu kỳ gửi dữ liệu Serial
unsigned long lastSerialSendTime = 0;
const unsigned long SERIAL_INTERVAL = 1000; // Gửi dữ liệu lên Web mỗi 1 giây

void setup() {
  Serial.begin(115200);
  
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED_FIRE, OUTPUT);
  pinMode(PIN_BTN_MODE, INPUT_PULLUP);
  pinMode(PIN_BTN_UP, INPUT_PULLUP);
  pinMode(PIN_BTN_STOP, INPUT_PULLUP);
  
  digitalWrite(PIN_BUZZER, LOW);
  digitalWrite(PIN_LED_FIRE, LOW);

  // Khởi động màn hình LCD
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("SMART FIRE CLOCK");
  lcd.setCursor(0, 1);
  lcd.print("IoT 102 Booting.");
  
  // Khởi động RTC DS3231
  if (!rtc.begin()) {
    lcd.setCursor(0, 1);
    lcd.print("RTC DS3231 ERR!");
    Serial.println("{\"error\":\"Không tìm thấy module RTC DS3231!\"}");
  } else {
    if (rtc.lostPower()) {
      rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
    }
  }

  // Khởi tạo mảng lọc trung bình
  for (int i = 0; i < NUM_SAMPLES; i++) {
    tempSamples[i] = analogRead(PIN_LM35);
    delay(20);
  }

  delay(1200);
  lcd.clear();
}

void loop() {
  DateTime now = rtc.now();

  // 1. Đọc và lọc nhiễu nhiệt độ từ LM35
  readFilteredTemperature();

  // 2. Kiểm tra điều kiện Báo Cháy
  checkFireAlarmConditions();

  // 3. Kiểm tra điều kiện Báo Thức
  checkClockAlarm(now);

  // 4. Đọc nút bấm vật lý (Chống dội 50ms)
  handlePhysicalButtons(now);

  // 5. Cập nhật màn hình LCD 16x2
  updateLcdDisplay(now);

  // 6. Gửi dữ liệu JSON lên Dashboard Web qua cổng Serial USB (115200 bps)
  if (millis() - lastSerialSendTime >= SERIAL_INTERVAL) {
    lastSerialSendTime = millis();
    sendTelemetryToWeb(now);
  }

  // 7. Nhận lệnh điều khiển từ Dashboard Web (nếu có)
  handleWebCommands();
}

/**
 * Đọc điện áp cảm biến LM35 với bộ lọc trung bình trượt 10 mẫu (Moving Average)
 * Công thức: Vout = ADC * (5.0V / 1023.0) -> Temp(C) = Vout * 100.0
 */
void readFilteredTemperature() {
  tempSamples[sampleIndex] = analogRead(PIN_LM35);
  sampleIndex = (sampleIndex + 1) % NUM_SAMPLES;

  long sum = 0;
  for (int i = 0; i < NUM_SAMPLES; i++) {
    sum += tempSamples[i];
  }
  float avgAdc = (float)sum / NUM_SAMPLES;
  float millivolts = (avgAdc * 5000.0) / 1023.0;
  currentTemperature = millivolts / 10.0;
}

/**
 * Kiểm tra nguy cơ hỏa hoạn và kiểm soát còi hú kêu liên tục vĩnh viễn cho đến khi tắt
 */
void checkFireAlarmConditions() {
  if (currentTemperature >= fireThreshold) {
    if (!isFireAlarmActive) {
      isFireAlarmActive = true;
      fireAlarmStartTime = millis();
      digitalWrite(PIN_LED_FIRE, HIGH);
    }

    // Còi hú báo động PCCC kêu liên tục vĩnh viễn cho đến khi người dùng bấm nút tắt D4
    tone(PIN_BUZZER, 1000 + 400 * sin((millis() % 1000) * 0.00628));
  } else if (currentTemperature <= (fireThreshold - 3.0)) {
    // Trễ đóng ngắt (Hysteresis 3 độ C)
    if (isFireAlarmActive) {
      isFireAlarmActive = false;
      digitalWrite(PIN_LED_FIRE, LOW);
      noTone(PIN_BUZZER);
    }
  }
}

/**
 * Kiểm tra báo thức đồng hồ và reo liên tục vĩnh viễn cho đến khi người dùng bấm tắt
 */
void checkClockAlarm(DateTime now) {
  if (isAlarmSet && !isAlarmRinging && !isFireAlarmActive) {
    if (now.hour() == alarmHour && now.minute() == alarmMinute && now.second() == 0) {
      isAlarmRinging = true;
      alarmStartTime = millis();
    }
  }

  if (isAlarmRinging) {
    // Tiếng bíp bíp ngắt quãng đồng hồ số kêu liên tục vĩnh viễn cho đến khi bấm nút tắt D4
    if ((millis() % 600) < 150) {
      tone(PIN_BUZZER, 2093); // Nốt C7
    } else {
      noTone(PIN_BUZZER);
    }
  }
}

/**
 * Đọc nút bấm phần cứng có khử rung phím (Debounce)
 */
void handlePhysicalButtons(DateTime now) {
  // Nút D4: Tắt nhanh còi báo cháy hoặc chuông báo thức
  if (digitalRead(PIN_BTN_STOP) == LOW) {
    delay(50); // Khử rung 50ms
    if (digitalRead(PIN_BTN_STOP) == LOW) {
      isAlarmRinging = false;
      noTone(PIN_BUZZER);
      digitalWrite(PIN_LED_FIRE, LOW);
      while (digitalRead(PIN_BTN_STOP) == LOW);
    }
  }
}

/**
 * Hiển thị dữ liệu lên màn hình LCD 16x2
 */
void updateLcdDisplay(DateTime now) {
  static unsigned long lastLcdUpdate = 0;
  if (millis() - lastLcdUpdate < 300) return;
  lastLcdUpdate = millis();

  // Dòng 1: Giờ : Phút : Giây
  lcd.setCursor(0, 0);
  if (now.hour() < 10) lcd.print('0');
  lcd.print(now.hour());
  lcd.print(':');
  if (now.minute() < 10) lcd.print('0');
  lcd.print(now.minute());
  lcd.print(':');
  if (now.second() < 10) lcd.print('0');
  lcd.print(now.second());

  // Trạng thái Báo thức trên Dòng 1
  lcd.setCursor(11, 0);
  if (isAlarmRinging) {
    lcd.print("!RING");
  } else if (isAlarmSet) {
    lcd.print("AL:ON");
  } else {
    lcd.print("AL:OF");
  }

  // Dòng 2: Nhiệt độ LM35 và trạng thái PCCC
  lcd.setCursor(0, 1);
  lcd.print("T:");
  lcd.print(currentTemperature, 1);
  lcd.print((char)223); // Ký tự độ C
  lcd.print("C ");

  lcd.setCursor(9, 1);
  if (isFireAlarmActive) {
    lcd.print("!CHAY!");
  } else if (currentTemperature >= fireThreshold - 5.0) {
    lcd.print("CANHBAO");
  } else {
    lcd.print("AN TOAN");
  }
}

/**
 * Truyền dữ liệu định dạng JSON chuẩn qua Serial 115200 bps
 * Tương thích trực tiếp với Web Serial API của Dashboard HTML
 */
void sendTelemetryToWeb(DateTime now) {
  char timeBuf[12];
  snprintf(timeBuf, sizeof(timeBuf), "%02d:%02d:%02d", now.hour(), now.minute(), now.second());

  Serial.print("{\"type\":\"TELEMETRY\",\"temperature\":");
  Serial.print(currentTemperature, 1);
  Serial.print(",\"threshold\":");
  Serial.print(fireThreshold, 1);
  Serial.print(",\"time\":\"");
  Serial.print(timeBuf);
  Serial.print("\",\"isFire\":");
  Serial.print(isFireAlarmActive ? "true" : "false");
  Serial.print(",\"isAlarmRinging\":");
  Serial.print(isAlarmRinging ? "true" : "false");
  Serial.print(",\"isAlarmSet\":");
  Serial.print(isAlarmSet ? "true" : "false");
  Serial.println("}");
}

/**
 * Nhận lệnh từ Dashboard Web (đồng bộ 2 chiều qua cổng USB)
 */
void handleWebCommands() {
  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd == "STOP_ALARM") {
      isAlarmRinging = false;
      noTone(PIN_BUZZER);
    } else if (cmd == "TEST_FIRE") {
      currentTemperature = 65.5;
    } else if (cmd == "RESET_FIRE") {
      currentTemperature = 28.5;
      isFireAlarmActive = false;
      noTone(PIN_BUZZER);
    }
  }
}
