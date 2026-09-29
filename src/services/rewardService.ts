import { User } from '../models/User';
import { Paper } from '../models/Paper';

export const PAPER_APPROVAL_POINTS = 10;

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
  const contributor = await User.findByIdAndUpdate(
    contributorId,
    { $inc: { points: PAPER_APPROVAL_POINTS } },
    { new: true }
  );
  if (!contributor) {
    await Paper.findByIdAndUpdate(paper._id, { $set: { pointsAwarded: 0 } });
    return 0;
  }
  return PAPER_APPROVAL_POINTS;
};
