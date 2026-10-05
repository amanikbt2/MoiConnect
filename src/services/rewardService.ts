import { User } from '../models/User';
import { Paper } from '../models/Paper';
import { RewardPayout } from '../models/RewardPayout';
import { getAppSettingValue } from '../models/AppSetting';
import { attemptB2CPayout, createOriginatorConversationId } from './mpesaB2CService';

export const PAPER_APPROVAL_POINTS = 1;
export const REWARD_MILESTONES = [
  { points: 6, amount: 5 },
  { points: 8, amount: 1 },
  { points: 10, amount: 1 },
  { points: 100, amount: 1 },
  { points: 1000, amount: 1 }
] as const;

const queueEligibleMilestonePayouts = async (user: any, currentPoints: number) => {
  if (!(await getAppSettingValue('allowPayments', true))) return;
  if (user.paymentBlacklisted) return;
  if (!user?.phone) {
    console.warn(`[Rewards] User ${user?._id} reached a milestone but has no phone number.`);
    return;
  }

  for (const milestone of REWARD_MILESTONES) {
    if (currentPoints < milestone.points) continue;
    const payout = await RewardPayout.findOneAndUpdate(
      { userId: user._id, milestonePoints: milestone.points },
      {
        $setOnInsert: {
          userId: user._id,
          milestonePoints: milestone.points,
          amount: milestone.amount,
          phone: user.phone,
          status: 'pending',
          originatorConversationId: createOriginatorConversationId()
        }
      },
      { upsert: true, new: true }
    );
    if (payout.status === 'pending') void attemptB2CPayout(payout);
  }
};

export const awardPaperApprovalPoints = async (paper: any): Promise<number> => {
  if (!paper?.submittedBy || paper.pointsAwarded === PAPER_APPROVAL_POINTS) return 0;

  const claimedPaper = await Paper.findOneAndUpdate(
    {
      _id: paper._id,
      status: 'approved',
      $or: [{ pointsAwarded: { $exists: false } }, { pointsAwarded: 0 }]
    },
    { $set: { pointsAwarded: PAPER_APPROVAL_POINTS } },
    { new: true }
  );
  if (!claimedPaper) return 0;

  const contributorId = typeof paper.submittedBy === 'object' && paper.submittedBy._id
    ? paper.submittedBy._id
    : paper.submittedBy;
  // Older accounts may not have the field yet; initialize their original +5 balance
  // before applying the approval reward.
  await User.updateOne(
    { _id: contributorId, points: { $exists: false } },
    { $set: { points: 5 } }
  );
  const pointsToAward = Math.random() < 0.5 ? 1 : 2;
  const contributor = await User.findByIdAndUpdate(
    contributorId,
    { $inc: { points: pointsToAward } },
    { new: true }
  );
  if (!contributor) {
    await Paper.findByIdAndUpdate(paper._id, { $set: { pointsAwarded: 0 } });
    return 0;
  }
  void queueEligibleMilestonePayouts(contributor, Number(contributor.points || 0));
  return pointsToAward;
};
