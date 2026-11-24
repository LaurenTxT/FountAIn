import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DesktopHud } from './desktop-hud';
import { ErrorBoundary, reportRenderError } from './ErrorBoundary';
import './styles.css';
import './team.css';
import './project-room.css';

// Errors outside rendering (event handlers, timers, promises) never reach a boundary; record them too.
window.addEventListener('error', event => reportRenderError('窗口脚本', event.error ?? event.message));
window.addEventListener('unhandledrejection', event => reportRenderError('后台请求', event.reason));

const isDesktopHud = new URLSearchParams(window.location.search).get('surface') === 'hud';
if (isDesktopHud) document.title = 'FountAIn 桌面浮层';
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary area="FountAIn 界面" fullPage>{isDesktopHud ? <DesktopHud /> : <App />}</ErrorBoundary></React.StrictMode>);
