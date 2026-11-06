export type RiskLevel = 'low' | 'medium' | 'high' | 'offline';
export type EventStatus = 'pending' | 'processing' | 'done';
export type StreamType = 'flv' | 'mpegts' | 'hls' | 'mp4';
export type AnalysisValidity = 'unknown' | 'valid' | 'stale' | 'error';
export type VlmModelSource = 'local' | 'cloud' | 'cloud-fallback' | 'unknown';

export interface CameraPoint {
  id: string;
  name: string;
  area: string;
  riskScore: number;
  level: RiskLevel;
  status: 'online' | 'offline';
  todayEvents: number;
  lastAlertTime: string;
  coordinates: [number, number];
  mapPoint?: {
    lng: number;
    lat: number;
  };
  streamCover: string;
  streamUrl?: string;
  streamType?: StreamType;
  scene: string;
}

export interface RiskBreakdown {
  label: string;
  value: number;
}

export interface TrendPoint {
  time: string;
  value: number;
}

export interface VlmAnalysis {
  riskScore: number;
  level: 'Normal' | 'A' | 'B' | 'C';
  hasLoitering?: boolean;
  hasGathering?: boolean;
  hasFallen?: boolean;
  hasRisk: boolean;
  summary: string;
  confidence: number;
  evidenceTimeline: string[];
  breakdown: RiskBreakdown[];
  trend: TrendPoint[];
}

export interface VlmAnalysisContext {
  cameraId: string;
  capturedAt: number;
  completedAt: number;
  modelSource: VlmModelSource;
}

export interface RiskEvent {
  id: string;
  title: string;
  cameraId: string;
  cameraName: string;
  area: string;
  eventType: string;
  riskScore: number;
  level: 'Normal' | 'A' | 'B' | 'C';
  status: EventStatus;
  occurredAt: string;
  summary: string;
  suggestion: string;
  snapshot: string;
  tags: string[];
  analysis: VlmAnalysis;
}

export interface DashboardMetric {
  label: string;
  value: string | number;
  extra?: string;
}

export interface ChatMessageContentText {
  type: 'text';
  text: string;
}

export interface ChatMessageContentImageUrl {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export interface OpenAICompatibleMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | (ChatMessageContentText | ChatMessageContentImageUrl)[];
}

export interface EquipmentStats {
  label: string;
  value: number;
  icon: string;
  color: string;
}

export interface RiskLevelStat {
  level: string;
  count: number;
  color: string;
  percent: number;
}

export interface EventTypeStat {
  type: string;
  count: number;
  color: string;
}

export interface DetectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  confidence: number;
  risk: boolean;
}

export interface DetectionResult {
  label: string
  score: number
  bbox: [number, number, number, number]
}
