import { Response } from 'express';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { Paper } from '../models/Paper';
import { getAppSettingValue } from '../models/AppSetting';
import { AuthenticatedRequest } from '../middleware/auth';
import { CreatePaperInput } from '@moi/shared';
import { getSignedCloudinaryUrl, getAuthenticatedCloudinaryPdfUrl, extractPublicIdFromCloudinaryUrl } from '../services/tempFileService';
import { stableMaterialStats } from '../utils/materialStats';
import { TEMP_UPLOADS_DIR } from '../middleware/upload';

export const buildPaperResponseData = (paperDoc: any, req?: AuthenticatedRequest) => {
  const data = paperDoc.toObject ? paperDoc.toObject() : paperDoc;
  const fallbackStats = stableMaterialStats(String(data._id || data.title || 'material'));
  data.downloads = typeof data.downloads === 'number' && data.downloads >= 500 ? data.downloads : fallbackStats.downloads;
  data.ratingScore = data.ratingScore || fallbackStats.ratingScore;

  const cleanCloudinaryUrl = getSignedCloudinaryUrl(data.publicId, data.fileUrl, data.fileType);
  data.rawCloudinaryUrl = cleanCloudinaryUrl;
  if (data.ttsTextPublicId || data.ttsTextUrl) {
    // Keep the uploaded TXT extension from the stored URL. A raw public ID without
    // an extension is otherwise interpreted as a PDF by the generic URL helper.
    data.ttsTextUrl = getSignedCloudinaryUrl(undefined, data.ttsTextUrl, 'text');
  }

  const protocol = req ? (req.headers['x-forwarded-proto'] || req.protocol || 'http') : 'http';
  const host = req ? (req.get ? req.get('host') : (req.headers ? req.headers.host : 'localhost:5000')) || 'localhost:5000' : 'localhost:5000';
  const viewProxyUrl = `${protocol}://${host}/api/v1/papers/${data._id}/view`;
  data.viewUrl = viewProxyUrl;

  if (data._id && (data.fileType === 'pdf' || !data.fileType || data.fileUrl?.includes('/raw/upload/') || data.publicId?.includes('MoiConnect/pdf') || data.fileUrl?.includes('res.cloudinary.com'))) {
    data.fileUrl = viewProxyUrl;
  } else {
    data.fileUrl = cleanCloudinaryUrl;
  }

  if (!data.thumbnail) {
    if (data.fileType === 'image' || cleanCloudinaryUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
      data.thumbnail = cleanCloudinaryUrl;
    } else if (cleanCloudinaryUrl?.match(/\.pdf($|\?)/i) && cleanCloudinaryUrl.includes('cloudinary.com')) {
      data.thumbnail = cleanCloudinaryUrl.replace(/\/upload\/(?:[a-zA-Z0-9_,]+\/)?/g, '/upload/w_600,h_450,c_fill,pg_1,q_auto,f_jpg/').replace(/\.pdf$/i, '.jpg');
    } else if (Array.isArray(data.attachments)) {
      const imgAtt = data.attachments.find((att: any) => att.fileType === 'image' || att.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i));
      if (imgAtt && imgAtt.fileUrl) {
        data.thumbnail = imgAtt.fileUrl;
      }
    }
  }
  if (data.thumbnail) {
    data.thumbnail = getSignedCloudinaryUrl(undefined, data.thumbnail, 'image');
  }
  if (Array.isArray(data.attachments)) {
    data.attachments = data.attachments.map((att: any) => ({
      ...att,
      fileUrl: getSignedCloudinaryUrl(att.publicId, att.fileUrl, att.fileType)
    }));
  }
  return data;
};

export const getPapers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  try {
    const page = parseInt(req.query.page as string || '1', 10);
    const requestedLimit = parseInt(req.query.limit as string || '50', 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
    const skip = (page - 1) * limit;

    const { school, courseCode, unitCode, type, semester, year, search, includePending } = req.query;

    const cursorContext = JSON.stringify({
      school: school || '', courseCode: courseCode || '', unitCode: unitCode || '',
      type: type || '', semester: semester || '', year: year || '', search: String(search || '').trim().toLowerCase()
    });
    let cursor: any = null;
    if (typeof req.query.cursor === 'string' && req.query.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString('utf8'));
        if (cursor.context !== cursorContext || !mongoose.Types.ObjectId.isValid(cursor.id)) {
          res.status(400).json({ success: false, error: 'The result cursor is invalid for this query. Start a new search.' });
          return;
        }
      } catch {
        res.status(400).json({ success: false, error: 'The result cursor is invalid. Start a new search.' });
        return;
      }
    }
    const pageLimit = limit + 1;
    const lightweightFeed = req.query.feed === '1' || req.query.feed === 'true';

    const query: any = {};

    query.status = includePending === 'true' ? { $in: ['approved', 'pending'] } : 'approved';
    query.isHidden = { $ne: true };

    const showDemoMaterials = await getAppSettingValue('showDemoMaterials', false);
    if (!showDemoMaterials) {
      query.isDemo = { $ne: true };
    }

    if (school) query.school = school;
    if (courseCode) query.courseCode = (courseCode as string).toUpperCase();
    if (unitCode) query.unitCode = (unitCode as string).toUpperCase();
    if (semester) query.semester = semester;
    if (type) {
      if (typeof type === 'string' && type.includes(',')) {
        query.type = { $in: type.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) };
      } else if (Array.isArray(type)) {
        query.type = { $in: type };
      } else if (type === 'notes') {
        query.type = { $in: ['notes', 'revision', 'lecture_notes'] };
      } else if (type === 'cat') {
        query.type = { $in: ['cat', 'quiz'] };
      } else if (type === 'past_paper') {
        query.type = { $in: ['past_paper', 'solution', 'exam'] };
      } else {
        query.type = type;
      }
    }
    if (year) query.examYear = parseInt(year as string, 10);

    const searchStr = search ? String(search).trim() : '';
    let searchTokenGroups: any[] = [];
    const searchTokens = searchStr
      .toLowerCase()
      .replace(/\b(?:past|previous|old|question|exam|exams|examination|examinations|paper|papers|final|semester|main|special|supplementary|deferred|resit|retake|mock|model|revision|cat|cats|quiz|quizzes|continuous|assessment|class|test|tests|midterm|midterms|mid|notes?|lecture|slides|pdf|handout|handouts|reading|study|course|unit|material|materials|guide|guides|summary|summaries|solution|solutions|answer|answers|key|marking|scheme|schemes|worked|solved)\b/gi, ' ')
      .split(/\s+/)
      .filter((token: string) => token.length > 1 && !['and', 'the', 'of', 'in', 'for', 'to', 'with', 'a', 'an', 'at', 'by', 'from', 'on', 'or', 'as', 'is', 'it'].includes(token));

    if (searchStr) {
      // 1. Extract unit code embedded in query e.g. "sta 111 exam" -> "STA 111"
      const unitCodeRegexMatch = searchStr.match(/\b([a-zA-Z]{2,4})[-_ ]?(\d{2,3}[a-zA-Z]?)\b/i);
      const unitCodePrefix = unitCodeRegexMatch ? unitCodeRegexMatch[1].toUpperCase() : null;
      const unitCodeNum = unitCodeRegexMatch ? unitCodeRegexMatch[2] : null;
      const unitCodeVariant = unitCodePrefix && unitCodeNum
        ? new RegExp(`^${unitCodePrefix}[-_ ]?${unitCodeNum}($|[^0-9])`, 'i')
        : null;

      const searchConditionsFor = (token: string) => {
        const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const prefixRegex = new RegExp(`^${escapedToken}`, 'i');
        // Match token with trailing boundary so "sta" does not match "status" or "stage"
        const wordRegex = new RegExp(`(^|\\s|[._-])${escapedToken}(?:\\s|[._-]|$|[0-9])`, 'i');

        const conditions: any[] = [
          { unitCode: prefixRegex },
          { courseCode: prefixRegex },
          { mtid: prefixRegex },
          { title: wordRegex },
          { unitName: wordRegex },
          { school: wordRegex },
          { department: wordRegex },
          { semester: wordRegex },
          { academicYear: wordRegex },
          { description: wordRegex }
        ];
        if (unitCodeVariant) {
          conditions.push({ unitCode: unitCodeVariant }, { courseCode: unitCodeVariant });
        }
        const yearNum = Number(token);
        if (yearNum > 1900 && yearNum < 2100) conditions.push({ examYear: yearNum });
        return conditions;
      };

      // Fields are alternatives within a token; any meaningful token can match.
      searchTokenGroups = searchTokens.map((token) => ({ $or: searchConditionsFor(token) }));
      const baseConditions = searchTokenGroups.flatMap((group) => group.$or);
      if (unitCodeVariant) {
        baseConditions.push({ unitCode: unitCodeVariant }, { courseCode: unitCodeVariant });
      }
      if (baseConditions.length > 0) {
        query.$and = [...(query.$and || []), { $or: baseConditions }];
      }
    }

    // Feed clients use hasMore/nextCursor and do not need an exact total.
    // Avoid counting every match on each cursor page, especially for regex searches.
    const total = lightweightFeed ? null : await Paper.countDocuments(query);
    let papers: any[];
    const rankedSearch = Boolean(searchStr && (searchTokens.length > 0 || searchStr.length >= 2));
    if (rankedSearch) {
      const regexFor = (token: string) => `(^|\\s|[._-])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|[._-]|$|[0-9])`;
      const cleanRawSearch = searchStr.toLowerCase().trim();
      const unitCodeRegexMatch = searchStr.match(/\b([a-zA-Z]{2,4})[-_ ]?(\d{2,3}[a-zA-Z]?)\b/i);
      const unitCodePrefix = unitCodeRegexMatch ? unitCodeRegexMatch[1].toUpperCase() : null;
      const unitCodeNum = unitCodeRegexMatch ? unitCodeRegexMatch[2] : null;

      const relevanceParts: any[] = [
        { $cond: [{ $eq: [{ $toLower: { $ifNull: ['$unitCode', ''] } }, cleanRawSearch] }, 500, 0] },
        { $cond: [{ $eq: [{ $toLower: { $ifNull: ['$courseCode', ''] } }, cleanRawSearch] }, 450, 0] },
        { $cond: [{ $regexMatch: { input: { $ifNull: ['$title', ''] }, regex: cleanRawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' } }, 200, 0] }
      ];

      // Massive boost for exact unit code match e.g. STA 111 / STA-111 / STA111
      if (unitCodePrefix && unitCodeNum) {
        const strictCodePattern = `^${unitCodePrefix}[-_ ]?${unitCodeNum}($|[^0-9])`;
        relevanceParts.push(
          { $cond: [{ $regexMatch: { input: { $ifNull: ['$unitCode', ''] }, regex: strictCodePattern, options: 'i' } }, 600, 0] },
          { $cond: [{ $regexMatch: { input: { $ifNull: ['$courseCode', ''] }, regex: strictCodePattern, options: 'i' } }, 550, 0] },
          { $cond: [{ $regexMatch: { input: { $ifNull: ['$title', ''] }, regex: strictCodePattern, options: 'i' } }, 400, 0] }
        );
      }

      for (const token of searchTokens) {
        const regex = regexFor(token);
        const scoreFor = (field: string, weight: number) => ({
          $cond: [{ $regexMatch: { input: { $ifNull: [field, ''] }, regex, options: 'i' } }, weight, 0]
        });
        relevanceParts.push(
          scoreFor('$unitCode', 40), scoreFor('$courseCode', 35),
          scoreFor('$title', 30), scoreFor('$unitName', 25),
          scoreFor('$department', 5), scoreFor('$school', 3),
          scoreFor('$description', 2)
        );
      }
      const rankedPipeline: any[] = [
        { $match: query },
        { $addFields: { _searchScore: { $add: relevanceParts }, _cursorDownloads: { $ifNull: ['$downloads', 0] } } }
      ];
      if (cursor) {
        const cursorId = new mongoose.Types.ObjectId(cursor.id);
        rankedPipeline.push({ $match: { $or: [
          { _searchScore: { $lt: Number(cursor.score) } },
          { _searchScore: Number(cursor.score), _cursorDownloads: { $lt: Number(cursor.downloads) } },
          { _searchScore: Number(cursor.score), _cursorDownloads: Number(cursor.downloads), createdAt: { $lt: new Date(cursor.createdAt) } },
          { _searchScore: Number(cursor.score), _cursorDownloads: Number(cursor.downloads), createdAt: new Date(cursor.createdAt), _id: { $lt: cursorId } }
        ] } });
      }
      rankedPipeline.push(
        { $sort: { _searchScore: -1, _cursorDownloads: -1, createdAt: -1, _id: -1 } },
        ...(cursor ? [] : [{ $skip: skip }]),
        { $limit: pageLimit },
        ...(lightweightFeed ? [{ $project: {
          _id: 1, _searchScore: 1, _cursorDownloads: 1, mtid: 1, title: 1, type: 1,
          unitCode: 1, courseCode: 1, unitName: 1, school: 1, department: 1, semester: 1,
          academicYear: 1, examYear: 1, description: 1, downloads: 1, ratingScore: 1,
          thumbnail: 1, fileUrl: 1, fileType: 1, publicId: 1, ttsTextUrl: 1,
          ttsTextPublicId: 1, submittedBy: 1, createdAt: 1
        } }] : [])
      );
      papers = await Paper.aggregate(rankedPipeline);
      papers = await Paper.populate(papers, { path: 'submittedBy', select: 'name email avatarUrl' });
    } else {
      if (cursor) {
        const cursorDate = new Date(cursor.createdAt);
        const cursorId = new mongoose.Types.ObjectId(cursor.id);
        query.$and = [...(query.$and || []), { $or: [
          { createdAt: { $lt: cursorDate } },
          { createdAt: cursorDate, _id: { $lt: cursorId } }
        ] }];
      }
      const findQuery = Paper.find(query)
        .populate('submittedBy', 'name email avatarUrl')
        .sort({ createdAt: -1, _id: -1 });
      if (lightweightFeed) {
        findQuery.select('_id mtid title type unitCode courseCode unitName school department semester academicYear examYear description downloads ratingScore thumbnail fileUrl fileType publicId ttsTextUrl ttsTextPublicId submittedBy createdAt');
      }
      if (!cursor) findQuery.skip(skip);
      papers = await findQuery.limit(pageLimit);
    }

    const hasMore = papers.length > limit;
    if (hasMore) papers = papers.slice(0, limit);
    const lastPaper = papers[papers.length - 1];
    const nextCursor = hasMore && lastPaper ? Buffer.from(JSON.stringify({
      context: cursorContext,
      id: String(lastPaper._id),
      createdAt: new Date(lastPaper.createdAt).toISOString(),
      score: rankedSearch ? Number(lastPaper._searchScore || 0) : undefined,
      downloads: rankedSearch ? Number(lastPaper._cursorDownloads || 0) : undefined
    })).toString('base64url') : null;

    const formatPaperData = (paperDoc: any) => {
      const data = paperDoc.toObject ? paperDoc.toObject() : paperDoc;
      const fallbackStats = stableMaterialStats(String(data._id || data.title || 'material'));
      data.downloads = typeof data.downloads === 'number' && data.downloads >= 500 ? data.downloads : fallbackStats.downloads;
      data.ratingScore = data.ratingScore || fallbackStats.ratingScore;
      data.fileUrl = getSignedCloudinaryUrl(data.publicId, data.fileUrl, data.fileType);
      data.viewUrl = `/api/papers/${data._id}/view`;
      if (!data.thumbnail) {
        if (data.fileType === 'image' || data.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
          data.thumbnail = data.fileUrl;
        } else if (data.fileUrl?.match(/\.pdf($|\?)/i) && data.fileUrl.includes('cloudinary.com')) {
          data.thumbnail = data.fileUrl.replace(/\/upload\/(?:[a-zA-Z0-9_,]+\/)?/g, '/upload/w_600,h_450,c_fill,pg_1,q_auto,f_jpg/').replace(/\.pdf$/i, '.jpg');
        } else if (Array.isArray(data.attachments)) {
          const imgAtt = data.attachments.find((att: any) => att.fileType === 'image' || att.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i));
          if (imgAtt && imgAtt.fileUrl) {
            data.thumbnail = imgAtt.fileUrl;
          }
        }
      }
      if (data.thumbnail) {
        data.thumbnail = getSignedCloudinaryUrl(undefined, data.thumbnail, 'image');
      }
      if (Array.isArray(data.attachments)) {
        data.attachments = data.attachments.map((att: any) => ({
          ...att,
          fileUrl: getSignedCloudinaryUrl(att.publicId, att.fileUrl, att.fileType)
        }));
      }
      return data;
    };

    const papersWithSignedUrls = papers.map((doc) => {
      const data = buildPaperResponseData(doc, req);
      if (lightweightFeed) {
        delete data.attachments;
        delete data.rawCloudinaryUrl;
      }
      delete data._searchScore;
      delete data._cursorDownloads;
      return data;
    });

    res.json({
      success: true,
      data: papersWithSignedUrls,
      pagination: {
        page,
        limit,
        total,
        pages: total === null ? null : Math.ceil(total / limit),
        hasMore,
        nextCursor
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch academic papers' });
  }
};

export const getPaperById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const paper = await Paper.findById(id).populate('submittedBy', 'name email avatarUrl');

    if (!paper) {
      res.status(404).json({ success: false, error: 'Academic resource not found.' });
      return;
    }

    const showDemoMaterials = await getAppSettingValue('showDemoMaterials', false);
    const isAdmin = !!(req.user && req.user.roles.includes('admin'));
    if (!showDemoMaterials && paper.isDemo && !isAdmin) {
      res.status(404).json({ success: false, error: 'Academic resource not found.' });
      return;
    }

    if (paper.isHidden) {
      const isAdmin = !!(req.user && req.user.roles.includes('admin'));
      const submitterId = paper.submittedBy ? ((paper.submittedBy as any)._id || paper.submittedBy).toString() : null;
      const isSubmitter = !!(req.user && submitterId && submitterId === req.user._id.toString());
      if (!isAdmin && !isSubmitter) {
        res.status(404).json({ success: false, error: 'Academic resource not found.' });
        return;
      }
    }

    // Unapproved papers can only be viewed by submitter or admin
    if (paper.status !== 'approved') {
      const submitterId = paper.submittedBy ? ((paper.submittedBy as any)._id || paper.submittedBy).toString() : null;
      const isSubmitter = !!(req.user && submitterId && submitterId === req.user._id.toString());
      const isAdmin = !!(req.user && req.user.roles.includes('admin'));
      if (!isSubmitter && !isAdmin) {
        res.status(403).json({ success: false, error: 'This academic resource is pending approval.' });
        return;
      }
    }

    const paperData = buildPaperResponseData(paper, req);
    res.json({ success: true, data: paperData });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch paper' });
  }
};

export const uploadPaperFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded' });
      return;
    }

    const host = req.get('host') || 'localhost:5000';
    const protocol = req.protocol || 'http';
    const relativeUrl = `/uploads/temp/${req.file.filename}`;
    const fullUrl = `${protocol}://${host}${relativeUrl}`;

    const cleanOrig = req.file.originalname.toLowerCase();
    const ext = path.extname(cleanOrig).replace('.', '');
    let detectedType = 'pdf';
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'ico', 'tiff'].includes(ext)) {
      detectedType = 'image';
    } else if (['doc', 'docx', 'dotx', 'odt'].includes(ext)) {
      detectedType = 'doc';
    } else if (['txt', 'text', 'md', 'csv', 'json', 'log', 'rtf'].includes(ext)) {
      detectedType = 'text';
    } else if (ext === 'pdf') {
      detectedType = 'pdf';
    } else {
      detectedType = ext || 'pdf';
    }

    res.status(201).json({
      success: true,
      message: 'File temporarily saved to server for admin verification.',
      data: {
        tempFilename: req.file.filename,
        originalName: req.file.originalname,
        fileUrl: fullUrl,
        relativeUrl,
        fileSize: req.file.size,
        fileType: detectedType
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'File upload failed' });
  }
};

export const createPaper = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const input: CreatePaperInput = req.body;
    const userId = req.user ? req.user._id : undefined;

    let tempFilename = (input as any).tempFilename;
    if (!tempFilename && input.fileUrl && input.fileUrl.includes('/uploads/temp/')) {
      tempFilename = input.fileUrl.split('/uploads/temp/')[1]?.split('?')[0];
    }

    let thumbnail = (input as any).thumbnail;
    if (!thumbnail) {
      if (input.fileType === 'image' || input.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
        thumbnail = input.fileUrl;
      } else if (input.fileUrl?.match(/\.pdf($|\?)/i) && input.fileUrl.includes('cloudinary.com')) {
        thumbnail = input.fileUrl.replace(/\/upload\/(?:[a-zA-Z0-9_,]+\/)?/g, '/upload/w_600,h_450,c_fill,pg_1,q_auto,f_jpg/').replace(/\.pdf$/i, '.jpg');
      } else if (Array.isArray((input as any).attachments)) {
        const imgAtt = (input as any).attachments.find((att: any) => att.fileType === 'image' || att.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i));
        if (imgAtt && imgAtt.fileUrl) {
          thumbnail = imgAtt.fileUrl;
        }
      }
    }

    const newPaper = await Paper.create({
      ...input,
      thumbnail,
      tempFilename,
      submittedBy: userId,
      status: 'pending',
});

    const populated = userId ? await newPaper.populate('submittedBy', 'name email avatarUrl') : newPaper;

    res.status(201).json({
      success: true,
      message: 'Academic paper submitted successfully and is pending administrator review.',
      data: populated
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Paper submission failed' });
  }
};

export const getMySubmissions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const papers = await Paper.find({ submittedBy: user._id }).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: papers
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch submissions' });
  }
};

export const downloadPaper = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const paper = await Paper.findByIdAndUpdate(id, { $inc: { downloads: 1 } }, { new: true });
    if (!paper) {
      res.status(404).json({ success: false, error: 'Resource not found' });
      return;
    }

    if (paper.isHidden) {
      res.status(404).json({ success: false, error: 'Resource not found' });
      return;
    }

    res.json({
      success: true,
      data: { fileUrl: paper.fileUrl, downloads: paper.downloads }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Download failed' });
  }
};

const setPdfResponseHeaders = (res: Response): void => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="document.pdf"');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
};

const streamLocalPdf = (req: AuthenticatedRequest, res: Response, localPath: string): boolean => {
  if (!fs.existsSync(localPath)) return false;
  const stat = fs.statSync(localPath);
  if (!stat.isFile()) return false;
  const range = req.headers.range;
  setPdfResponseHeaders(res);

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return true;
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
    const end = match[2] && match[1] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (start >= stat.size || end < start) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return true;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(localPath, { start, end }).on('error', () => res.destroy()).pipe(res);
    return true;
  }

  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(localPath).on('error', () => res.destroy()).pipe(res);
  return true;
};

const streamUpstreamPdf = async (
  req: AuthenticatedRequest,
  res: Response,
  url: string,
  cacheControl = 'private, max-age=3600'
): Promise<boolean> => {
  const headers: Record<string, string> = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await fetch(url, { headers });
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    return false;
  }

  setPdfResponseHeaders(res);
  res.setHeader('Cache-Control', cacheControl);
  const contentLength = upstream.headers.get('content-length');
  const contentRange = upstream.headers.get('content-range');
  const acceptRanges = upstream.headers.get('accept-ranges');
  if (contentLength) res.setHeader('Content-Length', contentLength);
  if (contentRange) res.setHeader('Content-Range', contentRange);
  if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
  res.status(upstream.status);
  Readable.fromWeb(upstream.body as any).on('error', () => res.destroy()).pipe(res);
  return true;
};

export const viewPaperPdf = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");

  try {
    const { id } = req.params;
    let paper: any = null;

    if (mongoose.Types.ObjectId.isValid(id)) {
      paper = await Paper.findById(id);
    }
    if (!paper) {
      paper = await Paper.findOne({ $or: [{ mtid: id }, { title: id }, { courseCode: id }] });
    }

    if (!paper) {
      res.status(404).send('Academic resource not found.');
      return;
    }

    if (!req.headers.range || req.headers.range.startsWith('bytes=0-')) {
      paper.downloads = (paper.downloads || 0) + 1;
      await paper.save().catch(() => {});
    }

    const isProxyUrl = (url?: string) => {
      if (!url) return true;
      return url.includes('/api/papers/') || url.includes('/api/v1/papers/') || url.includes('/view');
    };

    // 0. Check local disk for tempFilename or local file path
    if (paper.tempFilename) {
      const localPath = path.join(TEMP_UPLOADS_DIR, paper.tempFilename);
      if (streamLocalPdf(req, res, localPath)) return;
    }

    if (paper.fileUrl) {
      const filename = path.basename(paper.fileUrl.split('?')[0]);
      if (filename && filename.endsWith('.pdf')) {
        const localPath = path.join(TEMP_UPLOADS_DIR, filename);
        if (streamLocalPdf(req, res, localPath)) return;
      }
    }

    // 1. Try fetching direct public Cloudinary URL if it's not pointing back to server proxy
    const directUrl = getSignedCloudinaryUrl(paper.publicId, paper.fileUrl, paper.fileType);
    if (directUrl && !isProxyUrl(directUrl)) {
      try {
        if (await streamUpstreamPdf(req, res, directUrl)) return;
      } catch (_) {}
    }

    // 2. Fallback: Extract publicId or use paper.publicId to fetch authenticated private Cloudinary URL
    const effectivePublicId = paper.publicId || extractPublicIdFromCloudinaryUrl(paper.fileUrl);
    if (effectivePublicId) {
      try {
        const authUrl = getAuthenticatedCloudinaryPdfUrl(effectivePublicId);
        if (authUrl && !isProxyUrl(authUrl) && await streamUpstreamPdf(req, res, authUrl)) return;
      } catch (_) {}
    }

    // 3. Fallback: Fetch raw paper.fileUrl if it's a valid non-proxy URL
    if (paper.fileUrl && !isProxyUrl(paper.fileUrl) && (paper.fileUrl.startsWith('http://') || paper.fileUrl.startsWith('https://'))) {
      try {
        if (await streamUpstreamPdf(req, res, paper.fileUrl)) return;
      } catch (_) {}
    }

    res.status(502).send('Unable to retrieve the PDF from its storage provider.');
  } catch (err: any) {
    console.error('Error in viewPaperPdf:', err);
    res.status(500).send('Error retrieving PDF document');
  }
};

export const streamPaperPdfByUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");

  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      res.status(400).send('Missing url parameter.');
      return;
    }

    const parsedUrl = new URL(rawUrl);
    if (!['https:', 'http:'].includes(parsedUrl.protocol) || !['res.cloudinary.com', 'api.cloudinary.com'].includes(parsedUrl.hostname.toLowerCase())) {
      res.status(400).send('Only secure Cloudinary PDF URLs are supported.');
      return;
    }
    const publicId = extractPublicIdFromCloudinaryUrl(rawUrl);

    if (publicId) {
      try {
        const authUrl = getAuthenticatedCloudinaryPdfUrl(publicId);
        if (await streamUpstreamPdf(req, res, authUrl, 'no-store, no-cache, must-revalidate')) return;
      } catch (_) {}
    }

    if (await streamUpstreamPdf(req, res, rawUrl, 'no-store, no-cache, must-revalidate')) return;
    res.status(502).send('Unable to retrieve the PDF from Cloudinary.');
  } catch (error: any) {
    res.status(500).send('Failed to stream PDF.');
  }
};
