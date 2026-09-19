import { Response } from 'express';
import { Report } from '../models/Report';
import { AuthenticatedRequest } from '../middleware/auth';
import { CreateReportInput } from '@moi/shared';

export const createReport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { targetType, targetId, reason, details }: CreateReportInput = req.body;
    const user = req.user!;

    const report = await Report.create({
      reporterId: user._id,
      targetType,
      targetId,
      reason,
      details,
      status: 'pending'
    });

    res.status(201).json({
      success: true,
      message: 'Report submitted successfully. Administrators will review it.',
      data: report
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Report submission failed' });
  }
};
