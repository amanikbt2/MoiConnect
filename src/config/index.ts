import dotenv from 'dotenv';
import path from 'path';

const sandboxMode = process.env.MCONNECT_SANDBOX === 'true';
dotenv.config({ path: path.resolve(__dirname, sandboxMode ? '../../.env.sandbox' : '../../.env') });

const sandboxMongoUri = 'mongodb://127.0.0.1:27017/mconnect_sandbox';
const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || (sandboxMode ? sandboxMongoUri : 'mongodb://localhost:27017/moi_app');

export const assertSandboxConfiguration = (): void => {
  if (!sandboxMode) return;
  let parsed: URL;
  try {
    parsed = new URL(mongoUri);
  } catch {
    throw new Error('Sandbox refused to start: MONGODB_URI must point to the local mconnect_sandbox database.');
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const databaseName = decodeURIComponent(parsed.pathname.startsWith('/') ? parsed.pathname.slice(1) : parsed.pathname);
  if (parsed.protocol !== 'mongodb:' || !localHosts.has(parsed.hostname) || databaseName !== 'mconnect_sandbox') {
    throw new Error('Sandbox refused to start: only mongodb://127.0.0.1:27017/mconnect_sandbox is allowed.');
  }
};

export const config = {
  port: sandboxMode ? 5000 : parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  sandboxMode,
  mongoUri,
  jwtAccessSecret: sandboxMode ? 'mconnect_local_sandbox_access_secret' : process.env.JWT_ACCESS_SECRET || 'moi_app_access_secret_default_key',
  jwtRefreshSecret: sandboxMode ? 'mconnect_local_sandbox_refresh_secret' : process.env.JWT_REFRESH_SECRET || 'moi_app_refresh_secret_default_key',
  jwtAccessExpiration: '100y',
  jwtRefreshExpiration: '100y',
  cloudinary: {
    cloudName: sandboxMode ? process.env.CLOUDINARY_SANDBOX_CLOUD_NAME || '' : process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: sandboxMode ? '' : process.env.CLOUDINARY_API_KEY || '',
    apiSecret: sandboxMode ? '' : process.env.CLOUDINARY_API_SECRET || ''
  },
  livekit: {
    url: process.env.LIVEKIT_URL || '',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || ''
  },
  corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['*']
};
