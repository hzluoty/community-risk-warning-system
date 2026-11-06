import type { EventStatus, RiskLevel } from '@/types';

export const riskColorMap: Record<RiskLevel, string> = {
  low: '#22c55e',
  medium: '#f59e0b',
  high: '#ef4444',
  offline: '#64748b'
};

export const riskLevelTextMap: Record<RiskLevel, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  offline: '离线'
};

export const eventStatusTextMap: Record<EventStatus, string> = {
  pending: '未处置',
  processing: '处置中',
  done: '已处置'
};

export const riskGradeColorMap: Record<'Normal' | 'A' | 'B' | 'C', string> = {
  Normal: '#94a3b8',
  A: '#ef4444',
  B: '#f59e0b',
  C: '#3b82f6'
};
