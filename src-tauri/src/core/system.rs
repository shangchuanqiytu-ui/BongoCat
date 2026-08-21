//! 系统级查询（替代已删除的全局键鼠钩子）：空闲时长、光标位置、对话轮次互斥。
//! 查询式 API，不装钩子、不需要管理员权限。

use std::sync::atomic::{AtomicBool, Ordering};

/// 全进程"对话轮次进行中"标志：所有窗口（宠物/聊天记录）共享一个进程，
/// 以 CAS 实现跨窗口互斥——同一时刻只允许一轮对话在飞（读快照→LLM→落盘），
/// 消除多窗口并发读写的竞态。进程退出标志即消失，无死锁残留，
/// 因此不需要 OpenClaw 那种文件锁的过期偷锁逻辑。
static CHAT_ROUND_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 尝试抢占对话轮次：返回 true=抢到（此前空闲），false=别窗正在对话中。
#[tauri::command]
pub fn chat_round_begin() -> bool {
    !CHAT_ROUND_ACTIVE.swap(true, Ordering::SeqCst)
}

/// 归还对话轮次。
#[tauri::command]
pub fn chat_round_end() {
    CHAT_ROUND_ACTIVE.store(false, Ordering::SeqCst);
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
