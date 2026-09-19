import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { app } from '../server';
import { User } from '../models/User';
import { Paper } from '../models/Paper';
import { House } from '../models/House';
import { Booking } from '../models/Booking';

describe('MoiConnect API Endpoints & Authorization', () => {
  let studentToken: string;
  let studentId: string;
  let landlordToken: string;
  let landlordId: string;
  let adminToken: string;
  let testPaperId: string;
  let testHouseId: string;

  beforeAll(async () => {
    // Connect to in-memory/test database or test mongo URI
    const mongoUri = process.env.MONGODB_TEST_URI || 'mongodb://127.0.0.1:27017/moi_app_test';
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri);
    }
    await User.deleteMany({});
    await Paper.deleteMany({});
    await House.deleteMany({});
    await Booking.deleteMany({});
  });

  afterAll(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    await mongoose.connection.close();
  });

  it('1. POST /api/v1/auth/register - Should register a new student', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: 'Test Student',
        email: 'student@moi.ac.ke',
        password: 'Password123!',
        phone: '0712345678'
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.roles).toContain('student');
    expect(res.body.data.user.roles).not.toContain('admin');

    studentToken = res.body.data.tokens.accessToken;
    studentId = res.body.data.user._id;
  });

  it('2. POST /api/v1/auth/login - Should login student and return JWT tokens', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'student@moi.ac.ke',
        password: 'Password123!'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tokens.accessToken).toBeDefined();
  });

  it('3. GET /api/v1/admin/stats - Should block regular student from admin route (403)', async () => {
    const res = await request(app)
      .get('/api/v1/admin/stats')
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('4. Create Admin & Landlord users in DB for testing', async () => {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('Admin123!', salt);

    // Create Admin
    const adminUser = await User.create({
      name: 'System Admin',
      email: 'admin@moi.ac.ke',
      passwordHash,
      roles: ['student', 'admin'],
      activeRole: 'admin',
      accountStatus: 'active'
    });

    const adminLoginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@moi.ac.ke', password: 'Admin123!' });

    adminToken = adminLoginRes.body.data.tokens.accessToken;

    // Create Approved Landlord
    const landlordUser = await User.create({
      name: 'Test Landlord',
      email: 'landlord@moi.ac.ke',
      passwordHash,
      phone: '0799887766',
      roles: ['student', 'landlord'],
      activeRole: 'landlord',
      landlordStatus: 'approved',
      accountStatus: 'active'
    });

    landlordId = landlordUser._id.toString();

    const landlordLoginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'landlord@moi.ac.ke', password: 'Admin123!' });

    landlordToken = landlordLoginRes.body.data.tokens.accessToken;
  });

  it('5. POST /api/v1/papers - Student submits a paper (Status: pending)', async () => {
    const res = await request(app)
      .post('/api/v1/papers')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        title: 'COM 310 Data Structures Exam 2025',
        type: 'past_paper',
        school: 'School of Information Sciences',
        department: 'Computer Science',
        courseCode: 'COM 310',
        unitCode: 'COM 310',
        unitName: 'Data Structures and Algorithms',
        examYear: 2025,
        fileUrl: 'https://res.cloudinary.com/demo/image/upload/sample.pdf'
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
    testPaperId = res.body.data._id;
  });

  it('6. GET /api/v1/papers - Public paper search should NOT include pending papers', async () => {
    const res = await request(app).get('/api/v1/papers');
    expect(res.status).toBe(200);
    const found = res.body.data.some((p: any) => p._id === testPaperId);
    expect(found).toBe(false);
  });

  it('7. PATCH /api/v1/admin/papers/:id/review - Admin approves paper', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/papers/${testPaperId}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
  });

  it('8. GET /api/v1/papers - Public search now includes approved paper', async () => {
    const res = await request(app).get('/api/v1/papers');
    expect(res.status).toBe(200);
    const found = res.body.data.some((p: any) => p._id === testPaperId);
    expect(found).toBe(true);
  });

  it('9. POST /api/v1/houses - Verified landlord creates listing', async () => {
    const res = await request(app)
      .post('/api/v1/houses')
      .set('Authorization', `Bearer ${landlordToken}`)
      .send({
        title: 'Modern Bedsitter Near Main Campus Stage',
        description: 'Self-contained bedsitter with tiled floors and 24/7 water supply.',
        propertyType: 'bedsetter',
        location: 'Kesses / Main Campus',
        monthlyRent: 4500,
        deposit: 4500,
        amenities: ['WiFi', 'Water 24/7', 'Tiles'],
        photos: ['https://res.cloudinary.com/demo/image/upload/sample.jpg']
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
    testHouseId = res.body.data._id;

    // Approve house via admin
    await request(app)
      .patch(`/api/v1/admin/houses/${testHouseId}/review`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'approved' });
  });

  it('10. POST /api/v1/bookings - Student requests booking, prevents duplicates', async () => {
    const firstBooking = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        houseId: testHouseId,
        requestedMoveIn: '2026-10-01',
        message: 'Hello, I would like to view and reserve this house.'
      });

    expect(firstBooking.status).toBe(201);
    expect(firstBooking.body.data.status).toBe('pending');

    // Duplicate attempt
    const duplicateBooking = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        houseId: testHouseId,
        requestedMoveIn: '2026-10-01'
      });

    expect(duplicateBooking.status).toBe(400);
    expect(duplicateBooking.body.error).toMatch(/already have an active/i);
  });
});
