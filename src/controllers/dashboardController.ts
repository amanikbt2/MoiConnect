import { Request, Response } from 'express';
import path from 'path';
import { User } from '../models/User';
import { Paper } from '../models/Paper';
import { House } from '../models/House';
import { Report } from '../models/Report';
import { getOnlineStats } from '../socket';
import {
  listTempFiles,
  deleteTempFile,
  deleteBatchTempFiles,
  uploadTempFileToCloudinary
} from '../services/tempFileService';

// 1. JSON API: Get full dashboard data
export const getDashboardOverview = async (_req: Request, res: Response): Promise<void> => {
  try {
    const totalUsers = await User.countDocuments();
    const pendingLandlords = await User.countDocuments({ landlordStatus: 'pending' });
    const pendingPapers = await Paper.countDocuments({ status: 'pending' });
    const approvedPapers = await Paper.countDocuments({ status: 'approved' });
    const rejectedPapers = await Paper.countDocuments({ status: 'rejected' });
    const pendingHouses = await House.countDocuments({ status: 'pending' });
    const approvedHouses = await House.countDocuments({ status: 'approved' });
    const pendingReports = await Report.countDocuments({ status: 'pending' });
    const departmentsList = await Paper.distinct('department');
    const totalDepartments = departmentsList.filter(Boolean).length;

    // Fast zero-polling in-memory online statistics
    const onlineStats = getOnlineStats();

    const pendingPaperList = await Paper.find({ status: 'pending' })
      .populate('submittedBy', 'name email')
      .sort({ createdAt: -1 });

    const approvedPaperList = await Paper.find({ status: 'approved' })
      .populate('submittedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(30);

    const userList = await User.find()
      .select('-passwordHash -refreshTokens')
      .sort({ createdAt: -1 })
      .limit(50);

    const houseList = await House.find()
      .populate('landlordId', 'name email phone')
      .sort({ createdAt: -1 })
      .limit(30);

    const tempFilesSummary = await listTempFiles();

    res.json({
      success: true,
      stats: {
        totalUsers,
        pendingLandlords,
        pendingPapers,
        approvedPapers,
        rejectedPapers,
        pendingHouses,
        approvedHouses,
        pendingReports,
        totalDepartments,
        totalOnline: onlineStats.totalOnline,
        authenticatedOnline: onlineStats.authenticatedCount,
        guestOnline: onlineStats.guestCount,
        onlineUserIds: onlineStats.onlineUserIds,
        totalTempFiles: tempFilesSummary.totalFiles,
        totalTempSizeBytes: tempFilesSummary.totalSizeBytes,
        totalTempSizeFormatted: tempFilesSummary.totalSizeFormatted
      },
      pendingPapers: pendingPaperList,
      approvedPapers: approvedPaperList,
      users: userList,
      houses: houseList
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch dashboard data' });
  }
};

// 2. Quick Approve Paper Endpoint for Web Dashboard
export const quickApprovePaper = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const paper = await Paper.findById(id);
    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    paper.status = 'approved';
    paper.rejectionReason = undefined;

    // Cloudinary Upload Pipeline: If document is stored in server temp, upload to Cloudinary under MoiConnect/pdf
    if (paper.tempFilename || paper.fileUrl?.includes('/uploads/temp/')) {
      try {
        const fileTarget = paper.tempFilename || paper.fileUrl;
        const uploadResult = await uploadTempFileToCloudinary(fileTarget, 'MoiConnect/pdf');
        paper.fileUrl = uploadResult.secure_url;
        paper.publicId = uploadResult.public_id;
        paper.tempFilename = undefined;
      } catch (cloudErr: any) {
        console.error('[Dashboard Quick Approve] Cloudinary upload error:', cloudErr);
        res.status(500).json({
          success: false,
          error: `Cloudinary upload to folder "MoiConnect/pdf" failed: ${cloudErr?.message || cloudErr}`
        });
        return;
      }
    }

    if (!paper.mtid) {
      let prefix = 'N';
      let typesToCount = ['notes', 'revision'];
      if (paper.type === 'cat') {
        prefix = 'C';
        typesToCount = ['cat'];
      } else if (paper.type === 'past_paper') {
        prefix = 'P';
        typesToCount = ['past_paper'];
      }

      const approvedCount = await Paper.countDocuments({
        status: 'approved',
        type: { $in: typesToCount }
      });
      paper.mtid = `${prefix}${String(approvedCount + 1).padStart(4, '0')}`;
    }

    paper.reviewedAt = new Date();
    await paper.save();

    res.json({
      success: true,
      message: `Approved "${paper.title}" with MTID ${paper.mtid} & uploaded to Cloudinary (MoiConnect/pdf).`,
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Approval failed' });
  }
};

// 3. Quick Reject Paper Endpoint for Web Dashboard
export const quickRejectPaper = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const paper = await Paper.findById(id);
    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    paper.status = 'rejected';
    paper.rejectionReason = reason || 'Does not meet document upload guidelines.';

    // Clean up temporary server storage if file was stored locally
    if (paper.tempFilename || paper.fileUrl?.includes('/uploads/temp/')) {
      deleteTempFile(paper.tempFilename || paper.fileUrl);
      paper.tempFilename = undefined;
    }

    paper.reviewedAt = new Date();
    await paper.save();

    res.json({
      success: true,
      message: `Rejected "${paper.title}" and deleted temporary file from server.`,
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Rejection failed' });
  }
};

// 4. Quick Edit Paper Metadata
export const quickEditPaper = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const paper = await Paper.findById(id);
    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    if (updates.title !== undefined) paper.title = updates.title;
    if (updates.courseCode !== undefined) paper.courseCode = updates.courseCode.toUpperCase();
    if (updates.unitCode !== undefined) paper.unitCode = updates.unitCode.toUpperCase();
    if (updates.unitName !== undefined) paper.unitName = updates.unitName;
    if (updates.school !== undefined) paper.school = updates.school;
    if (updates.department !== undefined) paper.department = updates.department;
    if (updates.type !== undefined) paper.type = updates.type;
    if (updates.examYear !== undefined) paper.examYear = updates.examYear;

    await paper.save();

    res.json({
      success: true,
      message: `Updated "${paper.title}" metadata successfully.`,
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to update paper' });
  }
};

// 5. Quick Replace Paper File with Clean Media
export const quickReplacePaperFile = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No replacement file provided.' });
      return;
    }

    const paper = await Paper.findById(id);
    if (!paper) {
      deleteTempFile(req.file.filename);
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    // Delete old temp file if it was on server
    if (paper.tempFilename || paper.fileUrl?.includes('/uploads/temp/')) {
      deleteTempFile(paper.tempFilename || paper.fileUrl);
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

    paper.tempFilename = req.file.filename;
    paper.fileUrl = fullUrl;
    paper.fileSize = req.file.size;
    paper.fileType = detectedType;

    await paper.save();

    res.json({
      success: true,
      message: `Clean document uploaded! Previous temporary file replaced.`,
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'File replacement failed' });
  }
};

// 6. Get Server Media Temp Files
export const getDashboardTempFiles = async (_req: Request, res: Response): Promise<void> => {
  try {
    const data = await listTempFiles();
    res.json({ success: true, ...data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to list temp files' });
  }
};

// 7. Delete Single Temp File
export const deleteDashboardTempFile = async (req: Request, res: Response): Promise<void> => {
  try {
    const { filename } = req.params;
    const deleted = deleteTempFile(filename);
    if (!deleted) {
      res.status(404).json({ success: false, error: `File "${filename}" not found on server.` });
      return;
    }
    res.json({ success: true, message: `File "${filename}" deleted from server temporary storage.` });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete temp file' });
  }
};

// 8. Delete Batch Temp Files
export const deleteDashboardBatchTempFiles = async (req: Request, res: Response): Promise<void> => {
  try {
    const { filenames } = req.body;
    if (!Array.isArray(filenames) || filenames.length === 0) {
      res.status(400).json({ success: false, error: 'No filenames specified for batch cleanup.' });
      return;
    }

    const result = deleteBatchTempFiles(filenames);
    res.json({
      success: true,
      message: `Cleaned ${result.deletedCount} files from server temporary storage.`,
      ...result
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to batch delete temp files' });
  }
};

// 9. Render Public Temporary Storage Folder Page (GET /mydomain_admin/temp_files/)
export const renderPublicTempFolder = async (_req: Request, res: Response): Promise<void> => {
  try {
    const tempSummary = await listTempFiles();
    const files = tempSummary.files;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MoiConnect • Public Server Temp Storage</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; color: #1e293b; min-height: 100vh; display: flex; flex-direction: column; }
    header { background-color: #064e3b; color: #ffffff; padding: 16px 24px; border-bottom: 2px solid #047857; }
    .header-container { max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
    .brand-title { font-size: 18px; font-weight: 800; display: flex; align-items: center; gap: 10px; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 700; text-decoration: none; cursor: pointer; border: none; transition: all 0.2s; }
    .btn-green { background-color: #10b981; color: #ffffff; }
    .btn-green:hover { background-color: #059669; }
    .btn-dark { background-color: #1e293b; color: #ffffff; }
    .btn-dark:hover { background-color: #0f172a; }
    .btn-view { background-color: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; }
    .btn-view:hover { background-color: #bae6fd; }
    main { max-width: 1200px; width: 100%; margin: 0 auto; padding: 24px 16px; flex: 1; }
    .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 20px; }
    .stat-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; }
    .stat-label { font-size: 11px; font-weight: 800; color: #64748b; text-transform: uppercase; margin-bottom: 4px; }
    .stat-val { font-size: 24px; font-weight: 800; color: #15803d; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th { background: #f1f5f9; padding: 12px 14px; font-weight: 700; color: #475569; border-bottom: 2px solid #e2e8f0; }
    td { padding: 12px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
    tr:hover td { background-color: #f8fafc; }
    .tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    .tag-img { background: #fdf2f8; color: #9d174d; border: 1px solid #fbcfe8; }
    .tag-pdf { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
    .tag-doc { background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; }
    .tag-txt { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
    .search-bar { width: 100%; max-width: 320px; padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 13px; }
    #toast { position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; background: #15803d; color: #ffffff; font-weight: 700; font-size: 13px; z-index: 9999; display: none; }
  </style>
</head>
<body>
  <div id="toast"></div>
  <header>
    <div class="header-container">
      <div class="brand-title">
        <span>📂</span>
        <span>MoiConnect Server • Public Temporary Storage</span>
      </div>
      <div style="display: flex; gap: 10px; align-items: center;">
        <a href="/admin" class="btn btn-green">⬅️ Back to Admin Dashboard</a>
        <button onclick="location.reload()" class="btn btn-dark">🔄 Refresh</button>
      </div>
    </div>
  </header>

  <main>
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 20px;">
        <div>
          <h2 style="font-size: 20px; font-weight: 800; color: #0f172a;">Server Media (Temp) Public Directory</h2>
          <p style="font-size: 12px; color: #64748b; margin-top: 2px;">Assessed URL: <code>/mydomain_admin/temp_files/</code> • Local Directory: <code>backend/uploads/temp/</code></p>
        </div>
        <input type="text" id="file-search" oninput="filterFiles()" class="search-bar" placeholder="Search files by name..." />
      </div>

      <div class="stats-row">
        <div class="stat-box">
          <div class="stat-label">Total Files in Storage</div>
          <div class="stat-val">${tempSummary.totalFiles}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Total Disk Space</div>
          <div class="stat-val" style="color: #0284c7;">${tempSummary.totalSizeFormatted}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Public Access Mount</div>
          <div style="font-family: monospace; font-size: 13px; font-weight: 700; color: #15803d; margin-top: 6px;">/mydomain_admin/temp_files/</div>
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table id="temp-table">
          <thead>
            <tr>
              <th>File Name</th>
              <th>Format</th>
              <th>Size</th>
              <th>Modified</th>
              <th>Public URL</th>
              <th style="text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${files.length === 0 ? `<tr><td colspan="6" style="text-align: center; padding: 48px; color: #94a3b8;">No temporary files in storage. Server is completely clean!</td></tr>` : files.map(f => {
              const ext = (path.extname(f.filename) || '').toLowerCase().replace('.', '');
              let tagClass = 'tag-pdf';
              let tagIcon = '📄';
              let tagText = 'PDF';
              if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) {
                tagClass = 'tag-img';
                tagIcon = '🖼️';
                tagText = ext.toUpperCase() + ' IMAGE';
              } else if (['docx', 'doc'].includes(ext)) {
                tagClass = 'tag-doc';
                tagIcon = '📝';
                tagText = ext.toUpperCase() + ' WORD';
              } else if (['txt', 'md', 'csv', 'json'].includes(ext)) {
                tagClass = 'tag-txt';
                tagIcon = '📑';
                tagText = ext.toUpperCase() + ' TEXT';
              }
              const publicUrl = `/mydomain_admin/temp_files/${encodeURIComponent(f.filename)}`;
              const previewUrl = `/admin/preview?url=${encodeURIComponent(publicUrl)}&title=${encodeURIComponent(f.filename)}&type=${encodeURIComponent(ext)}`;

              return `
              <tr class="file-row" data-name="${f.filename.toLowerCase()}">
                <td>
                  <a href="${publicUrl}" target="_blank" style="font-weight: 700; color: #0284c7; text-decoration: none;">
                    ${f.filename}
                  </a>
                </td>
                <td><span class="tag ${tagClass}">${tagIcon} ${tagText}</span></td>
                <td style="font-weight: 600;">${f.sizeFormatted}</td>
                <td style="color: #64748b;">${new Date(f.modifiedAt).toLocaleString()}</td>
                <td>
                  <button onclick="copyUrl('${publicUrl}')" class="btn btn-view" style="font-size: 11px; padding: 4px 8px;">
                    📋 Copy Link
                  </button>
                </td>
                <td style="text-align: right;">
                  <div style="display: inline-flex; gap: 6px;">
                    <a href="${previewUrl}" target="_blank" class="btn btn-view" style="font-size: 11px; padding: 4px 10px;">
                      👁️ Smart Preview
                    </a>
                    <a href="${publicUrl}" download class="btn btn-dark" style="font-size: 11px; padding: 4px 10px;">
                      📥 Download
                    </a>
                  </div>
                </td>
              </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <script>
    function copyUrl(rel) {
      var full = window.location.origin + rel;
      navigator.clipboard.writeText(full).then(function() {
        showToast('Copied to clipboard: ' + full);
      });
    }

    function showToast(msg) {
      var t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(function() { t.style.display = 'none'; }, 3000);
    }

    function filterFiles() {
      var q = document.getElementById('file-search').value.toLowerCase().trim();
      var rows = document.querySelectorAll('.file-row');
      for (var i = 0; i < rows.length; i++) {
        var name = rows[i].getAttribute('data-name') || '';
        rows[i].style.display = (!q || name.indexOf(q) !== -1) ? '' : 'none';
      }
    }
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error: any) {
    res.status(500).send('Error rendering public temp folder: ' + error.message);
  }
};

// 10. Render Smart Document & Media Preview Page (GET /admin/preview) for PDF, Word DOCX/DOC, Images, and Text
export const renderSmartPreviewPage = (req: Request, res: Response): void => {
  const fileUrl = (req.query.url as string) || '';
  const title = (req.query.title as string) || 'Document Preview';
  const rawType = ((req.query.type as string) || '').toLowerCase();

  const cleanUrl = fileUrl.split('?')[0];
  const ext = (path.extname(cleanUrl) || '').toLowerCase().replace('.', '') || rawType;

  let category = 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico', 'tiff'].includes(ext)) {
    category = 'image';
  } else if (['docx', 'doc', 'dotx', 'odt'].includes(ext)) {
    category = 'docx';
  } else if (['txt', 'text', 'md', 'csv', 'json', 'log', 'rtf'].includes(ext)) {
    category = 'text';
  } else {
    category = 'pdf';
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} • Smart Preview</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <!-- Mammoth.js for offline Word DOCX document parsing -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0f172a; color: #f8fafc; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    
    /* Top Toolbar */
    .toolbar { height: 60px; background-color: #1e293b; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; gap: 12px; z-index: 100; }
    .toolbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .toolbar-title { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 450px; }
    .badge { font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-image { background: #ec4899; color: #ffffff; }
    .badge-pdf { background: #10b981; color: #ffffff; }
    .badge-docx { background: #0284c7; color: #ffffff; }
    .badge-text { background: #f59e0b; color: #ffffff; }
    
    .toolbar-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 8px; font-size: 12px; font-weight: 700; text-decoration: none; cursor: pointer; border: none; transition: all 0.2s; color: #ffffff; }
    .btn-back { background: #334155; }
    .btn-back:hover { background: #475569; }
    .btn-primary { background: #15803d; }
    .btn-primary:hover { background: #16a34a; }
    .btn-sub { background: #0284c7; }
    .btn-sub:hover { background: #0369a1; }
    .btn-tool { background: #334155; padding: 6px 10px; font-size: 12px; border-radius: 6px; color: #ffffff; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; border: none; cursor: pointer; }
    .btn-tool:hover { background: #475569; }
    
    /* Main Preview Container */
    .viewport { flex: 1; position: relative; overflow: auto; display: flex; justify-content: center; align-items: center; background: #0b0f19; }
    
    /* Image Viewer */
    .image-wrapper { position: relative; display: flex; justify-content: center; align-items: center; width: 100%; height: 100%; overflow: auto; padding: 20px; }
    .image-element { max-width: 90%; max-height: 90%; object-fit: contain; transition: transform 0.2s ease; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .floating-controls { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); background: rgba(30, 41, 59, 0.9); backdrop-filter: blur(8px); padding: 8px 14px; border-radius: 30px; display: flex; gap: 8px; border: 1px solid #475569; z-index: 10; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }

    /* PDF Viewer */
    .pdf-frame { width: 100%; height: 100%; border: none; }

    /* Word DOCX Viewer */
    .docx-viewport { width: 100%; height: 100%; overflow-y: auto; padding: 32px 16px; background: #334155; display: flex; flex-direction: column; align-items: center; }
    .docx-paper { background: #ffffff; color: #1e293b; width: 100%; max-width: 860px; min-height: 800px; padding: 50px 40px; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,0.25); line-height: 1.7; font-size: 14px; }
    .docx-paper h1, .docx-paper h2, .docx-paper h3 { color: #0f172a; margin-top: 18px; margin-bottom: 8px; }
    .docx-paper p { margin-bottom: 12px; }
    .docx-paper table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
    .docx-paper th, .docx-paper td { border: 1px solid #cbd5e1; padding: 8px 12px; }
    .docx-paper th { background: #f8fafc; font-weight: 700; }
    .docx-paper img { max-width: 100%; height: auto; border-radius: 4px; margin: 10px 0; }
    .docx-external-bar { background: #1e293b; padding: 12px 20px; border-radius: 8px; margin-bottom: 20px; width: 100%; max-width: 860px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; border: 1px solid #475569; font-size: 12px; }

    /* Text Viewer */
    .text-viewport { width: 100%; height: 100%; overflow: auto; padding: 30px; background: #0f172a; }
    .text-box { max-width: 960px; margin: 0 auto; background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 24px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; line-height: 1.6; color: #e2e8f0; white-space: pre-wrap; word-break: break-word; user-select: text; }

    /* Loader */
    .spinner { border: 4px solid rgba(255, 255, 255, 0.1); width: 44px; height: 44px; border-radius: 50%; border-left-color: #10b981; animation: spin 1s linear infinite; margin-bottom: 14px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <!-- Top Toolbar -->
  <div class="toolbar">
    <div class="toolbar-left">
      <button onclick="window.history.length > 1 ? window.history.back() : window.close()" class="btn btn-back">
        ⬅ Back
      </button>
      <span class="badge badge-${category}">${category.toUpperCase()} • ${ext.toUpperCase()}</span>
      <span class="toolbar-title" title="${title}">${title}</span>
    </div>

    <div class="toolbar-actions">
      <a href="${fileUrl}" download class="btn btn-primary">
        📥 Download File
      </a>
      <a href="${fileUrl}" target="_blank" class="btn btn-sub">
        🔗 Raw URL
      </a>
    </div>
  </div>

  <!-- Viewport Content -->
  <div class="viewport">
    ${category === 'image' ? `
      <div class="image-wrapper" id="img-container">
        <img id="preview-image" src="${fileUrl}" alt="${title}" class="image-element" />
        <div class="floating-controls">
          <button class="btn btn-tool" onclick="zoomIn()">🔍 Zoom +</button>
          <button class="btn btn-tool" onclick="zoomOut()">🔍 Zoom -</button>
          <button class="btn btn-tool" onclick="resetZoom()">🎯 100%</button>
          <button class="btn btn-tool" onclick="rotateImage()">⟳ Rotate</button>
          <button class="btn btn-tool" onclick="toggleBackground()">🎨 Backdrop</button>
        </div>
      </div>
      <script>
        var currentScale = 1;
        var currentRotation = 0;
        var isLightBg = false;
        var img = document.getElementById('preview-image');
        var container = document.getElementById('img-container');

        function updateTransform() {
          img.style.transform = 'scale(' + currentScale + ') rotate(' + currentRotation + 'deg)';
        }
        function zoomIn() { currentScale = Math.min(currentScale + 0.25, 4); updateTransform(); }
        function zoomOut() { currentScale = Math.max(currentScale - 0.25, 0.25); updateTransform(); }
        function resetZoom() { currentScale = 1; currentRotation = 0; updateTransform(); }
        function rotateImage() { currentRotation = (currentRotation + 90) % 360; updateTransform(); }
        function toggleBackground() {
          isLightBg = !isLightBg;
          container.style.background = isLightBg ? '#ffffff' : '#0b0f19';
        }
      </script>
    ` : category === 'pdf' ? `
      <iframe src="${fileUrl}#toolbar=1" class="pdf-frame"></iframe>
    ` : category === 'docx' ? `
      <div class="docx-viewport">
        <div class="docx-external-bar">
          <span style="color: #94a3b8;">Formatted live with client-side document renderer</span>
          <div style="display: flex; gap: 8px;">
            <a href="https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(fileUrl)}" target="_blank" class="btn btn-tool">
              🌐 Office Online
            </a>
            <a href="https://docs.google.com/viewer?url=${encodeURIComponent(fileUrl)}&embedded=true" target="_blank" class="btn btn-tool">
              🌐 Google Docs Viewer
            </a>
          </div>
        </div>
        <div id="docx-loading" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px;">
          <div class="spinner"></div>
          <div style="color: #cbd5e1; font-size: 14px; font-weight: 600;">Parsing Word (.docx) document...</div>
        </div>
        <div id="docx-content" class="docx-paper" style="display: none;"></div>
      </div>
      <script>
        fetch('${fileUrl}')
          .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.arrayBuffer();
          })
          .then(function(buffer) {
            return mammoth.convertToHtml({ arrayBuffer: buffer });
          })
          .then(function(result) {
            document.getElementById('docx-loading').style.display = 'none';
            var paper = document.getElementById('docx-content');
            paper.innerHTML = result.value || '<p style="color: #94a3b8; font-style: italic;">(Empty or unreadable document body)</p>';
            paper.style.display = 'block';
          })
          .catch(function(err) {
            document.getElementById('docx-loading').innerHTML = '<div style="color: #f87171; text-align: center;"><b>Could not parse document in browser.</b><br><span style="font-size: 12px; color: #94a3b8;">' + err.message + '</span><br><br><a href="${fileUrl}" download class="btn btn-primary">Download Word File</a></div>';
          });
      </script>
    ` : `
      <div class="text-viewport">
        <div id="text-loading" style="text-align: center; padding: 60px;">
          <div class="spinner" style="margin: 0 auto 12px;"></div>
          <div style="color: #94a3b8;">Loading text file content...</div>
        </div>
        <div id="text-wrapper" style="display: none;">
          <div style="max-width: 960px; margin: 0 auto 12px; display: flex; justify-content: flex-end;">
            <button onclick="copyTextContent()" class="btn btn-tool">📋 Copy Text</button>
          </div>
          <pre id="text-content" class="text-box"></pre>
        </div>
      </div>
      <script>
        var rawText = '';
        fetch('${fileUrl}')
          .then(function(res) { return res.text(); })
          .then(function(t) {
            rawText = t;
            document.getElementById('text-loading').style.display = 'none';
            document.getElementById('text-wrapper').style.display = 'block';
            document.getElementById('text-content').textContent = t;
          })
          .catch(function(err) {
            document.getElementById('text-loading').innerHTML = '<div style="color: #f87171;">Failed to load text file: ' + err.message + '</div>';
          });

        function copyTextContent() {
          navigator.clipboard.writeText(rawText).then(function() {
            alert('Text copied to clipboard!');
          });
        }
      </script>
    `}
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
};

// 4. Render HTML Admin Dashboard Page for GET / and GET /admin
export const renderAdminDashboard = (_req: Request, res: Response): void => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MoiConnect Admin Control Center</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" href="/favicon.ico">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; min-height: 100vh; display: flex; flex-direction: column; }
    
    /* Header Banner */
    header { background-color: #064e3b; color: #ffffff; padding: 16px 24px; border-bottom: 2px solid #047857; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .header-container { max-width: 1200px; margin: 0 auto; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
    .brand-box { display: flex; align-items: center; gap: 12px; }
    .brand-logo { width: 44px; height: 44px; background-color: #047857; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 800; color: #ffffff; border: 1px solid #10b981; }
    .brand-title { font-size: 20px; font-weight: 800; color: #ffffff; display: flex; align-items: center; gap: 8px; }
    .brand-badge { background-color: #059669; color: #ecfdf5; font-size: 11px; padding: 2px 8px; border-radius: 12px; font-weight: 700; border: 1px solid #34d399; }
    .brand-sub { font-size: 12px; color: #a7f3d0; margin-top: 2px; }
    
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .status-pill { display: inline-flex; align-items: center; gap: 6px; background-color: #065f46; color: #a7f3d0; font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 8px; border: 1px solid #047857; }
    .status-dot { width: 8px; height: 8px; background-color: #34d399; border-radius: 50%; }
    .btn-refresh { background-color: #047857; color: #ffffff; font-size: 12px; font-weight: 700; padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .btn-refresh:hover { background-color: #059669; }

    /* Main Container */
    main { max-width: 1200px; width: 100%; margin: 0 auto; padding: 24px 16px; flex: 1; }

    /* Tabs Bar */
    .tab-bar { display: flex; flex-wrap: wrap; gap: 8px; background-color: #e2e8f0; padding: 6px; border-radius: 14px; margin-bottom: 24px; border: 1px solid #cbd5e1; }
    .tab-btn { padding: 10px 18px; border-radius: 10px; font-size: 14px; font-weight: 700; color: #475569; border: none; background: transparent; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 8px; }
    .tab-btn:hover { background-color: #cbd5e1; color: #0f172a; }
    .tab-btn.active { background-color: #15803d; color: #ffffff; box-shadow: 0 4px 12px rgba(21, 128, 61, 0.25); }
    .tab-badge { background-color: #f59e0b; color: #ffffff; font-size: 11px; padding: 2px 7px; border-radius: 10px; font-weight: 800; }

    /* SVG Icon Helpers */
    .svg-icon { display: inline-flex; align-items: center; justify-content: center; }

    /* Cards & Sections */
    .card { background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 24px; margin-bottom: 24px; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
    .card-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid #f1f5f9; }
    .card-title { font-size: 18px; font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 8px; }
    .card-sub { font-size: 12px; color: #64748b; margin-top: 2px; }

    /* Stats Grid */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background-color: #ffffff; padding: 20px; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
    .stat-label { font-size: 11px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; display: flex; items-center; justify-content: space-between; }
    .stat-val { font-size: 28px; font-weight: 800; color: #15803d; }
    .stat-sub { font-size: 11px; color: #94a3b8; margin-top: 4px; }

    /* Item Cards (Pending Materials) */
    .item-list { display: flex; flex-direction: column; gap: 12px; }
    .item-card { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; transition: all 0.2s; }
    .item-card:hover { border-color: #cbd5e1; background-color: #f1f5f9; }
    .badge-tag { display: inline-block; font-size: 10px; font-weight: 800; text-transform: uppercase; padding: 3px 8px; border-radius: 6px; background-color: #dcfce7; color: #166534; border: 1px solid #bbf7d0; margin-right: 6px; }
    .mtid-tag { font-family: monospace; font-size: 11px; font-weight: 700; background-color: #0f172a; color: #ffffff; padding: 2px 6px; border-radius: 4px; margin-right: 6px; }
    .item-title { font-size: 15px; font-weight: 800; color: #0f172a; margin: 4px 0; }
    .item-meta { font-size: 12px; color: #475569; }
    .item-sub { font-size: 11px; color: #94a3b8; margin-top: 2px; }

    /* Action Buttons */
    .btn-group { display: flex; align-items: center; gap: 8px; }
    .btn { padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 800; border: none; cursor: pointer; text-decoration: none; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    .btn-view { background-color: #ffffff; color: #334155; border: 1px solid #cbd5e1; }
    .btn-view:hover { background-color: #e2e8f0; }
    .btn-approve { background-color: #15803d; color: #ffffff; box-shadow: 0 2px 4px rgba(21, 128, 61, 0.2); }
    .btn-approve:hover { background-color: #166534; }
    .btn-reject { background-color: #dc2626; color: #ffffff; box-shadow: 0 2px 4px rgba(220, 38, 38, 0.2); }
    .btn-reject:hover { background-color: #b91c1c; }

    /* Search input with icon */
    .search-input-wrapper { position: relative; display: flex; align-items: center; }
    .search-input-icon { position: absolute; left: 10px; color: #94a3b8; pointer-events: none; }
    .search-input { padding-left: 32px !important; }

    /* Table */
    .table-responsive { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
    th { background-color: #f8fafc; color: #64748b; font-size: 11px; font-weight: 800; text-transform: uppercase; padding: 12px 16px; border-bottom: 2px solid #e2e8f0; }
    td { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; color: #334155; }
    tr:hover td { background-color: #f8fafc; }

    /* Toast Notification */
    #toast { margin-bottom: 16px; padding: 14px 18px; border-radius: 12px; font-size: 14px; font-weight: 700; display: none; }
    #toast.success { background-color: #dcfce7; color: #14532d; border: 1px solid #bbf7d0; display: block; }
    #toast.error { background-color: #fee2e2; color: #991b1b; border: 1px solid #fecaca; display: block; }

    /* Modal Backdrop & Modern Approval Dialog */
    .modal-backdrop { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(15, 23, 42, 0.7); backdrop-filter: blur(4px); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .modal-content { background-color: #ffffff; border-radius: 18px; width: 100%; max-width: 680px; max-height: 92vh; overflow-y: auto; padding: 24px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); border: 1px solid #e2e8f0; }
    
    /* Tiny List Row for Pending Approvals */
    .tiny-paper-row { background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 14px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; transition: all 0.15s ease-in-out; }
    .tiny-paper-row:hover { background-color: #f8fafc; border-color: #10b981; box-shadow: 0 2px 6px rgba(0,0,0,0.04); transform: translateY(-1px); }
    .size-pill { font-size: 11px; font-weight: 700; color: #475569; background-color: #f1f5f9; padding: 2px 8px; border-radius: 6px; border: 1px solid #e2e8f0; white-space: nowrap; }
    .btn-tiny { padding: 5px 12px; font-size: 11px; font-weight: 800; border-radius: 6px; border: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }

    /* Media Choice Radio Cards */
    .choice-radio-card { display: block; padding: 12px; background: #ffffff; border: 2px solid #e2e8f0; border-radius: 10px; cursor: pointer; transition: all 0.2s; user-select: none; }
    .choice-radio-card:hover { border-color: #cbd5e1; background: #f8fafc; }
    .choice-radio-card.active { border-color: #15803d; background: #f0fdf4; box-shadow: 0 2px 6px rgba(21, 128, 61, 0.1); }
    .choice-radio-card.active.upload-active { border-color: #d97706; background: #fffbeb; box-shadow: 0 2px 6px rgba(217, 119, 6, 0.1); }

    /* Utilities */
    .hidden { display: none !important; }
    .flex-1 { flex: 1; }
    .form-control { padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 13px; outline: none; }
    .form-control:focus { border-color: #15803d; }
    
    footer { background-color: #ffffff; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; font-size: 12px; color: #64748b; margin-top: auto; }
  </style>
</head>
<body>

  <!-- Header Banner -->
  <header>
    <div class="header-container">
      <div class="brand-box">
        <div class="brand-logo" style="background: transparent; border: none; padding: 0;">
          <img src="/favicon.png" alt="MC Logo" style="width: 44px; height: 44px; border-radius: 10px; object-fit: cover;" />
        </div>
        <div>
          <div class="brand-title">
            MoiConnect <span class="brand-badge">Admin Hub</span>
          </div>
          <div class="brand-sub">Official Control Panel for Revision Materials, Users & Hostels</div>
        </div>
      </div>
      <div class="header-actions">
        <div class="status-pill">
          <div class="status-dot"></div>
          Backend API Live (Port 5000)
        </div>
        <button onclick="loadDashboardData()" class="btn-refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          Refresh
        </button>
      </div>
    </div>
  </header>

  <!-- Main Content -->
  <main>

    <!-- Top Navigation Tabs -->
    <div class="tab-bar">
      <button id="tab-btn-pending" onclick="switchTab('pending')" class="tab-btn active">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
        Pending Approvals
        <span id="badge-pending-count" class="tab-badge hidden">0</span>
      </button>

      <button id="tab-btn-temp" onclick="switchTab('temp')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        Server Media (Temp)
        <span id="badge-temp-count" class="tab-badge hidden">0</span>
      </button>

      <button id="tab-btn-stats" onclick="switchTab('stats')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
        Stats & Registered Users
      </button>

      <button id="tab-btn-houses" onclick="switchTab('houses')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 10h6"/><path d="M9 14h6"/></svg>
        Rental Hostels
      </button>

      <button id="tab-btn-system" onclick="switchTab('system')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        System Health & API
      </button>

      <button id="tab-btn-push" onclick="switchTab('push')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        Notify (In-App & Push)
      </button>
    </div>

    <!-- Notification Toast -->
    <div id="toast"></div>

    <!-- TAB 1: PENDING APPROVALS -->
    <section id="tab-content-pending" class="tab-content">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              Revision Materials Approval Panel
            </h2>
            <p class="card-sub">Simple compact view. Click any material to inspect, download, edit, replace file, and approve directly to Cloudinary.</p>
          </div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <div class="search-input-wrapper">
              <svg class="search-input-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" id="paper-search-input" oninput="filterPapersList()" placeholder="Filter by title, code or school..." class="form-control search-input" style="width: 220px;" />
            </div>
            <select id="paper-filter" onchange="loadDashboardData()" class="form-control" style="font-weight: 700;">
              <option value="pending">Pending Only</option>
              <option value="approved">Approved Materials</option>
            </select>
          </div>
        </div>

        <div id="pending-papers-container" style="display: flex; flex-direction: column; gap: 8px;">
          <div style="text-align: center; padding: 48px; color: #94a3b8; font-size: 14px;">Loading revision materials...</div>
        </div>
      </div>
    </section>

    <!-- TAB: SERVER MEDIA (TEMP) -->
    <section id="tab-content-temp" class="tab-content hidden">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
              Server Media Temporary Storage
            </h2>
            <p class="card-sub">Files uploaded by students and stored in <code>backend/uploads/temp/</code> waiting for approval or rejection.</p>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="loadTempFiles()" class="btn btn-view">
              🔄 Refresh Storage
            </button>
            <button onclick="deleteSelectedTempFiles()" class="btn btn-reject">
              🗑️ Delete Selected
            </button>
          </div>
        </div>

        <!-- Temp KPI Cards -->
        <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom: 20px;">
          <div class="stat-card">
            <div class="stat-label">Pending Temp Files</div>
            <div id="temp-stat-count" class="stat-val">0</div>
            <div class="stat-sub">Stored locally in uploads/temp</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Disk Space</div>
            <div id="temp-stat-size" class="stat-val" style="color: #0284c7;">0 Bytes</div>
            <div class="stat-sub">Clean anytime to free up server space</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Server Folder Path</div>
            <div style="font-family: monospace; font-size: 13px; font-weight: 700; color: #15803d; margin-top: 6px;">backend/uploads/temp</div>
            <div class="stat-sub">Served at /uploads/temp/*</div>
          </div>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th style="width: 36px;"><input type="checkbox" id="temp-select-all" onchange="toggleSelectAllTemp(this)" /></th>
                <th>File Name</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th>Linked Material Status</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody id="temp-files-table-body">
              <tr><td colspan="6" style="text-align: center; padding: 32px; color: #94a3b8;">Loading temporary server files...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 2: STATS & REGISTERED USERS -->
    <section id="tab-content-stats" class="tab-content hidden">
      <!-- KPI Cards -->
      <div class="stats-grid">
        <div class="stat-card" style="border-left: 4px solid #166534;">
          <div class="stat-label">
            Online Users
            <span style="display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 800; color: #166534; background: #dcfce7; padding: 2px 7px; border-radius: 10px; border: 1px solid #bbf7d0;">
              <span style="width: 6px; height: 6px; background-color: #22c55e; border-radius: 50%; display: inline-block;"></span> LIVE
            </span>
          </div>
          <div id="stat-online-users" class="stat-val" style="color: #166534;">--</div>
          <div id="stat-online-sub" class="stat-sub">Active Socket Connections</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">
            Total Users
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div id="stat-users" class="stat-val">--</div>
          <div class="stat-sub">Registered Moi Students & Staff</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">
            Approved Papers
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </div>
          <div id="stat-approved-papers" class="stat-val" style="color: #2563eb;">--</div>
          <div class="stat-sub">Past Papers & Revision Notes</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">
            Pending Papers
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div id="stat-pending-papers" class="stat-val" style="color: #d97706;">--</div>
          <div class="stat-sub">Awaiting Admin Verification</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">
            Active Departments
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          </div>
          <div id="stat-departments" class="stat-val" style="color: #7c3aed;">--</div>
          <div class="stat-sub">Academic Faculties & Departments</div>
        </div>
      </div>

      <!-- Users Table -->
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
              Registered Platform Users
            </h2>
            <p class="card-sub">Students, Landlords, and Admin accounts</p>
          </div>
          <div class="search-input-wrapper">
            <svg class="search-input-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              type="text"
              id="user-search"
              oninput="filterUsers()"
              placeholder="Search user by name or email..."
              class="form-control search-input"
              style="width: 260px;"
            />
          </div>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
                <th>Landlord Status</th>
                <th>Presence</th>
                <th>Joined Date</th>
              </tr>
            </thead>
            <tbody id="users-table-body">
              <tr><td colspan="5" style="text-align: center; padding: 32px; color: #94a3b8;">Loading user database...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 3: RENTAL HOUSES -->
    <section id="tab-content-houses" class="tab-content hidden">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 10h6"/><path d="M9 14h6"/></svg>
              Student Rental Marketplace Listings
            </h2>
            <p class="card-sub">Houses, Single Rooms & Bedsitters around Moi University Main Campus</p>
          </div>
        </div>

        <div id="houses-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
          <div style="text-align: center; padding: 48px; color: #94a3b8; font-size: 14px;">Loading rental listings...</div>
        </div>
      </div>
    </section>

    <!-- TAB 4: SYSTEM HEALTH -->
    <section id="tab-content-system" class="tab-content hidden">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px;">
        <div class="card">
          <h3 style="font-size: 16px; font-weight: 800; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; color: #0f172a;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            Backend Service Status
          </h3>
          <div style="font-size: 13px;">
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
              <span style="color: #64748b;">Service Name</span>
              <span style="font-weight: 700;">MoiConnect Node.js API</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
              <span style="color: #64748b;">MongoDB Database</span>
              <span style="font-weight: 700; color: #15803d; background: #dcfce7; padding: 2px 8px; border-radius: 6px;">Connected</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
              <span style="color: #64748b;">Real-Time WebSockets</span>
              <span style="font-weight: 700; color: #4338ca; background: #e0e7ff; padding: 2px 8px; border-radius: 6px;">Socket.IO Ready</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 8px 0;">
              <span style="color: #64748b;">API Base URL</span>
              <span style="font-family: monospace; font-weight: 700; color: #15803d;">/api/v1</span>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 style="font-size: 16px; font-weight: 800; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; color: #0f172a;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Key REST API Endpoints
          </h3>
          <ul style="display: flex; flex-direction: column; gap: 8px; font-family: monospace; font-size: 12px; list-style: none;">
            <li style="background: #f8fafc; padding: 10px 14px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: space-between;">
              <span>GET /api/v1/papers</span>
              <span style="color: #15803d; font-weight: 700;">Public Papers</span>
            </li>
            <li style="background: #f8fafc; padding: 10px 14px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: space-between;">
              <span>POST /api/v1/papers</span>
              <span style="color: #15803d; font-weight: 700;">Submit Document</span>
            </li>
            <li style="background: #f8fafc; padding: 10px 14px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: space-between;">
              <span>GET /api/v1/houses</span>
              <span style="color: #15803d; font-weight: 700;">Rental Houses</span>
            </li>
            <li style="background: #f8fafc; padding: 10px 14px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: space-between;">
              <span>GET /api/v1/admin/stats</span>
              <span style="color: #d97706; font-weight: 700;">Admin Only</span>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- TAB 5: NOTIFY (IN-APP POPUPS & PUSH NOTIFICATIONS) -->
    <section id="tab-content-push" class="tab-content hidden">
      <!-- Sub-Tab Switcher -->
      <div style="display: flex; gap: 12px; margin-bottom: 20px; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px;">
        <button id="sub-btn-popups" type="button" onclick="switchNotifySubTab('popups')" class="btn" style="background: #15803d; color: #ffffff; font-weight: 800; border-radius: 10px; padding: 10px 18px; font-size: 13px;">
          💬 In-App Popups (Modal Overlay)
        </button>
        <button id="sub-btn-push" type="button" onclick="switchNotifySubTab('push')" class="btn" style="background: #f1f5f9; color: #475569; font-weight: 800; border-radius: 10px; padding: 10px 18px; font-size: 13px;">
          🔔 Android Push Notifications
        </button>
      </div>

      <!-- SUB-SECTION 1: IN-APP POPUPS -->
      <div id="notify-sub-popups">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 24px;">
          
          <!-- In-App Popup Form Card -->
          <div class="card">
            <div class="card-header">
              <div>
                <h2 class="card-title">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                  Broadcast In-App Popup
                </h2>
                <p class="card-sub">Create normal announcement popups or version update popups for mobile app users.</p>
              </div>
            </div>

            <!-- Toggle Popup Type (Normal vs Update) -->
            <div style="display: flex; background: #f1f5f9; padding: 4px; border-radius: 10px; margin-bottom: 16px;">
              <button type="button" id="pop-type-btn-normal" onclick="setPopupType('normal')" style="flex: 1; padding: 8px; font-weight: 800; border-radius: 8px; border: none; background: #ffffff; color: #15803d; cursor: pointer; font-size: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.1);">
                📢 Normal Popup
              </button>
              <button type="button" id="pop-type-btn-update" onclick="setPopupType('update')" style="flex: 1; padding: 8px; font-weight: 800; border-radius: 8px; border: none; background: transparent; color: #64748b; cursor: pointer; font-size: 12px;">
                🚀 App Update Popup
              </button>
            </div>

            <!-- Normal Popup Form -->
            <form id="popup-normal-form" onsubmit="handleCreateNormalPopup(event)" style="display: flex; flex-direction: column; gap: 14px;">
              <div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                  <label style="font-size: 12px; font-weight: 700; color: #334155;">Popup Title *</label>
                  <span style="font-size: 11px; color: #15803d; font-weight: 700;">Magic Tags:</span>
                </div>
                <div style="display: flex; gap: 6px; margin-bottom: 6px;">
                  <button type="button" onclick="insertPopVar('{name}', 'pop-normal-title')" style="background: #e0e7ff; color: #3730a3; border: 1px solid #c7d2fe; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {name}</button>
                  <button type="button" onclick="insertPopVar('{course}', 'pop-normal-title')" style="background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {course}</button>
                </div>
                <input type="text" id="pop-normal-title" class="form-control" placeholder="e.g. Welcome back, {name}! 🎉" required style="width: 100%; font-weight: 700;" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Subtitle</label>
                <input type="text" id="pop-normal-subtitle" class="form-control" placeholder="e.g. Check out the latest exam revision materials for {course}" style="width: 100%;" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Body / Detailed Message</label>
                <textarea id="pop-normal-body" class="form-control" rows="3" placeholder="Popup body message..." style="width: 100%; font-size: 13px;"></textarea>
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Banner Image URL (Optional)</label>
                <input type="url" id="pop-normal-image" class="form-control" placeholder="https://example.com/banner.png" style="width: 100%;" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Smart Destination Target (When Clicked)</label>
                <select id="pop-normal-target" class="form-control" style="width: 100%; font-weight: 700;">
                  <option value="/community">🌐 Community Chat (/community)</option>
                  <option value="/academics">📚 Notes PDF (/academics)</option>
                  <option value="/past-papers">📄 Past Papers (/past-papers)</option>
                  <option value="/cat-papers">📝 CAT Papers (/cat-papers)</option>
                  <option value="/rentals">🏠 Rental Hostels (/rentals)</option>
                  <option value="/contribute">📤 Contribute Materials (/contribute)</option>
                  <option value="/(auth)/login">🔐 Sign In (/login)</option>
                </select>
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Action Button Text</label>
                <input type="text" id="pop-normal-btn-text" class="form-control" placeholder="e.g. Open Community" style="width: 100%; font-weight: 700;" value="Explore Now" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Target Audience</label>
                <select id="pop-normal-audience" onchange="togglePopAudienceBox()" class="form-control" style="width: 100%; font-weight: 700;">
                  <option value="all">🌐 All Users & Guests</option>
                  <option value="unauthenticated">👤 Guests Only (Unauthenticated)</option>
                  <option value="emails">📧 Specific Email List</option>
                </select>
              </div>

              <div id="pop-audience-emails-box" class="hidden">
                <textarea id="pop-normal-emails" class="form-control" rows="2" placeholder="student1@moi.ac.ke, student2@gmail.com" style="width: 100%; font-family: monospace; font-size: 12px;"></textarea>
              </div>

              <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; color: #334155; cursor: pointer;">
                <input type="checkbox" id="pop-normal-cancel" checked /> Include Cancel / Dismiss Button
              </label>

              <button type="submit" id="btn-submit-pop-normal" class="btn btn-approve" style="padding: 12px; font-size: 14px; justify-content: center; width: 100%;">
                ✨ Broadcast Normal Popup
              </button>
            </form>

            <!-- Update Popup Form -->
            <form id="popup-update-form" onsubmit="handleCreateUpdatePopup(event)" class="hidden" style="display: flex; flex-direction: column; gap: 14px;">
              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Minimum Required Version *</label>
                <input type="text" id="pop-update-minver" class="form-control" placeholder="e.g. 1.0.7" required style="width: 100%; font-weight: 700;" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Update Title *</label>
                <input type="text" id="pop-update-title" class="form-control" placeholder="e.g. MoiConnect Version 1.0.7 is Ready!" required style="width: 100%; font-weight: 700;" value="New App Update Available" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Update Subtitle / Release Notes</label>
                <textarea id="pop-update-sub" class="form-control" rows="3" placeholder="e.g. Includes faster past paper downloads and new chat features." style="width: 100%; font-size: 13px;"></textarea>
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Google Play Store Link</label>
                <input type="url" id="pop-update-url" class="form-control" placeholder="https://play.google.com/store/apps/details?id=com.amanikbt1.moiconnect" style="width: 100%;" value="https://play.google.com/store/apps/details?id=com.amanikbt1.moiconnect" />
              </div>

              <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; color: #2563eb; cursor: pointer;">
                <input type="checkbox" id="pop-update-force" /> Mandatory Force Update (Non-dismissible)
              </label>

              <button type="submit" id="btn-submit-pop-update" class="btn" style="background: #2563eb; color: #ffffff; padding: 12px; font-size: 14px; font-weight: 800; border-radius: 8px; justify-content: center; width: 100%;">
                🚀 Broadcast Version Update Popup
              </button>
            </form>
          </div>

          <!-- Active Popups History Card -->
          <div class="card">
            <div class="card-header">
              <div>
                <h3 style="font-size: 16px; font-weight: 800; color: #0f172a;">Active In-App Popups History</h3>
                <p class="card-sub">Currently broadcasted popups</p>
              </div>
              <button onclick="loadPopupHistory()" class="btn btn-view" style="font-size: 11px;">Refresh Popups</button>
            </div>

            <div id="popups-history-container" style="display: flex; flex-direction: column; gap: 10px;">
              <div style="text-align: center; padding: 32px; color: #94a3b8; font-size: 13px;">Loading popups history...</div>
            </div>
          </div>

        </div>
      </div>

      <!-- SUB-SECTION 2: PUSH NOTIFICATIONS -->
      <div id="notify-sub-push" class="hidden">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 24px;">
          
          <!-- Push Notify Form -->
          <div class="card">
            <div class="card-header">
              <div>
                <h2 class="card-title">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                  Send Push Notification
                </h2>
                <p class="card-sub">Broadcast high-priority push notifications to android mobile devices & guest users.</p>
              </div>
            </div>

            <form id="push-form" onsubmit="handleSendPush(event)" style="display: flex; flex-direction: column; gap: 16px;">
              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px;">Notification Title *</label>
                <input type="text" id="push-title" class="form-control" placeholder="e.g. 📢 End of Semester Exam Timetable Released" required style="width: 100%; font-size: 14px; font-weight: 700;" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px;">Notification Subtitle / Category Header</label>
                <input type="text" id="push-subtitle" class="form-control" placeholder="e.g. Academic Announcement • School of Information Sciences" style="width: 100%;" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px;">Select Monochrome Icon (100% Android & Native Compatible)</label>
                <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                  <label style="display: flex; align-items: center; gap: 6px; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700;">
                    <input type="radio" name="push-icon" value="moiconnect" checked />
                    🟢 MoiConnect App
                  </label>
                  <label style="display: flex; align-items: center; gap: 6px; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700;">
                    <input type="radio" name="push-icon" value="bell" />
                    🔔 General (Bell)
                  </label>
                  <label style="display: flex; align-items: center; gap: 6px; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700;">
                    <input type="radio" name="push-icon" value="academic" />
                    🎓 Academic (Cap)
                  </label>
                  <label style="display: flex; align-items: center; gap: 6px; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700;">
                    <input type="radio" name="push-icon" value="house" />
                    🏠 Rentals (House)
                  </label>
                  <label style="display: flex; align-items: center; gap: 6px; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700;">
                    <input type="radio" name="push-icon" value="alert" />
                    ⚡ Urgent (Alert)
                  </label>
                </div>
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px;">Recipient Audience Target *</label>
                <div style="display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 8px;">
                  <label style="font-size: 13px; font-weight: 700; color: #0f172a; display: flex; align-items: center; gap: 6px; cursor: pointer;">
                    <input type="radio" name="push-target" value="all" checked onchange="toggleEmailBox()" />
                    🌐 All Users & Guest Devices (Broadcast)
                  </label>
                  <label style="font-size: 13px; font-weight: 700; color: #0f172a; display: flex; align-items: center; gap: 6px; cursor: pointer;">
                    <input type="radio" name="push-target" value="emails" onchange="toggleEmailBox()" />
                    ✉️ Specific Email List
                  </label>
                </div>

                <div id="email-recipients-box" class="hidden" style="margin-top: 6px;">
                  <textarea id="push-emails" class="form-control" rows="2" placeholder="e.g. student1@moi.ac.ke, student2@moi.ac.ke" style="width: 100%; font-family: monospace; font-size: 12px;"></textarea>
                  <span style="font-size: 11px; color: #64748b;">Enter comma-separated emails of recipient students.</span>
                </div>
              </div>

              <div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <label style="font-size: 12px; font-weight: 700; color: #334155;">Notification Body Content *</label>
                  <span style="font-size: 11px; font-weight: 700; color: #15803d;">Magic Template Tags:</span>
                </div>
                
                <!-- Magic variable tags helper -->
                <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px;">
                  <button type="button" onclick="insertMagicVar('{name}')" style="background: #e0e7ff; color: #3730a3; border: 1px solid #c7d2fe; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {name}</button>
                  <button type="button" onclick="insertMagicVar('{course}')" style="background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {course}</button>
                  <button type="button" onclick="insertMagicVar('{admissionNumber}')" style="background: #fef3c7; color: #92400e; border: 1px solid #fde68a; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {admissionNumber}</button>
                  <button type="button" onclick="insertMagicVar('{email}')" style="background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {email}</button>
                </div>

                <textarea id="push-body" class="form-control" rows="4" placeholder="Dear {name}, your official timetable for {course} is now live. Tap to open!" required style="width: 100%; font-size: 13px;"></textarea>
              </div>

              <button type="submit" id="btn-submit-push" class="btn btn-approve" style="padding: 12px 20px; font-size: 14px; width: 100%; justify-content: center;">
                🚀 Dispatch Android Push Notification
              </button>
            </form>
          </div>

          <!-- Push History -->
          <div class="card">
            <div class="card-header">
              <div>
                <h3 style="font-size: 16px; font-weight: 800; color: #0f172a;">Broadcast History</h3>
                <p class="card-sub">Recently dispatched push notifications</p>
              </div>
              <button onclick="loadPushHistory()" class="btn btn-view" style="font-size: 11px;">Refresh History</button>
            </div>

            <div id="push-history-container" style="display: flex; flex-direction: column; gap: 10px;">
              <div style="text-align: center; padding: 32px; color: #94a3b8; font-size: 13px;">Loading broadcast history...</div>
            </div>
          </div>

        </div>
      </div>
    </section>

    <!-- MATERIAL REVIEW, EDIT & APPROVAL MODAL -->
    <div id="material-modal" class="modal-backdrop hidden" onclick="if(event.target === this) closeMaterialModal()">
      <div class="modal-content">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 1px solid #e2e8f0; padding-bottom: 14px;">
          <div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span id="modal-type-badge" class="badge-tag">PAST_PAPER</span>
              <span id="modal-mtid-badge" class="mtid-tag hidden">MTID</span>
              <span id="modal-status-badge" style="font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 6px; text-transform: uppercase;">STATUS</span>
            </div>
            <h3 id="modal-title-display" style="font-size: 18px; font-weight: 800; color: #0f172a; margin-top: 6px;">Title</h3>
            <p id="modal-submitter-display" style="font-size: 12px; color: #64748b; margin-top: 2px;">Submitted by</p>
          </div>
          <button onclick="closeMaterialModal()" style="background: none; border: none; font-size: 26px; color: #64748b; cursor: pointer; line-height: 1;">&times;</button>
        </div>

        <!-- 1. Media Operations Box -->
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 16px; margin-bottom: 20px;">
          <div style="font-size: 13px; font-weight: 800; color: #0f172a; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <span style="display: flex; align-items: center; gap: 6px;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              Document Media Management
            </span>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span id="modal-format-badge" style="font-size: 11px; font-weight: 800; background: #e2e8f0; color: #1e293b; padding: 2px 8px; border-radius: 6px;">PDF</span>
              <span id="modal-media-storage-tag" style="font-size: 11px; font-weight: 700; background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 6px;">Server Temp</span>
            </div>
          </div>

          <!-- Action buttons: Download, Smart Tab Preview & Copy Public Temp Link -->
          <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
            <a id="modal-download-btn" href="#" download class="btn" style="background: #0284c7; color: #ffffff;">
              📥 Download Media File
            </a>
            <a id="modal-preview-btn" href="#" target="_blank" class="btn btn-view" style="font-weight: 800; color: #0f172a;">
              👁️ Open & Preview in Tab
            </a>
            <button type="button" id="modal-copy-url-btn" onclick="copyModalFileUrl()" class="btn btn-view" style="font-size: 11px;">
              📋 Copy Public Temp URL
            </button>
          </div>

          <!-- Inline Smart Live Preview Card -->
          <div id="modal-inline-preview-card" style="margin-bottom: 14px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; display: none;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <span style="font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase;" id="modal-inline-preview-label">Live Preview</span>
              <a id="modal-inline-open-link" href="#" target="_blank" style="font-size: 11px; color: #0284c7; text-decoration: none; font-weight: 700;">Open Full View ↗</a>
            </div>
            <div id="modal-inline-preview-body" style="display: flex; justify-content: center; align-items: center; min-height: 80px;">
              <!-- Dynamically populated -->
            </div>
          </div>

          <!-- Approval Document Media Choice (Radio Buttons) -->
          <div style="border-top: 1px dashed #cbd5e1; padding-top: 14px; margin-top: 12px;">
            <div style="font-size: 12px; font-weight: 800; color: #1e293b; margin-bottom: 8px;">
              Approval Document Media Choice:
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
              <!-- Option 1: Use Current Document -->
              <label id="choice-card-current" class="choice-radio-card active" onclick="setMediaChoice('current')">
                <div style="display: flex; align-items: flex-start; gap: 8px;">
                  <input type="radio" name="modal-media-choice" id="radio-choice-current" value="current" checked onchange="setMediaChoice('current')" style="margin-top: 3px; accent-color: #15803d; cursor: pointer;" />
                  <div>
                    <div style="font-weight: 800; font-size: 12px; color: #0f172a;">📄 Use Current Document</div>
                    <div style="font-size: 11px; color: #64748b; margin-top: 2px;">File is already clean & ready for approval.</div>
                  </div>
                </div>
              </label>

              <!-- Option 2: Upload Clean Document -->
              <label id="choice-card-upload" class="choice-radio-card" onclick="setMediaChoice('upload')">
                <div style="display: flex; align-items: flex-start; gap: 8px;">
                  <input type="radio" name="modal-media-choice" id="radio-choice-upload" value="upload" onchange="setMediaChoice('upload')" style="margin-top: 3px; accent-color: #d97706; cursor: pointer;" />
                  <div>
                    <div style="font-weight: 800; font-size: 12px; color: #0f172a;">📤 Upload Clean Document</div>
                    <div style="font-size: 11px; color: #64748b; margin-top: 2px;">Replace with edited / cleaned copy.</div>
                  </div>
                </div>
              </label>
            </div>

            <!-- Status Box for Option 1 -->
            <div id="media-status-current-box" style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px 12px; display: flex; align-items: center; gap: 8px; font-size: 12px; color: #166534; font-weight: 600;">
              <span>✅</span>
              <span>Using current file. It will be uploaded to Cloudinary (folder: <code>MoiConnect/pdf</code>) upon approval.</span>
            </div>

            <!-- Box for Option 2 (Upload Clean) -->
            <div id="media-status-upload-box" class="hidden" style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px; font-size: 12px;">
              <div style="font-weight: 700; color: #92400e; margin-bottom: 6px;">
                Select clean replacement file (PDF, Word DOCX/DOC, Images, or Text):
              </div>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
                <input type="file" id="modal-replace-input" accept=".pdf,.doc,.docx,.txt,.rtf,.md,image/*" onchange="onModalFileSelected()" style="font-size: 12px; flex: 1; min-width: 200px;" />
                <button type="button" id="btn-modal-replace" onclick="handleModalFileReplace()" class="btn" style="background: #d97706; color: #ffffff;">
                  Upload Clean Copy Now
                </button>
              </div>
              <div id="selected-clean-file-info" style="margin-top: 8px; font-size: 11px; color: #92400e; font-weight: 700; display: none;"></div>
            </div>
          </div>
        </div>

        <!-- 2. Metadata Editing Form -->
        <form id="modal-edit-form" onsubmit="handleSavePaperEdits(event)" style="display: flex; flex-direction: column; gap: 14px; margin-bottom: 20px;">
          <div style="font-size: 13px; font-weight: 800; color: #0f172a;">✏️ Edit Metadata:</div>

          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Unit Title *</label>
            <input type="text" id="modal-input-title" class="form-control" style="width: 100%; font-weight: 700;" required />
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Course Code *</label>
              <input type="text" id="modal-input-code" class="form-control" style="width: 100%; font-weight: 700; text-transform: uppercase;" required />
            </div>
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Exam Year</label>
              <input type="number" id="modal-input-year" class="form-control" style="width: 100%;" />
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Material Type</label>
              <select id="modal-input-type" class="form-control" style="width: 100%; font-weight: 700;">
                <option value="past_paper">Past Paper</option>
                <option value="cat">CAT Paper</option>
                <option value="lecture_notes">Lecture Notes</option>
                <option value="notes">Study Notes</option>
                <option value="solution">Solutions</option>
                <option value="revision">Revision Material</option>
              </select>
            </div>
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">School / Faculty</label>
              <input type="text" id="modal-input-school" class="form-control" style="width: 100%;" />
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end;">
            <button type="submit" id="btn-save-paper-edits" class="btn" style="background: #334155; color: #ffffff;">
              💾 Save Metadata Edits
            </button>
          </div>
        </form>

        <!-- 3. Final Decision Approval / Rejection Row -->
        <div style="border-top: 2px solid #f1f5f9; padding-top: 16px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px;">
          <button type="button" id="modal-btn-reject" onclick="rejectCurrentPaperFromModal()" class="btn btn-reject" style="padding: 10px 18px;">
            ❌ Reject & Delete Temp File
          </button>
          <button type="button" id="modal-btn-approve" onclick="approveCurrentPaperFromModal()" class="btn btn-approve" style="padding: 10px 22px;">
            ✨ Approve & Upload to Cloudinary
          </button>
        </div>
      </div>
    </div>

  </main>

  <footer>
    MoiConnect Student Hub • Admin Panel v1.0.0 • Moi University
  </footer>

  <!-- Dashboard JavaScript Logic -->
  <script>
    let globalData = null;

    const SVG_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    const SVG_CROSS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const SVG_FILE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';

    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));

      document.getElementById('tab-btn-' + tabId).classList.add('active');
      document.getElementById('tab-content-' + tabId).classList.remove('hidden');

      if (tabId === 'push') {
        loadPopupHistory();
        loadPushHistory();
      }
    }

    function switchNotifySubTab(sub) {
      const popupsDiv = document.getElementById('notify-sub-popups');
      const pushDiv = document.getElementById('notify-sub-push');
      const popBtn = document.getElementById('sub-btn-popups');
      const pushBtn = document.getElementById('sub-btn-push');

      if (sub === 'popups') {
        popupsDiv.classList.remove('hidden');
        pushDiv.classList.add('hidden');
        popBtn.style.background = '#15803d';
        popBtn.style.color = '#ffffff';
        pushBtn.style.background = '#f1f5f9';
        pushBtn.style.color = '#475569';
        loadPopupHistory();
      } else {
        popupsDiv.classList.add('hidden');
        pushDiv.classList.remove('hidden');
        pushBtn.style.background = '#15803d';
        pushBtn.style.color = '#ffffff';
        popBtn.style.background = '#f1f5f9';
        popBtn.style.color = '#475569';
        loadPushHistory();
      }
    }

    function setPopupType(type) {
      const normalForm = document.getElementById('popup-normal-form');
      const updateForm = document.getElementById('popup-update-form');
      const btnNormal = document.getElementById('pop-type-btn-normal');
      const btnUpdate = document.getElementById('pop-type-btn-update');

      if (type === 'normal') {
        normalForm.classList.remove('hidden');
        updateForm.classList.add('hidden');
        btnNormal.style.background = '#ffffff';
        btnNormal.style.color = '#15803d';
        btnUpdate.style.background = 'transparent';
        btnUpdate.style.color = '#64748b';
      } else {
        normalForm.classList.add('hidden');
        updateForm.classList.remove('hidden');
        btnUpdate.style.background = '#ffffff';
        btnUpdate.style.color = '#2563eb';
        btnNormal.style.background = 'transparent';
        btnNormal.style.color = '#64748b';
      }
    }

    function togglePopAudienceBox() {
      const val = document.getElementById('pop-normal-audience').value;
      const box = document.getElementById('pop-audience-emails-box');
      if (val === 'emails') {
        box.classList.remove('hidden');
      } else {
        box.classList.add('hidden');
      }
    }

    function insertPopVar(variable, elementId) {
      const input = document.getElementById(elementId);
      if (input) {
        input.value += ' ' + variable;
        input.focus();
      }
    }

    async function handleCreateNormalPopup(e) {
      e.preventDefault();
      const title = document.getElementById('pop-normal-title').value;
      const subtitle = document.getElementById('pop-normal-subtitle').value;
      const body = document.getElementById('pop-normal-body').value;
      const imageUrl = document.getElementById('pop-normal-image').value;
      const actionTarget = document.getElementById('pop-normal-target').value;
      const actionButtonText = document.getElementById('pop-normal-btn-text').value;
      const targetAudience = document.getElementById('pop-normal-audience').value;
      const targetEmails = document.getElementById('pop-normal-emails')?.value || '';
      const hasCancelButton = document.getElementById('pop-normal-cancel').checked;

      const btn = document.getElementById('btn-submit-pop-normal');
      btn.disabled = true;
      btn.innerText = '⏳ Broadcasting...';

      try {
        const res = await fetch('/api/v1/notify/popups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'normal',
            title,
            subtitle,
            body,
            imageUrl,
            actionTarget,
            actionButtonText,
            targetAudience,
            targetEmails,
            hasCancelButton
          })
        });

        const json = await res.json();
        if (json.success) {
          showToast('✨ Normal Popup Created: ' + (json.data?.popupId || ''));
          document.getElementById('popup-normal-form').reset();
          loadPopupHistory();
        } else {
          showToast(json.error || 'Failed to create popup.', true);
        }
      } catch (err) {
        showToast('Error creating popup: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = '✨ Broadcast Normal Popup';
      }
    }

    async function handleCreateUpdatePopup(e) {
      e.preventDefault();
      const minAppVersion = document.getElementById('pop-update-minver').value;
      const title = document.getElementById('pop-update-title').value;
      const subtitle = document.getElementById('pop-update-sub').value;
      const playStoreUrl = document.getElementById('pop-update-url').value;
      const isForceUpdate = document.getElementById('pop-update-force').checked;

      const btn = document.getElementById('btn-submit-pop-update');
      btn.disabled = true;
      btn.innerText = '⏳ Broadcasting...';

      try {
        const res = await fetch('/api/v1/notify/popups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'update',
            minAppVersion,
            title,
            subtitle,
            playStoreUrl,
            isForceUpdate
          })
        });

        const json = await res.json();
        if (json.success) {
          showToast('🚀 Version Update Popup Broadcasted!');
          document.getElementById('popup-update-form').reset();
          loadPopupHistory();
        } else {
          showToast(json.error || 'Failed to broadcast update popup.', true);
        }
      } catch (err) {
        showToast('Error broadcasting update: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = '🚀 Broadcast Version Update Popup';
      }
    }

    async function loadPopupHistory() {
      const container = document.getElementById('popups-history-container');
      if (!container) return;

      try {
        const res = await fetch('/api/v1/notify/popups');
        const json = await res.json();
        if (!json.success || !json.data) return;

        if (json.data.length === 0) {
          container.innerHTML = '<div style="text-align: center; padding: 24px; color: #94a3b8; font-size: 13px;">No active popups created yet.</div>';
          return;
        }

        container.innerHTML = json.data.map(function(item) {
          return '<div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; font-size: 12px;">' +
            '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">' +
              '<span style="font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 6px;">' +
                '<span style="background: #15803d; color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px;">' + item.popupId + '</span>' +
                item.title +
              '</span>' +
              '<button data-id="' + item._id + '" onclick="handleDeletePopup(this.dataset.id)" class="btn" style="background: #fee2e2; color: #dc2626; padding: 3px 8px; font-size: 10px; font-weight: 800; border: 1px solid #fca5a5; border-radius: 6px;">' +
                '🗑️ Delete' +
              '</button>' +
            '</div>' +
            (item.subtitle ? '<div style="font-size: 11px; font-weight: 700; color: #15803d; margin-bottom: 4px;">' + item.subtitle + '</div>' : '') +
            '<div style="display: flex; gap: 8px; font-size: 11px; color: #64748b; margin-top: 6px;">' +
              '<span>Type: <strong style="color: #0f172a;">' + item.type + '</strong></span>' +
              (item.actionTarget ? '<span>Target: <strong style="color: #15803d;">' + item.actionTarget + '</strong></span>' : '') +
              (item.minAppVersion ? '<span>Min Ver: <strong style="color: #2563eb;">' + item.minAppVersion + '</strong></span>' : '') +
            '</div>' +
          '</div>';
        }).join('');
      } catch (err) {
        container.innerHTML = '<div style="text-align: center; padding: 24px; color: #ef4444; font-size: 13px;">Error loading popups history.</div>';
      }
    }

    async function handleDeletePopup(id) {
      if (!confirm('Are you sure you want to delete this popup? It will no longer show up to users.')) return;
      try {
        const res = await fetch('/api/v1/notify/popups/' + id, { method: 'DELETE' });
        const json = await res.json();
        if (json.success) {
          showToast('Popup removed successfully.');
          loadPopupHistory();
        } else {
          showToast(json.error || 'Failed to remove popup', true);
        }
      } catch (err) {
        showToast('Error deleting popup: ' + err.message, true);
      }
    }

    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.innerText = message;
      toast.className = isError ? 'error' : 'success';
      setTimeout(() => { toast.className = ''; }, 4000);
    }

    async function loadDashboardData() {
      try {
        const res = await fetch('/api/v1/dashboard/overview');
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Fetch failed');

        globalData = json;
        renderStats(json.stats);
        renderPendingPapers(json.pendingPapers);
        renderUsers(json.users);
        renderHouses(json.houses);
      } catch (err) {
        showToast('Error loading dashboard: ' + err.message, true);
      }
    }

    function formatBytes(bytes) {
      if (!bytes || bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function renderStats(stats) {
      const onlineElem = document.getElementById('stat-online-users');
      if (onlineElem) onlineElem.innerText = stats.totalOnline || 0;

      const subElem = document.getElementById('stat-online-sub');
      if (subElem) {
        const authCount = stats.authenticatedOnline || 0;
        const guestCount = stats.guestOnline || 0;
        subElem.innerText = authCount + ' Logged In • ' + guestCount + (guestCount === 1 ? ' Guest' : ' Guests') + ' (Unknown)';
      }

      document.getElementById('stat-users').innerText = stats.totalUsers || 0;
      document.getElementById('stat-approved-papers').innerText = stats.approvedPapers || 0;
      document.getElementById('stat-pending-papers').innerText = stats.pendingPapers || 0;
      document.getElementById('stat-departments').innerText = stats.totalDepartments || 0;

      const pendingBadge = document.getElementById('badge-pending-count');
      if (stats.pendingPapers > 0) {
        pendingBadge.innerText = stats.pendingPapers;
        pendingBadge.classList.remove('hidden');
      } else {
        pendingBadge.classList.add('hidden');
      }

      // Temp files badge & stats
      const tempBadge = document.getElementById('badge-temp-count');
      if (stats.totalTempFiles > 0) {
        tempBadge.innerText = stats.totalTempFiles;
        tempBadge.classList.remove('hidden');
      } else {
        tempBadge.classList.add('hidden');
      }

      const tempCountElem = document.getElementById('temp-stat-count');
      if (tempCountElem) tempCountElem.innerText = stats.totalTempFiles || 0;
      const tempSizeElem = document.getElementById('temp-stat-size');
      if (tempSizeElem) tempSizeElem.innerText = stats.totalTempSizeFormatted || '0 Bytes';
    }

    function renderPendingPapers(papers) {
      const container = document.getElementById('pending-papers-container');
      const filter = document.getElementById('paper-filter')?.value || 'pending';

      const filtered = filter === 'approved' && globalData?.approvedPapers
        ? globalData.approvedPapers
        : papers;

      if (!filtered || filtered.length === 0) {
        container.innerHTML = \`
          <div style="text-align: center; padding: 48px; background: #f8fafc; border-radius: 12px; border: 2px dashed #cbd5e1;">
            <p style="color: #475569; font-weight: 700; font-size: 14px;">No \${filter} revision materials right now.</p>
            <p style="font-size: 12px; color: #94a3b8; margin-top: 4px;">All student submissions are processed.</p>
          </div>
        \`;
        return;
      }

      container.innerHTML = filtered.map(paper => {
        const isApproved = paper.status === 'approved';
        return \`
        <div class="tiny-paper-row" onclick="openPaperModal('\${paper._id}')">
          <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
            <span class="badge-tag" style="font-size: 10px; padding: 2px 6px;">\${paper.type?.toUpperCase() || 'DOCUMENT'}</span>
            \${paper.mtid 
              ? \`<span class="mtid-tag" style="font-size: 10px; padding: 2px 6px;">\${paper.mtid}</span>\` 
              : '<span style="font-size: 10px; background: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px; font-weight: 800;">PENDING</span>'}
            <span style="font-weight: 800; color: #0f172a; font-size: 13px; font-family: monospace;">\${paper.unitCode || 'UNIT'}</span>
            <span style="color: #cbd5e1;">•</span>
            <span style="font-weight: 700; color: #1e293b; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              \${paper.title}
            </span>
          </div>

          <div style="display: flex; align-items: center; gap: 10px; font-size: 11px; color: #64748b;">
            <span style="color: #64748b;">\${paper.school ? paper.school.split('School of ')[1] || paper.school : ''}</span>
            <span class="size-pill">\${formatBytes(paper.fileSize || 0)}</span>
            <span style="color: #94a3b8;">\${paper.submittedBy?.name || 'Student'}</span>
            <button class="btn btn-tiny" onclick="event.stopPropagation(); openPaperModal('\${paper._id}')" style="background: \${isApproved ? '#0284c7' : '#15803d'}; color: #ffffff;">
              \${isApproved ? 'Inspect & Edit' : 'Review & Action ⚡'}
            </button>
          </div>
        </div>
      \`;
      }).join('');
    }

    function filterPapersList() {
      const q = (document.getElementById('paper-search-input')?.value || '').toLowerCase().trim();
      const filter = document.getElementById('paper-filter')?.value || 'pending';
      const sourceList = filter === 'approved' ? (globalData?.approvedPapers || []) : (globalData?.pendingPapers || []);

      if (!q) {
        renderPendingPapers(sourceList);
        return;
      }

      const filtered = sourceList.filter(p => 
        (p.title && p.title.toLowerCase().includes(q)) ||
        (p.unitCode && p.unitCode.toLowerCase().includes(q)) ||
        (p.courseCode && p.courseCode.toLowerCase().includes(q)) ||
        (p.school && p.school.toLowerCase().includes(q)) ||
        (p.unitName && p.unitName.toLowerCase().includes(q))
      );
      renderPendingPapers(filtered);
    }

    function openPaperModal(id) {
      const allPapers = [...(globalData?.pendingPapers || []), ...(globalData?.approvedPapers || [])];
      const paper = allPapers.find(p => p._id === id);
      if (!paper) {
        showToast('Document not found in list.', true);
        return;
      }

      currentModalPaper = paper;

      // Header fields
      document.getElementById('modal-title-display').innerText = paper.title || 'Untitled Document';
      document.getElementById('modal-type-badge').innerText = (paper.type || 'DOCUMENT').toUpperCase();

      const mtidBadge = document.getElementById('modal-mtid-badge');
      if (paper.mtid) {
        mtidBadge.innerText = paper.mtid;
        mtidBadge.classList.remove('hidden');
      } else {
        mtidBadge.classList.add('hidden');
      }

      const statusBadge = document.getElementById('modal-status-badge');
      statusBadge.innerText = (paper.status || 'PENDING').toUpperCase();
      if (paper.status === 'approved') {
        statusBadge.style.background = '#dcfce7';
        statusBadge.style.color = '#15803d';
      } else if (paper.status === 'rejected') {
        statusBadge.style.background = '#fee2e2';
        statusBadge.style.color = '#dc2626';
      } else {
        statusBadge.style.background = '#fef3c7';
        statusBadge.style.color = '#b45309';
      }

      document.getElementById('modal-submitter-display').innerText = 
        'Submitted by ' + (paper.submittedBy?.name || 'Student') + 
        (paper.submittedBy?.email ? ' (' + paper.submittedBy.email + ')' : '') + 
        ' on ' + new Date(paper.createdAt).toLocaleString();

      // Media details & links
      // Media details & links
      const isTemp = paper.tempFilename || (paper.fileUrl && paper.fileUrl.indexOf('/uploads/temp/') !== -1);
      const storageTag = document.getElementById('modal-media-storage-tag');
      if (isTemp) {
        storageTag.innerText = '📁 Server Temp (/mydomain_admin/temp_files/)';
        storageTag.style.background = '#fef3c7';
        storageTag.style.color = '#b45309';
      } else {
        storageTag.innerText = '☁️ Cloudinary CDN (MoiConnect/pdf)';
        storageTag.style.background = '#dcfce7';
        storageTag.style.color = '#15803d';
      }

      // Smart format detection
      const fmt = detectFormat(paper.fileUrl, paper.fileType);
      const formatBadge = document.getElementById('modal-format-badge');
      if (formatBadge) {
        formatBadge.innerText = fmt.icon + ' ' + fmt.label;
        if (fmt.category === 'image') {
          formatBadge.style.background = '#fdf2f8';
          formatBadge.style.color = '#9d174d';
        } else if (fmt.category === 'docx') {
          formatBadge.style.background = '#e0f2fe';
          formatBadge.style.color = '#0369a1';
        } else if (fmt.category === 'text') {
          formatBadge.style.background = '#fef3c7';
          formatBadge.style.color = '#92400e';
        } else {
          formatBadge.style.background = '#dcfce7';
          formatBadge.style.color = '#15803d';
        }
      }

      const downloadBtn = document.getElementById('modal-download-btn');
      downloadBtn.href = paper.fileUrl;
      const cleanDownloadName = (paper.unitCode || 'Paper') + '_' + (paper.title || 'file').replace(/[^a-zA-Z0-9_-]/g, '_') + '.' + (paper.fileType || 'pdf');
      downloadBtn.setAttribute('download', cleanDownloadName);

      // Smart preview URL in web tab
      const previewBtn = document.getElementById('modal-preview-btn');
      const smartPreviewUrl = '/admin/preview?url=' + encodeURIComponent(paper.fileUrl) + 
        '&title=' + encodeURIComponent(paper.title || 'Paper') + 
        '&type=' + encodeURIComponent(paper.fileType || fmt.category) + 
        '&id=' + encodeURIComponent(paper._id);
      previewBtn.href = smartPreviewUrl;

      // Inline Smart Preview Card
      const previewCard = document.getElementById('modal-inline-preview-card');
      const previewBody = document.getElementById('modal-inline-preview-body');
      const openLink = document.getElementById('modal-inline-open-link');
      if (openLink) openLink.href = smartPreviewUrl;

      if (previewCard && previewBody) {
        previewCard.style.display = 'block';
        if (fmt.category === 'image') {
          previewBody.innerHTML = '<div style="text-align: center; width: 100%;">' +
            '<a href="' + smartPreviewUrl + '" target="_blank" title="Click to view full image in tab">' +
              '<img src="' + paper.fileUrl + '" alt="Preview" style="max-height: 220px; max-width: 100%; border-radius: 6px; object-fit: contain; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border: 1px solid #e2e8f0;" />' +
            '</a>' +
            '<div style="font-size: 11px; color: #64748b; margin-top: 6px;">🔍 Click image or \\'Preview in Tab\\' to zoom & rotate</div>' +
          '</div>';
        } else if (fmt.category === 'pdf') {
          previewBody.innerHTML = '<div style="display: flex; align-items: center; justify-content: space-between; width: 100%; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">' +
            '<div style="display: flex; align-items: center; gap: 10px;">' +
              '<span style="font-size: 28px;">📄</span>' +
              '<div>' +
                '<div style="font-weight: 800; font-size: 13px; color: #0f172a;">PDF Academic Document</div>' +
                '<div style="font-size: 11px; color: #64748b;">' + formatBytes(paper.fileSize || 0) + ' • Ready for viewing</div>' +
              '</div>' +
            '</div>' +
            '<a href="' + smartPreviewUrl + '" target="_blank" class="btn btn-view" style="font-size: 11px;">' +
              '👁️ Launch PDF Viewer' +
            '</a>' +
          '</div>';
        } else if (fmt.category === 'docx') {
          previewBody.innerHTML = '<div style="display: flex; align-items: center; justify-content: space-between; width: 100%; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 12px;">' +
            '<div style="display: flex; align-items: center; gap: 10px;">' +
              '<span style="font-size: 28px;">📝</span>' +
              '<div>' +
                '<div style="font-weight: 800; font-size: 13px; color: #0369a1;">Microsoft Word Document (.docx)</div>' +
                '<div style="font-size: 11px; color: #64748b;">' + formatBytes(paper.fileSize || 0) + ' • Viewable in Smart Viewer</div>' +
              '</div>' +
            '</div>' +
            '<a href="' + smartPreviewUrl + '" target="_blank" class="btn btn-view" style="font-size: 11px;">' +
              '👁️ Launch Word Viewer' +
            '</a>' +
          '</div>';
        } else {
          previewBody.innerHTML = '<div style="display: flex; align-items: center; justify-content: space-between; width: 100%; background: #fefce8; border: 1px solid #fef08a; border-radius: 8px; padding: 12px;">' +
            '<div style="display: flex; align-items: center; gap: 10px;">' +
              '<span style="font-size: 28px;">📑</span>' +
              '<div>' +
                '<div style="font-weight: 800; font-size: 13px; color: #854d0e;">Plain Text / Notes File</div>' +
                '<div style="font-size: 11px; color: #64748b;">' + formatBytes(paper.fileSize || 0) + ' • Monospace text</div>' +
              '</div>' +
            '</div>' +
            '<a href="' + smartPreviewUrl + '" target="_blank" class="btn btn-view" style="font-size: 11px;">' +
              '👁️ Launch Text Reader' +
            '</a>' +
          '</div>';
        }
      }

      // Reset media choice to 'current'
      setMediaChoice('current');

      // Form fields
      document.getElementById('modal-input-title').value = paper.title || '';
      document.getElementById('modal-input-code').value = paper.unitCode || paper.courseCode || '';
      document.getElementById('modal-input-year').value = paper.examYear || 2025;
      document.getElementById('modal-input-type').value = paper.type || 'past_paper';
      document.getElementById('modal-input-school').value = paper.school || '';

      // Reset file input
      const replaceInput = document.getElementById('modal-replace-input');
      if (replaceInput) replaceInput.value = '';
      const cleanInfo = document.getElementById('selected-clean-file-info');
      if (cleanInfo) cleanInfo.style.display = 'none';

      // Action buttons state
      const approveBtn = document.getElementById('modal-btn-approve');
      const rejectBtn = document.getElementById('modal-btn-reject');
      if (paper.status === 'approved') {
        approveBtn.innerText = '✓ Already Approved';
        approveBtn.disabled = true;
      } else {
        approveBtn.innerText = '✨ Approve Current Document & Upload to Cloudinary';
        approveBtn.disabled = false;
      }

      // Unhide modal
      document.getElementById('material-modal').classList.remove('hidden');
    }

    function detectFormat(url, fallbackType) {
      var clean = (url || '').split('?')[0].toLowerCase();
      var parts = clean.split('.');
      var ext = parts.length > 1 ? parts.pop() : '';
      if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'ico', 'tiff'].indexOf(ext) !== -1) {
        return { category: 'image', ext: ext.toUpperCase(), icon: '🖼️', label: ext.toUpperCase() + ' Image' };
      }
      if (ext === 'pdf') {
        return { category: 'pdf', ext: 'PDF', icon: '📄', label: 'Adobe PDF' };
      }
      if (['doc', 'docx', 'dotx', 'odt'].indexOf(ext) !== -1) {
        return { category: 'docx', ext: ext.toUpperCase(), icon: '📝', label: 'Word ' + ext.toUpperCase() };
      }
      if (['txt', 'text', 'md', 'csv', 'json', 'log', 'rtf'].indexOf(ext) !== -1) {
        return { category: 'text', ext: ext.toUpperCase(), icon: '📑', label: 'Text ' + ext.toUpperCase() };
      }
      if (fallbackType && fallbackType.toLowerCase().indexOf('image') !== -1) {
        return { category: 'image', ext: 'IMG', icon: '🖼️', label: 'Image' };
      }
      if (fallbackType && fallbackType.toLowerCase().indexOf('doc') !== -1) {
        return { category: 'docx', ext: 'DOC', icon: '📝', label: 'Word Document' };
      }
      return { category: 'pdf', ext: 'DOC', icon: '📄', label: 'Document' };
    }

    var currentMediaMode = 'current';

    function setMediaChoice(mode) {
      currentMediaMode = mode;
      var radioCurrent = document.getElementById('radio-choice-current');
      var radioUpload = document.getElementById('radio-choice-upload');
      var cardCurrent = document.getElementById('choice-card-current');
      var cardUpload = document.getElementById('choice-card-upload');
      var currentBox = document.getElementById('media-status-current-box');
      var uploadBox = document.getElementById('media-status-upload-box');
      var approveBtn = document.getElementById('modal-btn-approve');

      if (mode === 'current') {
        if (radioCurrent) radioCurrent.checked = true;
        if (cardCurrent) { cardCurrent.classList.add('active'); cardCurrent.classList.remove('upload-active'); }
        if (cardUpload) { cardUpload.classList.remove('active'); cardUpload.classList.remove('upload-active'); }
        if (currentBox) currentBox.classList.remove('hidden');
        if (uploadBox) uploadBox.classList.add('hidden');
        if (approveBtn && !approveBtn.disabled) {
          approveBtn.innerText = '✨ Approve Current Document & Upload to Cloudinary';
        }
      } else {
        if (radioUpload) radioUpload.checked = true;
        if (cardUpload) { cardUpload.classList.add('active'); cardUpload.classList.add('upload-active'); }
        if (cardCurrent) { cardCurrent.classList.remove('active'); }
        if (uploadBox) uploadBox.classList.remove('hidden');
        if (currentBox) currentBox.classList.add('hidden');
        if (approveBtn && !approveBtn.disabled) {
          approveBtn.innerText = '✨ Upload Clean Copy & Approve to Cloudinary';
        }
      }
    }

    function onModalFileSelected() {
      var input = document.getElementById('modal-replace-input');
      var info = document.getElementById('selected-clean-file-info');
      if (!input || !input.files || input.files.length === 0) {
        if (info) info.style.display = 'none';
        return;
      }
      var file = input.files[0];
      var fmt = detectFormat(file.name, file.type);
      if (info) {
        info.innerHTML = 'Selected replacement: <b>' + file.name + '</b> (' + formatBytes(file.size) + ') • Format: <b>' + fmt.icon + ' ' + fmt.label + '</b>';
        info.style.display = 'block';
      }
    }

    function copyModalFileUrl() {
      if (!currentModalPaper) return;
      var url = currentModalPaper.fileUrl;
      if (currentModalPaper.tempFilename || (url && url.indexOf('/uploads/temp/') !== -1)) {
        var fn = currentModalPaper.tempFilename || url.split('/uploads/temp/')[1]?.split('?')[0];
        url = window.location.origin + '/mydomain_admin/temp_files/' + fn;
      }
      navigator.clipboard.writeText(url).then(function() {
        showToast('Copied public temp URL: ' + url);
      });
    }

    function closeMaterialModal() {
      document.getElementById('material-modal').classList.add('hidden');
      currentModalPaper = null;
    }

    async function handleSavePaperEdits(e) {
      e.preventDefault();
      if (!currentModalPaper) return;

      const title = document.getElementById('modal-input-title').value.trim();
      const unitCode = document.getElementById('modal-input-code').value.trim().toUpperCase();
      const examYear = parseInt(document.getElementById('modal-input-year').value.trim(), 10) || 2025;
      const type = document.getElementById('modal-input-type').value;
      const school = document.getElementById('modal-input-school').value.trim();

      const btn = document.getElementById('btn-save-paper-edits');
      btn.disabled = true;
      btn.innerText = '⏳ Saving...';

      try {
        const res = await fetch('/api/v1/dashboard/papers/' + currentModalPaper._id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            courseCode: unitCode,
            unitCode,
            unitName: title,
            examYear,
            type,
            school,
            department: school
          })
        });

        const json = await res.json();
        if (json.success) {
          showToast('Saved metadata edits!');
          currentModalPaper = json.data;
          document.getElementById('modal-title-display').innerText = json.data.title;
          loadDashboardData();
        } else {
          showToast(json.error || 'Failed to save edits.', true);
        }
      } catch (err) {
        showToast('Error saving: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = '💾 Save Metadata Edits';
      }
    }

    async function handleModalFileReplace() {
      if (!currentModalPaper) return;
      const fileInput = document.getElementById('modal-replace-input');
      if (!fileInput.files || fileInput.files.length === 0) {
        alert('Please choose a replacement file (.pdf, .doc, image) from your device first.');
        return;
      }

      const file = fileInput.files[0];
      const formData = new FormData();
      formData.append('file', file);

      const btn = document.getElementById('btn-modal-replace');
      btn.disabled = true;
      btn.innerText = '⏳ Uploading Replacement...';

      try {
        const res = await fetch('/api/v1/dashboard/papers/' + currentModalPaper._id + '/replace-file', {
          method: 'POST',
          body: formData
        });

        const json = await res.json();
        if (json.success) {
          showToast('Clean replacement file uploaded & old file replaced!');
          currentModalPaper = json.data;
          
          // Update download & preview links
          document.getElementById('modal-download-btn').href = json.data.fileUrl;
          const smartPreviewUrl = '/admin/preview?url=' + encodeURIComponent(json.data.fileUrl) + 
            '&title=' + encodeURIComponent(json.data.title || 'Paper') + 
            '&type=' + encodeURIComponent(json.data.fileType || '') + 
            '&id=' + encodeURIComponent(json.data._id);
          document.getElementById('modal-preview-btn').href = smartPreviewUrl;
          fileInput.value = '';
          const cleanInfo = document.getElementById('selected-clean-file-info');
          if (cleanInfo) cleanInfo.style.display = 'none';
          
          loadDashboardData();
          loadTempFiles();
        } else {
          showToast(json.error || 'Failed to replace file.', true);
        }
      } catch (err) {
        showToast('Upload error: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Upload Clean Copy Now';
      }
    }

    async function approveCurrentPaperFromModal() {
      if (!currentModalPaper) return;
      if (!confirm('Approve "' + currentModalPaper.title + '"? This will transfer the file to Cloudinary (folder: MoiConnect/pdf) and assign an MTID number.')) return;

      const btn = document.getElementById('modal-btn-approve');
      btn.disabled = true;

      // Smart upload if in upload mode and file selected
      if (currentMediaMode === 'upload') {
        const fileInput = document.getElementById('modal-replace-input');
        if (fileInput && fileInput.files && fileInput.files.length > 0) {
          btn.innerText = '⏳ Uploading Clean Replacement...';
          const file = fileInput.files[0];
          const formData = new FormData();
          formData.append('file', file);
          try {
            const replaceRes = await fetch('/api/v1/dashboard/papers/' + currentModalPaper._id + '/replace-file', {
              method: 'POST',
              body: formData
            });
            const replaceJson = await replaceRes.json();
            if (!replaceJson.success) {
              showToast('Replacement upload failed: ' + replaceJson.error, true);
              btn.disabled = false;
              btn.innerText = '✨ Upload Clean Copy & Approve to Cloudinary';
              return;
            }
            currentModalPaper = replaceJson.data;
            fileInput.value = '';
          } catch (rErr) {
            showToast('Replacement error: ' + rErr.message, true);
            btn.disabled = false;
            btn.innerText = '✨ Upload Clean Copy & Approve to Cloudinary';
            return;
          }
        }
      }

      btn.innerText = '⏳ Uploading to Cloudinary & Approving...';

      try {
        const res = await fetch('/api/v1/dashboard/papers/' + currentModalPaper._id + '/approve', {
          method: 'POST'
        });

        const json = await res.json();
        if (json.success) {
          showToast(json.message);
          closeMaterialModal();
          loadDashboardData();
          loadTempFiles();
        } else {
          showToast(json.error || 'Approval failed', true);
        }
      } catch (err) {
        showToast('Approval error: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = currentMediaMode === 'upload' ? '✨ Upload Clean Copy & Approve to Cloudinary' : '✨ Approve Current Document & Upload to Cloudinary';
      }
    }

    async function rejectCurrentPaperFromModal() {
      if (!currentModalPaper) return;
      const reason = prompt('Enter rejection reason for student:', 'Document quality is unclear or incomplete.');
      if (reason === null) return;

      const btn = document.getElementById('modal-btn-reject');
      btn.disabled = true;
      btn.innerText = '⏳ Rejecting & Cleaning...';

      try {
        const res = await fetch('/api/v1/dashboard/papers/' + currentModalPaper._id + '/reject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });

        const json = await res.json();
        if (json.success) {
          showToast(json.message);
          closeMaterialModal();
          loadDashboardData();
          loadTempFiles();
        } else {
          showToast(json.error || 'Rejection failed', true);
        }
      } catch (err) {
        showToast('Rejection error: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = '❌ Reject & Delete Temp File';
      }
    }

    // SERVER MEDIA TEMP MANAGEMENT FUNCTIONS
    async function loadTempFiles() {
      const tbody = document.getElementById('temp-files-table-body');
      if (!tbody) return;

      try {
        const res = await fetch('/api/v1/dashboard/temp-files');
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Failed to fetch temp files');

        tempFilesData = json.files || [];

        const countElem = document.getElementById('temp-stat-count');
        if (countElem) countElem.innerText = json.totalFiles || 0;
        const sizeElem = document.getElementById('temp-stat-size');
        if (sizeElem) sizeElem.innerText = json.totalSizeFormatted || '0 Bytes';

        const tempBadge = document.getElementById('badge-temp-count');
        if (json.totalFiles > 0) {
          tempBadge.innerText = json.totalFiles;
          tempBadge.classList.remove('hidden');
        } else {
          tempBadge.classList.add('hidden');
        }

        if (tempFilesData.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 36px; color: #94a3b8; font-size: 13px;">No temporary media files on server disk. Everything is clean! 🟢</td></tr>';
          return;
        }

        tbody.innerHTML = tempFilesData.map(f => {
          const linked = f.associatedPaper;
          return \`
            <tr>
              <td>
                <input type="checkbox" class="temp-file-cb" data-filename="\${f.filename}" />
              </td>
              <td style="font-family: monospace; font-size: 12px; font-weight: 700; color: #0f172a;">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span>📄</span>
                  <span title="\${f.filename}">\${f.filename}</span>
                </div>
              </td>
              <td style="font-weight: 700; color: #475569;">\${f.sizeFormatted}</td>
              <td style="color: #64748b; font-size: 12px;">\${new Date(f.modifiedAt).toLocaleString()}</td>
              <td>
                \${linked ? \`
                  <span style="font-size: 11px; font-weight: 700; color: #15803d; background: #dcfce7; padding: 3px 8px; border-radius: 6px;">
                    📌 \${linked.unitCode || 'Paper'}: \${linked.title || ''} (\${linked.status.toUpperCase()})
                  </span>
                \` : \`
                  <span style="font-size: 11px; font-weight: 700; color: #b45309; background: #fef3c7; padding: 3px 8px; border-radius: 6px;">
                    ⚠️ Unlinked / Orphaned
                  </span>
                \`}
              </td>
              <td style="text-align: right;">
                <div style="display: inline-flex; gap: 6px;">
                  <a href="\${f.fileUrl}" download="\${f.filename}" class="btn btn-tiny" style="background: #0284c7; color: #ffffff;">
                    📥 Download
                  </a>
                  <button onclick="deleteSingleTemp('\${f.filename}')" class="btn btn-tiny" style="background: #fee2e2; color: #dc2626; border: 1px solid #fecaca;">
                    🗑️ Delete
                  </button>
                </div>
              </td>
            </tr>
          \`;
        }).join('');
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: #dc2626;">Error loading temporary files: ' + err.message + '</td></tr>';
      }
    }

    function toggleSelectAllTemp(masterCheckbox) {
      const checkboxes = document.querySelectorAll('.temp-file-cb');
      checkboxes.forEach(cb => cb.checked = masterCheckbox.checked);
    }

    async function deleteSelectedTempFiles() {
      const checkedBoxes = Array.from(document.querySelectorAll('.temp-file-cb:checked'));
      if (checkedBoxes.length === 0) {
        alert('Please select at least one file to clean.');
        return;
      }

      const filenames = checkedBoxes.map(cb => cb.dataset.filename);
      if (!confirm('Are you sure you want to permanently delete ' + filenames.length + ' temporary file(s) from the server disk?')) return;

      try {
        const res = await fetch('/api/v1/dashboard/temp-files/delete-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames })
        });

        const json = await res.json();
        if (json.success) {
          showToast(json.message);
          loadTempFiles();
          loadDashboardData();
        } else {
          showToast(json.error || 'Failed to delete files', true);
        }
      } catch (err) {
        showToast('Error during cleanup: ' + err.message, true);
      }
    }

    async function deleteSingleTemp(filename) {
      if (!confirm('Permanently delete temporary file "' + filename + '" from server disk?')) return;

      try {
        const res = await fetch('/api/v1/dashboard/temp-files/' + encodeURIComponent(filename), {
          method: 'DELETE'
        });

        const json = await res.json();
        if (json.success) {
          showToast(json.message);
          loadTempFiles();
          loadDashboardData();
        } else {
          showToast(json.error || 'Failed to delete file', true);
        }
      } catch (err) {
        showToast('Error deleting file: ' + err.message, true);
      }
    }

    function renderUsers(users) {
      const tbody = document.getElementById('users-table-body');
      if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 32px; color: #94a3b8;">No users found.</td></tr>';
        return;
      }

      const onlineIds = globalData?.stats?.onlineUserIds || [];

      tbody.innerHTML = users.map(u => {
        const isOnline = onlineIds.includes(u._id);
        return \`
        <tr>
          <td style="font-weight: 700; color: #0f172a; display: flex; align-items: center; gap: 8px;">
            <div style="position: relative; width: 28px; height: 28px; border-radius: 50%; background: #15803d; color: #ffffff; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800;">
              \${(u.name || 'U')[0].toUpperCase()}
              \${isOnline ? '<span title="User Online Now" style="position: absolute; bottom: -1px; right: -1px; width: 9px; height: 9px; background-color: #22c55e; border: 2px solid #ffffff; border-radius: 50%;"></span>' : ''}
            </div>
            \${u.name || 'Student'}
          </td>
          <td style="font-family: monospace; font-size: 12px;">\${u.email}</td>
          <td>
            <span style="font-size: 10px; font-weight: 800; text-transform: uppercase; background: #f1f5f9; color: #334155; padding: 3px 8px; border-radius: 6px; border: 1px solid #cbd5e1;">
              \${(u.roles || ['student']).join(', ')}
            </span>
          </td>
          <td>
            <span style="font-size: 10px; font-weight: 800; padding: 3px 8px; border-radius: 6px; \${
              u.landlordStatus === 'approved' ? 'background: #dcfce7; color: #166534;' : 'background: #f1f5f9; color: #64748b;'
            }">
              \${u.landlordStatus || 'none'}
            </span>
          </td>
          <td>
            \${isOnline ? \`
              <span style="font-size: 10px; font-weight: 800; background: #dcfce7; color: #15803d; padding: 3px 8px; border-radius: 12px; border: 1px solid #bbf7d0; display: inline-flex; align-items: center; gap: 4px;">
                <span style="width: 6px; height: 6px; background-color: #22c55e; border-radius: 50%;"></span> Online
              </span>
            \` : \`
              <span style="font-size: 10px; font-weight: 600; color: #94a3b8; display: inline-flex; align-items: center; gap: 4px;">
                <span style="width: 6px; height: 6px; background-color: #cbd5e1; border-radius: 50%;"></span> Offline
              </span>
            \`}
          </td>
          <td style="color: #94a3b8; font-size: 12px;">
            \${new Date(u.createdAt).toLocaleDateString()}
          </td>
        </tr>
      \`;
      }).join('');
    }

    function filterUsers() {
      const q = document.getElementById('user-search').value.toLowerCase();
      if (!globalData || !globalData.users) return;

      const filtered = globalData.users.filter(u =>
        (u.name && u.name.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q))
      );
      renderUsers(filtered);
    }

    function renderHouses(houses) {
      const container = document.getElementById('houses-container');
      if (!houses || houses.length === 0) {
        container.innerHTML = \`
          <div style="grid-column: 1 / -1; text-align: center; padding: 48px; background: #f8fafc; border-radius: 12px; border: 2px dashed #cbd5e1; color: #94a3b8; font-size: 14px;">
            No rental houses posted yet.
          </div>
        \`;
        return;
      }

      container.innerHTML = houses.map(h => \`
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <span style="font-size: 12px; font-weight: 800; color: #15803d; background: #dcfce7; padding: 3px 8px; border-radius: 6px;">
                KSh \${h.price?.toLocaleString() || 0} / mo
              </span>
              <span style="font-size: 10px; font-weight: 800; text-transform: uppercase; color: #64748b; background: #ffffff; padding: 2px 6px; border-radius: 4px; border: 1px solid #cbd5e1;">
                \${h.status}
              </span>
            </div>
            <h4 style="font-size: 14px; font-weight: 800; color: #0f172a; margin-bottom: 4px;">\${h.title}</h4>
            <p style="font-size: 12px; color: #64748b;">\${h.location} • \${h.type}</p>
          </div>
          <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #64748b; display: flex; justify-content: space-between;">
            <span>Landlord: <strong>\${h.landlordId?.name || 'Owner'}</strong></span>
            <span>Phone: \${h.landlordId?.phone || 'N/A'}</span>
          </div>
        </div>
      \`).join('');
    }

    function toggleEmailBox() {
      const isEmails = document.querySelector('input[name="push-target"]:checked')?.value === 'emails';
      const box = document.getElementById('email-recipients-box');
      if (box) {
        if (isEmails) {
          box.classList.remove('hidden');
        } else {
          box.classList.add('hidden');
        }
      }
    }

    function insertMagicVar(variable) {
      const textarea = document.getElementById('push-body');
      if (textarea) {
        textarea.value += variable;
        textarea.focus();
      }
    }

    async function handleSendPush(e) {
      e.preventDefault();
      const title = document.getElementById('push-title').value;
      const subtitle = document.getElementById('push-subtitle').value;
      const icon = document.querySelector('input[name="push-icon"]:checked')?.value || 'bell';
      const target = document.querySelector('input[name="push-target"]:checked')?.value || 'all';
      const recipientEmails = document.getElementById('push-emails')?.value || '';
      const body = document.getElementById('push-body').value;

      const btn = document.getElementById('btn-submit-push');
      btn.disabled = true;
      btn.innerText = '⏳ Dispatching Push Notification...';

      try {
        const res = await fetch('/api/v1/admin/push-notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            subtitle,
            icon,
            target,
            recipientEmails,
            body
          })
        });

        const json = await res.json();
        if (json.success) {
          showToast('🚀 ' + json.message);
          document.getElementById('push-form').reset();
          toggleEmailBox();
          loadPushHistory();
        } else {
          showToast(json.error || 'Push dispatch failed.', true);
        }
      } catch (err) {
        showToast('Push dispatch error: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = '🚀 Dispatch Android Push Notification';
      }
    }

    async function loadPushHistory() {
      const container = document.getElementById('push-history-container');
      if (!container) return;

      try {
        const res = await fetch('/api/v1/admin/push-history');
        const json = await res.json();
        if (!json.success || !json.history) return;

        if (json.history.length === 0) {
          container.innerHTML = '<div style="text-align: center; padding: 24px; color: #94a3b8; font-size: 13px;">No push notifications sent yet.</div>';
          return;
        }

        const ICON_MAP = {
          bell: '🔔',
          academic: '🎓',
          house: '🏠',
          alert: '⚡'
        };

        container.innerHTML = json.history.map(item => \`
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; font-size: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span style="font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 6px;">
                <span>\${ICON_MAP[item.icon] || '🔔'}</span> \${item.title}
              </span>
              <span style="font-size: 10px; font-weight: 800; text-transform: uppercase; background: #e0e7ff; color: #3730a3; padding: 2px 6px; border-radius: 4px;">
                \${item.target}
              </span>
            </div>
            \${item.subtitle ? \`<div style="font-size: 11px; font-weight: 700; color: #15803d; margin-bottom: 4px;">\${item.subtitle}</div>\` : ''}
            <div style="color: #475569; margin-bottom: 6px; line-height: 1.4;">\${item.body}</div>
            <div style="display: flex; justify-content: space-between; color: #94a3b8; font-size: 11px;">
              <span>Target: \${item.target === 'emails' ? (item.recipientEmails || []).join(', ') : 'All Users & Guests'}</span>
              <span>\${new Date(item.createdAt).toLocaleString()}</span>
            </div>
          </div>
        \`).join('');
      } catch (err) {
        console.error('Failed to load push history:', err);
      }
    }

    // Auto load on page render
    loadDashboardData();
    loadPushHistory();
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
};
