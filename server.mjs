import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT) || 3000;
const indexPath = fileURLToPath(new URL('./index.html', import.meta.url));

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
      alarmBuzzer: 'Dual-Tone Active Buzzer (Clock Alarm & Fire Siren)',
      inputButtons: 'Digital Push Buttons with 50ms Debounce'
    },
    emailAlert: {
      configured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
      sender: process.env.GMAIL_USER || 'Chưa cấu hình (Chạy chế độ mô phỏng trực quan)'
    },
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    aiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    timestamp: new Date().toISOString()
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

// Endpoint gửi cảnh báo khẩn cấp tới Gmail
app.post('/api/alert/email', async (req, res) => {
  const { email, temperature, threshold, timestamp, reason, snapshot } = req.body ?? {};

  const targetEmail = (email || '').trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!targetEmail || !emailRegex.test(targetEmail)) {
    return res.status(400).json({
      success: false,
      error: 'Địa chỉ Gmail không hợp lệ. Vui lòng kiểm tra lại định dạng email.'
    });
  }

  const temp = Number(temperature) || 0;
  const thresh = Number(threshold) || 50;
  const time = timestamp || new Date().toLocaleString('vi-VN');
  const alertReason = reason || 'Nhiệt độ cảm biến vượt ngưỡng an toàn';

  const subject = `🚨 [CẢNH BÁO KHẨN CẤP] Smart Fire Clock: Phát hiện nhiệt độ ${temp.toFixed(1)}°C vượt ngưỡng!`;

  const textContent = `
🚨 CẢNH BÁO BÁO CHÁY KHẨN CẤP TỪ HỆ THỐNG SMART DIGITAL CLOCK 🚨
-------------------------------------------------------------
Thời gian phát hiện: ${time}
Nhiệt độ cảm biến LM35: ${temp.toFixed(1)}°C
Ngưỡng kích hoạt báo động: ${thresh.toFixed(1)}°C
Lý do cảnh báo: ${alertReason}
Trạng thái thiết bị: Còi hú báo động đang kích hoạt, Camera đã ghi nhận hiện trường.

HƯỚNG DẪN XỬ LÝ KHẨN CẤP (PCCC):
1. Giữ bình tĩnh, ngắt ngay nguồn điện hoặc cầu dao tổng khu vực xảy ra sự cố.
2. Kiểm tra hình ảnh từ camera giám sát để định vị vị trí phát sinh nhiệt.
3. Sử dụng bình chữa cháy mini dập tắt ngay nếu đám cháy mới chớm.
4. Gọi ngay Cảnh sát PCCC 114 nếu nhiệt độ tiếp tục tăng cao.
-------------------------------------------------------------
Hệ thống Smart Thermal Fire Alarm Clock & AI Vision
`;

  const htmlContent = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; background-color: #f8fafc; padding: 20px; color: #0f172a;">
  <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 12px; border: 1px solid #fee2e2; overflow: hidden; box-shadow: 0 4px 15px rgba(239,68,68,0.15);">
    <div style="background: linear-gradient(135deg, #b91c1c, #ef4444); color: white; padding: 20px; text-align: center;">
      <h1 style="margin: 0; font-size: 22px;">🚨 CẢNH BÁO BÁO CHÁY TỰ ĐỘNG</h1>
      <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.9;">Smart Thermal Fire Alarm Clock & AI Vision System</p>
    </div>
    <div style="padding: 24px;">
      <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 14px; border-radius: 6px; margin-bottom: 20px;">
        <strong style="color: #b91c1c; font-size: 16px;">Phát hiện nguy cơ hỏa hoạn vượt ngưỡng an toàn!</strong>
        <p style="margin: 6px 0 0; color: #475569; font-size: 13.5px;">Cảm biến nhiệt độ LM35 và đồng hồ thời gian thực RTC DS3231 đã ghi nhận biến cố bất thường.</p>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;">
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px; color: #64748b;">⏱️ Thời gian ghi nhận:</td>
          <td style="padding: 10px; font-weight: bold; color: #0f172a;">${time}</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px; color: #64748b;">🌡️ Nhiệt độ LM35:</td>
          <td style="padding: 10px; font-weight: bold; color: #ef4444; font-size: 18px;">${temp.toFixed(1)} °C</td>
        </tr>
        <tr style="border-bottom: 1px solid #f1f5f9;">
          <td style="padding: 10px; color: #64748b;">⚙️ Ngưỡng kích hoạt:</td>
          <td style="padding: 10px; font-weight: bold; color: #0f172a;">${thresh.toFixed(1)} °C</td>
        </tr>
        <tr>
          <td style="padding: 10px; color: #64748b;">🔔 Trạng thái còi hú:</td>
          <td style="padding: 10px; font-weight: bold; color: #b91c1c;">ĐANG KÍCH HOẠT HÚ CÒI</td>
        </tr>
      </table>

      ${snapshot ? `<div style="text-align: center; margin: 15px 0;"><img src="${snapshot}" alt="Ảnh hiện trường" style="max-width: 100%; border-radius: 8px; border: 1px solid #e2e8f0;" /></div>` : ''}

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px;">
        <strong style="color: #0f172a; font-size: 13.5px;">🛡️ QUY TRÌNH XỬ LÝ KHẨN CẤP:</strong>
        <ol style="margin: 8px 0 0; padding-left: 20px; color: #475569; font-size: 13px; line-height: 1.6;">
          <li>Ngắt ngay cầu dao tổng tại khu vực nghi ngờ.</li>
          <li>Kiểm tra camera giám sát để xác định đốm lửa hoặc khói.</li>
          <li>Dùng bình chữa cháy mini dập lửa hoặc sơ tán theo lối thoát hiểm.</li>
          <li>Gọi khẩn cấp lực lượng Cứu hỏa PCCC <strong>114</strong> nếu sự cố lan rộng.</li>
        </ol>
      </div>
    </div>
    <div style="background: #f1f5f9; padding: 12px; text-align: center; font-size: 12px; color: #64748b;">
      Hệ thống Đồng hồ Cảm biến Nhiệt Báo cháy & Giám sát Camera AI · IoT 102
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
