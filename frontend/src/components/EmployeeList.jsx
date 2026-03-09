import { useState, useEffect, useCallback } from 'react';
import { getEmployees, getDepartments, deleteEmployee } from '../api/employeeApi';

export default function EmployeeList({ onAdd, onEdit, refreshTrigger }) {
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const fetchDepartments = useCallback(async () => {
    try {
      const data = await getDepartments();
      setDepartments(data);
    } catch {
      // departments list is optional, ignore errors
    }
  }, []);

  const fetchEmployees = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getEmployees({ department, search });
      setEmployees(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [department, search]);

  useEffect(() => {
    fetchDepartments();
  }, [fetchDepartments, refreshTrigger]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchEmployees();
    }, 200);
    return () => clearTimeout(timer);
  }, [fetchEmployees, refreshTrigger]);

  async function handleDelete(employee) {
    if (deleteConfirm !== employee.id) {
      setDeleteConfirm(employee.id);
      return;
    }
    try {
      await deleteEmployee(employee.id);
      setDeleteConfirm(null);
      fetchEmployees();
      fetchDepartments();
    } catch (err) {
      setError(err.message);
    }
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    const [year, month, day] = dateStr.split('-');
    return `${month}/${day}/${year}`;
  }

  return (
    <div className="employee-list">
      <div className="list-header">
        <h2>Employees {!loading && <span className="count">({employees.length})</span>}</h2>
        <button className="btn btn-primary" onClick={onAdd}>
          + Add Employee
        </button>
      </div>

      <div className="filters">
        <input
          type="text"
          className="search-input"
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="department-filter"
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
        >
          <option value="">All Departments</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="list-error">{error}</div>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : employees.length === 0 ? (
        <div className="empty-state">
          {search || department ? 'No employees match your filters.' : 'No employees yet. Add one to get started!'}
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="employees-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Email</th>
                <th>Department</th>
                <th>Role</th>
                <th>Hire Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => (
                <tr key={emp.id}>
                  <td>{emp.id}</td>
                  <td>{emp.name}</td>
                  <td>
                    <a href={`mailto:${emp.email}`}>{emp.email}</a>
                  </td>
                  <td>
                    <span className="badge">{emp.department}</span>
                  </td>
                  <td>{emp.role}</td>
                  <td>{formatDate(emp.hire_date)}</td>
                  <td className="actions">
                    <button className="btn btn-sm btn-secondary" onClick={() => onEdit(emp)}>
                      Edit
                    </button>
                    <button
                      className={`btn btn-sm ${deleteConfirm === emp.id ? 'btn-danger-confirm' : 'btn-danger'}`}
                      onClick={() => handleDelete(emp)}
                    >
                      {deleteConfirm === emp.id ? 'Confirm?' : 'Delete'}
                    </button>
                    {deleteConfirm === emp.id && (
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => setDeleteConfirm(null)}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
