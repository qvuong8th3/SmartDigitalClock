// =============================================================================
// DATABASE MANAGER: QUẢN LÝ DỮ LIỆU BỀN VỮNG CHO HỆ THỐNG PCCC (IoT 102)
// Hỗ trợ SQLite chuẩn và file lưu trữ bền vững (Auto-Persistence)
// =============================================================================
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dbFilePath = join(__dirname, 'smart_fire_clock.json');

// Khởi tạo trạng thái dữ liệu mặc định
const initialData = {
  users: [
    {
      id: 1,
      username: 'admin',
      role: 'admin',
      password_hash: 'admin123', // Mật khẩu mặc định
      full_name: 'Quản Trị Viên Hệ Thống PCCC',
      created_at: new Date().toISOString()
    },
    {
      id: 2,
      username: 'user',
      role: 'user',
      password_hash: '123456',
      full_name: 'Nhân Viên Giám Sát',
      created_at: new Date().toISOString()
    }
  ],
  devices: [
    {
      device_id: 'ARDUINO-UNO-01',
      name: 'KIT Arduino Uno & RTC DS3231 (Trạm Giám Sát)',
      com_port: 'COM3',
      baud_rate: 115200,
      status: 'STANDBY',
      sensor_status: 'NORMAL',
      buzzer_status: 'READY',
      last_seen: new Date().toISOString()
    },
    {
      device_id: 'ESP32-CAM-01',
      name: 'Camera Giám Sát AI Hiện Trường',
      com_port: 'WiFi/IP',
      baud_rate: 115200,
      status: 'STANDBY',
      sensor_status: 'NORMAL',
      buzzer_status: 'STANDBY',
      last_seen: new Date().toISOString()
    }
  ],
  alert_thresholds: {
    warning_temp: 40.0,
    danger_temp: 50.0,
    sustain_seconds: 2,
    buzzer_enabled: 1,
    email_enabled: 1,
    rate_of_rise_threshold: 3.0,
    updated_at: new Date().toISOString()
  },
  sensor_data: [],
  fire_events: [],
  alarm_logs: [],
  camera_images: [],
  email_logs: [],
  notifications: [
    {
      id: 1,
      title: 'Hệ thống khởi động',
      message: 'Máy chủ Giám sát PCCC & Đồng hồ thông minh đã sẵn sàng.',
      level: 'INFO',
      is_read: 0,
      created_at: new Date().toISOString()
    }
  ],
  system_logs: [
    {
      id: 1,
      action: 'SYSTEM_BOOT',
      details: 'Khởi động máy chủ và nạp cơ sở dữ liệu bền vững.',
      created_at: new Date().toISOString()
    }
  ],
  family_members: [
    {
      id: 1,
      name: 'Bố (Chủ Hộ)',
      relation: 'Chủ Hộ',
      email: 'bo.giadinh@gmail.com',
      phone: '0901234567',
      is_active: 1,
      created_at: new Date().toISOString()
    },
    {
      id: 2,
      name: 'Mẹ',
      relation: 'Mẹ',
      email: 'me.giadinh@gmail.com',
      phone: '0912345678',
      is_active: 1,
      created_at: new Date().toISOString()
    },
    {
      id: 3,
      name: 'Con Trai',
      relation: 'Con',
      email: 'contrai.giadinh@gmail.com',
      phone: '0987654321',
      is_active: 1,
      created_at: new Date().toISOString()
    }
  ]
};

let db = { ...initialData };

// Tải dữ liệu từ đĩa khi khởi động
export function initDatabase() {
  try {
    if (existsSync(dbFilePath)) {
      const raw = readFileSync(dbFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      db = {
        ...initialData,
        ...parsed,
        alert_thresholds: { ...initialData.alert_thresholds, ...(parsed.alert_thresholds || {}) },
        family_members: (Array.isArray(parsed.family_members) && parsed.family_members.length > 0) ? parsed.family_members : [...initialData.family_members]
      };
      console.log(`[DATABASE] Đã tải CSDL bền vững từ file: ${dbFilePath}`);
    } else {
      saveDatabase();
      console.log(`[DATABASE] Khởi tạo CSDL mới tại: ${dbFilePath}`);
    }
  } catch (err) {
    console.error('[DATABASE] Lỗi đọc CSDL, khởi tạo mặc định:', err.message);
    saveDatabase();
  }
}

export function saveDatabase() {
  try {
    writeFileSync(dbFilePath, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DATABASE] Lỗi ghi CSDL:', err.message);
  }
}

// 1. Quản lý ngưỡng cảnh báo
export function getThresholds() {
  return { ...db.alert_thresholds };
}

export function updateThresholds(updates) {
  if (typeof updates.warning_temp === 'number') db.alert_thresholds.warning_temp = updates.warning_temp;
  if (typeof updates.danger_temp === 'number') db.alert_thresholds.danger_temp = updates.danger_temp;
  if (typeof updates.sustain_seconds === 'number') db.alert_thresholds.sustain_seconds = updates.sustain_seconds;
  if (typeof updates.buzzer_enabled === 'number' || typeof updates.buzzer_enabled === 'boolean') {
    db.alert_thresholds.buzzer_enabled = updates.buzzer_enabled ? 1 : 0;
  }
  if (typeof updates.email_enabled === 'number' || typeof updates.email_enabled === 'boolean') {
    db.alert_thresholds.email_enabled = updates.email_enabled ? 1 : 0;
  }
  if (typeof updates.rate_of_rise_threshold === 'number') {
    db.alert_thresholds.rate_of_rise_threshold = updates.rate_of_rise_threshold;
  }
  db.alert_thresholds.updated_at = new Date().toISOString();
  saveDatabase();
  return db.alert_thresholds;
}

// 2. Quản lý dữ liệu cảm biến
export function recordSensorData({ device_id = 'ARDUINO-UNO-01', temperature, source = 'USB_SERIAL', rate_of_rise = 0.0, status = 'NORMAL' }) {
  const item = {
    id: db.sensor_data.length + 1,
    device_id,
    temperature: Number(temperature),
    source,
    rate_of_rise: Number(rate_of_rise),
    status,
    recorded_at: new Date().toISOString()
  };
  db.sensor_data.push(item);
  if (db.sensor_data.length > 2000) {
    db.sensor_data = db.sensor_data.slice(-2000); // Giữ 2.000 mẫu gần nhất
  }
  saveDatabase();
  return item;
}

export function getSensorHistory(timeFilter = 'all') {
  const now = Date.now();
  let filtered = db.sensor_data;

  if (timeFilter === '1h') {
    const limit = now - 3600 * 1000;
    filtered = filtered.filter(d => new Date(d.recorded_at).getTime() >= limit);
  } else if (timeFilter === '24h') {
    const limit = now - 24 * 3600 * 1000;
    filtered = filtered.filter(d => new Date(d.recorded_at).getTime() >= limit);
  } else if (timeFilter === '7d') {
    const limit = now - 7 * 24 * 3600 * 1000;
    filtered = filtered.filter(d => new Date(d.recorded_at).getTime() >= limit);
  } else if (timeFilter === '30d') {
    const limit = now - 30 * 24 * 3600 * 1000;
    filtered = filtered.filter(d => new Date(d.recorded_at).getTime() >= limit);
  }

  // Tính thống kê Min, Max, Avg
  let min = 999.0;
  let max = -999.0;
  let sum = 0.0;

  if (filtered.length > 0) {
    for (const item of filtered) {
      if (item.temperature < min) min = item.temperature;
      if (item.temperature > max) max = item.temperature;
      sum += item.temperature;
    }
  } else {
    min = 28.5;
    max = 28.5;
    sum = 28.5;
  }

  const avg = filtered.length > 0 ? (sum / filtered.length) : 28.5;

  return {
    records: filtered.slice(-100), // 100 mẫu gần nhất cho biểu đồ
    totalSamples: filtered.length,
    stats: {
      min: Number(min.toFixed(1)),
      max: Number(max.toFixed(1)),
      avg: Number(avg.toFixed(1))
    }
  };
}

// 3. Quản lý sự cố hỏa hoạn (Fire Events)
export function createFireEvent({ event_id, device_id = 'ARDUINO-UNO-01', peak_temperature, severity = 'DANGER', alarm_reason = 'Vượt ngưỡng an toàn PCCC' }) {
  const id = event_id || 'EVT-' + Date.now();
  const event = {
    event_id: id,
    device_id,
    peak_temperature: Number(peak_temperature),
    severity,
    status: 'ACTIVE',
    alarm_reason,
    resolution_notes: '',
    start_time: new Date().toISOString(),
    end_time: null
  };
  db.fire_events.unshift(event);
  if (db.fire_events.length > 200) db.fire_events = db.fire_events.slice(0, 200);

  // Thêm thông báo
  addNotification({
    title: '🚨 Báo Động Hỏa Hoạn!',
    message: `Phát hiện nhiệt độ ${peak_temperature}°C vượt ngưỡng an toàn! Còi báo động đã kích hoạt.`,
    level: 'DANGER'
  });

  saveDatabase();
  return event;
}

export function resolveFireEvent(eventId, notes = '') {
  const event = db.fire_events.find(e => e.event_id === eventId);
  if (event) {
    event.status = 'RESOLVED';
    event.end_time = new Date().toISOString();
    event.resolution_notes = notes || 'Đã kiểm tra và xác nhận an toàn tại chỗ.';
    saveDatabase();
    return event;
  }
  return null;
}

export function getFireEvents() {
  return [...db.fire_events];
}

// 4. Quản lý còi báo động (Alarm Logs)
export function logAlarmAction({ event_id = null, alarm_type = 'FIRE_SIREN', action = 'TRIGGER', duration_seconds = 0 }) {
  const log = {
    id: db.alarm_logs.length + 1,
    event_id,
    alarm_type,
    action,
    duration_seconds,
    triggered_at: new Date().toISOString()
  };
  db.alarm_logs.unshift(log);
  if (db.alarm_logs.length > 500) db.alarm_logs = db.alarm_logs.slice(0, 500);
  saveDatabase();
  return log;
}

export function getAlarmLogs() {
  return [...db.alarm_logs];
}

// 5. Quản lý ảnh chụp Camera AI
export function saveCameraImage({ event_id = null, image_url, temperature, ai_detection = 'NORMAL', confidence = 0.0, source = 'WEBCAM' }) {
  const item = {
    id: db.camera_images.length + 1,
    event_id,
    image_url,
    temperature: Number(temperature),
    ai_detection,
    confidence: Number(confidence),
    source,
    captured_at: new Date().toISOString()
  };
  db.camera_images.unshift(item);
  if (db.camera_images.length > 50) db.camera_images = db.camera_images.slice(0, 50); // Giữ 50 ảnh gần nhất
  saveDatabase();
  return item;
}

export function getCameraImages() {
  return [...db.camera_images];
}

export function deleteCameraImage(id) {
  const numId = Number(id);
  db.camera_images = db.camera_images.filter(img => img.id !== numId);
  saveDatabase();
  return true;
}

// 6. Quản lý gửi Email
export function logEmailDispatch({ event_id = null, recipient, subject, temperature, status, error_message = '' }) {
  const log = {
    id: db.email_logs.length + 1,
    event_id,
    recipient,
    subject,
    temperature: Number(temperature),
    status,
    error_message,
    sent_at: new Date().toISOString()
  };
  db.email_logs.unshift(log);
  if (db.email_logs.length > 200) db.email_logs = db.email_logs.slice(0, 200);
  saveDatabase();
  return log;
}

export function getEmailLogs() {
  return [...db.email_logs];
}

// 7. Thông báo và nhật ký kiểm toán hệ thống
export function addNotification({ title, message, level = 'INFO' }) {
  const notif = {
    id: db.notifications.length + 1,
    title,
    message,
    level,
    is_read: 0,
    created_at: new Date().toISOString()
  };
  db.notifications.unshift(notif);
  if (db.notifications.length > 100) db.notifications = db.notifications.slice(0, 100);
  saveDatabase();
  return notif;
}

export function getNotifications() {
  return [...db.notifications];
}

export function markNotificationsRead() {
  db.notifications.forEach(n => { n.is_read = 1; });
  saveDatabase();
  return true;
}

export function logSystemAction(action, details = '', ip_address = '127.0.0.1') {
  const item = {
    id: db.system_logs.length + 1,
    action,
    details,
    ip_address,
    created_at: new Date().toISOString()
  };
  db.system_logs.unshift(item);
  if (db.system_logs.length > 500) db.system_logs = db.system_logs.slice(0, 500);
  saveDatabase();
  return item;
}

export function getSystemLogs() {
  return [...db.system_logs];
}

// 8. Quản lý thiết bị
export function getDevices() {
  return [...db.devices];
}

export function updateDeviceHeartbeat(deviceId, updates = {}) {
  const dev = db.devices.find(d => d.device_id === deviceId);
  if (dev) {
    if (updates.status) dev.status = updates.status;
    if (updates.sensor_status) dev.sensor_status = updates.sensor_status;
    if (updates.buzzer_status) dev.buzzer_status = updates.buzzer_status;
    if (updates.com_port) dev.com_port = updates.com_port;
    dev.last_seen = new Date().toISOString();
    saveDatabase();
    return dev;
  }
  return null;
}

// 9. Xác thực người dùng (Auth)
export function authenticateUser(username, password) {
  const user = db.users.find(u => u.username === username && u.password_hash === password);
  if (user) {
    user.last_login = new Date().toISOString();
    saveDatabase();
    return { success: true, user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name } };
  }
  return { success: false, error: 'Tên đăng nhập hoặc mật khẩu không đúng.' };
}


// 10. Quản lý thành viên gia đình (Family Members)
export function getFamilyMembers() {
  if (!Array.isArray(db.family_members)) db.family_members = [...initialData.family_members];
  return [...db.family_members];
}

export function addFamilyMember({ name, relation = 'Thành viên', email, phone = '', is_active = 1 }) {
  if (!Array.isArray(db.family_members)) db.family_members = [];
  const maxId = db.family_members.reduce((acc, m) => Math.max(acc, m.id || 0), 0);
  const member = {
    id: maxId + 1,
    name: (name || '').trim(),
    relation: (relation || 'Thành viên').trim(),
    email: (email || '').trim().toLowerCase(),
    phone: (phone || '').trim(),
    is_active: is_active ? 1 : 0,
    created_at: new Date().toISOString()
  };
  db.family_members.push(member);
  saveDatabase();
  return member;
}

export function updateFamilyMember(id, updates = {}) {
  if (!Array.isArray(db.family_members)) return null;
  const numId = Number(id);
  const member = db.family_members.find(m => m.id === numId);
  if (!member) return null;

  if (typeof updates.name === 'string') member.name = updates.name.trim();
  if (typeof updates.relation === 'string') member.relation = updates.relation.trim();
  if (typeof updates.email === 'string') member.email = updates.email.trim().toLowerCase();
  if (typeof updates.phone === 'string') member.phone = updates.phone.trim();
  if (typeof updates.is_active !== 'undefined') {
    member.is_active = updates.is_active ? 1 : 0;
  }
  member.updated_at = new Date().toISOString();
  saveDatabase();
  return member;
}

export function deleteFamilyMember(id) {
  if (!Array.isArray(db.family_members)) return false;
  const numId = Number(id);
  const idx = db.family_members.findIndex(m => m.id === numId);
  if (idx !== -1) {
    db.family_members.splice(idx, 1);
    saveDatabase();
    return true;
  }
  return false;
}
export function changeUserPassword(username, oldPassword, newPassword) {
  const user = db.users.find(u => u.username === username && u.password_hash === oldPassword);
  if (!user) return { success: false, error: 'Mật khẩu cũ không chính xác.' };
  user.password_hash = newPassword;
  saveDatabase();
  return { success: true, message: 'Đổi mật khẩu thành công.' };
}

// Khởi chạy khi nạp module
initDatabase();
