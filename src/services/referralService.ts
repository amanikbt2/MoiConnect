import { User, IUserDocument } from '../models/User';
import { awardReferralSignupPoints, REFERRAL_REWARD_POINTS } from './rewardService';

const normalizeReferralCode = (code?: string): string => String(code || '').trim().toUpperCase();

export const awardPendingReferralPoints = async (referrerId: string): Promise<void> => {
  const referrals = await User.find({ referredBy: referrerId }).select('_id').lean();
  for (const referral of referrals) {
    await awardReferralSignupPoints(referrerId, String(referral._id));
  }
};

export const attachReferralToNewUser = async (
  newUser: IUserDocument,
  rawReferralCode?: string
): Promise<boolean> => {
  const referralCode = normalizeReferralCode(rawReferralCode);
  if (!referralCode || !/^[A-Z0-9]{4,24}$/.test(referralCode)) return false;

  const referrer = await User.findOne({ referralCode }).select('_id email phone');
  if (!referrer || String(referrer._id) === String(newUser._id)) return false;
  if (referrer.email.toLowerCase() === newUser.email.toLowerCase()) return false;
  if (referrer.phone && newUser.phone && referrer.phone.replace(/\D/g, '') === newUser.phone.replace(/\D/g, '')) return false;

  const alreadyReferred = newUser.referredBy && String(newUser.referredBy) !== String(referrer._id);
  if (alreadyReferred) return false;

  if (!newUser.referredBy) {
    const attributed = await User.findOneAndUpdate(
      { _id: newUser._id, $or: [{ referredBy: { $exists: false } }, { referredBy: null }] },
      { $set: { referredBy: referrer._id } },
      { new: true }
    );
    if (!attributed) return false;
    newUser.referredBy = referrer._id;
  }

  // The creditedReferralIds set makes retries safe if a signup or referral
  // summary request races with a transient database failure.
  return awardReferralSignupPoints(String(referrer._id), String(newUser._id));
};

export const getReferralRewardPoints = (): number => REFERRAL_REWARD_POINTS;
