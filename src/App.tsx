import { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { ConfigProvider, App as AntApp, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { RouterProvider } from 'react-router-dom';
import { router } from '@/router';

export default function App() {
  useEffect(() => {
    const tick = () => useAppStore.getState().tickEventClock(performance.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#2f7bff',
          borderRadius: 14,
          fontFamily: 'Bahnschrift, DIN Alternate, PingFang SC, Microsoft YaHei, sans-serif'
        }
      }}
    >
      <AntApp>
        <RouterProvider router={router} />
      </AntApp>
    </ConfigProvider>
  );
}
