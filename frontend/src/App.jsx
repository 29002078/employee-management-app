import { useState, useCallback } from 'react';
import EmployeeList from './components/EmployeeList';
import EmployeeForm from './components/EmployeeForm';
import { createEmployee, updateEmployee } from './api/employeeApi';
import './App.css';

export default function App() {
  const [view, setView] = useState('list'); // 'list' | 'form'
  const [editingEmployee, setEditingEmployee] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const refresh = useCallback(() => setRefreshTrigger((n) => n + 1), []);

  function handleAdd() {
    setEditingEmployee(null);
    setView('form');
  }

  function handleEdit(employee) {
    setEditingEmployee(employee);
    setView('form');
  }

  function handleCancel() {
    setEditingEmployee(null);
    setView('list');
  }

  async function handleSubmit(formData) {
    if (editingEmployee) {
      await updateEmployee(editingEmployee.id, formData);
    } else {
      await createEmployee(formData);
    }
    setEditingEmployee(null);
    setView('list');
    refresh();
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Employee Management</h1>
      </header>

      <main className="app-main">
        {view === 'list' ? (
          <EmployeeList
            onAdd={handleAdd}
            onEdit={handleEdit}
            refreshTrigger={refreshTrigger}
          />
        ) : (
          <EmployeeForm
            employee={editingEmployee}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
          />
        )}
      </main>
    </div>
  );
}

