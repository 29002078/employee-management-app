import { useState, useEffect } from 'react';

const EMPTY_FORM = {
  name: '',
  email: '',
  department: '',
  role: '',
  hire_date: '',
};

export default function EmployeeForm({ employee, onSubmit, onCancel }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (employee) {
      setForm({
        name: employee.name || '',
        email: employee.email || '',
        department: employee.department || '',
        role: employee.role || '',
        hire_date: employee.hire_date || '',
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setError('');
  }, [employee]);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSubmit(form);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="employee-form" onSubmit={handleSubmit} noValidate>
      <h2>{employee ? 'Edit Employee' : 'Add Employee'}</h2>

      {error && <div className="form-error">{error}</div>}

      <div className="form-group">
        <label htmlFor="name">Full Name *</label>
        <input
          id="name"
          name="name"
          type="text"
          value={form.name}
          onChange={handleChange}
          required
          placeholder="e.g. Jane Smith"
        />
      </div>

      <div className="form-group">
        <label htmlFor="email">Email *</label>
        <input
          id="email"
          name="email"
          type="email"
          value={form.email}
          onChange={handleChange}
          required
          placeholder="e.g. jane@company.com"
        />
      </div>

      <div className="form-group">
        <label htmlFor="department">Department *</label>
        <input
          id="department"
          name="department"
          type="text"
          value={form.department}
          onChange={handleChange}
          required
          placeholder="e.g. Engineering"
        />
      </div>

      <div className="form-group">
        <label htmlFor="role">Role *</label>
        <input
          id="role"
          name="role"
          type="text"
          value={form.role}
          onChange={handleChange}
          required
          placeholder="e.g. Software Engineer"
        />
      </div>

      <div className="form-group">
        <label htmlFor="hire_date">Hire Date *</label>
        <input
          id="hire_date"
          name="hire_date"
          type="date"
          value={form.hire_date}
          onChange={handleChange}
          required
        />
      </div>

      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={loading}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Saving…' : employee ? 'Update Employee' : 'Add Employee'}
        </button>
      </div>
    </form>
  );
}
