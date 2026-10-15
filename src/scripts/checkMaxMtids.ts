import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { Paper } from '../models/Paper';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const mongoUri = process.env.MONGODB_URI;

async function checkMaxMtids() {
  await mongoose.connect(mongoUri!);
  const papers = await Paper.find({}, { mtid: 1, type: 1, title: 1, createdAt: 1 }).sort({ mtid: 1 });
  
  const byPrefix: Record<string, string[]> = {};
  for (const p of papers) {
    if (!p.mtid) continue;
    const prefix = p.mtid[0].toUpperCase();
    if (!byPrefix[prefix]) byPrefix[prefix] = [];
    byPrefix[prefix].push(p.mtid);
  }

  for (const prefix of Object.keys(byPrefix)) {
    const list = byPrefix[prefix];
    list.sort((a, b) => {
      const numA = parseInt(a.slice(1), 10);
      const numB = parseInt(b.slice(1), 10);
      return numA - numB;
    });
    console.log(`Prefix ${prefix}: Total ${list.length}, Min: ${list[0]}, Max: ${list[list.length - 1]}`);
    console.log(`Last 10 ${prefix} MTIDs:`, list.slice(-10));
  }

  await mongoose.disconnect();
}

checkMaxMtids();
