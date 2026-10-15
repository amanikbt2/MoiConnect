import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { Paper } from '../models/Paper';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const mongoUri = process.env.MONGODB_URI;

async function checkDuplicates() {
  if (!mongoUri) {
    console.error('MONGODB_URI not found in environment');
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB database...');

    const papers = await Paper.find({}).sort({ mtid: 1 });
    console.log(`\n========================================`);
    console.log(`DATABASE AUDIT REPORT`);
    console.log(`========================================`);
    console.log(`Total materials in database: ${papers.length}`);

    const mtidMap = new Map<string, typeof papers>();
    const withoutMtid: typeof papers = [];

    for (const paper of papers) {
      if (!paper.mtid) {
        withoutMtid.push(paper);
        continue;
      }
      const existing = mtidMap.get(paper.mtid) || [];
      existing.push(paper);
      mtidMap.set(paper.mtid, existing);
    }

    console.log(`Materials with MTID: ${papers.length - withoutMtid.length}`);
    console.log(`Unique MTIDs count:  ${mtidMap.size}`);
    console.log(`Materials without MTID: ${withoutMtid.length}`);

    // Check duplicates
    const duplicates: { mtid: string; items: typeof papers }[] = [];
    for (const [mtid, items] of mtidMap.entries()) {
      if (items.length > 1) {
        duplicates.push({ mtid, items });
      }
    }

    // Prefix stats
    const prefixStats: Record<string, number> = {};
    for (const mtid of mtidMap.keys()) {
      const p = mtid.charAt(0).toUpperCase();
      prefixStats[p] = (prefixStats[p] || 0) + 1;
    }
    console.log(`Breakdown by prefix:`, prefixStats);

    // Verify P0059 and P0069 specifically
    const p59 = await Paper.find({ mtid: 'P0059' });
    const p69 = await Paper.find({ mtid: 'P0069' });
    console.log(`\nChecking specific previously-duplicated cards:`);
    console.log(`- MTID P0059 count: ${p59.length} -> "${p59[0]?.title}" (${p59[0]?.unitCode})`);
    console.log(`- MTID P0069 count: ${p69.length} -> "${p69[0]?.title}" (${p69[0]?.unitCode})`);

    console.log(`\nDuplicate check result:`);
    if (duplicates.length === 0) {
      console.log(`✅ ZERO DUPLICATES FOUND: Every single MTID in MongoDB is 100% unique!`);
    } else {
      console.error(`❌ FOUND ${duplicates.length} DUPLICATES:`);
      for (const dup of duplicates) {
        console.error(`  - ${dup.mtid}: ${dup.items.length} items`);
      }
    }
    console.log(`========================================\n`);

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error during check:', error);
    process.exit(1);
  }
}

checkDuplicates();
