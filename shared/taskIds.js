/**
 * 赛题任务 ID 白名单 —— 跨端契约，住在 shared/（渲染端、JS 服务端、
 * Rust 端经 shared/contract.json 三方共读；服务端实现模块不得再私持一份）。
 * 与 competition/code/task-contract/types.ts 的 TaskId 联合类型保持一致（镜像，勿双处扩展）；
 * 契约本体以 task-contract/specs.ts（单测覆盖）为单一事实源。
 */
export const COMPETITION_TASK_IDS = Object.freeze([
  'traffic_light',
  'people_count',
  'sign_reading',
  'trash_bin',
  'building_fire',
  'building_temperature',
  'gauge_reading',
  'license_plate',
  'ebike_status',
  'parking'
]);
