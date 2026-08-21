//! 系统级查询（替代已删除的全局键鼠钩子）：空闲时长、光标位置、对话轮次互斥。
//! 查询式 API，不装钩子、不需要管理员权限。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 全进程"对话轮次进行中"标志：所有窗口（宠物/聊天记录）共享一个进程，
/// 以 CAS 实现跨窗口互斥——同一时刻只允许一轮对话在飞（读快照→LLM→落盘）。
static CHAT_ROUND_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 持锁令牌：只有 token 匹配的持有者才能释放，
/// 防止"IPC 抖动导致未持锁却误归还"偷掉别窗正在持有的锁。
static CHAT_ROUND_TOKEN: AtomicU32 = AtomicU32::new(0);

static CHAT_ROUND_TOKEN_SEQ: AtomicU32 = AtomicU32::new(0);

/// 持锁时刻（ms）：单 webview 崩溃时 JS 的 finally 不会执行、进程却还活着，
/// 超过 STALE 阈值后允许下一轮直接接管（等价 OpenClaw 文件锁的过期偷锁）。
static CHAT_ROUND_ACQUIRED_AT: AtomicU64 = AtomicU64::new(0);

/// 偷锁阈值：正常一轮 ≤35s（LLM 30s 超时），前端最长自旋 75s 后降级，
/// 120s 足以覆盖健康轮次，又不至于卡死太久。
const CHAT_ROUND_STALE_MS: u64 = 120_000;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 尝试抢占对话轮次：抢到返回本次的 token（正整数），被占返回 None；
/// 持锁超过 STALE 阈值视为持有者已死，直接接管（换新 token）。
#[tauri::command]
pub fn chat_round_begin() -> Option<u32> {
    let token = CHAT_ROUND_TOKEN_SEQ.fetch_add(1, Ordering::SeqCst) + 1;

    if !CHAT_ROUND_ACTIVE.swap(true, Ordering::SeqCst) {
        CHAT_ROUND_TOKEN.store(token, Ordering::SeqCst);

        CHAT_ROUND_ACQUIRED_AT.store(now_ms(), Ordering::SeqCst);

        return Some(token);
    }

    let acquired_at = CHAT_ROUND_ACQUIRED_AT.load(Ordering::SeqCst);

    if now_ms().saturating_sub(acquired_at) > CHAT_ROUND_STALE_MS {
        // 陈旧锁接管：换 token，旧持有者迟到的 end 因 token 不匹配自然失效
        CHAT_ROUND_TOKEN.store(token, Ordering::SeqCst);

        CHAT_ROUND_ACQUIRED_AT.store(now_ms(), Ordering::SeqCst);

        return Some(token);
    }

    None
}

/// 归还对话轮次：仅当 token 与当前持有者一致时生效。
#[tauri::command]
pub fn chat_round_end(token: u32) {
    if CHAT_ROUND_TOKEN.load(Ordering::SeqCst) == token {
        CHAT_ROUND_ACTIVE.store(false, Ordering::SeqCst);
    }
}

/// 距上次系统输入（键鼠任意操作）的秒数，供主动搭话的空闲判定。
#[tauri::command]
pub fn get_idle_seconds() -> Option<u64> {
    get_idle_seconds_impl()
}

/// 当前光标物理坐标（px），供悬停隐藏的恢复检测。
#[tauri::command]
pub fn get_cursor_pos() -> Option<(f64, f64)> {
    get_cursor_pos_impl()
}

#[cfg(windows)]
fn get_idle_seconds_impl() -> Option<u64> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::System::SystemInformation::GetTickCount64;

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };

    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }

    // GetTickCount64 低 32 位与 LASTINPUTINFO.dwTime 同基准；dwTime 是 u32（约 49.7 天回绕），
    // 必须把 now 截到同一 u32 域再做 wrapping_sub，否则开机超 49.7 天后空闲恒为巨大值
    let now = unsafe { GetTickCount64() } as u32;

    let elapsed_ms = now.wrapping_sub(info.dwTime) as u64;

    Some(elapsed_ms / 1000)
}

#[cfg(windows)]
fn get_cursor_pos_impl() -> Option<(f64, f64)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT { x: 0, y: 0 };

    if unsafe { GetCursorPos(&mut point) } == 0 {
        return None;
    }

    Some((point.x as f64, point.y as f64))
}

#[cfg(not(windows))]
fn get_idle_seconds_impl() -> Option<u64> {
    None
}

#[cfg(not(windows))]
fn get_cursor_pos_impl() -> Option<(f64, f64)> {
    None
}
