import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { SearchReport } from '../models/SearchReport';
import { Paper } from '../models/Paper';

const clean = (value: unknown, maxLength: number): string => String(value || '').trim().slice(0, maxLength);

const findSearchMatch = async (query: string, source: string): Promise<boolean> => {
  const tokens = query.split(/\s+/).filter(Boolean).slice(0, 12);
  const conditions = tokens.flatMap((token) => {
    const expression = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return [{ title: expression }, { unitCode: expression }, { unitName: expression }, { courseCode: expression }, { school: expression }, { department: expression }, { description: expression }, { mtid: expression }];
  });
  const typeFilter = source === 'past_papers' ? { type: { $in: ['past_paper', 'solution'] } } : source === 'cats' ? { type: 'cat' } : source === 'notes' ? { type: { $in: ['notes', 'revision_notes'] } } : {};
  return (await Paper.countDocuments({ status: 'approved', isHidden: { $ne: true }, ...typeFilter, $or: conditions })) > 0;
};

export const createSearchReport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const query = clean(req.body?.query, 240);
    if (!query) {
      res.status(400).json({ success: false, error: 'Search words are required.' });
      return;
    }

    const user = req.user;
    const found = typeof req.body?.found === 'boolean' ? req.body.found : await findSearchMatch(query, clean(req.body?.source, 40) || 'home');
    const report = await SearchReport.create({
      userId: user?._id,
      name: clean(user?.name, 120) || 'Guest',
      email: clean(user?.email, 254) || 'Guest',
      query,
      source: clean(req.body?.source, 40) || 'home',
      found
    });

    res.status(201).json({ success: true, reportId: report._id });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to save search report.' });
  }
};

export const getSearchReports = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const reports = await SearchReport.find().sort({ createdAt: -1 }).limit(500).lean();
    res.json({ success: true, reports });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to load search reports.' });
  }
};

export const deleteSearchReport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await SearchReport.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete search report.' });
  }
};

export const deleteAllSearchReports = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await SearchReport.deleteMany({});
    res.json({ success: true, deletedCount: result.deletedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete search reports.' });
  }
};
