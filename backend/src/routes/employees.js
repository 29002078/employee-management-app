const express = require('express');
const router = express.Router();
const { getDb } = require('../database');

// GET /api/employees - list all employees, optionally filter by department
router.get('/', async (req, res) => {
  try {
    const db = getDb();
    const { department, search } = req.query;

    let query = db('employees').orderBy('name', 'asc');

    if (department) {
      query = query.where({ department });
    }

    if (search) {
      query = query.where(function () {
        this.where('name', 'like', `%${search}%`).orWhere('email', 'like', `%${search}%`);
      });
    }

    const employees = await query;
    res.json(employees);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve employees', details: err.message });
  }
});

// GET /api/employees/departments - list unique departments
router.get('/departments', async (req, res) => {
  try {
    const db = getDb();
    const rows = await db('employees').distinct('department').orderBy('department', 'asc');
    res.json(rows.map((r) => r.department));
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve departments', details: err.message });
  }
});

// GET /api/employees/:id - get a single employee
router.get('/:id', async (req, res) => {
  try {
    const db = getDb();
    const employee = await db('employees').where({ id: req.params.id }).first();
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    res.json(employee);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve employee', details: err.message });
  }
});

// POST /api/employees - create a new employee
router.post('/', async (req, res) => {
  try {
    const { name, email, department, role, hire_date } = req.body;

    if (!name || !email || !department || !role || !hire_date) {
      return res.status(400).json({ error: 'Missing required fields: name, email, department, role, hire_date' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const db = getDb();
    const [id] = await db('employees').insert({
      name: name.trim(),
      email: email.trim(),
      department: department.trim(),
      role: role.trim(),
      hire_date,
    });

    const newEmployee = await db('employees').where({ id }).first();
    res.status(201).json(newEmployee);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'An employee with this email already exists' });
    }
    res.status(500).json({ error: 'Failed to create employee', details: err.message });
  }
});

// PUT /api/employees/:id - update an employee
router.put('/:id', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db('employees').where({ id: req.params.id }).first();
    if (!existing) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const { name, email, department, role, hire_date } = req.body;

    if (!name || !email || !department || !role || !hire_date) {
      return res.status(400).json({ error: 'Missing required fields: name, email, department, role, hire_date' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    await db('employees').where({ id: req.params.id }).update({
      name: name.trim(),
      email: email.trim(),
      department: department.trim(),
      role: role.trim(),
      hire_date,
    });

    const updated = await db('employees').where({ id: req.params.id }).first();
    res.json(updated);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'An employee with this email already exists' });
    }
    res.status(500).json({ error: 'Failed to update employee', details: err.message });
  }
});

// DELETE /api/employees/:id - delete an employee
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const existing = await db('employees').where({ id: req.params.id }).first();
    if (!existing) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    await db('employees').where({ id: req.params.id }).delete();
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete employee', details: err.message });
  }
});

module.exports = router;
