// 全局 Window.electronAPI 声明的再导出引用点：类型唯一所有者是
// src/services/runtimeBridge.ts（ElectronApi / RuntimeBridge），此处不重复声明形状。
import type { ElectronApi } from '@/services/runtimeBridge'

export type { ElectronApi }
