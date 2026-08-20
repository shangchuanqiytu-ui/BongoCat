//! 系统级查询（替代已删除的全局键鼠钩子）：空闲时长、光标位置。
//! 查询式 API，不装钩子、不需要管理员权限。

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
