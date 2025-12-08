import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom';
import './App.css';

// Lazy load page components for code splitting
const Applications = lazy(() => import('./pages/Applications'));
const Pipelines = lazy(() => import('./pages/Pipelines'));
const Analytics = lazy(() => import('./pages/Analytics'));

function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <nav className="top-nav">
          <div className="nav-brand">
            <h2>PodRick</h2>
          </div>
          <div className="nav-title">
            <h1>DevOps Portfolio Manager</h1>
          </div>
          <div className="nav-links">
            <NavLink to="/applications" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              Applications
            </NavLink>
            <NavLink to="/pipelines" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              CI/CD Pipelines
            </NavLink>
            <NavLink to="/analytics" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
              Analytics
            </NavLink>
          </div>
        </nav>

        <main className="main-content">
          <Suspense fallback={
            <div className="loading-container">
              <div className="spinner"></div>
              <p>Loading...</p>
            </div>
          }>
            <Routes>
              <Route path="/" element={<Navigate to="/applications" />} />
              <Route path="/applications" element={<Applications />} />
              <Route path="/pipelines" element={<Pipelines />} />
              <Route path="/analytics" element={<Analytics />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
