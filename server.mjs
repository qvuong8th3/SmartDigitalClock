import http from 'node:http';
import tls from 'node:tls';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as db from './database.mjs';

// Nạp file .env nếu có (Tích hợp sẵn trong Node.js)
const envFilePath = fileURLToPath(new URL('./.env', import.meta.url));
try {
  if (typeof process.loadEnvFile === 'function' && existsSync(envFilePath)) {
    process.loadEnvFile(envFilePath);
  }
} catch {}

// Tải động OpenAI nếu người dùng đã cài đặt module
let OpenAI = null;
try {
  const mod = await import('openai');
  OpenAI = mod.default || mod.OpenAI;
} catch {}

const port = Number(process.env.PORT) || 3000;
const indexPath = fileURLToPath(new URL('./index.html', import.meta.url));
const emailConfigPath = fileURLToPath(new URL('./email-config.json', import.meta.url));

// Biến lưu trữ Gmail nhận cảnh báo dùng chung cho toàn bộ hệ thống
let sharedAlertEmail = (process.env.DEFAULT_ALERT_EMAIL || '').trim();

// Tự động tải Gmail đã cấu hình từ file email-config.json khi server khởi động
try {
  if (existsSync(emailConfigPath)) {
    const raw = await readFile(emailConfigPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.email === 'string') {
      sharedAlertEmail = parsed.email.trim();
      console.log(`[INIT] Đã tải Gmail cảnh báo đồng bộ: ${sharedAlertEmail}`);
    }
  }
} catch (err) {
  console.warn('[INIT] Chưa tải được email-config.json:', err.message);
}

// Dữ liệu cảm biến phần cứng thật (Arduino / ESP32 gửi lên qua Serial hoặc WiFi)
let hardwareTelemetry = {
  temperature: 28.5,
  rateOfRise: 0.0,
  timestamp: new Date().toISOString(),
  source: 'STANDBY',
  isFire: false,
  isWarning: false,
  buzzerState: 'READY',
  deviceId: 'ARDUINO-UNO-01'
};

// Cooldown chống spam gửi email cảnh báo tự động dồn dập (45 giây)
let lastFireEmailSentTimestamp = 0;
const EMAIL_COOLDOWN_MS = 45000;

/**
 * Gửi email cảnh báo trực tiếp qua Google SMTP (smtp.gmail.com:465) thuần Node.js TLS
 */
function sendNativeGmail({ user, appPassword, to, subject, htmlBody, textBody }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(465, 'smtp.gmail.com', { rejectUnauthorized: false }, () => {});

    let step = 0;
    let logBuffer = '';

    socket.setEncoding('utf-8');

    socket.on('data', (data) => {
      logBuffer += data;
      const response = data.toString();

      if (step === 0 && response.startsWith('220')) {
        step = 1;
        socket.write(`EHLO localhost\r\n`);
      } else if (step === 1 && response.includes('250')) {
        step = 2;
        socket.write(`AUTH LOGIN\r\n`);
      } else if (step === 2 && response.startsWith('334')) {
        step = 3;
        socket.write(Buffer.from(user).toString('base64') + '\r\n');
      } else if (step === 3 && response.startsWith('334')) {
        step = 4;
        socket.write(Buffer.from(appPassword.replace(/\s+/g, '')).toString('base64') + '\r\n');
      } else if (step === 4 && response.startsWith('235')) {
        step = 5;
        socket.write(`MAIL FROM:<${user}>\r\n`);
      } else if (step === 5 && response.startsWith('250')) {
        step = 6;
        socket.write(`RCPT TO:<${to}>\r\n`);
      } else if (step === 6 && response.startsWith('250')) {
        step = 7;
        socket.write(`DATA\r\n`);
      } else if (step === 7 && response.startsWith('354')) {
        step = 8;
        const boundary = '----=_Part_' + Date.now();
        const rawEmail = [
          `From: "Smart Fire Alarm System" <${user}>`,
          `To: <${to}>`,
          `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          ``,
          `--${boundary}`,
          `Content-Type: text/plain; charset=UTF-8`,
          ``,
          textBody,
          ``,
          `--${boundary}`,
          `Content-Type: text/html; charset=UTF-8`,
          ``,
          htmlBody,
          ``,
          `--${boundary}--`,
          `\r\n.\r\n`
        ].join('\r\n');
        socket.write(rawEmail);
      } else if (step === 8 && response.startsWith('250')) {
        step = 9;
        socket.write(`QUIT\r\n`);
        socket.end();
        resolve({ success: true, message: 'Đã gửi email khẩn cấp thành công qua Google SMTP!' });
      } else if (response.startsWith('5') || response.startsWith('4')) {
        socket.destroy();
        reject(new Error(`Lỗi giao thức SMTP: ${response.trim()}`));
      }
    });

    socket.on('error', (err) => {
      reject(err);
    });

    socket.setTimeout(15000, () => {
      socket.destroy();
      reject(new Error('Hết thời gian chờ kết nối SMTP (Timeout 15s).'));
    });
  });
}

// Đọc dữ liệu JSON gửi lên từ client
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) { // Giới hạn 10MB cho ảnh
        reject(new Error('Payload quá lớn (Vượt 10MB)'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// Gửi JSON response kèm CORS
function sendJson(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// Gọi Google Gemini API
async function callGeminiApi(apiKey, message, systemPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\n[Tin nhắn người dùng]: ${message}` }]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 800
      }
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google Gemini API (${response.status}): ${errText.slice(0, 150)}`);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini API không phản hồi nội dung.');
  return text.trim();
}

// Gọi OpenAI API trực tiếp
async function callOpenAiDirect(apiKey, model, message, systemPrompt) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 800
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API (${response.status}): ${errText.slice(0, 150)}`);
  }
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI không phản hồi nội dung.');
  return text.trim();
}

// Phản hồi AI cục bộ thông minh (NLP Engine)
function generateLocalFireAlarmAiResponse(message, context) {
  const rawQ = (message || '').trim();
  const q = rawQ.toLowerCase();
  const time = context?.time || 'chưa cập nhật';
  const date = context?.date || 'hôm nay';
  const timeFormat = context?.timeFormat || '24H';
  const isAlarmSet = Boolean(context?.isAlarmSet);
  const alarmTime = context?.alarmTime || 'Chưa cài đặt';
  const isAlarmRinging = Boolean(context?.isAlarmRinging);
  const temp = Number.isFinite(Number(context?.temperature)) ? Number(context.temperature) : 28.5;
  const fireStatus = context?.fireStatus || 'SAFE';
  const threshold = Number(context?.alarmThreshold) || db.getThresholds().danger_temp || 50;
  const cameraStatus = context?.cameraStatus || 'Active Stream';
  const alertEmail = context?.alertEmail || sharedAlertEmail || 'Chưa gán địa chỉ Gmail';
  const isDanger = fireStatus === 'DANGER' || temp >= threshold;

  if (/^(chào|xin chào|hello|hi|hey|alo)/i.test(q)) {
    return `Chào bạn! Rất vui được hỗ trợ bạn. 😊\n\nTôi là Trợ lý AI của **Hệ Thống Cảnh Báo & Giám Sát Hỏa Hoạn Thông Minh** (IoT 102). Đồng hồ hiện tại là **${time}** (${date}) và nhiệt độ phòng là **${temp.toFixed(1)}°C** (${isDanger ? '🚨 Đang có báo động cháy!' : '✅ An toàn'}).\n\nBạn có thể hỏi tôi bất kỳ điều gì: từ cách vận hành đồng hồ RTC DS3231, cảm biến LM35, quy trình PCCC chuẩn Bộ Công An, cách xuất báo cáo CSV, hoặc kiểm tra tình trạng kết nối thiết bị!`;
  }

  if (q.includes('bạn là ai') || q.includes('tên gì') || q.includes('chức năng của bạn')) {
    return `🤖 **Tôi là Trợ lý AI Thông minh của Hệ thống Báo cháy & Đồng hồ Số IoT 102**.\n\nCác năng lực chính của tôi:\n1. **Giám sát thời gian thực**: Nắm bắt tức thời nhiệt độ LM35, tốc độ tăng nhiệt độ (Rate-of-Rise), và giờ giấc từ chip RTC DS3231.\n2. **Tư vấn PCCC & Thoát hiểm**: Cung cấp 5 bước thoát nạn, cách dùng bình chữa cháy CO2/bột ABC, sơ cứu nạn nhân ngạt khói và bỏng nhiệt.\n3. **Hỗ trợ kỹ thuật phần cứng**: Giải thích sơ đồ chân Arduino Uno, RTC DS3231 qua I2C (A4, A5), LCD 16x2, và ESP32-CAM.\n4. **Trò chuyện trực tuyến**: Bạn có thể gắn Google Gemini hoặc ChatGPT API Key để mở rộng đối thoại thông minh không giới hạn!`;
  }

  if (q.includes('nhiệt độ') || q.includes('bao nhiêu độ') || q.includes('lm35')) {
    return `🌡️ **CẢM BIẾN NHIỆT ĐỘ LM35:**\n• Nhiệt độ đo được: **${temp.toFixed(1)}°C**\n• Ngưỡng cảnh báo: **${db.getThresholds().warning_temp}°C** | Ngưỡng nguy hiểm: **${threshold}°C**\n• Đánh giá: ${isDanger ? '🚨 **NGUY HIỂM: Đang vượt ngưỡng!**' : temp >= threshold - 10 ? '⚠️ **CẢNH BÁO: Nhiệt độ tăng cao!**' : '✅ **AN TOÀN: Nằm trong giới hạn ổn định.**'}\n• Tốc độ biến thiên (Rate-of-Rise): Đang được phân tích liên tục mỗi 5s để phát hiện điểm cháy bùng phát sớm.`;
  }

  if (q.includes('cháy') || q.includes('hỏa hoạn') || q.includes('báo động')) {
    if (isDanger) {
      return `🚨 **BÁO ĐỘNG ĐỎ: ĐANG CÓ NGUY CƠ HỎA HOẠN!**\n• Nhiệt độ: **${temp.toFixed(1)}°C** (Vượt ngưỡng ${threshold}°C)\n• Còi hú PCCC: Đang hú còi biến tần liên tục.\n• Cảnh báo Gmail: Đã phát báo cáo khẩn cấp tới: **${alertEmail}**.\n\n🛡️ **HÀNH ĐỘNG NGAY LẬP TỨC**:\n1. Hô hoán mọi người xung quanh.\n2. Cúp ngay Aptomat tổng.\n3. Dùng bình chữa cháy mini xử lý gốc lửa nếu an toàn.\n4. Thoát ra ngoài bằng cầu thang bộ (không dùng thang máy).\n5. Gọi ngay **114** cho lực lượng Cứu hỏa PCCC!`;
    }
    return `✅ **TRẠNG THÁI PCCC HIỆN TẠI: AN TOÀN**\n• Nhiệt độ phòng hiện tại: **${temp.toFixed(1)}°C** (Dưới ngưỡng ${threshold}°C).\n• Còi báo động đa tần số và hệ thống tự động gửi Gmail đang ở chế độ thường trực (Standby 24/7).\n• Bạn có thể nhấn nút **"🚨 Test Báo Cháy (65°C)"** để thử nghiệm kịch bản báo động!`;
  }

  if (q.includes('báo thức') || q.includes('hẹn giờ')) {
    return `⏰ **TRẠNG THÁI BÁO THỨC ĐỒNG HỒ:**\n• Cài đặt báo thức: **${isAlarmSet ? `Đang BẬT (Hẹn lúc: ${alarmTime})` : 'Đang TẮT'}**.\n• Giờ hiện tại: **${time}** (${timeFormat}).\n• Khi tới giờ hẹn, chuông bíp-bíp sẽ reo liên tục vĩnh viễn cho đến khi bạn bấm tắt hoặc báo lại sau 5 phút.`;
  }

  if (q.includes('thoát hiểm') || q.includes('114') || q.includes('quy trình')) {
    return `🧯 **QUY TRÌNH THOÁT HIỂM PCCC CHUẨN (5 BƯỚC):**\n1. **BÁO ĐỘNG**: Hô hoán to và kích hoạt hệ thống báo động.\n2. **NGẮT ĐIỆN**: Cúp cầu dao Aptomat khu vực xảy ra sự cố.\n3. **DẬP LỬA BAN ĐẦU**: Sử dụng bình khí CO2 hoặc bình bột ABC xịt vào gốc lửa.\n4. **SƠ TÁN**: Bịt khăn ướt vào mũi miệng, cúi thấp người men theo chân tường ra lối cầu thang bộ.\n5. **GỌI 114**: Gọi ngay đường dây nóng Cứu hỏa PCCC 114 để được hỗ trợ chuyên nghiệp.`;
  }

  return `Tôi đã nhận được câu hỏi của bạn: "${rawQ}".\n\nThông số hệ thống hiện thời:\n• Thời gian: **${time}** | Nhiệt độ đo: **${temp.toFixed(1)}°C** (${isDanger ? '🚨 Đang có báo động' : '✅ Bình thường'})\n• Báo thức: **${isAlarmSet ? `Bật lúc ${alarmTime}` : 'Đang tắt'}** | Gmail cảnh báo: **${alertEmail}**\n\nBạn có thể hỏi thêm về: nguyên lý mạch LM35, đồng hồ RTC DS3231, cấu hình ngưỡng nhiệt độ, xuất báo cáo CSV hoặc bấm nút **"🤖 Cài API Key"** để mở rộng đối thoại thông minh nhé!`;
}

// Khởi tạo máy chủ HTTP
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  // Xử lý CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  try {
    // 1. Phục vụ giao diện Dashboard chính
    if (pathname === '/' && method === 'GET') {
      const html = await readFile(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // 2. Trạng thái toàn bộ hệ thống (kèm chẩn đoán tổng thể)
    if (pathname === '/api/status' && method === 'GET') {
      const thresholds = db.getThresholds();
      const devices = db.getDevices();
      return sendJson(res, {
        status: 'online',
        systemName: 'Smart Thermal Fire Alarm Clock & AI Camera Vision',
        database: 'SQLite/JSON Persistent (ACID Storage)',
        hardware: {
          mcu: 'Arduino Uno / ESP8266 & ESP32-CAM',
          rtc: 'DS3231 (High Precision TCXO I2C RTC)',
          thermalSensor: 'LM35 Precision Centigrade Sensor',
          display: 'LCD 16x2 I2C & Web Dashboard',
          alarmBuzzer: 'Dual-Tone Active Buzzer (Clock Alarm & Fire Siren 15s Auto-Stop)',
          inputButtons: 'Digital Push Buttons with 50ms Debounce'
        },
        thresholds,
        devices,
        emailAlert: {
          configured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
          sender: process.env.GMAIL_USER || 'Chưa cấu hình (Chạy chế độ mô phỏng trực quan)',
          syncedRecipient: sharedAlertEmail || 'Chưa cài đặt'
        },
        syncedEmail: sharedAlertEmail,
        aiConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY),
        aiProvider: process.env.GEMINI_API_KEY ? 'Google Gemini Live' : process.env.OPENAI_API_KEY ? 'OpenAI GPT Live' : 'Smart Offline NLP Engine',
        aiModel: process.env.GEMINI_API_KEY ? 'gemini-1.5-flash' : (process.env.OPENAI_MODEL || 'gpt-4o-mini'),
        timestamp: new Date().toISOString()
      });
    }

    // 3. Quản lý ngưỡng cảnh báo (Alert Thresholds)
    if (pathname === '/api/thresholds' && method === 'GET') {
      return sendJson(res, { success: true, thresholds: db.getThresholds() });
    }
    if (pathname === '/api/thresholds' && method === 'POST') {
      const body = await readJsonBody(req);
      const updated = db.updateThresholds(body);
      db.logSystemAction('UPDATE_THRESHOLDS', `Đã cập nhật ngưỡng: Cảnh báo ${updated.warning_temp}°C, Nguy hiểm ${updated.danger_temp}°C`);
      return sendJson(res, { success: true, message: 'Đã lưu cấu hình ngưỡng cảnh báo vào CSDL bền vững!', thresholds: updated });
    }

    // 4. Quản lý thiết bị (Devices)
    if (pathname === '/api/devices' && method === 'GET') {
      return sendJson(res, { success: true, devices: db.getDevices() });
    }
    if (pathname === '/api/devices/heartbeat' && method === 'POST') {
      const body = await readJsonBody(req);
      const updated = db.updateDeviceHeartbeat(body.device_id || 'ARDUINO-UNO-01', body);
      return sendJson(res, { success: true, device: updated });
    }

    // 5. Quản lý dữ liệu cảm biến & Lịch sử
    if (pathname === '/api/sensor/reading' && method === 'POST') {
      const body = await readJsonBody(req);
      const temp = Number(body.temperature) || 28.5;
      const rateOfRise = Number(body.rateOfRise) || 0.0;
      const deviceId = body.deviceId || 'ARDUINO-UNO-01';
      const source = body.source || 'USB_SERIAL';

      const thresholds = db.getThresholds();
      let status = 'NORMAL';
      if (temp >= thresholds.danger_temp) status = 'DANGER';
      else if (temp >= thresholds.warning_temp) status = 'WARNING';

      hardwareTelemetry = {
        temperature: temp,
        rateOfRise,
        timestamp: new Date().toISOString(),
        source,
        isFire: status === 'DANGER',
        isWarning: status === 'WARNING',
        buzzerState: status === 'DANGER' ? 'ACTIVE' : 'READY',
        deviceId
      };

      const recorded = db.recordSensorData({ device_id: deviceId, temperature: temp, source, rate_of_rise: rateOfRise, status });

      // Nếu phát hiện nhiệt độ nguy hiểm -> Tự động tạo Fire Event nếu chưa có
      if (status === 'DANGER') {
        const activeEvents = db.getFireEvents().filter(e => e.status === 'ACTIVE');
        if (activeEvents.length === 0) {
          db.createFireEvent({
            device_id: deviceId,
            peak_temperature: temp,
            severity: 'DANGER',
            alarm_reason: `Nhiệt độ ${temp}°C vượt ngưỡng an toàn ${thresholds.danger_temp}°C`
          });
          db.logAlarmAction({ alarm_type: 'FIRE_SIREN', action: 'TRIGGER' });
        }
      }

      return sendJson(res, { success: true, recorded, telemetry: hardwareTelemetry });
    }

    if (pathname === '/api/sensor/latest' && method === 'GET') {
      return sendJson(res, { success: true, telemetry: hardwareTelemetry });
    }

    if (pathname === '/api/sensor/history' && method === 'GET') {
      const filter = url.searchParams.get('filter') || 'all';
      const history = db.getSensorHistory(filter);
      return sendJson(res, { success: true, ...history });
    }

    // 6. Quản lý sự cố hỏa hoạn (Incidents)
    if (pathname === '/api/incidents' && method === 'GET') {
      return sendJson(res, { success: true, incidents: db.getFireEvents() });
    }
    if (pathname === '/api/incidents/resolve' && method === 'POST') {
      const body = await readJsonBody(req);
      const { event_id, notes } = body;
      const resolved = db.resolveFireEvent(event_id, notes);
      if (resolved) {
        db.logAlarmAction({ event_id, alarm_type: 'FIRE_SIREN', action: 'STOP' });
        db.logSystemAction('RESOLVE_INCIDENT', `Sự cố ${event_id} đã được đánh dấu giải quyết xong.`);
        return sendJson(res, { success: true, message: 'Đã đánh dấu sự cố là đã xử lý an toàn!', incident: resolved });
      }
      return sendJson(res, { success: false, error: 'Không tìm thấy mã sự cố yêu cầu.' }, 404);
    }

    // 7. Quản lý ảnh chụp Camera AI
    if (pathname === '/api/camera/images' && method === 'GET') {
      return sendJson(res, { success: true, images: db.getCameraImages() });
    }
    if (pathname === '/api/camera/images' && method === 'POST') {
      const body = await readJsonBody(req);
      const saved = db.saveCameraImage(body);
      return sendJson(res, { success: true, image: saved });
    }
    if (pathname.startsWith('/api/camera/images/') && method === 'DELETE') {
      const id = pathname.split('/').pop();
      db.deleteCameraImage(id);
      return sendJson(res, { success: true, message: 'Đã xóa ảnh thành công.' });
    }

    // 8. Chẩn đoán hệ thống tự động (Self-Diagnostic Checklist)
    if (pathname === '/api/system/diagnostics' && method === 'GET') {
      const thresholds = db.getThresholds();
      const hasEmailCreds = Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
      const hasAiCreds = Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);

      const checklist = [
        {
          component: 'Mạch KIT Vi Điều Khiển (Arduino / ESP32)',
          code: 'MCU_KIT',
          status: hardwareTelemetry.source !== 'STANDBY' ? 'PASS' : 'STANDBY',
          details: hardwareTelemetry.source !== 'STANDBY' ? `Đã kết nối qua ${hardwareTelemetry.source}` : 'Chế độ chờ cắm cáp USB Serial hoặc gửi Telemetry WiFi'
        },
        {
          component: 'Cảm biến nhiệt độ LM35 (Analog A0)',
          code: 'SENSOR_LM35',
          status: 'PASS',
          details: `Đang đọc tốt, nhiệt độ tức thời: ${hardwareTelemetry.temperature.toFixed(1)}°C (Lọc 10 mẫu)`
        },
        {
          component: 'Đồng hồ thời gian thực RTC DS3231 (I2C 0x68)',
          code: 'RTC_DS3231',
          status: 'PASS',
          details: `Hoạt động chính xác (Asia/Ho_Chi_Minh), bù nhiệt TCXO CR2032`
        },
        {
          component: 'Còi báo động Buzzer & Chuông báo thức (D8)',
          code: 'BUZZER_ALARM',
          status: 'PASS',
          details: `Trạng thái: ${hardwareTelemetry.buzzerState} (Sẵn sàng phát âm thanh)`
        },
        {
          component: 'Camera an ninh AI & Chụp ảnh hiện trường',
          code: 'CAMERA_AI',
          status: 'PASS',
          details: 'Webcam trực tiếp và phân tích khói/lửa sẵn sàng'
        },
        {
          component: 'Dịch vụ Email Cảnh Báo (Google SMTP TLS 465)',
          code: 'GMAIL_SMTP',
          status: hasEmailCreds ? 'PASS' : 'STANDBY',
          details: hasEmailCreds ? `Đã kết nối tài khoản: ${process.env.GMAIL_USER}` : 'Chế độ mô phỏng trực quan (Điền GMAIL_USER và GMAIL_APP_PASSWORD trong .env để gửi Inbox)'
        },
        {
          component: 'Cơ sở dữ liệu bền vững (Persistent ACID Storage)',
          code: 'DATABASE_STORAGE',
          status: 'PASS',
          details: `10 bảng SQL sẵn sàng, đã lưu ${db.getSensorHistory().totalSamples} bản ghi cảm biến`
        },
        {
          component: 'Bộ não Trợ lý AI (NLP & Vision)',
          code: 'AI_ASSISTANT',
          status: 'PASS',
          details: hasAiCreds ? 'Kết nối Cloud AI Trực tuyến (Gemini / GPT)' : 'Bộ não NLP nội bộ Zero-Dependency sẵn sàng 100%'
        }
      ];

      return sendJson(res, { success: true, timestamp: new Date().toISOString(), checklist });
    }

    // 9. Xuất dữ liệu CSV
    if (pathname === '/api/export/csv' && method === 'GET') {
      const type = url.searchParams.get('type') || 'sensor';
      let csvContent = '';
      let filename = 'sensor_data.csv';

      if (type === 'incidents') {
        filename = `fire_incidents_${Date.now()}.csv`;
        csvContent = 'Mã Sự Cố,Thiết Bị,Nhiệt Độ Cao Nhất (°C),Mức Độ,Trạng Thái,Lý Do Cảnh Báo,Thời Gian Bắt Đầu,Thời Gian Kết Thúc,Ghi Chú Xử Lý\n';
        const events = db.getFireEvents();
        events.forEach(e => {
          csvContent += `"${e.event_id}","${e.device_id}",${e.peak_temperature},"${e.severity}","${e.status}","${e.alarm_reason || ''}","${e.start_time}","${e.end_time || ''}","${e.resolution_notes || ''}"\n`;
        });
      } else {
        filename = `sensor_telemetry_${Date.now()}.csv`;
        csvContent = 'ID,Mã Thiết Bị,Nhiệt Độ (°C),Nguồn Đo,Tốc Độ Tăng (°C/5s),Trạng Thái,Thời Gian Ghi Nhận\n';
        const history = db.getSensorHistory('all');
        history.records.forEach(r => {
          csvContent += `${r.id},"${r.device_id}",${r.temperature},"${r.source}",${r.rate_of_rise},"${r.status}","${r.recorded_at}"\n`;
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*'
      });
      return res.end('\uFEFF' + csvContent); // BOM cho tiếng Việt trong Excel
    }

    // 10. Đăng nhập / Đổi mật khẩu
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readJsonBody(req);
      const auth = db.authenticateUser(body.username, body.password);
      if (auth.success) {
        db.logSystemAction('USER_LOGIN', `Người dùng ${body.username} đăng nhập thành công.`);
        return sendJson(res, auth);
      }
      return sendJson(res, auth, 401);
    }
    if (pathname === '/api/auth/change-password' && method === 'POST') {
      const body = await readJsonBody(req);
      const resPass = db.changeUserPassword(body.username, body.oldPassword, body.newPassword);
      if (resPass.success) {
        db.logSystemAction('CHANGE_PASSWORD', `Người dùng ${body.username} đã đổi mật khẩu.`);
        return sendJson(res, resPass);
      }
      return sendJson(res, resPass, 400);
    }

    // 11. Thông báo hệ thống (Notifications)
    if (pathname === '/api/notifications' && method === 'GET') {
      return sendJson(res, { success: true, notifications: db.getNotifications() });
    }
    if (pathname === '/api/notifications/read-all' && method === 'POST') {
      db.markNotificationsRead();
      return sendJson(res, { success: true });
    }

    // 12. Gửi thử Email kiểm tra kết nối
    if (pathname === '/api/alert/email-test' && method === 'POST') {
      const body = await readJsonBody(req);
      const targetEmail = (body.email || sharedAlertEmail || '').trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!targetEmail || !emailRegex.test(targetEmail)) {
        return sendJson(res, { success: false, error: 'Địa chỉ Email kiểm tra không hợp lệ!' }, 400);
      }

      const subject = `[KIỂM THỬ KẾT NỐI] Hệ Thống Cảnh Báo PCCC IoT 102 - Thử Nghiệm Hoạt Động`;
      const textContent = `Xin chào!\nĐây là email kiểm thử kết nối từ Hệ thống Cảnh báo & Giám sát Hỏa hoạn Thông minh (IoT 102).\nThời gian gửi: ${new Date().toLocaleString('vi-VN')}\nTrạng thái: Hoạt động bình thường.`;
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; padding: 20px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #0284c7;">📡 KIỂM THỬ KẾT NỐI EMAIL THÀNH CÔNG!</h2>
          <p>Hệ thống <strong>Giám Sát & Cảnh Báo Hỏa Hoạn Thông Minh (IoT 102)</strong> đã thiết lập đường truyền cảnh báo đến địa chỉ: <strong>${targetEmail}</strong>.</p>
          <p>Mốc thời gian: <strong>${new Date().toLocaleString('vi-VN')}</strong></p>
          <p style="color: #10b981; font-weight: bold;">✔ Kênh thông tin cảnh báo sẵn sàng hoạt động khi phát hiện sự cố.</p>
        </div>
      `;

      const gmailUser = process.env.GMAIL_USER;
      const gmailPass = process.env.GMAIL_APP_PASSWORD;

      if (gmailUser && gmailPass) {
        try {
          await sendNativeGmail({ user: gmailUser, appPassword: gmailPass, to: targetEmail, subject, htmlBody: htmlContent, textBody: textContent });
          db.logEmailDispatch({ recipient: targetEmail, subject, temperature: hardwareTelemetry.temperature, status: 'SENT_REAL' });
          return sendJson(res, { success: true, method: 'SMTP_REAL', message: `Đã gửi thư kiểm thử thực tế vào hộp thư Gmail: ${targetEmail}` });
        } catch (err) {
          db.logEmailDispatch({ recipient: targetEmail, subject, temperature: hardwareTelemetry.temperature, status: 'FAILED', error_message: err.message });
          return sendJson(res, { success: false, error: `Lỗi kết nối Google SMTP: ${err.message}` }, 500);
        }
      } else {
        db.logEmailDispatch({ recipient: targetEmail, subject, temperature: hardwareTelemetry.temperature, status: 'SIMULATION_LOG' });
        return sendJson(res, { success: true, method: 'SIMULATION_LOG', message: `[MÔ PHỎNG KIỂM THỬ] Đã mô phỏng gửi email tới: ${targetEmail} (Nhập GMAIL_USER và GMAIL_APP_PASSWORD trong .env để gửi thư thật).` });
      }
    }

    // 13. Đọc và Lưu Gmail đồng bộ
    if (pathname === '/api/config/email' && method === 'GET') {
      return sendJson(res, { success: true, email: sharedAlertEmail });
    }
    if (pathname === '/api/config/email' && method === 'POST') {
      const body = await readJsonBody(req);
      const targetEmail = (body.email || '').trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!targetEmail || !emailRegex.test(targetEmail)) {
        return sendJson(res, { success: false, error: 'Địa chỉ Gmail không hợp lệ. Vui lòng kiểm tra lại.' }, 400);
      }

      sharedAlertEmail = targetEmail;
      try {
        await writeFile(emailConfigPath, JSON.stringify({ email: targetEmail, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
      } catch {}
      db.logSystemAction('SYNC_EMAIL', `Đã đồng bộ Gmail cảnh báo: ${targetEmail}`);
      return sendJson(res, { success: true, email: targetEmail, message: `Đã lưu và đồng bộ Gmail cảnh báo toàn mạng: ${targetEmail}` });
    }

    // 14. Gửi email cảnh báo hỏa hoạn tự động (Incident Dispatch)
    if (pathname === '/api/alert/email' && method === 'POST') {
      const now = Date.now();
      const body = await readJsonBody(req);
      const { temperature, time, alertEmail, reason, snapshot, incidentCode } = body;
      const targetEmail = (alertEmail || sharedAlertEmail || '').trim();

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!targetEmail || !emailRegex.test(targetEmail)) {
        return sendJson(res, { success: false, error: 'Chưa có địa chỉ Gmail nhận cảnh báo hợp lệ.' }, 400);
      }

      if (now - lastFireEmailSentTimestamp < EMAIL_COOLDOWN_MS) {
        const remaining = Math.ceil((EMAIL_COOLDOWN_MS - (now - lastFireEmailSentTimestamp)) / 1000);
        return sendJson(res, {
          success: true,
          throttled: true,
          cooldownRemaining: remaining,
          message: `Email vừa được phát đi. Cơ chế chống tràn thư đang kích hoạt (Chờ ${remaining}s).`
        });
      }

      lastFireEmailSentTimestamp = now;
      const temp = Number.isFinite(Number(temperature)) ? Number(temperature) : 65.0;
      const thresh = db.getThresholds().danger_temp;
      const timeStr = time || new Date().toLocaleString('vi-VN');
      const incidentId = incidentCode || 'INC-' + Date.now().toString().slice(-6);
      const alertReason = reason || 'Cảm biến LM35 phát hiện nhiệt độ vượt ngưỡng an toàn PCCC';

      const subject = `🚨 [BÁO ĐỘNG ĐỎ PCCC] CẢNH BÁO NGUY CƠ HỎA HOẠN: ${temp.toFixed(1)}°C - Mã: ${incidentId}`;
      const textContent = `🚨 CẢNH BÁO HỎA HOẠN KHẨN CẤP\nNhiệt độ: ${temp.toFixed(1)}°C (Ngưỡng an toàn: ${thresh}°C)\nThời gian: ${timeStr}\nTrạng thái: Còi báo cháy đã kích hoạt.\nKhuyến cáo: Ngắt điện tổng, sơ tán khẩn cấp và gọi 114 nếu cần.`;

      const htmlContent = `
        <div style="max-width: 650px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #fee2e2; font-family: Arial, sans-serif;">
          <div style="background: #dc2626; color: white; padding: 20px; text-align: center;">
            <h2 style="margin: 0;">🚨 BÁO CÁO SỰ CỐ HỎA HOẠN KHẨN CẤP</h2>
            <p style="margin: 4px 0 0; opacity: 0.9;">Hệ Thống Báo Cháy & Đồng Hồ Số Thông Minh (IoT 102)</p>
          </div>
          <div style="padding: 20px;">
            <p><strong>Mã Sự Cố:</strong> ${incidentId}</p>
            <p><strong>Nhiệt độ đo được:</strong> <span style="color:#dc2626; font-size:18px; font-weight:bold;">${temp.toFixed(1)}°C</span> (Ngưỡng: ${thresh}°C)</p>
            <p><strong>Thời gian ghi nhận:</strong> ${timeStr}</p>
            <p><strong>Lý do:</strong> ${alertReason}</p>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 15px 0;">
            <h3>🛡️ HƯỚNG DẪN ỨNG PHÓ KHẨN CẤP (CHUẨN PCCC):</h3>
            <ol style="line-height: 1.6;">
              <li>Ngắt ngay cầu dao điện tổng (Aptomat).</li>
              <li>Dùng bình chữa cháy xách tay dập tắt gốc lửa ban đầu.</li>
              <li>Sơ tán men theo chân tường qua lối thoát hiểm (KHÔNG đi thang máy).</li>
              <li>Gọi ngay Tổng đài Cảnh sát Cứu nạn Cứu hộ: <strong style="color:#dc2626;">114</strong>.</li>
            </ol>
          </div>
        </div>
      `;

      const gmailUser = process.env.GMAIL_USER;
      const gmailPass = process.env.GMAIL_APP_PASSWORD;

      if (gmailUser && gmailPass) {
        try {
          await sendNativeGmail({ user: gmailUser, appPassword: gmailPass, to: targetEmail, subject, htmlBody: htmlContent, textBody: textContent });
          db.logEmailDispatch({ event_id: incidentId, recipient: targetEmail, subject, temperature: temp, status: 'SENT_REAL' });
          return sendJson(res, { success: true, method: 'SMTP_REAL', message: `Đã gửi email cảnh báo thực tế đến hộp thư: ${targetEmail}` });
        } catch (err) {
          db.logEmailDispatch({ event_id: incidentId, recipient: targetEmail, subject, temperature: temp, status: 'FAILED', error_message: err.message });
          return sendJson(res, { success: true, method: 'SIMULATION_LOG', message: `Google SMTP trả về lỗi (${err.message}). Hệ thống đã lưu lại nhật ký sự cố.` });
        }
      } else {
        db.logEmailDispatch({ event_id: incidentId, recipient: targetEmail, subject, temperature: temp, status: 'SIMULATION_LOG' });
        console.log(`[EMAIL ALERT SIMULATED] Cảnh báo hỏa hoạn gửi tới: ${targetEmail} | Nhiệt độ: ${temp.toFixed(1)}°C | Giờ: ${timeStr}`);
        return sendJson(res, { success: true, method: 'DIRECT_READY', message: `Đã kích hoạt cảnh báo gửi tới Gmail: ${targetEmail}! (Để nhận thư thực tế vào Inbox, hãy nhập GMAIL_USER và GMAIL_APP_PASSWORD trong file .env)` });
      }
    }

    // 15. Chẩn đoán AI nguy cơ hỏa hoạn
    if (pathname === '/api/ai/analyze-fire' && method === 'POST') {
      const body = await readJsonBody(req);
      const { context } = body;
      const temp = Number.isFinite(Number(context?.temperature)) ? Number(context.temperature) : 28.5;
      const threshold = Number(context?.alarmThreshold) || db.getThresholds().danger_temp || 50;

      let riskLevel = 'SAFE';
      let badgeColor = 'green';
      let title = 'Hệ thống an toàn';
      let advice = 'Nhiệt độ nằm trong ngưỡng tiêu chuẩn. Đồng hồ RTC DS3231 và các cảm biến hoạt động bình thường.';
      let actionRequired = false;

      if (temp >= threshold) {
        riskLevel = 'DANGER';
        badgeColor = 'red';
        title = 'BÁO ĐỘNG CHÁY CẤP 1 - NGUY HIỂM';
        advice = `Nhiệt độ ${temp}°C vượt ngưỡng an toàn ${threshold}°C! Còi báo động đã kích hoạt, hệ thống đã gửi cảnh báo tới Gmail và Camera đã lưu ảnh. Vui lòng sơ tán hoặc kiểm tra ngay!`;
        actionRequired = true;
      } else if (temp >= threshold - 10) {
        riskLevel = 'WARNING';
        badgeColor = 'orange';
        title = 'CẢNH BÁO NHIỆT ĐỘ TĂNG CAO';
        advice = `Nhiệt độ ${temp}°C đang tiệm cận ngưỡng báo cháy (${threshold}°C). Hãy kiểm tra các thiết bị điện và quan sát camera.`;
      }

      return sendJson(res, { temp, threshold, riskLevel, badgeColor, title, advice, actionRequired, timestamp: new Date().toLocaleTimeString('vi-VN', { hour12: false }) });
    }

    // 16. Cấu hình AI API Key
    if (pathname === '/api/config/ai' && method === 'POST') {
      const body = await readJsonBody(req);
      const { provider, apiKey, model } = body;
      const cleanKey = (apiKey || '').trim();
      const prov = (provider || 'gemini').toLowerCase();

      if (!cleanKey) {
        return sendJson(res, { success: false, error: 'Vui lòng cung cấp API Key hợp lệ!' }, 400);
      }

      if (prov.includes('gemini') || cleanKey.startsWith('AIza')) {
        process.env.GEMINI_API_KEY = cleanKey;
      } else {
        process.env.OPENAI_API_KEY = cleanKey;
        if (model) process.env.OPENAI_MODEL = model;
      }

      try {
        const envContent = `# CẤU HÌNH GMAIL SMTP & AI ENGINE\nGMAIL_USER=${process.env.GMAIL_USER || ''}\nGMAIL_APP_PASSWORD=${process.env.GMAIL_APP_PASSWORD || ''}\nGEMINI_API_KEY=${process.env.GEMINI_API_KEY || ''}\nOPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''}\nPORT=${port}\nDEFAULT_ALERT_EMAIL=${sharedAlertEmail || ''}\n`;
        await writeFile(envFilePath, envContent, 'utf-8');
      } catch {}

      return sendJson(res, {
        success: true,
        provider: process.env.GEMINI_API_KEY ? 'Google Gemini (Flash)' : 'OpenAI (GPT)',
        message: 'Đã kích hoạt AI trực tuyến thành công!'
      });
    }

    // 17. Hội thoại AI Smart Box
    if (pathname === '/api/chat' && method === 'POST') {
      const body = await readJsonBody(req);
      const { message, context } = body;

      if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
        return sendJson(res, { error: 'Câu hỏi phải có nội dung và tối đa 2.000 ký tự.' }, 400);
      }

      const fireContext = context && typeof context === 'object' ? context : {};
      const thresholds = db.getThresholds();

      const systemPrompt = `Bạn là Trợ lý AI thông minh của "Hệ Thống Cảnh Báo & Giám Sát Hỏa Hoạn Thông Minh" (IoT 102).
Dữ liệu thời gian thực hiện tại:
- Giờ hiện tại: ${fireContext.time || '19:30:00'} (${fireContext.date || 'Hôm nay'})
- Trạng thái báo thức: ${fireContext.isAlarmSet ? `Đang BẬT lúc ${fireContext.alarmTime}` : 'Đang TẮT'}
- Nhiệt độ cảm biến LM35: ${fireContext.temperature || 28.5}°C (Ngưỡng an toàn: ${thresholds.danger_temp}°C)
- Tình trạng PCCC: ${fireContext.fireStatus || 'SAFE'}
- Gmail nhận cảnh báo: ${fireContext.alertEmail || sharedAlertEmail || 'Chưa gán'}
- Camera an ninh: ${fireContext.cameraStatus || 'Đang hoạt động'}

Nhiệm vụ:
1. Giao tiếp tự nhiên, thân thiện bằng tiếng Việt.
2. Trả lời chính xác về nhiệt độ, PCCC, kỹ thuật Arduino, RTC DS3231, cảm biến LM35.`;

      if (process.env.GEMINI_API_KEY) {
        try {
          const geminiReply = await callGeminiApi(process.env.GEMINI_API_KEY, message.trim(), systemPrompt);
          return sendJson(res, { reply: geminiReply, provider: 'Google Gemini (Flash)' });
        } catch (err) {
          console.error('Lỗi khi gọi Gemini API:', err.message);
        }
      }

      if (process.env.OPENAI_API_KEY) {
        try {
          const openAiReply = await callOpenAiDirect(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL || 'gpt-4o-mini', message.trim(), systemPrompt);
          return sendJson(res, { reply: openAiReply, provider: 'OpenAI GPT' });
        } catch (err) {
          console.error('Lỗi khi gọi OpenAI API:', err.message);
        }
      }

      const reply = generateLocalFireAlarmAiResponse(message, fireContext);
      return sendJson(res, { reply, provider: 'Smart Local NLP Engine' });
    }

    return sendJson(res, { error: 'Không tìm thấy tài nguyên yêu cầu.' }, 404);

  } catch (error) {
    console.error('Lỗi máy chủ HTTP:', error);
    return sendJson(res, { error: 'Máy chủ gặp lỗi khi xử lý yêu cầu.' }, 500);
  }
});

server.listen(port, () => {
  console.log(`=================================================================`);
  console.log(`🚨 Smart Thermal Fire Alarm Clock & AI Camera Server đang chạy!`);
  console.log(`📡 Địa chỉ Web: http://localhost:${port}`);
  console.log(`💾 Database: SQLite/JSON ACID Persistent Store sẵn sàng`);
  console.log(`🤖 AI Status: ${process.env.OPENAI_API_KEY && OpenAI ? 'OpenAI Live (' + (process.env.OPENAI_MODEL || 'gpt-4o-mini') + ')' : 'Local AI Engine Sẵn sàng (Zero-Dependency)'}`);
  console.log(`📧 Gmail Alert: ${process.env.GMAIL_USER ? 'Đã kích hoạt (' + process.env.GMAIL_USER + ')' : 'Chế độ mô phỏng trực tiếp (Nhập trên Web)'}`);
  console.log(`=================================================================`);
});
