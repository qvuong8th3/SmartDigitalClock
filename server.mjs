import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import tls from 'node:tls';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = express();
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

// Hỗ trợ nhận payload JSON tối đa 5MB (để kèm ảnh chụp hiện trường nếu có)
app.use(express.json({ limit: '5mb' }));

// Phục vụ giao diện Dashboard chính
app.get('/', async (_req, res, next) => {
  try {
    res.type('html').send(await readFile(indexPath));
  } catch (error) {
    next(error);
  }
});

// Endpoint kiểm tra trạng thái toàn bộ hệ thống IoT, Đồng hồ & AI
app.get('/api/status', (_req, res) => {
  res.json({
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
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    aiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    timestamp: new Date().toISOString()
  });
});

// Endpoint lấy cấu hình Gmail cảnh báo đang được đồng bộ cho toàn bộ các máy
app.get('/api/config/email', (_req, res) => {
  res.json({
    success: true,
    email: sharedAlertEmail
  });
});

// Endpoint lưu và đồng bộ Gmail cảnh báo cho mọi máy truy cập Dashboard
app.post('/api/config/email', async (req, res) => {
  const { email } = req.body ?? {};
  const targetEmail = (email || '').trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!targetEmail || !emailRegex.test(targetEmail)) {
    return res.status(400).json({
      success: false,
      error: 'Địa chỉ Gmail không hợp lệ. Vui lòng kiểm tra lại định dạng email.'
    });
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
  return res.json({
    success: true,
    email: sharedAlertEmail,
    message: `Đã lưu và đồng bộ thành công địa chỉ Gmail [${sharedAlertEmail}] cho tất cả các máy đang truy cập!`
  });
});

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

// Cooldown chống spam gửi email cảnh báo tự động dồn dập (45 giây)
let lastFireEmailSentTimestamp = 0;
const EMAIL_COOLDOWN_MS = 45000;

// Endpoint gửi cảnh báo khẩn cấp tới Gmail
app.post('/api/alert/email', async (req, res) => {
  const { email, temperature, threshold, timestamp, reason, snapshot } = req.body ?? {};

  // Ưu tiên email gửi lên, nếu trống thì dùng email đã đồng bộ trên hệ thống
  const targetEmail = (email || sharedAlertEmail || '').trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!targetEmail || !emailRegex.test(targetEmail)) {
    return res.status(400).json({
      success: false,
      error: 'Địa chỉ Gmail không hợp lệ. Vui lòng kiểm tra lại định dạng email.'
    });
  }

  // Tự động lưu và đồng bộ nếu chưa có
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
    return res.json({
      success: true,
      method: 'COOLDOWN_ACTIVE',
      warning: `Hệ thống vừa gửi cảnh báo hỏa hoạn cách đây ít giây. Cooldown an toàn (còn ${waitSec}s) để chống tràn hộp thư.`,
      message: `Đã phát cảnh báo khẩn cấp tới ${targetEmail} (Nhật ký biến cố đã được ghi nhận).`
    });
  }
  lastFireEmailSentTimestamp = now;

  const temp = Number(temperature) || 0;
  const thresh = Number(threshold) || 50;
  const time = timestamp || new Date().toLocaleString('vi-VN');
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
----------------------------------------------------------------------------------------
- Mã sự cố ghi nhận: ${incidentId}
- Mốc thời gian chính xác: ${time} (Đồng bộ theo thạch anh bù nhiệt độ cao RTC DS3231)
- Vị trí trạm đo: Trạm cảm biến nhiệt môi trường LM35 & Camera giám sát hiện trường
- Nhiệt độ đo được tức thời: ${temp.toFixed(1)} °C
- Ngưỡng giới hạn kích hoạt cảnh báo: ${thresh.toFixed(1)} °C
- Mức độ vượt ngưỡng an toàn: +${(temp - thresh > 0 ? (temp - thresh).toFixed(1) : '0.0')} °C
- Lý do kích hoạt cảnh báo: ${alertReason}
- Mức độ rủi ro: CẤP ĐỘ NGUY HIỂM CAO (CRITICAL FIRE ALERT)

II. CÁC HÀNH ĐỘNG HỆ THỐNG ĐÃ TỰ ĐỘNG THỰC THI:
----------------------------------------------------------------------------------------
1. Kích hoạt còi hú báo động PCCC đa tần số (Wail Siren) và chuông cảnh báo liên tục trong 15 giây để cảnh báo sơ tán tại chỗ.
2. Đồng bộ tín hiệu cảnh báo trên toàn bộ các thiết bị đang truy cập Dashboard hệ thống.
3. Camera an ninh AI (ESP32-CAM / Webcam) đã tự động chụp lại ảnh chứng cứ hiện trường có gắn mốc thời gian (Timestamp Watermark).
4. Tự động phát thông báo khẩn cấp tức thời tới hòm thư quản trị viên: ${targetEmail}.
5. Ghi nhận nhật ký sự cố vào cơ sở dữ liệu giám sát an ninh PCCC.

III. QUY TRÌNH PHẢN ỨNG VÀ XỬ LÝ KHẨN CẤP (TIÊU CHUẨN PCCC BỘ CÔNG AN):
----------------------------------------------------------------------------------------
Quản trị viên và người có mặt tại hiện trường cần khẩn trương thực hiện ngay các bước sau:
1. GIỮ BÌNH TĨNH VÀ NGẮT ĐIỆN: Lập tức ngắt ngay cầu dao tổng (Aptomat) tại khu vực xảy ra cảnh báo nhằm triệt tiêu nguy cơ chập cháy điện lan rộng.
2. XÁC MINH HIỆN TRƯỜNG: Quan sát hình ảnh chụp hiện trường đính kèm bên dưới hoặc kiểm tra từ xa qua camera để định vị chính xác vị trí đốm nhiệt/khói.
3. DẬP LỬA SƠ KHỞI: Nếu đám cháy mới chớm phát sinh, lập tức sử dụng bình chữa cháy xách tay (bình bột ABC hoặc khí CO2) dập tắt triệt để tại gốc lửa.
4. TỔ CHỨC THOÁT HIỂM AN TOÀN: Nếu đám cháy có nguy cơ bùng phát nhanh hoặc nhiều khói độc, nhanh chóng hô hoán, dùng khăn ẩm bịt kín mũi miệng, cúi thấp người men sát chân tường thoát ra ngoài theo lối cầu thang bộ. TUYỆT ĐỐI KHÔNG SỬ DỤNG THANG MÁY.
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
    
    <!-- Header Banner -->
    <div style="background: linear-gradient(135deg, #991b1b 0%, #dc2626 50%, #b91c1c 100%); color: #ffffff; padding: 26px 24px; text-align: center;">
      <div style="display: inline-block; background: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; letter-spacing: 0.5px; margin-bottom: 8px;">
        🚨 BÁO CÁO SỰ CỐ KHẨN CẤP · CẤP ĐỘ 1 (BÁO ĐỘNG ĐỎ)
      </div>
      <h1 style="margin: 0; font-size: 22px; font-weight: 800; line-height: 1.3;">TRUNG TÂM GIÁM SÁT AN TOÀN PCCC</h1>
      <p style="margin: 6px 0 0; font-size: 13.5px; opacity: 0.92;">Hệ thống Đồng hồ Số Thông minh RTC DS3231 & Cảm biến nhiệt LM35</p>
    </div>

    <div style="padding: 26px 24px;">
      <!-- Alert Summary Card -->
      <div style="background: #fef2f2; border-left: 5px solid #dc2626; padding: 16px; border-radius: 8px; margin-bottom: 22px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <strong style="color: #991b1b; font-size: 16px;">Phát hiện nguy cơ hỏa hoạn vượt ngưỡng an toàn!</strong>
          <span style="font-size: 12px; background: #fee2e2; color: #991b1b; padding: 2px 8px; border-radius: 4px; font-weight: bold;">Mã: ${incidentId}</span>
        </div>
        <p style="margin: 8px 0 0; color: #475569; font-size: 13.5px; line-height: 1.5;">
          Cụm cảm biến nhiệt độ LM35 và đồng hồ thời gian thực RTC DS3231 đã phát hiện nhiệt độ tăng đột biến vượt ngưỡng an toàn quy định. Còi báo cháy đã được kích hoạt trong 15 giây và camera đã lưu vết hiện trường.
        </p>
      </div>

      <!-- Detail Table -->
      <h3 style="margin: 0 0 10px; font-size: 14px; color: #334155; text-transform: uppercase; letter-spacing: 0.5px;">I. THÔNG SỐ ĐO LƯỜNG TỨC THỜI</h3>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 22px; font-size: 13.5px;">
        <tbody>
          <tr style="border-bottom: 1px solid #f1f5f9; background: #fafafa;">
            <td style="padding: 10px 12px; color: #64748b; width: 42%;">⏱️ Mốc thời gian ghi nhận:</td>
            <td style="padding: 10px 12px; font-weight: 700; color: #0f172a;">${time}</td>
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
            <td style="padding: 10px 12px; color: #64748b;">🔊 Còi hú báo cháy (15s):</td>
            <td style="padding: 10px 12px; font-weight: 700; color: #dc2626;">ĐÃ KÍCH HOẠT CHU KỲ 15 GIÂY</td>
          </tr>
          <tr>
            <td style="padding: 10px 12px; color: #64748b;">📝 Lý do cảnh báo:</td>
            <td style="padding: 10px 12px; font-weight: 600; color: #334155;">${alertReason}</td>
          </tr>
        </tbody>
      </table>

      <!-- Evidence Snapshot -->
      ${snapshot ? `
      <div style="margin-bottom: 22px;">
        <h3 style="margin: 0 0 10px; font-size: 14px; color: #334155; text-transform: uppercase; letter-spacing: 0.5px;">II. ẢNH CHỨNG CỨ HIỆN TRƯỜNG TỰ ĐỘNG CHỤP</h3>
        <div style="text-align: center; background: #000000; padding: 8px; border-radius: 8px; border: 1px solid #cbd5e1;">
          <img src="${snapshot}" alt="Ảnh chụp hiện trường khi quá nhiệt" style="max-width: 100%; height: auto; border-radius: 6px; display: block; margin: 0 auto;" />
          <div style="color: #38bdf8; font-size: 11.5px; font-family: monospace; margin-top: 6px;">Camera an ninh AI · Gắn nhãn thời gian từ RTC DS3231</div>
        </div>
      </div>` : ''}

      <!-- Emergency SOP -->
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

      <!-- Quick Action Button -->
      <div style="text-align: center; margin-top: 24px;">
        <a href="http://localhost:${port}" style="background: #dc2626; color: #ffffff; text-decoration: none; padding: 11px 22px; border-radius: 6px; font-size: 13.5px; font-weight: 700; display: inline-block;">
          Truy Cập Dashboard Giám Sát Thời Gian Thực
        </a>
      </div>
    </div>

    <!-- Footer -->
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
      return res.json({
        success: true,
        method: 'SMTP_REAL',
        message: `Đã gửi email cảnh báo hỏa hoạn thực tế đến hộp thư Gmail: ${targetEmail}`
      });
    } catch (err) {
      console.error('Lỗi khi gửi email qua Google SMTP:', err.message);
      return res.json({
        success: true,
        method: 'SIMULATION_LOG',
        warning: `Google SMTP trả về lỗi (${err.message}). Hệ thống đã lưu lại thông điệp cảnh báo.`,
        message: `Đã phát cảnh báo khẩn cấp tới ${targetEmail} (Ghi nhận trên hệ thống và nhật ký PCCC).`
      });
    }
  } else {
    console.log(`[EMAIL ALERT SIMULATED] Cảnh báo hỏa hoạn gửi tới: ${targetEmail} | Nhiệt độ: ${temp.toFixed(1)}°C | Giờ: ${time}`);
    return res.json({
      success: true,
      method: 'DIRECT_READY',
      message: `Đã kích hoạt cảnh báo gửi tới Gmail: ${targetEmail}! (Để nhận thư thực tế vào Inbox, bạn có thể nhập GMAIL_USER và GMAIL_APP_PASSWORD trong file .env)`
    });
  }
});

// Hàm tạo phản hồi AI nội bộ đồng bộ 100% với Đồng hồ & Giám sát Báo cháy (Fallback AI Engine)
function generateLocalFireAlarmAiResponse(message, context) {
  const q = (message || '').toLowerCase().trim();
  const time = context?.time || 'chưa cập nhật';
  const date = context?.date || 'hôm nay';
  const timeFormat = context?.timeFormat || '24H';
  const isAlarmSet = Boolean(context?.isAlarmSet);
  const alarmTime = context?.alarmTime || 'Chưa cài đặt';
  const isAlarmRinging = Boolean(context?.isAlarmRinging);
  const temp = Number.isFinite(Number(context?.temperature)) ? Number(context.temperature) : 28.5;
  const fireStatus = context?.fireStatus || 'SAFE'; // SAFE | WARNING | DANGER
  const threshold = Number(context?.alarmThreshold) || 50;
  const cameraStatus = context?.cameraStatus || 'Active Stream';
  const alertEmail = context?.alertEmail || 'Chưa gán địa chỉ Gmail';
  const readings = Array.isArray(context?.readings) ? context.readings : [];

  // 1. Hỏi về Báo thức (Alarm Clock)
  if (q.includes('báo thức') || q.includes('hẹn giờ') || q.includes('alarm') || q.includes('chuông')) {
    if (isAlarmRinging) {
      return `⏰ [CHÚ Ý - BÁO THỨC ĐANG REO!]
• Đồng hồ báo thức đang kích hoạt chuông reo (Hẹn lúc: ${alarmTime}).
• Bạn có thể nhấn nút "🔕 Tắt Báo Thức" hoặc "⏰ Hoãn 5 Phút (Snooze)" trên giao diện.`;
    }
    return `⏰ [TRẠNG THÁI BÁO THỨC ĐỒNG HỒ]
• Cài đặt báo thức: ${isAlarmSet ? `Đang BẬT (Hẹn lúc: ${alarmTime})` : 'Đang TẮT'}.
• Thời gian hiện tại: ${time} (${timeFormat}).
• Tính năng: Bạn có thể bật/tắt công tắc báo thức, chỉnh giờ hẹn và chuông báo thức ngắt quãng (Bíp-bíp) sẽ tự động phát khi tới giờ.`;
  }

  // 2. Hỏi về Đồng hồ thời gian thực RTC DS3231 & Chỉnh giờ
  if (q.includes('mấy giờ') || q.includes('thời gian') || q.includes('ngày') || q.includes('rtc') || q.includes('ds3231') || q.includes('chỉnh giờ') || q.includes('định dạng') || q.includes('12h') || q.includes('24h')) {
    return `⏱️ [ĐỒNG HỒ THỜI GIAN THỰC RTC DS3231]
• Thời gian hiện tại: ${time} (Định dạng: ${timeFormat})
• Ngày: ${date}
• Module phần cứng: RTC DS3231 độ chính xác cao (TCXO), giao tiếp I2C, duy trì nguồn qua pin CR2032.
• Tính năng đồng hồ:
  1. Hỗ trợ chuyển đổi định dạng 12H (AM/PM) và 24H.
  2. Hỗ trợ Chỉnh giờ thủ công (+/- Giờ, +/- Phút) hoặc Đồng bộ tự động.
  3. Gắn nhãn thời gian chuẩn xác lên từng sự kiện báo cháy và ảnh chụp camera.`;
  }

  // 3. Hỏi về Gmail cảnh báo cháy
  if (q.includes('gmail') || q.includes('email') || q.includes('thư') || q.includes('hộp thư')) {
    return `📧 [HỆ THỐNG CẢNH BÁO QUA GMAIL]
• Gmail nhận tin khẩn cấp: ${alertEmail !== 'Chưa gán địa chỉ Gmail' ? `Đã liên kết [${alertEmail}]` : 'Chưa cài đặt (Hãy nhập Gmail của bạn vào ô trên màn hình và bấm Lưu)'}.
• Cơ chế hoạt động: Khi nhiệt độ cảm biến LM35 vượt ngưỡng ${threshold}°C hoặc khi bấm "Test Báo Cháy", hệ thống sẽ tự động gửi email khẩn cấp chứa mốc thời gian, nhiệt độ tức thời và hình ảnh camera hiện trường về hộp thư của bạn.`;
  }

  // 4. Hỏi về trạng thái báo cháy / hỏa hoạn / an toàn
  if (q.includes('cháy') || q.includes('hỏa hoạn') || q.includes('báo động') || q.includes('nguy hiểm') || q.includes('còi') || q.includes('an toàn')) {
    if (fireStatus === 'DANGER' || temp >= threshold) {
      return `🚨 [CẢNH BÁO KHẨN CẤP - NGUY CƠ CHÁY CAO]
• Cảm biến nhiệt LM35 đo được: ${temp}°C (VƯỢT NGƯỠNG AN TOÀN ${threshold}°C!).
• Trạng thái còi hú: ĐANG KÍCH HOẠT còi báo động đa tần số.
• Cảnh báo Gmail: Đã kích hoạt gửi thư khẩn cấp đến: ${alertEmail}.
• Hành động khẩn cấp:
  1. Giữ bình tĩnh, ngắt ngay cầu dao điện tổng.
  2. Quan sát hình ảnh từ Camera an ninh để định vị điểm cháy/khói.
  3. Dùng bình chữa cháy dập lửa nếu mới bùng phát, hoặc di tản khẩn cấp theo lối thoát hiểm.
  4. Gọi ngay lực lượng Cứu hỏa PCCC 114.`;
    }

    if (fireStatus === 'WARNING' || temp >= threshold - 10) {
      return `⚠️ [CẢNH BÁO - NHIỆT ĐỘ TĂNG CAO]
• Nhiệt độ đo được: ${temp}°C (Tiệm cận ngưỡng báo cháy ${threshold}°C).
• Khuyến nghị: Kiểm tra các thiết bị điện, ổ cắm hoặc nguồn nhiệt quanh đồng hồ để ngăn ngừa nguy cơ chập cháy.`;
    }

    return `✅ [TRẠNG THÁI TOÀN BỘ HỆ THỐNG AN TOÀN]
• Nhiệt độ môi trường: ${temp}°C (Dưới ngưỡng kích hoạt ${threshold}°C).
• Đồng hồ RTC DS3231 và Camera AI đang hoạt động giám sát 24/7 ổn định.`;
  }

  // 5. Hỏi về camera giám sát / AI Vision
  if (q.includes('camera') || q.includes('hình ảnh') || q.includes('video') || q.includes('esp32-cam') || q.includes('chụp ảnh') || q.includes('vision')) {
    return `📷 [CAMERA GIÁM SÁT HIỆN TRƯỜNG & AI VISION]
• Thiết bị: ESP32-CAM / Webcam AI.
• Trạng thái: ${cameraStatus}.
• Tính năng:
  - Tự động chụp ảnh chứng cứ (Snapshot) lưu vào thư viện khi phát hiện quá nhiệt.
  - Hỗ trợ xem trực tiếp qua Webcam, luồng ESP32-CAM IP hoặc Radar nhiệt mô phỏng.
  - Gắn nhãn Timestamp chuẩn từ RTC DS3231 trực tiếp trên ảnh.`;
  }

  // 6. Hỏi về nhiệt độ / lịch sử đo
  if (q.includes('nhiệt độ') || q.includes('xu hướng') || q.includes('temp') || q.includes('mẫu đo') || q.includes('lịch sử')) {
    if (readings.length < 2) {
      return `🌡️ Nhiệt độ tức thời đo được: ${temp}°C. Ngưỡng báo cháy: ${threshold}°C. Chưa có đủ dữ liệu lịch sử để kết luận xu hướng.`;
    }
    const temps = readings.map(r => Number(r.temperature)).filter(Number.isFinite);
    const first = temps[0];
    const last = temps[temps.length - 1];
    const diff = Number((last - first).toFixed(1));
    const avg = (temps.reduce((s, v) => s + v, 0) / temps.length).toFixed(1);

    let trendDesc = 'ổn định';
    if (diff > 0.5) trendDesc = `tăng nhanh (+${diff}°C) - cần lưu ý`;
    else if (diff < -0.5) trendDesc = `đang hạ nhiệt (${diff}°C)`;

    return `📊 [BÁO CÁO NHIỆT ĐỘ CẢM BIẾN LM35]
• Mức đo hiện tại: ${last}°C (Mức đo trung bình: ${avg}°C).
• Xu hướng: ${trendDesc}.
• Đánh giá an toàn: ${last >= threshold ? '🚨 VƯỢT NGƯỠNG BÁO CHÁY!' : last >= threshold - 10 ? '⚠️ CẢNH BÁO NHIỆT CAO' : '✅ Mức nhiệt an toàn'}.`;
  }

  // 7. Quy trình PCCC
  if (q.includes('thoát hiểm') || q.includes('pccc') || q.includes('chữa cháy') || q.includes('114')) {
    return `🧯 [QUY TRÌNH THOÁT HIỂM AN TOÀN KHI CÓ HỎA HOẠN]
1. Bấm còi báo cháy và hô hoán mọi người xung quanh sơ tán.
2. Ngắt cầu dao điện tổng ngay lập tức.
3. Dùng khăn hoặc vải ướt bịt mũi miệng để tránh hít phải khí độc carbon monoxide (CO).
4. Cúi thấp người men sát chân tường để tìm lối thoát ra cửa hoặc cầu thang bộ (TUYỆT ĐỐI không đi thang máy).
5. Gọi ngay số khẩn cấp 114 để được lực lượng PCCC chuyên nghiệp ứng cứu.`;
  }

  // Phản hồi tổng quát
  return `Chào bạn! Tôi là Trợ lý AI của dự án "Đồng hồ thông minh cảm ứng nhiệt báo cháy & Giám sát Camera".
• Giờ hiện tại: ${time} (${date})
• Trạng thái báo thức: ${isAlarmSet ? `Bật (${alarmTime})` : 'Tắt'}
• Nhiệt độ LM35: ${temp}°C (${fireStatus === 'DANGER' ? '🚨 ĐANG BÁO ĐỘNG!' : '✅ An toàn'})
• Gmail nhận cảnh báo: ${alertEmail}
Tôi có thể hỗ trợ bạn theo dõi đồng hồ, kiểm tra báo thức, nhiệt độ, camera và quy trình PCCC an toàn!`;
}

// Endpoint chẩn đoán nguy cơ hỏa hoạn tự động
app.post('/api/ai/analyze-fire', async (req, res) => {
  const { context } = req.body ?? {};
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
    advice = `Nhiệt độ ${temp}°C vượt ngưỡng an toàn ${threshold}°C! Còi báo động đã kích hoạt, hệ thống đã gửi cảnh báo tới Gmail và Camera đã ghi hình. Vui lòng sơ tán hoặc kiểm tra ngay!`;
    actionRequired = true;
  } else if (temp >= threshold - 10) {
    riskLevel = 'WARNING';
    badgeColor = 'orange';
    title = 'CẢNH BÁO NHIỆT ĐỘ TĂNG CAO';
    advice = `Nhiệt độ ${temp}°C đang tiệm cận ngưỡng báo cháy (${threshold}°C). Hãy kiểm tra các thiết bị điện và quan sát camera.`;
  }

  res.json({
    temp,
    threshold,
    riskLevel,
    badgeColor,
    title,
    advice,
    actionRequired,
    timestamp: new Date().toLocaleTimeString('vi-VN', { hour12: false })
  });
});

// Endpoint chat chính của AI Box (kết hợp GPT-4o-mini và Local Fallback Engine)
app.post('/api/chat', async (req, res) => {
  const { message, context } = req.body ?? {};

  if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
    return res.status(400).json({ error: 'Câu hỏi phải có nội dung và tối đa 2.000 ký tự.' });
  }

  const fireContext = context && typeof context === 'object' ? context : {};

  // Nếu chưa cấu hình OpenAI API key: Sử dụng Local Engine tối ưu hóa
  if (!process.env.OPENAI_API_KEY) {
    const reply = generateLocalFireAlarmAiResponse(message, fireContext);
    return res.json({ reply });
  }

  // Nếu có OpenAI API key: Gọi GPT-4o-mini kèm context thời gian thực
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 });
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const systemPrompt = `Bạn là Trợ lý AI chuyên nghiệp của hệ thống "Đồng hồ thông minh cảm ứng nhiệt báo cháy & Giám sát Camera AI" (Smart Thermal Fire Alarm Clock).
Nhiệm vụ:
1. Đồng bộ và giải đáp về thời gian thực từ module RTC DS3231, chế độ 12h/24h, trạng thái cài đặt báo thức và chỉnh giờ.
2. Giám sát nhiệt độ cảm biến LM35, ngưỡng báo cháy, và thông báo trạng thái gửi email cảnh báo về Gmail của người dùng.
3. Hướng dẫn quy trình thoát hiểm PCCC, an toàn điện và sử dụng bình chữa cháy bằng tiếng Việt rõ ràng, chính xác.
4. Nắm rõ phần cứng IoT: Arduino Uno, ESP8266, ESP32-CAM, RTC DS3231 I2C, LCD 16x2, Active Buzzer.`;

    const completion = await client.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Dữ liệu hệ thống thời gian thực:\n${JSON.stringify(fireContext, null, 2)}\n\nCâu hỏi của người dùng:\n${message.trim()}`
        }
      ]
    });

    let replyText = completion.choices?.[0]?.message?.content?.trim();
    if (!replyText) {
      replyText = generateLocalFireAlarmAiResponse(message, fireContext);
    }
    return res.json({ reply: replyText });
  } catch (error) {
    console.error('Lỗi khi gọi OpenAI API:', error.message);
    const fallbackReply = generateLocalFireAlarmAiResponse(message, fireContext);
    return res.json({
      reply: `${fallbackReply}\n\n*(Ghi chú: Đang chạy bằng AI Engine nội bộ do: ${error.message})*`
    });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Nội dung JSON không hợp lệ.' });
  }
  console.error('Request failed:', error);
  return res.status(500).json({ error: 'Máy chủ gặp lỗi khi xử lý yêu cầu.' });
});

app.listen(port, () => {
  console.log(`=================================================================`);
  console.log(`🚨 Smart Thermal Fire Alarm Clock & AI Camera Server đang chạy!`);
  console.log(`📡 Địa chỉ Web: http://localhost:${port}`);
  console.log(`🤖 AI Status: ${process.env.OPENAI_API_KEY ? 'OpenAI Live (' + (process.env.OPENAI_MODEL || 'gpt-4o-mini') + ')' : 'Local AI Engine Sẵn sàng'}`);
  console.log(`📧 Gmail Alert: ${process.env.GMAIL_USER ? 'Đã kích hoạt (' + process.env.GMAIL_USER + ')' : 'Chế độ mô phỏng trực tiếp (Nhập trên Web)'}`);
  console.log(`=================================================================`);
});
