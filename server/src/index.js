import { createApp, seed } from './app.js';
import { awsPaths } from './profiles.js';
import { dataDir } from './store.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

await seed();
createApp().listen(PORT, HOST, () => {
  const p = awsPaths();
  console.log(`DynamoDB Studio listening on http://${HOST}:${PORT}`);
  console.log(`AWS config: ${p.config} | credentials: ${p.credentials} | data: ${dataDir()}`);
  if (!process.env.APP_PASSWORD) console.log('APP_PASSWORD not set: basic auth disabled');
});
