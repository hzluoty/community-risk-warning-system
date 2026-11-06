import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Space, Tag } from 'antd';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/store/useAppStore';

const levelConfig: Record<string, { color: string; label: string }> = {
  Normal: { color: '#94a3b8', label: '未达正式告警等级' },
  A: { color: '#f43f5e', label: 'A级 · 高危' },
  B: { color: '#ff8c00', label: 'B级 · 中危' },
  C: { color: '#00c3ff', label: 'C级 · 低危' }
};

const statusConfig: Record<string, { color: string; label: string }> = {
  pending: { color: '#f43f5e', label: '待处置' },
  processing: { color: '#ff8c00', label: '处理中' },
  done: { color: '#22c55e', label: '已处置' }
};

export function AlertsPage() {
  const { events, selectedEventId, selectEvent, markEventStatus, confirmEvent, persistenceError } = useAppStore(
    useShallow((state) => ({
      events: state.events,
      selectedEventId: state.selectedEventId,
      selectEvent: state.selectEvent,
      markEventStatus: state.markEventStatus,
      confirmEvent: state.confirmEvent,
      persistenceError: state.persistenceError
    }))
  );
  const [filter, setFilter] = useState<string>('全部');

  const filteredEvents = useMemo(() => {
    return [...events]
      .sort((a, b) => b.riskScore - a.riskScore)
      .filter((event) => {
        if (filter === '全部') return true;
        return `${event.level === 'Normal' ? '待确认' : `${event.level}级`}` === filter;
      });
  }, [events, filter]);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId),
    [events, selectedEventId]
  );

  return (
    <div className="alerts-layout">
      {/* 左栏：事件列表 */}
      <div className="panel alerts-list-col">
        <div className="panel-title">实际事件与人工复核列表</div>
        {persistenceError ? <Alert type="error" title={`事件未持久化：${persistenceError}`} /> : null}

        <div className="alerts-filter-bar">
          {['全部', 'A级', 'B级', 'C级'].map((key) => (
            <button
              key={key}
              className={`alerts-filter-btn ${filter === key ? 'active' : ''}`}
              onClick={() => setFilter(key)}
            >
              {key}
            </button>
          ))}
        </div>

        <div className="alerts-event-list">
          {filteredEvents.map((event, idx) => {
            const lv = levelConfig[event.level] ?? levelConfig.C;
            const st = statusConfig[event.status] ?? statusConfig.pending;
            return (
              <button
                type="button"
                key={event.id}
                className={`alerts-event-card${event.id === selectedEventId ? ' active' : ''}`}
                onClick={() => selectEvent(event.id)}
                aria-pressed={event.id === selectedEventId}
                aria-label={`查看预警：${event.title}`}
              >
                <div className="alerts-card-header">
                  <span className="alerts-card-rank">#{idx + 1}</span>
                  <span
                    className="alerts-card-level"
                    style={{ background: lv.color }}
                  >
                    {event.level === 'Normal' ? '待确认' : `${event.level}级`}
                  </span>
                  <span
                    className="alerts-card-status"
                    style={{ color: st.color }}
                  >
                    {st.label}
                  </span>
                </div>
                <div className="alerts-card-title">{event.title}</div>
                <div className="alerts-card-meta">
                  <span>{event.cameraName}</span>
                  <span>{event.area}</span>
                  <span>{event.occurredAt}</span>
                </div>
                <div className="alerts-card-tags">
                  {event.tags.map((tag) => (
                    <Tag key={tag} className="alerts-card-tag">{tag}</Tag>
                  ))}
                </div>
                <div className="alerts-card-score">
                  <span className="alerts-card-score-value" style={{ color: lv.color }}>
                    {event.riskScore}
                  </span>
                  <span className="alerts-card-score-label">风险分</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右栏：事件详情 */}
      <div className="panel alerts-detail-col">
        {selectedEvent ? (
          <div className="alerts-detail-inner">
            <div className="alerts-detail-header">
              <div>
                <div className="alerts-detail-title">{selectedEvent.title}</div>
                <div className="alerts-detail-meta">
                  <Tag color={levelConfig[selectedEvent.level]?.color ?? 'default'}>
                    {levelConfig[selectedEvent.level]?.label}
                  </Tag>
                  <Badge
                    color={statusConfig[selectedEvent.status]?.color}
                    text={statusConfig[selectedEvent.status]?.label}
                  />
                  <span className="alerts-detail-meta-text">
                    {selectedEvent.cameraName} · {selectedEvent.area}
                  </span>
                  <span className="alerts-detail-meta-text">
                    {selectedEvent.occurredAt}
                  </span>
                </div>
              </div>
              <div className="alerts-detail-score-box">
                <span className="alerts-detail-score-num" style={{ color: levelConfig[selectedEvent.level]?.color }}>
                  {selectedEvent.riskScore}
                </span>
                <span className="alerts-detail-score-label">风险评分</span>
              </div>
            </div>

            <div className="alerts-detail-divider" />

            <Space size={8} wrap>
              <Button onClick={() => confirmEvent(selectedEvent.id)}>人工确认事件属实</Button>
              {selectedEvent.status === 'pending' ? (
                <Button type="primary" onClick={() => markEventStatus(selectedEvent.id, 'processing')}>
                  开始处置
                </Button>
              ) : null}
              {selectedEvent.status === 'processing' ? (
                <Button type="primary" onClick={() => markEventStatus(selectedEvent.id, 'done')}>
                  标记已完成
                </Button>
              ) : null}
              {selectedEvent.status === 'done' ? (
                <Button onClick={() => markEventStatus(selectedEvent.id, 'processing')}>
                  重新打开
                </Button>
              ) : null}
              <span className="alerts-detail-meta-text">处置与人工确认保存本机元数据；不会解除可见风险。不含图像留存或远程工单服务。</span>
            </Space>

            <div className="alerts-detail-body">
              <div className="alerts-detail-section">
                <div className="alerts-detail-section-title">事件概要</div>
                <div className="alerts-detail-section-text">{selectedEvent.summary}</div>
              </div>

              <div className="alerts-detail-section">
                <div className="alerts-detail-section-title">处置建议</div>
                <div className="alerts-detail-section-text">{selectedEvent.suggestion}</div>
              </div>

              <div className="alerts-detail-section">
                <div className="alerts-detail-section-title">关键证据</div>
                <div className="alerts-detail-section-text">{selectedEvent.snapshot}</div>
              </div>

              <div className="alerts-detail-section">
                <div className="alerts-detail-section-title">VLM 研判结果</div>
                <div className="alerts-detail-vlm-grid">
                  <div className="alerts-detail-vlm-cell">
                    <span>风险分</span>
                    <strong>{selectedEvent.analysis.riskScore}</strong>
                  </div>
                  <div className="alerts-detail-vlm-cell">
                    <span>置信度</span>
                    <strong>{(selectedEvent.analysis.confidence * 100).toFixed(1)}%</strong>
                  </div>
                  <div className="alerts-detail-vlm-cell">
                    <span>风险等级</span>
                    <Tag color={levelConfig[selectedEvent.analysis.level]?.color}>
                      {selectedEvent.analysis.level === 'Normal' ? '未达正式等级' : `${selectedEvent.analysis.level}级`}
                    </Tag>
                  </div>
                  <div className="alerts-detail-vlm-cell">
                    <span>风险判定</span>
                    <strong style={{ color: selectedEvent.analysis.hasRisk ? '#f43f5e' : '#22c55e' }}>
                      {selectedEvent.analysis.hasRisk ? '存在风险' : '正常'}
                    </strong>
                  </div>
                </div>
                <div className="alerts-detail-vlm-summary">
                  <span className="alerts-detail-vlm-summary-label">AI 分析摘要</span>
                  <p>{selectedEvent.analysis.summary}</p>
                </div>
                {selectedEvent.analysis.evidenceTimeline.length > 0 && (
                  <div className="alerts-detail-timeline">
                    <span className="alerts-detail-vlm-summary-label">证据时间线</span>
                    {selectedEvent.analysis.evidenceTimeline.map((item, index) => (
                      <div key={`${index}-${item.slice(0, 32)}`} className="timeline-item">{item}</div>
                    ))}
                  </div>
                )}
              </div>

              <div className="alerts-detail-section">
                <div className="alerts-detail-section-title">关联标签</div>
                <div className="alerts-detail-tags">
                  {selectedEvent.tags.map((tag) => (
                    <Tag key={tag} className="alerts-card-tag">{tag}</Tag>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="alerts-detail-placeholder">
            请从左侧列表选择一条预警事件查看详情
          </div>
        )}
      </div>
    </div>
  );
}
