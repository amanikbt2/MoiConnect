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
                    <input type="radio" name="push-icon" value="bell" checked />
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
              '<button onclick="handleDeletePopup(\'' + item._id + '\')" class="btn" style="background: #fee2e2; color: #dc2626; padding: 3px 8px; font-size: 10px; font-weight: 800; border: 1px solid #fca5a5; border-radius: 6px;">' +
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
