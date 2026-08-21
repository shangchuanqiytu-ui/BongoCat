//! AI API Key 的安全存储（Windows 凭据管理器，替代 pinia 明文持久化）。

#[cfg(windows)]
mod impl_ {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    const TARGET: &str = "BongoCat/AiApiKey";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn get() -> Option<String> {
        let target = wide(TARGET);
        let mut cred_ptr: *mut CREDENTIALW = std::ptr::null_mut();

        // CredReadW 的 blob 按 UTF-16 写入，原样读回
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred_ptr) } != 1 {
            return None;
        }

        let cred = unsafe { &*cred_ptr };

        let blob = unsafe {
            std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize)
        };

        let text = String::from_utf16_lossy(
            &blob
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<u16>>(),
        );

        unsafe { CredFree(cred_ptr.cast()) };

        Some(text)
    }

    pub fn set(value: &str) -> Result<(), String> {
        // 空 key = 清除凭据（走中转不需要 key）
        if value.is_empty() {
            let target = wide(TARGET);

            unsafe {
                CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0);
            }

            return Ok(());
        }

        let mut target = wide(TARGET);
        let mut username = wide("BongoCat");
        let mut blob: Vec<u16> = value.encode_utf16().collect();

        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            CredentialBlobSize: (blob.len() * 2) as u32,
            CredentialBlob: blob.as_mut_ptr().cast(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: username.as_mut_ptr(),
        };

        if unsafe { CredWriteW(&cred, 0) } != 1 {
            return Err("凭据管理器写入失败".into());
        }

        Ok(())
    }
}

/// 读取 API Key（无凭据/非 Windows 返回 None，等价"走本地中转"）。
#[tauri::command]
pub fn get_api_key() -> Option<String> {
    #[cfg(windows)]
    { impl_::get() }

    #[cfg(not(windows))]
    { None }
}

/// 保存 API Key（空串 = 清除）。非 Windows 静默成功（key 只在内存态）。
#[tauri::command]
pub fn set_api_key(value: String) -> Result<(), String> {
    #[cfg(windows)]
    { impl_::set(&value) }

    #[cfg(not(windows))]
    {
        let _ = value;
        Ok(())
    }
}
