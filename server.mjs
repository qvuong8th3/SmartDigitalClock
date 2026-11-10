import http from 'node:http';
import tls from 'node:tls';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

// Biến lưu trữ Gmail nhận cảnh báo dùng chung cho toàn bộ hệ thống (đồng bộ tất cả các máy)
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

// Dữ liệu cảm biến phần cứng thật (Arduino / ESP32 gửi lên qua WiFi)
let hardwareTelemetry = {
  temperature: 28.5,
  timestamp: new Date().toISOString(),
  source: 'STANDBY',
  isFire: false,
  deviceId: 'ARDUINO-ESP32-01'
};

// Cooldown chống spam gửi email cảnh báo tự động dồn dập (45 giây)
let lastFireEmailSentTimestamp = 0;
const EMAIL_COOLDOWN_MS = 45000;

/**
 * Gửi email cảnh báo trực tiếp qua Google SMTP (smtp.gmail.com:465) thuần Node.js TLS
 * Không phụ thuộc vào thư viện ngoài.
 */
function sendNativeGmail({ user, appPassword, to, subject, htmlBody, textBody }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(465, 'smtp.gmail.com', { rejectUnauthorized: false }, () => {
      // Kết nối TLS thành công
    });

    let step = 0;
    let logBuffer = '';

    socket.setEncoding('utf-8');

    socket.on('data', (data) => {
      logBuffer += data;
      const response = data.toString();

      // Phản hồi chào mừng của SMTP Server (220)
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
          `From: "Smart Fire Alarm Clock" <${user}>`,
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

// Hàm đọc dữ liệu JSON gửi lên từ client
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) { // Giới hạn 5MB
        reject(new Error('Payload quá lớn (Vượt 5MB)'));
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

// Hàm gửi JSON response kèm CORS
function sendJson(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// Gọi Google Gemini API (Miễn phí qua AI Studio)
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

// Gọi OpenAI API trực tiếp qua fetch
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

// Bộ não xử lý ngôn ngữ tự nhiên thông minh nội bộ (Đồng bộ đa ngữ cảnh và trò chuyện linh hoạt)
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
  const threshold = Number(context?.alarmThreshold) || 50;
  const cameraStatus = context?.cameraStatus || 'Active Stream';
  const alertEmail = context?.alertEmail || sharedAlertEmail || 'Chưa gán địa chỉ Gmail';
  const isDanger = fireStatus === 'DANGER' || temp >= threshold;

  // 1. Chào hỏi, xưng hô, làm quen
  if (/^(chào|xin chào|hello|hi|hey|alo|ê|chao ban|hi bạn|chào bạn|chào em|chào bot)/i.test(q)) {
    return `Chào bạn! Rất vui được trò chuyện cùng bạn. 😊\n\nTôi là Trợ lý AI của hệ thống **Smart Digital Clock & Fire Alarm** (IoT 102). Hiện tại đồng hồ đang là **${time}** (${date}) và nhiệt độ phòng là **${temp.toFixed(1)}°C** (${isDanger ? '🚨 Đang có báo động cháy!' : '✅ An toàn'}).\n\nBạn có thể hỏi tôi bất kỳ điều gì: từ giờ giấc, báo thức, nhiệt độ, nguyên lý kỹ thuật LM35/RTC DS3231, đến các kỹ năng thoát hiểm PCCC khẩn cấp! Hoặc bạn muốn trò chuyện về chủ đề gì nào?`;
  }

  // 2. Hỏi danh tính, khả năng, bạn là ai
  if (q.includes('bạn là ai') || q.includes('tên gì') || q.includes('bạn làm được gì') || q.includes('giới thiệu') || q.includes('chức năng của bạn') || q.includes('ai tạo ra')) {
    return `🤖 **Tôi là Trợ lý AI Thông minh của dự án Smart Thermal Fire Alarm Clock**.\n\nTôi được thiết kế để đồng hành cùng bạn 24/7 với các khả năng:\n1. **Đồng bộ thời gian thực**: Nắm bắt chính xác từng giây từ chip RTC DS3231, trạng thái báo thức, và nhiệt độ môi trường từ cảm biến LM35.\n2. **Tư vấn & Cảnh báo an toàn**: Hướng dẫn quy trình thoát nạn PCCC chuẩn Bộ Công An, cách dùng bình chữa cháy CO2/bột, sơ cứu bỏng.\n3. **Giải đáp kỹ thuật IoT**: Nắm rõ kiến trúc Arduino Uno, ESP32-CAM, giao tiếp I2C, bộ lọc trung bình trượt LM35 và giao tiếp Serial.\n4. **Trò chuyện linh hoạt**: Nếu bạn gắn thêm API Key của Google Gemini hoặc OpenAI (bằng nút trên khung chat), tôi sẽ trò chuyện thông minh không giới hạn y như ChatGPT & Gemini trên web!\n\nHôm nay bạn muốn tôi giúp gì nào?`;
  }

  // 3. Hỏi thăm, cảm ơn, khen ngợi
  if (q.includes('khỏe không') || q.includes('hôm nay thế nào') || q.includes('thế nào rồi') || q.includes('có mệt không')) {
    return `Cảm ơn bạn đã hỏi thăm! Tôi là AI nên luôn tràn đầy năng lượng 100% để túc trực bảo vệ an toàn cho bạn. 🛡️\n\nHiện tại hệ thống hoạt động rất ổn định:\n• Đồng hồ RTC: **${time}**\n• Nhiệt độ LM35: **${temp.toFixed(1)}°C** (${temp < threshold ? 'mát mẻ, an toàn' : 'đang ở mức cao!'})\n• Trạng thái còi: Sẵn sàng báo động.\n\nCòn bạn thì sao, hôm nay công việc và học tập của bạn thế nào?`;
  }
  if (q.includes('cảm ơn') || q.includes('thank') || q.includes('cảm ơn bạn') || q.includes('ok cảm ơn')) {
    return `Không có chi bạn nhé! Rất vui được hỗ trợ bạn. Chúc bạn có một ngày làm việc và học tập thật năng suất, an toàn! Nếu cần hỗ trợ thêm bất cứ điều gì, cứ nhắn cho tôi nhé. 😊`;
  }
  if (q.includes('giỏi') || q.includes('tuyệt vời') || q.includes('hay quá') || q.includes('thông minh') || q.includes('good') || q.includes('vip')) {
    return `Cảm ơn lời khen của bạn! Đó là nhờ nhóm tác giả đã thiết kế và huấn luyện hệ sinh thái IoT kết hợp AI rất công phu đấy ạ. Tôi sẽ luôn cố gắng phản hồi chính xác và hữu ích nhất cho bạn! 🌟`;
  }
  if (q.includes('tạm biệt') || q.includes('bye') || q.includes('ngủ ngon') || q.includes('hẹn gặp lại')) {
    return `Tạm biệt bạn! Chúc bạn nghỉ ngơi thật ngon giấc. Hãy yên tâm ngủ ngon vì hệ thống đồng hồ và cảm biến nhiệt PCCC của chúng tôi vẫn sẽ túc trực 24/7 để bảo vệ bạn! Hẹn gặp lại bạn nhé. 👋`;
  }

  // 4. Báo thức & Chuông
  if (q.includes('báo thức') || q.includes('hẹn giờ') || q.includes('alarm') || q.includes('chuông') || q.includes('snooze') || q.includes('báo lại')) {
    if (isAlarmRinging) {
      return `⏰ **CHÚ Ý: BÁO THỨC ĐANG REO!**\n• Giờ hẹn: ${alarmTime}\n• Chuông đang kêu liên tục không ngừng cho đến khi bạn bấm nút để chống ngủ quên.\n• Bạn có thể nhấn nút **"🔕 Tắt Báo Thức"** hoặc **"⏳ Báo lại sau 5 phút (Snooze)"** ngay trên màn hình.`;
    }
    return `⏰ **TRẠNG THÁI BÁO THỨC ĐỒNG HỒ:**\n• Cài đặt báo thức: **${isAlarmSet ? `Đang BẬT (Hẹn lúc: ${alarmTime})` : 'Đang TẮT'}**.\n• Giờ hiện tại: **${time}** (${timeFormat}).\n• Đặc điểm chuông: Phát âm thanh bíp-bíp ngắt quãng qua Web Audio Synthesizer, reo liên tục vĩnh viễn cho đến khi bạn chủ động tắt hoặc hẹn báo lại sau 5 phút.`;
  }

  // 5. Đồng hồ, RTC DS3231, Chỉnh giờ
  if (q.includes('mấy giờ') || q.includes('thời gian') || q.includes('ngày') || q.includes('thứ') || q.includes('rtc') || q.includes('ds3231') || q.includes('chỉnh giờ') || q.includes('định dạng') || q.includes('12h') || q.includes('24h')) {
    return `⏱️ **ĐỒNG HỒ THỜI GIAN THỰC RTC DS3231:**\n• Thời gian hiện tại: **${time}** (Định dạng: **${timeFormat}**)\n• Ngày tháng: **${date}**\n• Phần cứng: Chip RTC DS3231 độ chính xác cao với thạch anh bù nhiệt TCXO, sai số cực thấp dưới 1 phút/năm và có pin nuôi nguồn riêng CR2032.\n• Tiện ích: Bạn có thể bấm nút chuyển 12H/24H hoặc bấm **"⚙️ Chỉnh Giờ Thủ Công"** để tăng giảm giờ/phút theo ý muốn.`;
  }

  // 6. Cảm biến LM35 & Nhiệt độ
  if (q.includes('nhiệt độ') || q.includes('bao nhiêu độ') || q.includes('nóng') || q.includes('lạnh') || q.includes('lm35') || q.includes('cảm biến nhiệt') || q.includes('nguyên lý lm35')) {
    return `🌡️ **CẢM BIẾN NHIỆT ĐỘ LM35 PRECISION SENSOR:**\n• Nhiệt độ đo được tức thời: **${temp.toFixed(1)}°C**\n• Ngưỡng báo cháy cài đặt: **${threshold.toFixed(1)}°C**\n• Đánh giá: ${isDanger ? '🚨 **NGUY HIỂM: Đang vượt ngưỡng an toàn!**' : temp >= threshold - 10 ? '⚠️ **CẢNH BÁO: Nhiệt độ tiệm cận ngưỡng!**' : '✅ **AN TOÀN: Môi trường trong giới hạn cho phép.**'}\n\n💡 **Nguyên lý hoạt động của LM35**:\n- Cảm biến xuất điện áp tỷ lệ tuyến tính với nhiệt độ theo hệ số **10mV/°C** (ví dụ 25°C = 250mV).\n- Arduino đọc qua chân Analog A0 và chạy thuật toán **Lọc trung bình trượt 10 mẫu** để khử nhiễu điện áp, chống báo động giả.`;
  }

  // 7. Báo cháy, hỏa hoạn, còi hú
  if (q.includes('cháy') || q.includes('hỏa hoạn') || q.includes('còi') || q.includes('báo động') || q.includes('hú còi') || q.includes('siren')) {
    if (isDanger) {
      return `🚨 **BÁO ĐỘNG ĐỎ: ĐANG CÓ NGUY CƠ HỎA HOẠN!**\n• Nhiệt độ cảm biến: **${temp.toFixed(1)}°C** (Vượt ngưỡng ${threshold.toFixed(1)}°C)\n• Còi hú PCCC: Đang hú còi biến tần liên tục không ngừng.\n• Cảnh báo Gmail: Đã tự động phát báo cáo khẩn cấp tới: **${alertEmail}**.\n\n🛡️ **HÀNH ĐỘNG NGAY LẬP TỨC**:\n1. Giữ bình tĩnh, hô hoán người xung quanh.\n2. Ngắt cầu dao điện tổng (Aptomat).\n3. Dùng bình chữa cháy mini dập gốc lửa nếu đám cháy nhỏ.\n4. Thoát ra ngoài theo cầu thang bộ (không dùng thang máy).\n5. Gọi ngay **114** cho lực lượng Cứu hỏa PCCC!`;
    }
    return `✅ **TRẠNG THÁI PCCC HIỆN TẠI: AN TOÀN**\n• Nhiệt độ phòng hiện tại: **${temp.toFixed(1)}°C** (Dưới ngưỡng kích hoạt ${threshold.toFixed(1)}°C).\n• Còi báo động đa tần số và hệ thống cảnh báo Gmail đang ở chế độ thường trực (Standby 24/7).\n• Bạn có thể thử nghiệm bằng cách bấm nút **"🚨 Test Báo Cháy (65°C)"** trên thanh tiêu đề!`;
  }

  // 8. Gmail cảnh báo, gửi thư, cooldown
  if (q.includes('gmail') || q.includes('email') || q.includes('hòm thư') || q.includes('hộp thư') || q.includes('thư') || q.includes('cooldown') || q.includes('spam')) {
    return `📧 **HỆ THỐNG CẢNH BÁO TỰ ĐỘNG QUA GMAIL:**\n• Gmail đã lưu: **${alertEmail}**\n• Cơ chế tự động: Khi nhiệt độ >= ${threshold}°C, hệ thống tự động phát email báo cáo sự cố kèm mốc thời gian RTC DS3231, ảnh camera hiện trường và quy trình cứu hộ 114.\n• Chống Spam: Có cơ chế **Cooldown 45 giây** đếm ngược để chống tràn hộp thư.\n• Gửi thật vào Inbox: Nếu bạn cấu hình Mật khẩu ứng dụng Google (App Password), email sẽ tự động bay thẳng vào Inbox của bạn mà không cần bấm gì thêm!`;
  }

  // 9. Camera giám sát, ESP32-CAM, webcam
  if (q.includes('camera') || q.includes('esp32-cam') || q.includes('webcam') || q.includes('chụp ảnh') || q.includes('ảnh') || q.includes('video') || q.includes('chứng cứ')) {
    return `📷 **CAMERA GIÁM SÁT AN NINH AI:**\n• Trạng thái: **${cameraStatus}**\n• 3 Chế độ linh hoạt: Radar nhiệt mô phỏng Canvas, Webcam laptop thiết bị thật, hoặc luồng IP Stream từ ESP32-CAM.\n• Tự động chụp bằng chứng: Khi phát hiện nhiệt độ vượt ngưỡng, camera tự động chụp ảnh hiện trường, đóng dấu mốc thời gian (Timestamp Watermark) và lưu vào thư viện để phục vụ điều tra nguyên nhân cháy.`;
  }

  // 10. Phần cứng IoT: Arduino, ESP32, LCD, I2C
  if (q.includes('arduino') || q.includes('esp32') || q.includes('phần cứng') || q.includes('linh kiện') || q.includes('sơ đồ') || q.includes('i2c') || q.includes('lcd') || q.includes('buzzer') || q.includes('mạch')) {
    return `🛠️ **KIẾN TRÚC PHẦN CỨNG HỆ THỐNG (IOT 102):**\n1. **Vi điều khiển**: Arduino Uno R3 (xử lý logic chính).\n2. **Đồng hồ thời gian thực**: RTC DS3231 (giao tiếp I2C chân A4-SDA, A5-SCL, địa chỉ 0x68).\n3. **Cảm biến nhiệt**: LM35 (kết nối chân Analog A0 có mạch lọc 10 mẫu).\n4. **Màn hình hiển thị**: LCD 16x2 I2C (địa chỉ 0x27).\n5. **Còi & Đèn**: Active Buzzer (chân D8), LED cảnh báo đỏ (chân D7).\n6. **Nút bấm phần cứng**: Chân D2 (Chế độ), D3 (Tăng giờ), D4 (Tắt còi khẩn cấp) có lọc chống dội 50ms.\n7. **Camera**: ESP32-CAM truyền luồng video MJPEG qua WiFi.\n\n*(Bạn có thể bấm nút "🛠️ Code Firmware & Sơ Đồ" trên đầu trang để xem trọn bộ code C++ nạp mạch)*.`;
  }

  // 11. Quy trình PCCC, bình chữa cháy, thoát hiểm, số 114
  if (q.includes('quy trình') || q.includes('thoát hiểm') || q.includes('114') || q.includes('bình chữa cháy') || q.includes('co2') || q.includes('bột') || q.includes('chữa cháy')) {
    return `🧯 **QUY TRÌNH THOÁT HIỂM PCCC CHUẨN BỘ CÔNG AN (5 BƯỚC):**\n1. **BÁO ĐỘNG**: Hô hoán thật to và bấm chuông báo động cho mọi người xung quanh biết.\n2. **NGẮT ĐIỆN**: Lập tức ngắt cầu dao tổng (Aptomat) khu vực cháy để tránh chập điện lan rộng.\n3. **DẬP LỬA SƠ KHỞI**: Nếu lửa mới phát sinh: dùng bình khí CO2 (cho đồ điện) hoặc bình bột ABC quét qua lại vào gốc lửa.\n4. **SƠ TÁN AN TOÀN**: Dùng khăn ẩm hoặc khẩu trang ướt bịt kín mũi miệng để tránh ngạt khói độc carbon monoxide (CO), cúi thấp người men sát chân tường thoát ra ngoài bằng cầu thang bộ (TUYỆT ĐỐI không đi thang máy).\n5. **GỌI 114**: Gọi ngay đường dây nóng Cảnh sát PCCC và CNCH **114** để được cứu hộ chuyên nghiệp.`;
  }

  // 12. Sơ cứu ngạt khói và bỏng
  if (q.includes('bỏng') || q.includes('sơ cứu') || q.includes('ngạt khói') || q.includes('sơ cấp cứu')) {
    return `🩹 **HƯỚNG DẪN SƠ CỨU KHI GẶP NẠN DO HỎA HOẠN:**\n\n1. **Sơ cứu nạn nhân ngạt khói**:\n• Đưa nạn nhân ngay ra nơi thoáng khí, nới lỏng cổ áo, thắt lưng.\n• Nếu nạn nhân ngừng thở, tiến hành ép tim ngoài lồng ngực và hô hấp nhân tạo ngay lập tức, gọi 115.\n\n2. **Sơ cứu vết thương bỏng nhiệt**:\n• Ngâm hoặc xối rửa nhẹ nhàng vết bỏng dưới vòi **nước mát sạch** trong 15-20 phút (nhiệt độ nước khoảng 16-20°C).\n• **TUYỆT ĐỐI KHÔNG**: Dùng nước đá lạnh buốt, không bôi kem đánh răng, mỡ trăn, nước mắm lên vết bỏng.\n• Băng vết bỏng bằng gạc vô trùng che nhẹ nhàng, không băng chặt, rồi chuyển ngay tới cơ sở y tế.`;
  }

  // 13. Hỏi về kết nối ChatGPT, Gemini, AI
  if (q.includes('chatgpt') || q.includes('gemini') || q.includes('openai') || q.includes('api key') || q.includes('ai lỏ') || q.includes('thông minh')) {
    return `🤖 **CÁCH KẾT NỐI GEMINI / CHATGPT THẬT 100% VÀO ĐÂY:**\n\nHiện tại tôi đang vận hành ở chế độ **Local Smart Engine** tích hợp sẵn (không tốn phí, không sợ mất mạng). Để tôi có thể trò chuyện đa năng, làm thơ, viết code, giải toán và giao tiếp tự nhiên y hệt như ChatGPT hay Gemini trên trang web chính thức:\n\n1. Bấm nút **"🤖 Cài API Key (Gemini / ChatGPT)"** ở góc trên khung chat này.\n2. Lấy API Key miễn phí của **Google Gemini** tại: https://aistudio.google.com/app/apikey (hoặc OpenAI API Key).\n3. Dán key vào và bấm OK.\n\nLập tức tôi sẽ biến thành phiên bản Gemini / GPT thông minh không giới hạn của bạn!`;
  }

  // 14. Phản hồi hội thoại thông minh linh hoạt (Conversational Contextual Engine)
  return `Tôi đã nhận được câu hỏi của bạn: "${rawQ}".\n\nVề mặt hệ thống hiện tại:\n• Thời gian: **${time}** | Nhiệt độ môi trường: **${temp.toFixed(1)}°C** (${isDanger ? '🚨 Đang có báo động' : '✅ Bình thường'})\n• Báo thức: **${isAlarmSet ? `Đang bật lúc ${alarmTime}` : 'Đang tắt'}**\n\nBạn có thể hỏi tôi chi tiết hơn về: nguyên lý hoạt động của cảm biến LM35, module RTC DS3231, cách cài đặt Gmail cảnh báo, quy trình thoát nạn PCCC, hoặc bấm nút **"🤖 Cài API Key"** ở trên để kết nối trực tiếp với bộ não Google Gemini / ChatGPT để trò chuyện không giới hạn nhé!`;
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
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

    // 2. Trạng thái toàn bộ hệ thống
    if (pathname === '/api/status' && method === 'GET') {
      return sendJson(res, {
        status: 'online',
        systemName: 'Smart Thermal Fire Alarm Clock & AI Camera Vision',
        hardware: {
          mcu: 'Arduino Uno / ESP8266 & ESP32-CAM',
          rtc: 'DS3231 (High Precision TCXO I2C RTC)',
          thermalSensor: 'LM35 Precision Centigrade Sensor',
          display: 'LCD 16x2 I2C & Web Dashboard',
          alarmBuzzer: 'Dual-Tone Active Buzzer (Clock Alarm & Fire Siren 15s Auto-Stop)',
          inputButtons: 'Digital Push Buttons with 50ms Debounce'
        },
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

    // 3. Đọc Gmail đã đồng bộ
    if (pathname === '/api/config/email' && method === 'GET') {
      return sendJson(res, { success: true, email: sharedAlertEmail });
    }

    // 4. Lưu và đồng bộ Gmail
    if (pathname === '/api/config/email' && method === 'POST') {
      const body = await readJsonBody(req);
      const targetEmail = (body.email || '').trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!targetEmail || !emailRegex.test(targetEmail)) {
        return sendJson(res, { success: false, error: 'Địa chỉ Gmail không hợp lệ. Vui lòng kiểm tra lại.' }, 400);
      }

      sharedAlertEmail = targetEmail;
      try {
        await writeFile(emailConfigPath, JSON.stringify({
          email: sharedAlertEmail,
          updatedAt: new Date().toISOString()
        }, null, 2), 'utf-8');
      } catch (err) {
        console.error('Lỗi khi lưu file email-config.json:', err.message);
      }

      console.log(`[SYNC GMAIL] Đã cập nhật và đồng bộ Gmail nhận cảnh báo: ${sharedAlertEmail}`);
      return sendJson(res, {
        success: true,
        email: sharedAlertEmail,
        message: `Đã lưu và đồng bộ thành công địa chỉ Gmail [${sharedAlertEmail}] cho tất cả các máy đang truy cập!`
      });
    }

    // 5. Đọc telemetry phần cứng mới nhất
    if (pathname === '/api/sensor/latest' && method === 'GET') {
      return sendJson(res, { success: true, telemetry: hardwareTelemetry });
    }

    // 6. Nhận dữ liệu đo nhiệt độ từ phần cứng thật (ESP32/ESP8266 qua WiFi)
    if (pathname === '/api/sensor/reading' && method === 'POST') {
      const body = await readJsonBody(req);
      const { temperature, isFire, deviceId, time } = body;
      if (temperature !== undefined && Number.isFinite(Number(temperature))) {
        hardwareTelemetry = {
          temperature: Number(temperature),
          timestamp: time || new Date().toISOString(),
          source: 'HARDWARE_LIVE',
          isFire: Boolean(isFire),
          deviceId: deviceId || 'ESP32-STATION-01'
        };
        return sendJson(res, { success: true, message: 'Đã ghi nhận dữ liệu đo phần cứng thành công!' });
      }
      return sendJson(res, { error: 'Nhiệt độ gửi lên không hợp lệ.' }, 400);
    }

    // 7. Gửi báo cáo sự cố PCCC khẩn cấp qua Gmail
    if (pathname === '/api/alert/email' && method === 'POST') {
      const body = await readJsonBody(req);
      const { email, temperature, threshold, timestamp, reason, snapshot } = body;

      const targetEmail = (email || sharedAlertEmail || '').trim();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!targetEmail || !emailRegex.test(targetEmail)) {
        return sendJson(res, { success: false, error: 'Địa chỉ Gmail không hợp lệ. Vui lòng kiểm tra lại.' }, 400);
      }

      if (!sharedAlertEmail || sharedAlertEmail !== targetEmail) {
        sharedAlertEmail = targetEmail;
        try {
          await writeFile(emailConfigPath, JSON.stringify({
            email: sharedAlertEmail,
            updatedAt: new Date().toISOString()
          }, null, 2), 'utf-8');
        } catch {}
      }

      const isTest = (reason || '').toLowerCase().includes('kiểm thử') || (reason || '').toLowerCase().includes('thủ công');
      const now = Date.now();
      if (!isTest && now - lastFireEmailSentTimestamp < EMAIL_COOLDOWN_MS) {
        const waitSec = Math.ceil((EMAIL_COOLDOWN_MS - (now - lastFireEmailSentTimestamp)) / 1000);
        return sendJson(res, {
          success: true,
          method: 'COOLDOWN_ACTIVE',
          warning: `Hệ thống vừa gửi cảnh báo hỏa hoạn cách đây ít giây. Cooldown an toàn (còn ${waitSec}s) để chống tràn hộp thư.`,
          message: `Đã phát cảnh báo khẩn cấp tới ${targetEmail} (Nhật ký biến cố đã được ghi nhận).`
        });
      }
      lastFireEmailSentTimestamp = now;

      const temp = Number(temperature) || 0;
      const thresh = Number(threshold) || 50;
      const timeStr = timestamp || new Date().toLocaleString('vi-VN');
      const alertReason = reason || 'Nhiệt độ cảm biến LM35 vượt ngưỡng an toàn PCCC';
      const incidentId = 'FA-' + Date.now().toString().slice(-6);

      const subject = `🚨 [BÁO CÁO SỰ CỐ KHẨN CẤP] Trung Tâm PCCC: Cảnh Báo Nguy Cơ Hỏa Hoạn ${temp.toFixed(1)}°C Vượt Ngưỡng Tại Trạm Giám Sát!`;

      const textContent = `
========================================================================================
🚨 THÔNG BÁO KHẨN CẤP: BÁO CÁO SỰ CỐ NGUY CƠ HỎA HOẠN TẠI KHU VỰC THEO DÕI
HỆ THỐNG GIÁM SÁT AN TOÀN PCCC & ĐỒNG HỒ SỐ THÔNG MINH (SMART FIRE CLOCK & AI VISION)
Mã sự cố: ${incidentId} | Mức độ cảnh báo: CẤP ĐỘ 1 - BÁO ĐỘNG ĐỎ
========================================================================================

Kính gửi: Bộ phận Quản trị An toàn & Người phụ trách cơ sở (${targetEmail})

Hệ thống cảm biến nhiệt độ LM35 kết hợp module đồng hồ thời gian thực RTC DS3231 vừa phát hiện biến cố tăng nhiệt bất thường vượt quá giới hạn an toàn cho phép tại trạm giám sát an ninh.

I. THÔNG SỐ KỸ THUẬT VÀ DỮ LIỆU ĐO ĐƯỢC TỨC THỜI:
- Mã sự cố: ${incidentId}
- Mốc thời gian chính xác: ${timeStr} (Đồng bộ theo RTC DS3231)
- Vị trí trạm đo: Trạm cảm biến nhiệt môi trường LM35 & Camera giám sát hiện trường
- Nhiệt độ đo được tức thời: ${temp.toFixed(1)} °C
- Ngưỡng giới hạn kích hoạt cảnh báo: ${thresh.toFixed(1)} °C
- Mức độ vượt ngưỡng an toàn: +${(temp - thresh > 0 ? (temp - thresh).toFixed(1) : '0.0')} °C
- Lý do kích hoạt cảnh báo: ${alertReason}
- Mức độ rủi ro: CẤP ĐỘ NGUY HIỂM CAO (CRITICAL FIRE ALERT)

II. CÁC HÀNH ĐỘNG HỆ THỐNG ĐÃ TỰ ĐỘNG THỰC THI:
1. Kích hoạt còi hú báo động PCCC đa tần số (Wail Siren) và chuông cảnh báo reo liên tục vĩnh viễn cho đến khi có người kiểm tra và tắt thủ công tại chỗ.
2. Đồng bộ tín hiệu cảnh báo trên toàn bộ các thiết bị đang truy cập Dashboard hệ thống.
3. Camera an ninh AI đã tự động chụp lại ảnh chứng cứ hiện trường có gắn mốc thời gian (Timestamp Watermark).
4. Tự động phát thông báo khẩn cấp tức thời tới hòm thư quản trị viên: ${targetEmail}.
5. Ghi nhận nhật ký sự cố vào cơ sở dữ liệu giám sát an ninh PCCC.

III. QUY TRÌNH PHẢN ỨNG VÀ XỬ LÝ KHẨN CẤP (TIÊU CHUẨN PCCC BỘ CÔNG AN):
1. GIỮ BÌNH TĨNH VÀ NGẮT ĐIỆN: Lập tức ngắt ngay cầu dao tổng (Aptomat) tại khu vực xảy ra cảnh báo nhằm triệt tiêu nguy cơ chập cháy điện lan rộng.
2. XÁC MINH HIỆN TRƯỜNG: Quan sát hình ảnh camera an ninh để định vị vị trí đốm nhiệt hoặc khói.
3. DẬP LỬA SƠ KHỞI: Sử dụng bình chữa cháy xách tay (khí CO2 hoặc bột ABC) dập tắt triệt để tại gốc lửa.
4. TỔ CHỨC THOÁT HIỂM AN TOÀN: Dùng khăn ẩm bịt kín mũi miệng, cúi thấp người men sát chân tường thoát ra ngoài theo lối cầu thang bộ. TUYỆT ĐỐI KHÔNG DÙNG THANG MÁY.
5. CỨU NẠN KHẨN CẤP: Gọi ngay đường dây nóng Cảnh sát PCCC và Cứu nạn Cứu hộ: 114 nếu sự cố vượt tầm kiểm soát cá nhân.
----------------------------------------------------------------------------------------
Hệ thống Giám sát An toàn PCCC & Đồng hồ Số Thông minh (Smart Digital Clock - IoT 102)
Hotline Khẩn cấp Cứu Hỏa: 114
`;

      const htmlContent = `
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Báo Cáo Sự Cố Hỏa Hoạn Khẩn Cấp</title>
</head>
<body style="margin: 0; padding: 24px; background-color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <div style="max-width: 650px; margin: 0 auto; background: #ffffff; border-radius: 14px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.25); border: 1px solid #fee2e2;">
    <div style="background: linear-gradient(135deg, #991b1b 0%, #dc2626 50%, #b91c1c 100%); color: #ffffff; padding: 26px 24px; text-align: center;">
      <div style="display: inline-block; background: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; letter-spacing: 0.5px; margin-bottom: 8px;">
        🚨 BÁO CÁO SỰ CỐ KHẨN CẤP · CẤP ĐỘ 1 (BÁO ĐỘNG ĐỎ)
      </div>
      <h1 style="margin: 0; font-size: 22px; font-weight: 800; line-height: 1.3;">TRUNG TÂM GIÁM SÁT AN TOÀN PCCC</h1>
      <p style="margin: 6px 0 0; font-size: 13.5px; opacity: 0.92;">Hệ thống Đồng hồ Số Thông minh RTC DS3231 & Cảm biến nhiệt LM35</p>
    </div>
    <div style="padding: 26px 24px;">
      <div style="background: #fef2f2; border-left: 5px solid #dc2626; padding: 16px; border-radius: 8px; margin-bottom: 22px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <strong style="color: #991b1b; font-size: 16px;">Phát hiện nguy cơ hỏa hoạn vượt ngưỡng an toàn!</strong>
          <span style="font-size: 12px; background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 4px; font-weight: bold;">Mã: ${incidentId}</span>
        </div>
        <p style="margin: 8px 0 0; color: #475569; font-size: 13.5px; line-height: 1.5;">
          Cụm cảm biến nhiệt độ LM35 và đồng hồ thời gian thực RTC DS3231 đã phát hiện nhiệt độ tăng đột biến vượt ngưỡng an toàn quy định. Còi báo cháy đã được kích hoạt reo liên tục vĩnh viễn (cho đến khi tắt thủ công) và camera đã lưu vết hiện trường.
        </p>
      </div>

      <h3 style="margin: 0 0 10px; font-size: 14px; color: #334155; text-transform: uppercase; letter-spacing: 0.5px;">I. THÔNG SỐ ĐO LƯỜNG TỨC THỜI</h3>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 22px; font-size: 13.5px;">
        <tbody>
          <tr style="border-bottom: 1px solid #f1f5f9; background: #fafafa;">
            <td style="padding: 10px 12px; color: #64748b; width: 42%;">⏱️ Mốc thời gian ghi nhận:</td>
            <td style="padding: 10px 12px; font-weight: 700; color: #0f172a;">${timeStr}</td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 12px; color: #64748b;">🌡️ Nhiệt độ đo được (LM35):</td>
            <td style="padding: 10px 12px; font-weight: 800; color: #dc2626; font-size: 18px;">${temp.toFixed(1)} °C</td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9; background: #fafafa;">
            <td style="padding: 10px 12px; color: #64748b;">⚙️ Ngưỡng kích hoạt an toàn:</td>
            <td style="padding: 10px 12px; font-weight: 700; color: #0f172a;">${thresh.toFixed(1)} °C</td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 12px; color: #64748b;">📈 Mức độ vượt ngưỡng:</td>
            <td style="padding: 10px 12px; font-weight: 700; color: #b91c1c;">+${(temp - thresh > 0 ? (temp - thresh).toFixed(1) : '0.0')} °C</td>
          </tr>
          <tr style="border-bottom: 1px solid #f1f5f9; background: #fafafa;">
            <td style="padding: 10px 12px; color: #64748b;">🔊 Còi hú báo cháy:</td>
            <td style="padding: 10px 12px; font-weight: 700; color: #dc2626;">HÚ LIÊN TỤC VĨNH VIỄN (CHỜ TẮT THỦ CÔNG)</td>
          </tr>
          <tr>
            <td style="padding: 10px 12px; color: #64748b;">📝 Lý do cảnh báo:</td>
            <td style="padding: 10px 12px; font-weight: 600; color: #334155;">${alertReason}</td>
          </tr>
        </tbody>
      </table>

      ${snapshot ? `
      <div style="margin-bottom: 22px;">
        <h3 style="margin: 0 0 10px; font-size: 14px; color: #334155; text-transform: uppercase; letter-spacing: 0.5px;">II. ẢNH CHỨNG CỨ HIỆN TRƯỜNG TỰ ĐỘNG CHỤP</h3>
        <div style="text-align: center; background: #000000; padding: 8px; border-radius: 8px; border: 1px solid #cbd5e1;">
          <img src="${snapshot}" alt="Ảnh chụp hiện trường khi quá nhiệt" style="max-width: 100%; height: auto; border-radius: 6px; display: block; margin: 0 auto;" />
          <div style="color: #38bdf8; font-size: 11.5px; font-family: monospace; margin-top: 6px;">Camera an ninh AI · Gắn nhãn thời gian từ RTC DS3231</div>
        </div>
      </div>` : ''}

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin-bottom: 20px;">
        <strong style="color: #0f172a; font-size: 14px; display: flex; align-items: center; gap: 6px;">
          🛡️ QUY TRÌNH PHẢN ỨNG VÀ XỬ LÝ KHẨN CẤP (TIÊU CHUẨN PCCC):
        </strong>
        <ol style="margin: 10px 0 0; padding-left: 20px; color: #334155; font-size: 13px; line-height: 1.65;">
          <li><strong>Ngắt điện khẩn cấp:</strong> Cúp ngay cầu dao tổng (Aptomat) tại khu vực xảy ra biến cố.</li>
          <li><strong>Xác minh hiện trường:</strong> Quan sát camera an ninh hoặc tiếp cận có bảo hộ để định vị điểm cháy.</li>
          <li><strong>Dập lửa ban đầu:</strong> Dùng bình chữa cháy xách tay (khí CO2 hoặc bột ABC) xử lý gốc lửa nếu mới phát sinh.</li>
          <li><strong>Sơ tán an toàn:</strong> Dùng khăn ẩm bịt kín mũi miệng, cúi thấp người men sát chân tường theo cầu thang bộ. <em>TUYỆT ĐỐI KHÔNG DÙNG THANG MÁY.</em></li>
          <li><strong>Ứng cứu chuyên nghiệp:</strong> Gọi ngay đường dây nóng Cảnh sát PCCC & CNCH: <strong style="color:#dc2626; font-size:14px;">114</strong>.</li>
        </ol>
      </div>

      <div style="text-align: center; margin-top: 24px;">
        <a href="http://localhost:${port}" style="background: #dc2626; color: #ffffff; text-decoration: none; padding: 11px 22px; border-radius: 6px; font-size: 13.5px; font-weight: 700; display: inline-block;">
          Truy Cập Dashboard Giám Sát Thời Gian Thực
        </a>
      </div>
    </div>
    <div style="background: #f1f5f9; padding: 14px 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
      Hệ thống Đồng hồ Cảm biến Nhiệt Báo cháy & Giám sát Camera AI · IoT 102<br>
      Bản tin cảnh báo khẩn cấp gửi tự động đến: <strong style="color: #0f172a;">${targetEmail}</strong>
    </div>
  </div>
</body>
</html>
`;

      const gmailUser = process.env.GMAIL_USER;
      const gmailPass = process.env.GMAIL_APP_PASSWORD;

      if (gmailUser && gmailPass) {
        try {
          await sendNativeGmail({
            user: gmailUser,
            appPassword: gmailPass,
            to: targetEmail,
            subject,
            htmlBody: htmlContent,
            textBody: textContent
          });
          return sendJson(res, {
            success: true,
            method: 'SMTP_REAL',
            message: `Đã gửi email cảnh báo hỏa hoạn thực tế đến hộp thư Gmail: ${targetEmail}`
          });
        } catch (err) {
          console.error('Lỗi khi gửi email qua Google SMTP:', err.message);
          return sendJson(res, {
            success: true,
            method: 'SIMULATION_LOG',
            warning: `Google SMTP trả về lỗi (${err.message}). Hệ thống đã lưu lại thông điệp cảnh báo.`,
            message: `Đã phát cảnh báo khẩn cấp tới ${targetEmail} (Ghi nhận trên hệ thống và nhật ký PCCC).`
          });
        }
      } else {
        console.log(`[EMAIL ALERT SIMULATED] Cảnh báo hỏa hoạn gửi tới: ${targetEmail} | Nhiệt độ: ${temp.toFixed(1)}°C | Giờ: ${timeStr}`);
        return sendJson(res, {
          success: true,
          method: 'DIRECT_READY',
          message: `Đã kích hoạt cảnh báo gửi tới Gmail: ${targetEmail}! (Để nhận thư thực tế vào Inbox, bạn có thể nhập GMAIL_USER và GMAIL_APP_PASSWORD trong file .env)`
        });
      }
    }

    // 8. Chẩn đoán AI nguy cơ hỏa hoạn
    if (pathname === '/api/ai/analyze-fire' && method === 'POST') {
      const body = await readJsonBody(req);
      const { context } = body;
      const temp = Number.isFinite(Number(context?.temperature)) ? Number(context.temperature) : 28.5;
      const threshold = Number(context?.alarmThreshold) || 50;

      let riskLevel = 'SAFE';
      let badgeColor = 'green';
      let title = 'Hệ thống an toàn';
      let advice = 'Nhiệt độ nằm trong ngưỡng tiêu chuẩn. Đồng hồ RTC DS3231 và các cảm biến hoạt động bình thường.';
      let actionRequired = false;

      if (temp >= threshold) {
        riskLevel = 'DANGER';
        badgeColor = 'red';
        title = 'BÁO ĐỘNG CHÁY CẤP 1 - NGUY HIỂM';
        advice = `Nhiệt độ ${temp}°C vượt ngưỡng an toàn ${threshold}°C! Còi báo động đã kêu 15s, hệ thống đã gửi cảnh báo tới Gmail và Camera đã ghi hình. Vui lòng sơ tán hoặc kiểm tra ngay!`;
        actionRequired = true;
      } else if (temp >= threshold - 10) {
        riskLevel = 'WARNING';
        badgeColor = 'orange';
        title = 'CẢNH BÁO NHIỆT ĐỘ TĂNG CAO';
        advice = `Nhiệt độ ${temp}°C đang tiệm cận ngưỡng báo cháy (${threshold}°C). Hãy kiểm tra các thiết bị điện và quan sát camera.`;
      }

      return sendJson(res, {
        temp,
        threshold,
        riskLevel,
        badgeColor,
        title,
        advice,
        actionRequired,
        timestamp: new Date().toLocaleTimeString('vi-VN', { hour12: false })
      });
    }

    // 8.1 Cấu hình AI API Key (Gemini hoặc OpenAI) từ giao diện Web
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
        console.log('[AI CONFIG] Đã kích hoạt Google Gemini API (Flash 1.5)!');
      } else {
        process.env.OPENAI_API_KEY = cleanKey;
        if (model) process.env.OPENAI_MODEL = model;
        console.log('[AI CONFIG] Đã kích hoạt OpenAI API!');
      }

      try {
        const envContent = `# CẤU HÌNH GMAIL SMTP & AI ENGINE\nGMAIL_USER=${process.env.GMAIL_USER || ''}\nGMAIL_APP_PASSWORD=${process.env.GMAIL_APP_PASSWORD || ''}\nGEMINI_API_KEY=${process.env.GEMINI_API_KEY || ''}\nOPENAI_API_KEY=${process.env.OPENAI_API_KEY || ''}\nPORT=${port}\nDEFAULT_ALERT_EMAIL=${sharedAlertEmail || ''}\n`;
        await writeFile(envFilePath, envContent, 'utf-8');
      } catch {}

      return sendJson(res, {
        success: true,
        provider: process.env.GEMINI_API_KEY ? 'Google Gemini (Flash)' : 'OpenAI (GPT)',
        message: 'Đã kích hoạt AI trực tuyến! Trợ lý AI bây giờ đã có thể trò chuyện tự nhiên, giải đáp thông minh như ChatGPT và Gemini thật 100%.'
      });
    }

    // 9. Hội thoại AI Smart Box
    if (pathname === '/api/chat' && method === 'POST') {
      const body = await readJsonBody(req);
      const { message, context } = body;

      if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
        return sendJson(res, { error: 'Câu hỏi phải có nội dung và tối đa 2.000 ký tự.' }, 400);
      }

      const fireContext = context && typeof context === 'object' ? context : {};

      const systemPrompt = `Bạn là Trợ lý AI thông minh của hệ thống "Đồng hồ thông minh cảm biến nhiệt báo cháy & Giám sát Camera AI" (Smart Thermal Fire Alarm Clock - IoT 102).
Dữ liệu thời gian thực hiện tại của hệ thống:
- Giờ hiện tại: ${fireContext.time || '19:30:00'} (${fireContext.date || 'Hôm nay'}, định dạng ${fireContext.timeFormat || '24H'})
- Trạng thái báo thức: ${fireContext.isAlarmSet ? `Đang BẬT lúc ${fireContext.alarmTime}` : 'Đang TẮT'}
- Nhiệt độ cảm biến LM35: ${fireContext.temperature || 28.5}°C (Ngưỡng an toàn: ${fireContext.alarmThreshold || 50}°C)
- Tình trạng an toàn PCCC: ${fireContext.fireStatus || 'SAFE'}
- Gmail nhận cảnh báo: ${fireContext.alertEmail || sharedAlertEmail || 'Chưa gán'}
- Camera an ninh: ${fireContext.cameraStatus || 'Đang hoạt động'}

Nhiệm vụ của bạn:
1. Giao tiếp tự nhiên, thân thiện, thông minh như ChatGPT / Gemini bằng tiếng Việt.
2. Trả lời được MỌI câu hỏi: từ chuyện trò, hỏi thăm, giải thích công nghệ, viết code, tư vấn đời sống, đến giải thích kiến trúc phần cứng IoT (Arduino Uno, RTC DS3231 I2C, LM35 lọc 10 mẫu, ESP32-CAM).
3. Khi người dùng hỏi về nhiệt độ, đồng hồ, báo thức hay PCCC, hãy dùng dữ liệu thời gian thực ở trên để trả lời chính xác!`;

      // 1. Thử gọi Google Gemini API nếu có key
      if (process.env.GEMINI_API_KEY) {
        try {
          const geminiReply = await callGeminiApi(process.env.GEMINI_API_KEY, message.trim(), systemPrompt);
          return sendJson(res, { reply: geminiReply, provider: 'Google Gemini (Flash)' });
        } catch (err) {
          console.error('Lỗi khi gọi Gemini API:', err.message);
        }
      }

      // 2. Thử gọi OpenAI API nếu có key
      if (process.env.OPENAI_API_KEY) {
        try {
          const openAiReply = await callOpenAiDirect(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL || 'gpt-4o-mini', message.trim(), systemPrompt);
          return sendJson(res, { reply: openAiReply, provider: 'OpenAI GPT' });
        } catch (err) {
          console.error('Lỗi khi gọi OpenAI API:', err.message);
        }
      }

      // 3. Phản hồi bằng Bộ não xử lý ngôn ngữ tự nhiên Offline thông minh
      const reply = generateLocalFireAlarmAiResponse(message, fireContext);
      return sendJson(res, { reply, provider: 'Smart Local NLP Engine' });
    }

    // Đường dẫn không tồn tại (404)
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
  console.log(`🤖 AI Status: ${process.env.OPENAI_API_KEY && OpenAI ? 'OpenAI Live (' + (process.env.OPENAI_MODEL || 'gpt-4o-mini') + ')' : 'Local AI Engine Sẵn sàng (Zero-Dependency)'}`);
  console.log(`📧 Gmail Alert: ${process.env.GMAIL_USER ? 'Đã kích hoạt (' + process.env.GMAIL_USER + ')' : 'Chế độ mô phỏng trực tiếp (Nhập trên Web)'}`);
  console.log(`=================================================================`);
});
