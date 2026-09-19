import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/moi_app',
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || 'moi_app_access_secret_default_key',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'moi_app_refresh_secret_default_key',
  jwtAccessExpiration: '15m',
  jwtRefreshExpiration: '7d',
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || ''
  },
  corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['*']
};
