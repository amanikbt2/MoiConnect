import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Paper } from '../models/Paper';

dotenv.config();

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/moi-app';

async function migrate() {
  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB for paper URL migration...');
    const papers = await Paper.find({});
    console.log('Found', papers.length, 'papers in database.');

    let updatedCount = 0;
    for (const p of papers) {
      let changed = false;
      let newUrl = p.fileUrl;

      if (newUrl && typeof newUrl === 'string') {
        if (newUrl.includes('/raw/upload/')) {
          const cleaned = newUrl.replace(/\/raw\/upload\/s--[^/]+--\//, '/raw/upload/').split('?')[0];
          if (cleaned !== newUrl) {
            newUrl = cleaned;
            changed = true;
          }
        }
      }

      if (changed) {
        p.fileUrl = newUrl;
        await p.save();
        updatedCount++;
      }
    }

    console.log('Successfully cleaned and migrated', updatedCount, 'existing paper records in MongoDB!');
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
}

migrate();
