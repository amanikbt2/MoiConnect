import { Response } from 'express';
import { Paper } from '../models/Paper';
import { House } from '../models/House';
import { User } from '../models/User';
import { Report } from '../models/Report';
import { AuthenticatedRequest } from '../middleware/auth';

export const getStats = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const totalUsers = await User.countDocuments();
    const pendingLandlords = await User.countDocuments({ landlordStatus: 'pending' });
    const pendingPapers = await Paper.countDocuments({ status: 'pending' });
    const approvedPapers = await Paper.countDocuments({ status: 'approved' });
    const pendingHouses = await House.countDocuments({ status: 'pending' });
    const approvedHouses = await House.countDocuments({ status: 'approved' });
    const pendingReports = await Report.countDocuments({ status: 'pending' });

    res.json({
      success: true,
      data: {
        totalUsers,
        pendingLandlords,
        pendingPapers,
        approvedPapers,
        pendingHouses,
        approvedHouses,
        pendingReports
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch admin stats' });
  }
};

export const getAdminPapers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const status = (req.query.status as string) || 'pending';
    const papers = await Paper.find({ status })
      .populate('submittedBy', 'name email')
      .populate('reviewedBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: papers });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch admin papers' });
  }
};

export const reviewPaper = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;
    const admin = req.user!;

    if (status === 'rejected' && (!rejectionReason || !rejectionReason.trim())) {
      res.status(400).json({ success: false, error: 'A rejection reason is required when rejecting a submission.' });
      return;
    }

    const paper = await Paper.findById(id);
    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    paper.status = status;
    if (status === 'rejected') {
      paper.rejectionReason = rejectionReason;
    } else {
      paper.rejectionReason = undefined;
    }
    paper.reviewedBy = admin._id;
    paper.reviewedAt = new Date();
    await paper.save();

    res.json({
      success: true,
      message: `Academic paper ${status}.`,
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Paper review failed' });
  }
};

export const getAdminHouses = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const status = (req.query.status as string) || 'pending';
    const houses = await House.find({ status })
      .populate('landlordId', 'name email phone landlordStatus')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: houses });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch admin houses' });
  }
};

export const reviewHouse = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;

    const house = await House.findById(id);
    if (!house) {
      res.status(404).json({ success: false, error: 'Rental listing not found.' });
      return;
    }

    house.status = status;
    if (status === 'rejected') {
      house.rejectionReason = rejectionReason;
    }
    await house.save();

    res.json({
      success: true,
      message: `Rental listing ${status}.`,
      data: house
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'House review failed' });
  }
};

export const getPendingLandlords = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const users = await User.find({ landlordStatus: 'pending' }).sort({ updatedAt: -1 });
    res.json({ success: true, data: users });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch pending landlords' });
  }
};

export const verifyLandlord = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'approved' | 'rejected'

    const user = await User.findById(id);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found.' });
      return;
    }

    user.landlordStatus = status;
    if (status === 'approved') {
      if (!user.roles.includes('landlord')) {
        user.roles.push('landlord');
      }
      user.activeRole = 'landlord';
    }
    await user.save();

    res.json({
      success: true,
      message: `Landlord status set to ${status}.`,
      data: user
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Landlord verification failed' });
  }
};

export const getAdminReports = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const status = (req.query.status as string) || 'pending';
    const reports = await Report.find({ status })
      .populate('reporterId', 'name email')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: reports });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch reports' });
  }
};

export const reviewReport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'reviewed' | 'dismissed'
    const admin = req.user!;

    const report = await Report.findById(id);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found.' });
      return;
    }

    report.status = status;
    report.reviewedBy = admin._id;
    report.reviewedAt = new Date();
    await report.save();

    res.json({
      success: true,
      message: `Report marked as ${status}.`,
      data: report
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Report review failed' });
  }
};
