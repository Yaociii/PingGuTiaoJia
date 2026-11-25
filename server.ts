import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GachaDatabase } from './server/db';
import { GeminiVlmProvider } from './server/vlmProvider';
import { createApiRouter } from './server/app';
import { registerGroupH5Route } from './server/groupH5Page';

async function startServer() {
  const app = express();
  const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;

  const dbPath = path.resolve(process.cwd(), process.env.DATABASE_PATH || './data/gacha-db.json');
  const db = new GachaDatabase({
    filePath: dbPath,
    defaultInviteCode: process.env.DEFAULT_INVITE_CODE || 'dev-local-001',
    defaultDailyLimit: Number.parseInt(process.env.DEFAULT_DAILY_LIMIT || '50', 10) || 50,
    seedMarketStats: true,
  });

  const vlmProvider = new GeminiVlmProvider('gemini-4-hydrogen');

  // Mount API routes and lightweight mobile H5 claim page (/g/:shareCode)
  app.use('/api/v1', createApiRouter({ db, vlmProvider }));
  registerGroupH5Route(app, db);

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Gacha Pricer server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
