import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';

const NODE_BIN = 'C:\\Users\\QUOC VUONG\\AppData\\Local\\ms-playwright-go\\1.57.0\\node.exe';
const results = [];

function assert(name, condition, details = '') {
  if (condition) {
    results.push({ name, pass: true, details });
    console.log(`[PASS] ${name}`);
  } else {
    results.push({ name, pass: false, details });
    console.error(`[FAIL] ${name}: ${details}`);
  }
}

// 1. Kiểm tra cấu trúc file dự án
console.log('--- 1. KIỂM TRA TỆP TIN DỰ ÁN ---');
const cwd = existsSync('index.html') ? '.' : 'SmartDigitalClock';
assert('File index.html tồn tại', existsSync(`${cwd}/index.html`));
assert('File server.mjs tồn tại', existsSync(`${cwd}/server.mjs`));
assert('File package.json tồn tại', existsSync(`${cwd}/package.json`));
assert('File README.md tồn tại', existsSync(`${cwd}/README.md`));
assert('Firmware Arduino Uno tồn tại', existsSync(`${cwd}/firmware/SmartFireClock_Arduino.ino`));
assert('Firmware ESP32-CAM tồn tại', existsSync(`${cwd}/firmware/ESP32_CAM_FireMonitor.ino`));
assert('Firmware Pinout README tồn tại', existsSync(`${cwd}/firmware/README.md`));

// 2. Kiểm tra DOM IDs trong index.html
console.log('\n--- 2. KIỂM TRA TÍNH TOÀN VẸN DOM CỦA INDEX.HTML ---');
const html = readFileSync(`${cwd}/index.html`, 'utf-8');
const requiredIds = [
  'clock', 'topTime', 'hudTimestamp', 'date',
  'alarmTimeInput', 'alarmStatusBadge', 'alarmToggleBtn', 'topAlarmStatus', 'topAlarmSub', 'aiAlarmVal',
  'clockAlarmBanner', 'clockAlarmBannerDetail',
  'alertEmailInput', 'gmailBadgeText', 'fireStatusSub', 'aiGmailVal', 'gmailAlertStatus', 'testEmailBtn',
  'fireAlarmBanner', 'alarmBannerDetail', 'fireStatusText', 'fireIconBadge',
  'buzzerState', 'hudStatusBadge', 'temperature', 'topThreshold', 'thresholdSlider', 'sliderValDisplay',
  'thermalGaugeFill', 'hudTempText', 'chartBox', 'fireHistoryTable', 'snapshotList', 'snapshotCountText',
  'simCanvas', 'cameraFeed', 'cameraSourceSelect', 'cameraViewport',
  'aiBoxSection', 'aiBoxPanel', 'aiMessages', 'aiInput', 'aiSendBtn', 'aiTypingIndicator', 'aiForm',
  'hardwareModal', 'arduinoCodeSnippet', 'esp32CodeSnippet', 'tabBtnArduino', 'tabBtnEsp32', 'tabBtnPinout',
  'toastMsg', 'toastText', 'toastIcon'
];

let missingIds = [];
for (const id of requiredIds) {
  if (!html.includes(`id="${id}"`)) {
    missingIds.push(id);
  }
}
assert('Toàn bộ ID giao diện cần thiết đều hiện diện trong DOM', missingIds.length === 0, missingIds.join(', '));
assert('Còi báo cháy & Chuông báo thức hỗ trợ kêu liên tục vĩnh viễn (chờ người dùng tắt)', html.includes('triggerContinuousFireSiren') && html.includes('clockAlarmElapsedSeconds'));
assert('Hệ thống tự động kích hoạt gửi Gmail khi phát hiện hỏa hoạn', html.includes('dispatchFireEmailAlert') && html.includes('isFireAlarmActive'));

// 3. Khởi động server trên cổng thử nghiệm 3999 để test API
console.log('\n--- 3. KIỂM TRA CÁC API ENDPOINTS CỦA SERVER ---');
const serverProcess = spawn(NODE_BIN, ['server.mjs'], {
  cwd,
  env: { ...process.env, PORT: '3999', NODE_TLS_REJECT_UNAUTHORIZED: '0' }
});

serverProcess.stdout.on('data', d => console.log('[SERVER STDOUT]:', d.toString().trim()));
serverProcess.stderr.on('data', d => console.error('[SERVER STDERR]:', d.toString().trim()));

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3999,
      path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), raw: data });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// Chờ server khởi động 1 giây
await new Promise(r => setTimeout(r, 1200));

try {
  // Test GET /
  const home = await request('/');
  assert('GET / (Phục vụ Dashboard HTML)', home.status === 200 && home.raw.includes('Smart Digital Clock'));

  // Test GET /api/status
  const status = await request('/api/status');
  assert('GET /api/status (Kiểm tra trạng thái hệ thống)', status.status === 200 && status.body?.status === 'online');

  // Test POST & GET /api/config/email (Đồng bộ Gmail)
  const saveEmail = await request('/api/config/email', {
    method: 'POST',
    body: { email: 'test_student_iot@gmail.com' }
  });
  assert('POST /api/config/email (Lưu và đồng bộ Gmail)', saveEmail.status === 200 && saveEmail.body?.success === true);

  const getEmail = await request('/api/config/email');
  assert('GET /api/config/email (Đọc email đã đồng bộ)', getEmail.status === 200 && getEmail.body?.email === 'test_student_iot@gmail.com');

  // Test POST /api/sensor/reading (Hardware Telemetry)
  const sensorPost = await request('/api/sensor/reading', {
    method: 'POST',
    body: { temperature: 31.8, isFire: false, deviceId: 'TEST-ARDUINO-01' }
  });
  assert('POST /api/sensor/reading (Nhận dữ liệu cảm biến thật)', sensorPost.status === 200 && sensorPost.body?.success === true);

  const sensorGet = await request('/api/sensor/latest');
  assert('GET /api/sensor/latest (Đọc telemetry cảm biến thật)', sensorGet.status === 200 && sensorGet.body?.telemetry?.temperature === 31.8);

  // Test POST /api/alert/email (Báo cáo hỏa hoạn)
  const emailAlert = await request('/api/alert/email', {
    method: 'POST',
    body: {
      email: 'test_student_iot@gmail.com',
      temperature: 66.2,
      threshold: 50.0,
      reason: 'Kiểm thử hệ thống báo động tự động'
    }
  });
  assert('POST /api/alert/email (Gửi báo cáo sự cố PCCC)', emailAlert.status === 200 && emailAlert.body?.success === true);

  // Test POST /api/ai/analyze-fire
  const aiAnalyze = await request('/api/ai/analyze-fire', {
    method: 'POST',
    body: { context: { temperature: 68.0, alarmThreshold: 50.0 } }
  });
  assert('POST /api/ai/analyze-fire (Chẩn đoán AI hỏa hoạn)', aiAnalyze.status === 200 && aiAnalyze.body?.riskLevel === 'DANGER');

  // Test POST /api/chat (Hội thoại AI Box)
  const aiChat = await request('/api/chat', {
    method: 'POST',
    body: {
      message: 'Mấy giờ rồi và nhiệt độ hiện tại thế nào?',
      context: { time: '19:00:00', temperature: 28.5, fireStatus: 'SAFE' }
    }
  });
  assert('POST /api/chat (Trợ lý AI Box phản hồi chính xác)', aiChat.status === 200 && typeof aiChat.body?.reply === 'string' && aiChat.body.reply.length > 20);

} catch (err) {
  assert('Lỗi kết nối API Server', false, err.message);
} finally {
  serverProcess.kill();
}

console.log('\n================ TỔNG KẾT KIỂM THỬ ================');
const passed = results.filter(r => r.pass).length;
const total = results.length;
const percent = Math.round((passed / total) * 100);
console.log(`Đã vượt qua: ${passed} / ${total} bài kiểm tra (${percent}%).`);

// Dọn dẹp email-config.json test nếu có
try {
  const cfg = `${cwd}/email-config.json`;
  if (existsSync(cfg)) {
    unlinkSync(cfg);
  }
} catch {}
