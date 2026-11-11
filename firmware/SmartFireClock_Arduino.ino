/*
  =============================================================================
  DỰ ÁN: SMART DIGITAL CLOCK & THERMAL FIRE ALARM SYSTEM (IoT 102)
  FIRMWARE ARDUINO UNO R3 / NANO (NÂNG CẤP TOÀN DIỆN V2.5)
  -----------------------------------------------------------------------------
  Linh kiện kết nối:
  1. Module Đồng hồ Thời gian thực RTC DS3231 (Giao tiếp I2C: SDA -> A4, SCL -> A5)
  2. Cảm biến Nhiệt độ LM35 Precision Centigrade Sensor (Chân Analog A0)
  3. Màn hình LCD 16x2 I2C (Địa chỉ 0x27 hoặc 0x3F, SDA -> A4, SCL -> A5)
  4. Còi Báo Động Active Buzzer (Chân Digital 8)
  5. Đèn LED Cảnh Báo Nguy Cơ Hỏa Hoạn (Chân Digital 7)
  6. Các nút bấm Chỉnh giờ & Tắt chuông (Chân D2, D3, D4 có lọc chống dội 50ms)
  7. Giao tiếp Web Serial USB 2 chiều với Dashboard Web (Baud rate 115200)
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
bool rtcInitialized = false;

// Biến trạng thái nhiệt độ và ngưỡng cảnh báo
float currentTemperature = 28.5;
float warningThreshold = 40.0;
float fireThreshold = 50.0;
bool isFireAlarmActive = false;
bool isWarningActive = false;
unsigned long fireAlarmStartTime = 0;

// Tính tốc độ tăng nhiệt độ (Rate-of-Rise Detection)
float prevTemperature = 28.5;
float rateOfRise = 0.0;
unsigned long lastRorCheckTime = 0;
const unsigned long ROR_INTERVAL_MS = 5000; // Đo delta mỗi 5 giây

// Cấu hình báo thức đồng hồ
bool isAlarmSet = false;
int alarmHour = 7;
int alarmMinute = 0;
bool isAlarmRinging = false;
unsigned long alarmStartTime = 0;

// Thử nghiệm còi Buzzer từ xa
bool isTestingBuzzer = false;
unsigned long testBuzzerStartTime = 0;
const unsigned long TEST_BUZZER_DURATION = 1500; // Thử còi trong 1.5 giây

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
  lcd.print("IoT 102 V2.5 OK ");
  
  // Khởi động RTC DS3231
  if (!rtc.begin()) {
    lcd.setCursor(0, 1);
    lcd.print("RTC DS3231 ERR!");
    Serial.println("{\"type\":\"SYS_ERROR\",\"error\":\"Không tìm thấy module RTC DS3231!\"}");
    rtcInitialized = false;
  } else {
    rtcInitialized = true;
    if (rtc.lostPower()) {
      rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
    }
  }

  // Khởi tạo mảng lọc trung bình LM35
  for (int i = 0; i < NUM_SAMPLES; i++) {
    tempSamples[i] = analogRead(PIN_LM35);
    delay(20);
  }

  prevTemperature = currentTemperature;
  lastRorCheckTime = millis();

  delay(1000);
  lcd.clear();
}

void loop() {
  DateTime now = rtcInitialized ? rtc.now() : DateTime(2026, 11, 11, 12, 0, 0);

  // 1. Đọc và lọc nhiễu nhiệt độ từ LM35
  readFilteredTemperature();

  // 2. Tính toán tốc độ biến thiên nhiệt độ (Rate-of-Rise)
  calculateRateOfRise();

  // 3. Kiểm tra điều kiện Cảnh báo & Báo Cháy
  checkFireAlarmConditions();

  // 4. Kiểm tra điều kiện Báo Thức
  checkClockAlarm(now);

  // 5. Kiểm tra thời gian thử còi (Test Buzzer)
  if (isTestingBuzzer) {
    if (millis() - testBuzzerStartTime < TEST_BUZZER_DURATION) {
      tone(PIN_BUZZER, 2400);
    } else {
      isTestingBuzzer = false;
      if (!isFireAlarmActive && !isAlarmRinging) {
        noTone(PIN_BUZZER);
      }
    }
  }

  // 6. Đọc nút bấm vật lý (Chống dội 50ms)
  handlePhysicalButtons(now);

  // 7. Cập nhật màn hình LCD 16x2
  updateLcdDisplay(now);

  // 8. Gửi telemetry JSON lên Dashboard Web qua cổng Serial USB (115200 bps)
  if (millis() - lastSerialSendTime >= SERIAL_INTERVAL) {
    lastSerialSendTime = millis();
    sendTelemetryToWeb(now);
  }

  // 9. Nhận lệnh điều khiển 2 chiều từ Dashboard Web
  handleWebCommands();
}

/**
 * Đọc điện áp cảm biến LM35 với bộ lọc trung bình trượt 10 mẫu (Moving Average)
 * Công thức chuẩn: Vout = ADC * (5000mV / 1023.0) -> Temp(°C) = Vout / 10mV/°C
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
 * Phát hiện nhiệt độ tăng nhanh bất thường (Rate-of-Rise)
 */
void calculateRateOfRise() {
  if (millis() - lastRorCheckTime >= ROR_INTERVAL_MS) {
    rateOfRise = currentTemperature - prevTemperature;
    prevTemperature = currentTemperature;
    lastRorCheckTime = millis();
  }
}

/**
 * Kiểm tra nguy cơ hỏa hoạn và kiểm soát còi hú
 */
void checkFireAlarmConditions() {
  // Trạng thái WARNING
  if (currentTemperature >= warningThreshold && currentTemperature < fireThreshold) {
    isWarningActive = true;
    digitalWrite(PIN_LED_FIRE, (millis() % 500 < 250) ? HIGH : LOW); // Nhấp nháy LED vàng/đỏ
  } else {
    isWarningActive = false;
  }

  // Trạng thái DANGER
  if (currentTemperature >= fireThreshold) {
    if (!isFireAlarmActive) {
      isFireAlarmActive = true;
      fireAlarmStartTime = millis();
      digitalWrite(PIN_LED_FIRE, HIGH);
    }

    // Còi hú báo động PCCC tần số biến thiên liên tục
    tone(PIN_BUZZER, 1000 + 400 * sin((millis() % 1000) * 0.00628));
  } else if (currentTemperature <= (fireThreshold - 3.0)) {
    // Độ trễ đóng ngắt (Hysteresis 3 độ C)
    if (isFireAlarmActive) {
      isFireAlarmActive = false;
      digitalWrite(PIN_LED_FIRE, LOW);
      if (!isAlarmRinging && !isTestingBuzzer) {
        noTone(PIN_BUZZER);
      }
    }
  }
}

/**
 * Kiểm tra báo thức đồng hồ
 */
void checkClockAlarm(DateTime now) {
  if (isAlarmSet && !isAlarmRinging && !isFireAlarmActive) {
    if (now.hour() == alarmHour && now.minute() == alarmMinute && now.second() == 0) {
      isAlarmRinging = true;
      alarmStartTime = millis();
    }
  }

  if (isAlarmRinging && !isFireAlarmActive) {
    // Tiếng bíp bíp ngắt quãng đồng hồ số
    if ((millis() % 600) < 150) {
      tone(PIN_BUZZER, 2093); // Nốt C7
    } else {
      noTone(PIN_BUZZER);
    }
  }
}

/**
 * Đọc nút bấm phần cứng có khử rung phím (Debounce 50ms)
 */
void handlePhysicalButtons(DateTime now) {
  // Nút D4: Tắt còi báo cháy hoặc chuông báo thức tại chỗ
  if (digitalRead(PIN_BTN_STOP) == LOW) {
    delay(50); // Khử rung
    if (digitalRead(PIN_BTN_STOP) == LOW) {
      isAlarmRinging = false;
      // Chỉ cho phép tắt còi nếu nhiệt độ thực tế đã hạ dưới ngưỡng nguy hiểm
      if (currentTemperature < fireThreshold) {
        isFireAlarmActive = false;
        digitalWrite(PIN_LED_FIRE, LOW);
        noTone(PIN_BUZZER);
      }
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
  } else if (isWarningActive) {
    lcd.print("CANHBAO");
  } else {
    lcd.print("AN TOAN");
  }
}

/**
 * Truyền dữ liệu định dạng JSON chuẩn qua Serial 115200 bps
 */
void sendTelemetryToWeb(DateTime now) {
  char timeBuf[12];
  snprintf(timeBuf, sizeof(timeBuf), "%02d:%02d:%02d", now.hour(), now.minute(), now.second());

  const char* buzzerStatusStr = "READY";
  if (isFireAlarmActive) buzzerStatusStr = "ACTIVE";
  else if (isAlarmRinging) buzzerStatusStr = "RINGING";
  else if (isTestingBuzzer) buzzerStatusStr = "TESTING";

  Serial.print("{\"type\":\"TELEMETRY\",\"temperature\":");
  Serial.print(currentTemperature, 1);
  Serial.print(",\"threshold\":");
  Serial.print(fireThreshold, 1);
  Serial.print(",\"warningThreshold\":");
  Serial.print(warningThreshold, 1);
  Serial.print(",\"rateOfRise\":");
  Serial.print(rateOfRise, 1);
  Serial.print(",\"time\":\"");
  Serial.print(timeBuf);
  Serial.print("\",\"isFire\":");
  Serial.print(isFireAlarmActive ? "true" : "false");
  Serial.print(",\"isWarning\":");
  Serial.print(isWarningActive ? "true" : "false");
  Serial.print(",\"isAlarmRinging\":");
  Serial.print(isAlarmRinging ? "true" : "false");
  Serial.print(",\"isAlarmSet\":");
  Serial.print(isAlarmSet ? "true" : "false");
  Serial.print(",\"buzzerState\":\"");
  Serial.print(buzzerStatusStr);
  Serial.print("\",\"rtcOk\":");
  Serial.print(rtcInitialized ? "true" : "false");
  Serial.println("}");
}

/**
 * Nhận lệnh điều khiển 2 chiều từ Dashboard Web qua cổng USB Serial
 */
void handleWebCommands() {
  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.length() == 0) return;

    if (cmd.startsWith("SYNC_TIME:")) {
      // Lệnh: SYNC_TIME:YYYY,MM,DD,HH,MM,SS
      String timeData = cmd.substring(10);
      int y, m, d, h, mi, s;
      if (sscanf(timeData.c_str(), "%d,%d,%d,%d,%d,%d", &y, &m, &d, &h, &mi, &s) == 6) {
        if (rtcInitialized) {
          rtc.adjust(DateTime(y, m, d, h, mi, s));
          Serial.println("{\"type\":\"CMD_ACK\",\"action\":\"SYNC_TIME\",\"status\":\"OK\"}");
        }
      }
    } else if (cmd.startsWith("SET_THRESH:")) {
      // Lệnh: SET_THRESH:WARN,DANGER
      String params = cmd.substring(11);
      float w, dg;
      if (sscanf(params.c_str(), "%f,%f", &w, &dg) == 2) {
        warningThreshold = w;
        fireThreshold = dg;
        Serial.println("{\"type\":\"CMD_ACK\",\"action\":\"SET_THRESH\",\"status\":\"OK\"}");
      }
    } else if (cmd == "TEST_BUZZER") {
      isTestingBuzzer = true;
      testBuzzerStartTime = millis();
      Serial.println("{\"type\":\"CMD_ACK\",\"action\":\"TEST_BUZZER\",\"status\":\"OK\"}");
    } else if (cmd == "STOP_ALARM") {
      isAlarmRinging = false;
      if (currentTemperature < fireThreshold) {
        isFireAlarmActive = false;
        noTone(PIN_BUZZER);
      }
      Serial.println("{\"type\":\"CMD_ACK\",\"action\":\"STOP_ALARM\",\"status\":\"OK\"}");
    } else if (cmd == "TEST_FIRE") {
      currentTemperature = 65.5; // Mô phỏng quá nhiệt để test
      Serial.println("{\"type\":\"CMD_ACK\",\"action\":\"TEST_FIRE\",\"status\":\"OK\"}");
    } else if (cmd == "RESET_FIRE") {
      currentTemperature = 28.5;
      isFireAlarmActive = false;
      noTone(PIN_BUZZER);
      Serial.println("{\"type\":\"CMD_ACK\",\"action\":\"RESET_FIRE\",\"status\":\"OK\"}");
    } else if (cmd == "PING") {
      Serial.println("{\"type\":\"PONG\",\"uptime\":");
      Serial.print(millis());
      Serial.println("}");
    }
  }
}
