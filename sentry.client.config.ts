// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // 🎯 1. 捕捉前端核心性能（组件加载、Web Vitals）
  tracesSampleRate: 1.0,

  // 🎯 2. 核心：开启浏览器性能分析（只有配置了这个，后台才会有帧数、卡顿火焰图）
  profilesSampleRate: 1.0,
  integrations: [
    // 🎯 3. 显式引入浏览器 Profiling 插件，用于抓取 FPS 波动和主线程阻塞栈
    Sentry.browserProfilingIntegration(),
  ],
});
