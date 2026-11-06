import { describe, expect, it, beforeEach } from 'vitest';
import { useAppStore } from './useAppStore';
import { events as fixtureEvents } from '@/data/mock';
import { emptyDecisionState } from '@/services/events/decisionEngine';

describe('useAppStore', () => {
  beforeEach(() => {
    const initialState = useAppStore.getInitialState();

    useAppStore.setState({
      events: [],
      decisionState: emptyDecisionState(),
      persistenceError: null,
      activeCameraId: initialState.cameras[0].id,
      selectedEventId: initialState.events[0]?.id,
      analysis: initialState.analysis,
      analysisContext: null,
      analysisValidity: 'unknown',
      vlmStatus: 'idle',
      vlmError: null,
      detectionBoxes: [],
      analysisFrameDataUrl: null,
      analysisTimestamp: null,
      detectorStatus: 'idle',
      detectedObjects: []
    });
  });

  it('initializes with waiting analysis state for VLM pipeline', () => {
    const state = useAppStore.getState();
    expect(state.analysis.hasRisk).toBe(false);
    expect(state.analysis.riskScore).toBe(0);
    expect(state.analysis.level).toBe('Normal');
    expect(state.analysis.summary).toContain('等待');
    expect(state.analysis.breakdown).toEqual([]);
    expect(state.analysisValidity).toBe('unknown');
    expect(state.analysisContext).toBeNull();
  });

  it('keeps camera and event aligned without overwriting real-time analysis', () => {
    useAppStore.setState({ events: fixtureEvents }); // explicit UI fixture, not production initialization
    const targetEvent = useAppStore.getState().events[1];

    const analysisBefore = useAppStore.getState().analysis;
    useAppStore.getState().selectEvent(targetEvent.id);

    const state = useAppStore.getState();
    expect(state.selectedEventId).toBe(targetEvent.id);
    expect(state.activeCameraId).toBe(targetEvent.cameraId);
    expect(state.analysis).toBe(analysisBefore);
  });

  it('updates analysis, detection boxes, and accumulates trend via setAnalysis', () => {
    const mockAnalysis1 = {
      riskScore: 85,
      level: 'A' as const,
      hasRisk: true,
      confidence: 0.92,
      summary: '消防通道被占用',
      evidenceTimeline: ['12:00:01 检测到障碍物'],
      breakdown: [{ label: '消防风险', value: 100 }],
      trend: []
    };
    const mockBoxes = [
      { x: 0.1, y: 0.2, width: 0.3, height: 0.4, label: '障碍物', confidence: 0.92, risk: true }
    ];

    useAppStore.getState().setAnalysis(mockAnalysis1, mockBoxes, {
      cameraId: 'LOCAL',
      capturedAt: 123,
      modelSource: 'local',
      frameDataUrl: 'data:image/jpeg;base64,frame'
    });

    const state1 = useAppStore.getState();
    expect(state1.analysis.riskScore).toBe(85);
    expect(state1.analysis.summary).toBe('消防通道被占用');
    expect(state1.analysis.breakdown).toEqual([{ label: '消防风险', value: 100 }]);
    expect(state1.analysis.trend).toHaveLength(1);
    expect(state1.analysis.trend[0].value).toBe(85);
    expect(state1.detectionBoxes).toEqual(mockBoxes);
    expect(state1.analysisFrameDataUrl).toBe('data:image/jpeg;base64,frame');
    expect(state1.analysisTimestamp).toBeGreaterThan(0);
    expect(state1.analysisValidity).toBe('valid');
    expect(state1.analysisContext).toMatchObject({
      cameraId: 'LOCAL',
      capturedAt: 123,
      modelSource: 'local'
    });

    const mockAnalysis2 = {
      ...mockAnalysis1,
      riskScore: 62,
      level: 'B' as const,
      summary: '风险降低'
    };

    useAppStore.getState().setAnalysis(mockAnalysis2, []);

    const state2 = useAppStore.getState();
    expect(state2.analysis.riskScore).toBe(62);
    expect(state2.analysis.trend).toHaveLength(2);
    expect(state2.analysis.trend[0].value).toBe(85);
    expect(state2.analysis.trend[1].value).toBe(62);
  });

  it('updates VLM status', () => {
    useAppStore.getState().setVlmStatus('analyzing');
    expect(useAppStore.getState().vlmStatus).toBe('analyzing');

    useAppStore.getState().setVlmStatus('error', 'Connection failed');
    expect(useAppStore.getState().vlmStatus).toBe('error');
    expect(useAppStore.getState().vlmError).toBe('Connection failed');
    expect(useAppStore.getState().analysisValidity).toBe('error');
  });

  it('marks malformed responses unavailable without treating the VLM as disconnected', () => {
    useAppStore.getState().setVlmStatus('response-error', 'VLM 在线，但响应格式异常');

    expect(useAppStore.getState().vlmStatus).toBe('response-error');
    expect(useAppStore.getState().vlmError).toBe('VLM 在线，但响应格式异常');
    expect(useAppStore.getState().analysisValidity).toBe('error');
  });

  it('returns to a neutral pending result while retrying the first failed analysis', () => {
    useAppStore.getState().setVlmStatus('response-error', 'VLM 响应格式异常');
    useAppStore.getState().setVlmStatus('analyzing');

    expect(useAppStore.getState().vlmStatus).toBe('analyzing');
    expect(useAppStore.getState().vlmError).toBeNull();
    expect(useAppStore.getState().analysisValidity).toBe('unknown');
  });

  it('returns to waiting-for-analysis after a recovered connection before the first result', () => {
    useAppStore.getState().setVlmStatus('error', 'Connection failed');
    useAppStore.getState().setVlmStatus('idle');

    expect(useAppStore.getState().vlmStatus).toBe('idle');
    expect(useAppStore.getState().vlmError).toBeNull();
    expect(useAppStore.getState().analysisValidity).toBe('unknown');
  });

  it('marks an existing analysis stale and clears boxes without rewriting its summary', () => {
    const analysis = {
      ...useAppStore.getState().analysis,
      riskScore: 72,
      level: 'B' as const,
      hasRisk: true,
      confidence: 0.8,
      summary: '保留最近一次有效结论'
    };

    useAppStore.getState().setAnalysis(analysis, [
      { x: 0.1, y: 0.1, width: 0.2, height: 0.2, label: '人员', confidence: 0.8, risk: true }
    ]);
    useAppStore.getState().invalidateAnalysis();

    const state = useAppStore.getState();
    expect(state.analysisValidity).toBe('stale');
    expect(state.detectionBoxes).toEqual([]);
    expect(state.analysisFrameDataUrl).toBeNull();
    expect(state.analysis.summary).toBe('保留最近一次有效结论');
  });

  it('keeps an analysis unknown when invalidated before the first result', () => {
    useAppStore.getState().invalidateAnalysis();
    expect(useAppStore.getState().analysisValidity).toBe('unknown');
  });

  it('updates detector status', () => {
    useAppStore.getState().setDetectorStatus('loading');
    expect(useAppStore.getState().detectorStatus).toBe('loading');

    useAppStore.getState().setDetectorStatus('ready');
    expect(useAppStore.getState().detectorStatus).toBe('ready');

    useAppStore.getState().setDetectorStatus('error');
    expect(useAppStore.getState().detectorStatus).toBe('error');
  });

  it('updates detected objects', () => {
    const objects = [
      { label: 'person', score: 0.8, bbox: [10, 20, 30, 40] as [number, number, number, number] }
    ];
    useAppStore.getState().setDetectedObjects(objects);
    expect(useAppStore.getState().detectedObjects).toEqual(objects);
  });
});
