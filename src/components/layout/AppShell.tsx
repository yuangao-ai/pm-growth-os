import type { ReactNode } from 'react';
import { useAppStore } from '../../store/app-store';

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const backendError = useAppStore((state) => state.backendError);
  const isBackendReady = useAppStore((state) => state.isBackendReady);
  const user = useAppStore((state) => state.userProfile);
  const weeklyProgress = Math.min(
    100,
    Math.round((user.savedNotes / Math.max(user.weeklyGoal, 1)) * 100),
  );

  return (
    <div className="app-shell">
      <div className="hero-backdrop" />
      <header className="hero">
        <div>
          <p className="eyebrow">AI PM Growth Workspace</p>
          <h1>PM Growth OS</h1>
          <p className="hero-copy">
            把记录、探索、总结和画像更新串成一个可持续运行的 Agent 工作流。
          </p>
          <div className="hero-tags">
            <span className="chip">记录</span>
            <span className="chip">探索</span>
            <span className="chip">总结</span>
            <span className="chip">成长</span>
          </div>
        </div>
        <div className="hero-summary">
          <span className="hero-summary-label">当前成长阶段</span>
          <strong>{user.currentStageLabel}</strong>
          <div className="hero-progress">
            <div className="mini-progress-bar">
              <span style={{ width: `${weeklyProgress}%` }} />
            </div>
            <span>
              {user.savedNotes} / {user.weeklyGoal} 条
            </span>
          </div>
          <span className={isBackendReady ? 'backend-pill backend-ready' : 'backend-pill'}>
            {isBackendReady ? '本地存储已就绪' : '本地存储不可用'}
          </span>
        </div>
      </header>
      {backendError ? <div className="backend-alert">{backendError}</div> : null}
      <main className="main-stack">{children}</main>
    </div>
  );
}
