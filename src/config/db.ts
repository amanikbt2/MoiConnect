import mongoose from 'mongoose';
import { config } from './index';

export const connectDB = async (): Promise<void> => {
  const isLocalhost = config.mongoUri.includes('localhost') || config.mongoUri.includes('127.0.0.1');

  if (config.nodeEnv === 'production' && isLocalhost) {
    console.warn(`========================================================================`);
    console.warn(`[WARNING]: Render production detected, but MONGODB_URI is unconfigured.`);
    console.warn(`[ACTION REQUIRED]: Go to Render Dashboard -> Environment -> Add:`);
    console.warn(`Key: MONGODB_URI`);
    console.warn(`Value: mongodb+srv://<username>:<password>@cluster0.mongodb.net/moiconnect`);
    console.warn(`========================================================================\n`);
  }

  try {
    const conn = await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 5000
    });
    console.log(`[MongoDB Connected]: ${conn.connection.host}`);
  } catch (error: any) {
    console.error(`[MongoDB Connection Error]:`, error?.message || error);
    if (config.nodeEnv === 'production' && isLocalhost) {
      console.error(`[MongoDB Guide]: Please set your cloud MongoDB Atlas connection string under MONGODB_URI in Render Environment Variables.`);
    }
  }
};
