const request = require('supertest');
const path = require('path');
const fs = require('fs');

// Use a separate test database
const TEST_DB_PATH = path.join(__dirname, 'test.db');
process.env.DB_PATH = TEST_DB_PATH;

const { app, initializeSchema } = require('../src/server');
const { closeDb } = require('../src/database');

beforeAll(async () => {
  await initializeSchema();
});

afterAll(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
});

describe('Health Check', () => {
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('Employee CRUD API', () => {
  let createdId;

  const sampleEmployee = {
    name: 'Alice Smith',
    email: 'alice@example.com',
    department: 'Engineering',
    role: 'Software Engineer',
    hire_date: '2023-01-15',
  };

  it('GET /api/employees returns empty array initially', async () => {
    const res = await request(app).get('/api/employees');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/employees creates a new employee', async () => {
    const res = await request(app).post('/api/employees').send(sampleEmployee);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Alice Smith');
    expect(res.body.email).toBe('alice@example.com');
    expect(res.body.department).toBe('Engineering');
    expect(res.body.id).toBeDefined();
    createdId = res.body.id;
  });

  it('POST /api/employees returns 400 for missing fields', async () => {
    const res = await request(app).post('/api/employees').send({ name: 'Bob' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required fields/);
  });

  it('POST /api/employees returns 400 for invalid email', async () => {
    const res = await request(app).post('/api/employees').send({
      ...sampleEmployee,
      email: 'not-an-email',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid email/);
  });

  it('POST /api/employees returns 409 for duplicate email', async () => {
    const res = await request(app).post('/api/employees').send(sampleEmployee);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('GET /api/employees/:id returns the employee', async () => {
    const res = await request(app).get(`/api/employees/${createdId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdId);
    expect(res.body.name).toBe('Alice Smith');
  });

  it('GET /api/employees/:id returns 404 for non-existent employee', async () => {
    const res = await request(app).get('/api/employees/99999');
    expect(res.status).toBe(404);
  });

  it('PUT /api/employees/:id updates the employee', async () => {
    const res = await request(app)
      .put(`/api/employees/${createdId}`)
      .send({ ...sampleEmployee, role: 'Senior Engineer' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('Senior Engineer');
  });

  it('PUT /api/employees/:id returns 404 for non-existent employee', async () => {
    const res = await request(app)
      .put('/api/employees/99999')
      .send(sampleEmployee);
    expect(res.status).toBe(404);
  });

  it('GET /api/employees/departments returns unique departments', async () => {
    const res = await request(app).get('/api/employees/departments');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toContain('Engineering');
  });

  it('GET /api/employees?department=Engineering filters by department', async () => {
    // Add another employee in a different department
    await request(app).post('/api/employees').send({
      name: 'Bob Jones',
      email: 'bob@example.com',
      department: 'Marketing',
      role: 'Manager',
      hire_date: '2022-06-01',
    });
    const res = await request(app).get('/api/employees?department=Engineering');
    expect(res.status).toBe(200);
    expect(res.body.every((e) => e.department === 'Engineering')).toBe(true);
  });

  it('GET /api/employees?search=alice filters by name', async () => {
    const res = await request(app).get('/api/employees?search=alice');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0].email).toBe('alice@example.com');
  });

  it('DELETE /api/employees/:id deletes the employee', async () => {
    const res = await request(app).delete(`/api/employees/${createdId}`);
    expect(res.status).toBe(204);
  });

  it('DELETE /api/employees/:id returns 404 for non-existent employee', async () => {
    const res = await request(app).delete('/api/employees/99999');
    expect(res.status).toBe(404);
  });
});
