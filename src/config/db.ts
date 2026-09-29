import mongoose from 'mongoose';
import { config } from './index';

export const connectDB = async (): Promise<void> => {
  const isLocalhost = config.mongoUri.includes('localhost') || config.mongoUri.includes('127.0.0.1');
  const maxAttempts = 5;

  if (config.nodeEnv === 'production' && isLocalhost) {
    console.warn(`========================================================================`);
    console.warn(`[WARNING]: Render production detected, but MONGODB_URI is unconfigured.`);
    console.warn(`[ACTION REQUIRED]: Go to Render Dashboard -> Environment -> Add:`);
    console.warn(`Key: MONGODB_URI`);
    console.warn(`Value: mongodb+srv://<username>:<password>@cluster0.mongodb.net/moiconnect`);
    console.warn(`========================================================================\n`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (mongoose.connection.readyState === 1) return;

      const conn = await mongoose.connect(config.mongoUri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 20000,
        family: 4
      });
      console.log(`[MongoDB Connected]: ${conn.connection.host}`);
      return;
    } catch (error: any) {
      const message = error?.message || String(error);
      if (attempt === maxAttempts) {
        console.error(`[MongoDB Connection Error]: ${message}`);
        if (config.nodeEnv === 'production' && isLocalhost) {
          console.error(`[MongoDB Guide]: Please set your cloud MongoDB Atlas connection string under MONGODB_URI in Render Environment Variables.`);
        } else {
          console.error(`[MongoDB Guide]: Check Atlas IP access list, DNS/network access, and database credentials.`);
        }
        return;
      }

      const delayMs = attempt * 2000;
      console.warn(`[MongoDB Retry ${attempt}/${maxAttempts - 1}]: ${message}. Retrying in ${delayMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
};