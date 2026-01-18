import { lazy, Suspense, useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom';
import './App.css';

// Lazy load page components for code splitting
const Applications = lazy(() => import('./pages/Applications'));
const Pipelines = lazy(() => import('./pages/Pipelines'));
const Analytics = lazy(() => import('./pages/Analytics'));

function Navigation() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  // Close mobile menu on escape key
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') setMobileMenuOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  return (
    <nav className="top-nav">
      <div className="nav-brand">
        <h2>PodRick</h2>
      </div>
      <div className="nav-title">
        <h1>DevOps Portfolio Manager</h1>
      </div>
      <button
        className={`hamburger ${mobileMenuOpen ? 'open' : ''}`}
        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        aria-label="Toggle navigation menu"
        aria-expanded={mobileMenuOpen}
      >
        <span></span>
        <span></span>
        <span></span>
      </button>
      <div className={`nav-links ${mobileMenuOpen ? 'open' : ''}`}>
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
      {mobileMenuOpen && <div className="nav-overlay" onClick={() => setMobileMenuOpen(false)} />}
    </nav>
  );
}

function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <Navigation />

        <main className="main-content">
          <Suspense fallback={
            <div className="loading-container">
              <div className="spinner"></div>
              <p>Loading...</p>
            </div>
          }>
            <Routes>
              <Route path="/" element={<Navigate to="/applications" replace />} />
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
