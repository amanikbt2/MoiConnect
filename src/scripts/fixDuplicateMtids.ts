import dns from 'dns';
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {}

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import cloudinary from '../config/cloudinary';
import { Paper } from '../models/Paper';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const mongoUri = process.env.MONGODB_URI;

function getPrefix(type: string): string {
  if (type === 'cat') return 'C';
  if (['notes', 'revision', 'lecture_notes'].includes(type)) return 'N';
  return 'P';
}

async function findNextFreeMtid(prefix: string): Promise<string> {
  const prefixRegex = new RegExp(`^${prefix}\\d+$`, 'i');
  const allWithPrefix = await Paper.find({ mtid: prefixRegex }, { mtid: 1 });
  
  let maxNum = 0;
  for (const doc of allWithPrefix) {
    if (!doc.mtid) continue;
    const num = parseInt(doc.mtid.slice(1), 10);
    if (!isNaN(num) && num > maxNum) {
      maxNum = num;
    }
  }

  let candidateNum = maxNum + 1;
  let candidateMtid = `${prefix}${String(candidateNum).padStart(4, '0')}`;
  
  while (await Paper.exists({ mtid: candidateMtid })) {
    candidateNum++;
    candidateMtid = `${prefix}${String(candidateNum).padStart(4, '0')}`;
  }

  return candidateMtid;
}

async function runFix() {
  if (!mongoUri) {
    console.error('MONGODB_URI not found.');
    process.exit(1);
  }

  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 15000,
      family: 4
    });
    console.log('Connected! Searching for duplicate MTIDs...');

    const papers = await Paper.find({ mtid: { $exists: true, $ne: '' } }).sort({ createdAt: 1 });
    const mtidMap = new Map<string, typeof papers>();

    for (const p of papers) {
      if (!p.mtid) continue;
      const list = mtidMap.get(p.mtid) || [];
      list.push(p);
      mtidMap.set(p.mtid, list);
    }

    const duplicateGroups = Array.from(mtidMap.entries()).filter(([_, list]) => list.length > 1);

    if (duplicateGroups.length === 0) {
      console.log('✅ No duplicate MTIDs found in MongoDB!');
    } else {
      console.log(`Found ${duplicateGroups.length} duplicate MTID group(s) to fix.`);

      for (const [mtid, list] of duplicateGroups) {
        console.log(`\nFixing group for MTID "${mtid}" (${list.length} papers)...`);
        // Keep the earlier one
        const original = list[0];
        console.log(`  -> Keeping original [${original._id}] "${original.title}" as ${original.mtid}`);

        // Push duplicates to after the last one
        for (let i = 1; i < list.length; i++) {
          const dupPaper = list[i];
          const prefix = getPrefix(dupPaper.type);
          const newMtid = await findNextFreeMtid(prefix);

          console.log(`  -> Moving duplicate #${i} [${dupPaper._id}] "${dupPaper.title}" from ${dupPaper.mtid} -> ${newMtid}`);

          if (dupPaper.ttsTextPublicId && dupPaper.ttsTextPublicId.includes(mtid)) {
            const oldPublicId = dupPaper.ttsTextPublicId;
            const newPublicId = oldPublicId.replace(new RegExp(mtid, 'g'), newMtid);
            try {
              console.log(`     Renaming Cloudinary raw file: "${oldPublicId}" -> "${newPublicId}"...`);
              const renameResult = await cloudinary.uploader.rename(oldPublicId, newPublicId, {
                resource_type: 'raw',
                overwrite: true
              });
              dupPaper.ttsTextPublicId = newPublicId;
              dupPaper.ttsTextUrl = renameResult.secure_url || dupPaper.ttsTextUrl?.replace(new RegExp(mtid, 'g'), newMtid);
              console.log(`     Cloudinary file successfully renamed to: ${dupPaper.ttsTextUrl}`);
            } catch (cloudErr: any) {
              console.warn(`     Cloudinary rename notice: ${cloudErr?.message || cloudErr}`);
              if (dupPaper.ttsTextUrl) {
                dupPaper.ttsTextUrl = dupPaper.ttsTextUrl.replace(new RegExp(mtid, 'g'), newMtid);
              }
              dupPaper.ttsTextPublicId = newPublicId;
            }
          }

          dupPaper.mtid = newMtid;
          await dupPaper.save();
          console.log(`     Successfully updated paper in MongoDB with new MTID ${newMtid}!`);
        }
      }
    }

    // Synchronize unique index in MongoDB Atlas
    console.log('\nSynchronizing unique index on mtid in MongoDB Atlas...');
    try {
      await Paper.syncIndexes();
      console.log('✅ Paper indexes synchronized successfully!');
    } catch (idxErr: any) {
      console.warn('Index sync notice:', idxErr.message);
    }

    // Final verification
    console.log('\nRunning final verification check...');
    const allPapers = await Paper.find({ mtid: { $exists: true, $ne: '' } });
    const finalMap = new Map<string, typeof allPapers>();
    for (const p of allPapers) {
      if (!p.mtid) continue;
      const list = finalMap.get(p.mtid) || [];
      list.push(p);
      finalMap.set(p.mtid, list);
    }

    let remainingDups = 0;
    for (const [key, list] of finalMap.entries()) {
      if (list.length > 1) {
        console.error(`❌ Still duplicate: ${key} (${list.length} items)`);
        remainingDups++;
      }
    }

    if (remainingDups === 0) {
      console.log(`🎉 ALL AUDITS PASSED: All ${allPapers.length} materials have guaranteed unique MTIDs!`);
    } else {
      console.error(`⚠️ Found ${remainingDups} remaining duplicates.`);
    }

    await mongoose.disconnect();
  } catch (error) {
    console.error('Operation failed:', error);
    process.exit(1);
  }
}

runFix();
