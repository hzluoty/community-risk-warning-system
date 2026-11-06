//! VLM 资源发现与缺失文件检查（llama-server.exe / gguf / CUDA DLL）。
//! `resource_dir` 语义 = vlm 资源目录本身（含可执行与模型，同层）。

use std::path::{Path, PathBuf};

pub struct VlmResources {
    pub server_exe: PathBuf,
    pub model_dir: PathBuf,
    pub cuda_available: bool,
}

pub fn find_vlm_resources(resource_dir: &Path) -> Option<VlmResources> {
    // 必需运行时文件名（契约驱动：shared/vlmRuntime.json 的 requiredRuntimeFiles 段）
    let spec = &crws_core::contract::vlm_runtime()["requiredRuntimeFiles"];
    let server_name = spec["serverExecutable"].as_str().expect("serverExecutable");
    let cuda_dlls: Vec<&str> = spec["cudaDlls"]
        .as_array()
        .expect("cudaDlls array")
        .iter()
        .map(|v| v.as_str().expect("cudaDlls entry"))
        .collect();

    let server_exe = resource_dir.join(server_name);
    if !server_exe.is_file() {
        return None;
    }
    let cuda_available = cuda_dlls.iter().all(|dll| resource_dir.join(dll).is_file());
    Some(VlmResources {
        server_exe,
        model_dir: resource_dir.to_path_buf(),
        cuda_available,
    })
}

pub fn missing_required_vlm_files(model_path: &Path, mmproj_path: Option<&Path>) -> Vec<PathBuf> {
    let mut missing = Vec::new();
    if !model_path.is_file() {
        missing.push(model_path.to_path_buf());
    }
    if let Some(mmproj) = mmproj_path {
        if !mmproj.is_file() {
            missing.push(mmproj.to_path_buf());
        }
    }
    missing
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_files_reported_for_both_model_and_mmproj() {
        let dir = std::env::temp_dir();
        let model = dir.join("no-such-model.gguf");
        let mmproj = dir.join("no-such-mmproj.gguf");
        let missing = missing_required_vlm_files(&model, Some(&mmproj));
        assert_eq!(missing.len(), 2);
    }

    /// 路径语义锁定：find_vlm_resources 接收 vlm 目录本身（含 exe 即 Some）。
    /// 双重拼接回归（base + resources/vlm）在此会变 None。
    #[test]
    fn find_vlm_resources_takes_the_vlm_directory_itself() {
        let dir = std::env::temp_dir().join(format!("crws-vlm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("llama-server.exe");
        std::fs::write(&exe, b"stub").unwrap();

        let resources =
            find_vlm_resources(&dir).expect("vlm dir with llama-server.exe must resolve");
        assert_eq!(resources.server_exe, exe);
        assert_eq!(resources.model_dir, dir);
        assert!(!resources.cuda_available);

        // 双重拼接回归哨兵：把 vlm 目录当基目录再拼一层 → 必然 None
        assert!(find_vlm_resources(&dir.join("resources").join("vlm")).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
