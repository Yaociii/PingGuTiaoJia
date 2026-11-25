import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GachaDatabase } from './server/db';
import { migrateLegacyJsonIfNeeded } from './server/dbMigration';
import { GeminiVlmProvider } from './server/vlmProvider';
import { createApiRouter } from './server/app';
import { registerGroupH5Route } from './server/groupH5Page';

async function startServer() {
  const app = express();
  const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;

  let dbPath = path.resolve(process.cwd(), process.env.DATABASE_PATH || './data/gacha-db.db');
  if (process.platform !== 'win32' && /["\\]/.test(dbPath)) {
    console.warn(
      `[warn] DATABASE_PATH 看起来是 Windows 路径（${dbPath}），` +
        `已回退到 ./data/gacha-db.db。请检查环境变量配置。`
    );
    dbPath = path.resolve(process.cwd(), './data/gacha-db.db');
  }

  const db = new GachaDatabase({
    filePath: dbPath,
    defaultInviteCode: process.env.DEFAULT_INVITE_CODE || 'dev-local-001',
    defaultDailyLimit: Number.parseInt(process.env.DEFAULT_DAILY_LIMIT || '50', 10) || 50,
    seedMarketStats: true,
  });
  migrateLegacyJsonIfNeeded(db.rawDb);

  const vlmProvider = new GeminiVlmProvider('gemini-4-hydrogen');

  // Mount API routes and lightweight mobile H5 claim page (/g/:shareCode)
  app.use('/api/v1', createApiRouter({ db, vlmProvider }));
  // Strictly isolate all /api/* paths so they never fall through to Vite/SPA HTML (<!doctype html>)
  app.use('/api', (_req, res) => {
    res.status(404).json({ detail: '请求的 API 接口不存在。' });
  });
  registerGroupH5Route(app, db);

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ detail: '请求的 API 接口不存在。' });
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // Final Express error guard so unhandled /api/* errors return JSON instead of default HTML
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      if (req.path.startsWith('/api/')) {
        const msg = err instanceof Error ? err.message : '服务端异常';
        res.status(500).json({ detail: `服务端处理失败：${msg}` });
        return;
      }
      next(err);
    }
  );

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Gacha Pricer server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
