import mongoose from 'mongoose';
import { config } from '../config';
import { User } from '../models/User';
import { createReferralCode } from '../utils/referralCode';

const MISSING_CODE_FILTER = {
  $or: [
    { referralCode: { $exists: false } },
    { referralCode: null },
    { referralCode: '' }
  ]
};

const run = async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(config.mongoUri);

  try {
    // Ensure the unique sparse index is active before assigning any codes.
    await User.init();
    const missingUsers = await User.find(MISSING_CODE_FILTER).select('_id').lean();

    if (!apply) {
      console.log(`[ReferralCodeBackfill] Dry run: ${missingUsers.length} account(s) need a referral code. Re-run with --apply to assign.`);
      return;
    }

    let assigned = 0;
    let skipped = 0;

    for (const account of missingUsers) {
      let finished = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const referralCode = createReferralCode();
        if (await User.exists({ referralCode })) continue;

        try {
          const result = await User.updateOne(
            { _id: account._id, ...MISSING_CODE_FILTER },
            { $set: { referralCode } }
          );
          if (result.modifiedCount > 0) assigned += 1;
          else skipped += 1;
          finished = true;
          break;
        } catch (error: any) {
          if (error?.code === 11000) continue;
          throw error;
        }
      }
      if (!finished) throw new Error('Could not find an unused referral code after 100 attempts.');
    }

    console.log(`[ReferralCodeBackfill] Complete: ${assigned} code(s) assigned; ${skipped} account(s) already updated concurrently.`);
  } finally {
    await mongoose.disconnect();
  }
};

void run().catch((error) => {
  console.error('[ReferralCodeBackfill] Failed. Database credentials were not printed.');
  console.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});
