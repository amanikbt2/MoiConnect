import { Request, Response } from 'express';
import { User } from '../models/User';
import { Paper } from '../models/Paper';
import { House } from '../models/House';
import { Report } from '../models/Report';
import { getOnlineStats } from '../socket';

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
      .limit(20);

    const userList = await User.find()
      .select('-passwordHash -refreshTokens')
      .sort({ createdAt: -1 })
      .limit(50);

    const houseList = await House.find()
      .populate('landlordId', 'name email phone')
      .sort({ createdAt: -1 })
      .limit(30);

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
        onlineUserIds: onlineStats.onlineUserIds
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

    res.json({ success: true, message: `Approved "${paper.title}" with MTID ${paper.mtid}`, data: paper });
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
    paper.reviewedAt = new Date();
    await paper.save();

    res.json({ success: true, message: `Rejected "${paper.title}"`, data: paper });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Rejection failed' });
  }
};

// 4. Render HTML Admin Dashboard Page for GET / and GET /admin
export const renderAdminDashboard = (_req: Request, res: Response): void => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MoiConnect Admin Control Center</title>
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
        <div class="brand-logo">M</div>
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
          Backend API Live (Port 8080)
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
              Revision Materials Pending Approval
            </h2>
            <p class="card-sub">Review student uploads (Past Papers, CATs, Notes) and assign MTID numbers instantly.</p>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 12px; font-weight: 600; color: #64748b;">Status Filter:</span>
            <select id="paper-filter" onchange="loadDashboardData()" class="form-control" style="font-weight: 700;">
              <option value="pending">Pending Only</option>
              <option value="approved">Approved Materials</option>
            </select>
          </div>
        </div>

        <div id="pending-papers-container" class="item-list">
          <div style="text-align: center; padding: 48px; color: #94a3b8; font-size: 14px;">Loading pending revision materials...</div>
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

      document.getElementById(\`tab-btn-\${tabId}\`).classList.add('active');
      document.getElementById(\`tab-content-\${tabId}\`).classList.remove('hidden');
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

      container.innerHTML = filtered.map(paper => \`
        <div class="item-card">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
              <span class="badge-tag">\${paper.type?.toUpperCase()}</span>
              \${paper.mtid ? \`<span class="mtid-tag">\${paper.mtid}</span>\` : ''}
              <span style="font-size: 12px; font-weight: 700; color: #94a3b8;">• \${paper.unitCode || 'UNIT'}</span>
            </div>
            <div class="item-title">\${paper.title}</div>
            <div class="item-meta">
              \${paper.school || 'Moi Uni'} • \${paper.department || ''} (\${paper.unitName || ''})
            </div>
            <div class="item-sub">
              Submitted by: <strong style="color: #334155;">\${paper.submittedBy?.name || 'Student'}</strong> (\${paper.submittedBy?.email || ''})
            </div>
          </div>

          <div class="btn-group">
            <a href="\${paper.fileUrl}" target="_blank" class="btn btn-view">
              \${SVG_FILE} View File
            </a>
            \${paper.status === 'pending' ? \`
              <button onclick="approvePaper('\${paper._id}')" class="btn btn-approve">
                \${SVG_CHECK} Approve
              </button>
              <button onclick="rejectPaper('\${paper._id}')" class="btn btn-reject">
                \${SVG_CROSS} Reject
              </button>
            \` : \`
              <span style="font-size: 12px; font-weight: 700; color: #15803d; background: #dcfce7; padding: 6px 12px; border-radius: 8px; border: 1px solid #bbf7d0;">
                Approved
              </span>
            \`}
          </div>
        </div>
      \`).join('');
    }

    async function approvePaper(id) {
      if (!confirm('Approve this revision material for campus public access?')) return;
      try {
        const res = await fetch(\`/api/v1/dashboard/papers/\${id}/approve\`, { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          showToast(json.message);
          loadDashboardData();
        } else {
          showToast(json.error || 'Approval failed', true);
        }
      } catch (err) {
        showToast('Approval error: ' + err.message, true);
      }
    }

    async function rejectPaper(id) {
      const reason = prompt('Enter rejection reason for the student:', 'Document quality is unclear or incomplete.');
      if (reason === null) return;

      try {
        const res = await fetch(\`/api/v1/dashboard/papers/\${id}/reject\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        const json = await res.json();
        if (json.success) {
          showToast(json.message);
          loadDashboardData();
        } else {
          showToast(json.error || 'Rejection failed', true);
        }
      } catch (err) {
        showToast('Rejection error: ' + err.message, true);
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

    // Auto load on page render
    loadDashboardData();
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
};
