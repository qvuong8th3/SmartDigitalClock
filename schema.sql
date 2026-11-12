-- =============================================================================
-- DỰ ÁN: HỆ THỐNG CẢNH BÁO & GIÁM SÁT HỎA HOẠN THÔNG MINH (IoT 102)
-- CƠ SỞ DỮ LIỆU CHUẨN (SQLITE / RELATIONAL DATABASE SCHEMA)
-- =============================================================================

-- 1. Bảng Quản Lý Người Dùng & Phân Quyền
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', -- 'admin' hoặc 'user'
    password_hash TEXT NOT NULL,
    full_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

-- 2. Bảng Quản Lý Thiết Bị KIT IoT
CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    com_port TEXT,
    baud_rate INTEGER DEFAULT 115200,
    status TEXT DEFAULT 'DISCONNECTED', -- 'CONNECTED', 'DISCONNECTED', 'STANDBY'
    sensor_status TEXT DEFAULT 'NORMAL',
    buzzer_status TEXT DEFAULT 'READY',
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. Bảng Cấu Hình Ngưỡng Cảnh Báo Tập Trung
CREATE TABLE IF NOT EXISTS alert_thresholds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    warning_temp REAL NOT NULL DEFAULT 40.0,
    danger_temp REAL NOT NULL DEFAULT 50.0,
    sustain_seconds INTEGER NOT NULL DEFAULT 2,
    buzzer_enabled INTEGER NOT NULL DEFAULT 1,
    email_enabled INTEGER NOT NULL DEFAULT 1,
    rate_of_rise_threshold REAL DEFAULT 3.0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Bảng Dữ Liệu Cảm Biến Thời Gian Thực
CREATE TABLE IF NOT EXISTS sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    temperature REAL NOT NULL,
    source TEXT DEFAULT 'USB_SERIAL', -- 'USB_SERIAL', 'WIFI_ESP', 'SIMULATION'
    rate_of_rise REAL DEFAULT 0.0,
    status TEXT DEFAULT 'NORMAL', -- 'NORMAL', 'WARNING', 'DANGER'
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

-- 5. Bảng Quản Lý Sự Cố Báo Cháy
CREATE TABLE IF NOT EXISTS fire_events (
    event_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    peak_temperature REAL NOT NULL,
    severity TEXT NOT NULL DEFAULT 'DANGER', -- 'WARNING', 'DANGER', 'CRITICAL'
    status TEXT NOT NULL DEFAULT 'ACTIVE',   -- 'ACTIVE', 'RESOLVED', 'FALSE_ALARM'
    alarm_reason TEXT,
    resolution_notes TEXT,
    start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time DATETIME,
    FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

-- 6. Bảng Nhật Ký Kích Hoạt Còi Báo Động
CREATE TABLE IF NOT EXISTS alarm_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT,
    alarm_type TEXT NOT NULL, -- 'FIRE_SIREN', 'CLOCK_ALARM', 'TEST_BEEP'
    action TEXT NOT NULL,     -- 'TRIGGER', 'MUTE', 'STOP', 'AUTO_RESET'
    duration_seconds INTEGER DEFAULT 0,
    triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES fire_events(event_id)
);

-- 7. Bảng Ảnh Chứng Cứ Hiện Trường Camera AI
CREATE TABLE IF NOT EXISTS camera_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT,
    image_url TEXT NOT NULL,
    temperature REAL,
    ai_detection TEXT DEFAULT 'NORMAL', -- 'NORMAL', 'FLAME_DETECTED', 'SMOKE_DETECTED'
    confidence REAL DEFAULT 0.0,        -- Độ tin cậy (0 - 100%)
    source TEXT DEFAULT 'WEBCAM',       -- 'WEBCAM', 'ESP32_CAM', 'SIMULATION'
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES fire_events(event_id)
);

-- 8. Bảng Nhật Ký Gửi Email Cảnh Báo
CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    temperature REAL,
    status TEXT NOT NULL, -- 'SENT_REAL', 'SIMULATION_LOG', 'FAILED'
    error_message TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES fire_events(event_id)
);

-- 9. Bảng Thông Báo Hệ Thống (Notifications)
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'INFO', -- 'INFO', 'WARNING', 'DANGER', 'SUCCESS'
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 10. Bảng Nhật Ký Hoạt Động Hệ Thống (Audit Logs)
CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);


-- 11. Bảng Quản Lý Thành Viên Gia Đình Nhận Cảnh Báo Cháy
CREATE TABLE IF NOT EXISTS family_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    relation TEXT DEFAULT 'Thành viên',
    email TEXT NOT NULL,
    phone TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
